// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The process-lifetime connection a backup keeps to its primary.
//!
//! A worker thread pairs with the primary, polls the revision of its live show, and downloads
//! and unpacks the show whenever the revision changes. The world picks up each unpacked show and
//! loads it. The link outlives world swaps, which the backup itself causes on every load.

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use nightfall_engine::prelude::LiveStateSnapshot;
use reqwest::{StatusCode, header};
use tokio::sync::watch;

use crate::{
    BackupLinkStatus, EXPORT_SOURCE_HEADER, EXPORT_SOURCE_LIVE, LIVE_STATE_PATH,
    LIVE_STATE_WAIT_HEADER, PAIRING_PATH, SHOWFILE_EXPORT_PATH, SHOWFILE_REVISION_PATH,
    ShowfileRevision, preferences,
};

/// Time between revision checks while the link is healthy.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Time between live state checkpoints once the backup holds the primary's show.
const CHECKPOINT_INTERVAL: Duration = Duration::from_millis(500);

/// Sequence of the newest checkpoint received, shared by every primary this process follows, so
/// a world that applied a checkpoint from an earlier link never mistakes a new one for stale.
static CHECKPOINT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Time before retrying a primary that could not be reached.
const RETRY_INTERVAL: Duration = Duration::from_secs(3);

/// Upper bound for a single request, including a show download.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Folder under the host data directory that holds unpacked copies of the primary's show.
const MIRROR_DIR_NAME: &str = "backup-mirror";

/// Name of the primary's pairing cookie, which carries its port.
fn pairing_cookie_name(address: &str) -> String {
    let port = address.rsplit_once(':').map_or("", |(_, port)| port);
    format!("nightfall_pairing_{port}")
}

/// The primary a backup follows and how it authenticates there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinkTarget {
    /// `host:port` of the primary.
    pub address: String,
    /// PIN to pair with first, when the operator just entered one.
    pub pin: Option<String>,
    /// Token from an earlier pairing, used until the primary rejects it.
    pub token: Option<String>,
}

/// Link progress the world turns into the client-facing backup state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct LinkReport {
    /// Where the link stands.
    pub status: BackupLinkStatus,
    /// Why the link is not synced, in words for the operator.
    pub error: Option<String>,
    /// Showfile the primary had open at the last sync.
    pub showfile_name: Option<String>,
    /// Unix time in milliseconds of the last show copied from the primary.
    pub synced_at_ms: Option<u64>,
}

/// A show unpacked from the primary, ready for the world to load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MirroredShow {
    /// Name the primary's show is loaded under, or `None` for the default showfile.
    pub showfile_name: Option<String>,
    /// Loadable show directory.
    pub directory: PathBuf,
}

/// The newest live state checkpoint from the primary.
#[derive(Debug, Clone)]
pub(crate) struct LiveCheckpoint {
    /// Increases with every checkpoint, so a world can tell which ones it already applied.
    pub sequence: u64,
    /// The primary's live state.
    pub snapshot: LiveStateSnapshot,
    /// When the backup received it.
    pub received_at: Instant,
    /// Estimated time the checkpoint spent travelling from the primary: half the round trip.
    pub transit: Duration,
}

impl LiveCheckpoint {
    /// Time since the primary captured this checkpoint.
    pub fn age(&self) -> Duration {
        self.transit + self.received_at.elapsed()
    }
}

/// State the worker shares with the world.
#[derive(Debug, Default)]
struct LinkShared {
    report: LinkReport,
    mirror: Option<MirroredShow>,
    checkpoint: Option<LiveCheckpoint>,
    /// Keeps the newest unpacked show on disk until the next one replaces it, since the world
    /// loads it a frame or more after the worker hands it over.
    unpacked: Option<tempfile::TempDir>,
}

/// Handle to the link worker, shared by every world in the process.
pub(crate) struct BackupLink {
    target: watch::Sender<Option<LinkTarget>>,
    shared: Arc<Mutex<LinkShared>>,
}

impl BackupLink {
    /// Starts the worker thread with no primary to follow.
    fn spawn() -> Self {
        let (target, target_rx) = watch::channel(None);
        let shared = Arc::new(Mutex::new(LinkShared::default()));
        let worker_shared = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("backup-link".into())
            .spawn(move || run_worker(target_rx, worker_shared));
        if let Err(error) = spawned {
            tracing::error!(%error, "Could not start the backup link");
        }
        Self { target, shared }
    }

    /// Follows `target`, or stops following with `None`. Setting the current target again keeps
    /// the running connection, so each new world can restate the stored role.
    ///
    /// A real change also drops the progress and any unloaded show from the previous primary
    /// before the worker wakes, so neither is mistaken for the new primary's.
    pub(crate) fn set_target(&self, target: Option<LinkTarget>) {
        self.target.send_if_modified(|current| {
            let changed = match (current.as_ref(), target.as_ref()) {
                (Some(current), Some(next)) => {
                    current.address != next.address || next.pin.is_some()
                }
                (None, None) => false,
                _ => true,
            };
            if changed {
                *current = target;
                if let Ok(mut shared) = self.shared.lock() {
                    shared.mirror = None;
                    shared.checkpoint = None;
                    shared.report = LinkReport::default();
                }
            }
            changed
        });
    }

    /// Returns the latest link progress.
    pub(crate) fn report(&self) -> LinkReport {
        self.shared
            .lock()
            .map(|shared| shared.report.clone())
            .unwrap_or_default()
    }

    /// Takes the show unpacked since the previous call, if any.
    pub(crate) fn take_mirror(&self) -> Option<MirroredShow> {
        self.shared.lock().ok()?.mirror.take()
    }

    /// Returns the newest checkpoint when it is newer than `applied`, the sequence a world last
    /// applied. Unlike a show copy, a checkpoint stays available, so the world that replaces
    /// this one after a show load applies it again.
    pub(crate) fn checkpoint_after(&self, applied: Option<u64>) -> Option<LiveCheckpoint> {
        let shared = self.shared.lock().ok()?;
        let checkpoint = shared.checkpoint.as_ref()?;
        (applied < Some(checkpoint.sequence)).then(|| checkpoint.clone())
    }
}

/// Returns the process-wide link, starting its worker on first use.
pub(crate) fn process_backup_link() -> &'static BackupLink {
    static LINK: OnceLock<BackupLink> = OnceLock::new();
    LINK.get_or_init(BackupLink::spawn)
}

/// Runs the worker: follows each target until it changes, idling while there is none.
fn run_worker(mut target_rx: watch::Receiver<Option<LinkTarget>>, shared: Arc<Mutex<LinkShared>>) {
    remove_stale_mirrors();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "Could not start the backup link runtime");
            return;
        }
    };
    runtime.block_on(async move {
        loop {
            let target = target_rx.borrow_and_update().clone();
            match target {
                None => {
                    set_report(&shared, LinkReport::default());
                    if target_rx.changed().await.is_err() {
                        return;
                    }
                }
                Some(target) => {
                    tokio::select! {
                        // `follow` gives up only on a rejected PIN; the same target would be
                        // rejected again, so wait for the operator to enter another one.
                        () = follow(&target, &shared) => {
                            if target_rx.changed().await.is_err() {
                                return;
                            }
                        }
                        changed = target_rx.changed() => {
                            if changed.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        }
    });
}

/// Replaces the link report the world reads.
fn set_report(shared: &Mutex<LinkShared>, report: LinkReport) {
    if let Ok(mut shared) = shared.lock() {
        shared.report = report;
    }
}

/// Updates the link report in place.
fn update_report(shared: &Mutex<LinkShared>, update: impl FnOnce(&mut LinkReport)) {
    if let Ok(mut shared) = shared.lock() {
        update(&mut shared.report);
    }
}

/// Failure talking to the primary.
#[derive(Debug, PartialEq, Eq)]
enum LinkError {
    /// The primary refused this host's PIN or token.
    Unauthorized(String),
    /// The primary could not be reached or answered with an error.
    Failed(String),
}

impl LinkError {
    /// Describes a transport failure without exposing request internals.
    fn from_request(error: &reqwest::Error) -> Self {
        let message = if error.is_timeout() {
            "The primary did not answer in time.".to_string()
        } else if error.is_connect() {
            "Could not connect to the primary.".to_string()
        } else {
            format!("Request to the primary failed: {error}")
        };
        Self::Failed(message)
    }
}

/// Pairs with the primary if the operator gave a PIN, then keeps the backup's copy of the show
/// in step with the primary's revisions. Returns only when the PIN was rejected; the caller then
/// waits for a new target.
async fn follow(target: &LinkTarget, shared: &Mutex<LinkShared>) {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            set_report(
                shared,
                LinkReport {
                    status: BackupLinkStatus::Unreachable,
                    error: Some(format!("Could not start the backup link: {error}")),
                    ..LinkReport::default()
                },
            );
            return std::future::pending().await;
        }
    };
    let base = format!("http://{}", target.address);
    set_report(
        shared,
        LinkReport {
            status: BackupLinkStatus::Connecting,
            ..LinkReport::default()
        },
    );

    let mut token = target.token.clone();
    if let Some(pin) = &target.pin {
        loop {
            match pair(&client, &base, &target.address, pin).await {
                Ok(paired) => {
                    store_token(&target.address, &paired);
                    token = Some(paired);
                    break;
                }
                Err(LinkError::Unauthorized(message)) => {
                    set_report(
                        shared,
                        LinkReport {
                            status: BackupLinkStatus::PairingRequired,
                            error: Some(message),
                            ..LinkReport::default()
                        },
                    );
                    // Retrying a wrong PIN would only lock this host out of the primary.
                    return;
                }
                Err(LinkError::Failed(message)) => {
                    update_report(shared, |report| {
                        report.status = BackupLinkStatus::Unreachable;
                        report.error = Some(message);
                    });
                    tokio::time::sleep(RETRY_INTERVAL).await;
                }
            }
        }
    }

    let cookie = token.map(|token| format!("{}={token}", pairing_cookie_name(&target.address)));
    let mut loaded_revision: Option<String> = None;
    let mut next_revision_check = Instant::now();
    loop {
        if Instant::now() >= next_revision_check {
            let wait = check_revision(
                &client,
                &base,
                cookie.as_deref(),
                &mut loaded_revision,
                shared,
            )
            .await;
            next_revision_check = Instant::now() + wait;
        }
        if loaded_revision.is_some() {
            let requested_at = Instant::now();
            match fetch_live_state(&client, &base, cookie.as_deref()).await {
                Ok((snapshot, primary_wait)) => {
                    let round_trip = requested_at.elapsed().saturating_sub(primary_wait);
                    if let Ok(mut shared) = shared.lock() {
                        shared.checkpoint = Some(LiveCheckpoint {
                            sequence: CHECKPOINT_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
                            snapshot,
                            received_at: Instant::now(),
                            transit: round_trip / 2,
                        });
                    }
                }
                Err(error) => {
                    tracing::debug!(?error, "backup_live_state_fetch_failed");
                }
            }
        }
        tokio::time::sleep(CHECKPOINT_INTERVAL).await;
    }
}

/// Checks the primary's show revision, copying the show when it changed, records the outcome in
/// the link report, and returns how long to wait before the next check.
async fn check_revision(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
    loaded_revision: &mut Option<String>,
    shared: &Mutex<LinkShared>,
) -> Duration {
    match sync_once(client, base, cookie, loaded_revision).await {
        Ok(Some((revision, show, unpacked))) => {
            *loaded_revision = Some(revision.revision);
            if let Ok(mut shared) = shared.lock() {
                shared.mirror = Some(show);
                shared.unpacked = Some(unpacked);
                shared.report = LinkReport {
                    status: BackupLinkStatus::Synced,
                    error: None,
                    showfile_name: revision.showfile_name,
                    synced_at_ms: Some(now_ms()),
                };
            }
            POLL_INTERVAL
        }
        Ok(None) => {
            update_report(shared, |report| {
                report.status = BackupLinkStatus::Synced;
                report.error = None;
            });
            POLL_INTERVAL
        }
        Err(LinkError::Unauthorized(message)) => {
            update_report(shared, |report| {
                report.status = BackupLinkStatus::PairingRequired;
                report.error = Some(message);
            });
            RETRY_INTERVAL
        }
        Err(LinkError::Failed(message)) => {
            update_report(shared, |report| {
                report.status = BackupLinkStatus::Unreachable;
                report.error = Some(message);
            });
            RETRY_INTERVAL
        }
    }
}

/// Asks the primary for a checkpoint of its live state, returning it with how long the primary
/// waited for its engine before capturing it.
async fn fetch_live_state(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
) -> Result<(LiveStateSnapshot, Duration), LinkError> {
    let mut request = client.get(format!("{base}{LIVE_STATE_PATH}"));
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    let response = check_status(response).await?;
    let primary_wait = response
        .headers()
        .get(LIVE_STATE_WAIT_HEADER)
        .and_then(|value| value.to_str().ok()?.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or_default();
    let body = response
        .bytes()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    let snapshot = serde_json::from_slice(&body).map_err(|error| {
        LinkError::Failed(format!(
            "The primary sent live state this version cannot read: {error}"
        ))
    })?;
    Ok((snapshot, primary_wait))
}

/// Checks the primary's revision and, when it differs from the loaded one, downloads and unpacks
/// the show. Returns `None` when the backup is already up to date.
async fn sync_once(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
    loaded_revision: &Option<String>,
) -> Result<Option<(ShowfileRevision, MirroredShow, tempfile::TempDir)>, LinkError> {
    let revision = fetch_revision(client, base, cookie).await?;
    if loaded_revision.as_ref() == Some(&revision.revision) {
        return Ok(None);
    }
    let archive = download_show(client, base, cookie, revision.showfile_name.as_deref()).await?;
    let (unpacked, directory) = tokio::task::spawn_blocking(move || unpack_show(archive.path()))
        .await
        .map_err(|error| LinkError::Failed(error.to_string()))?
        .map_err(LinkError::Failed)?;
    tracing::info!(
        showfile = ?revision.showfile_name,
        revision = %revision.revision,
        "Copied the primary's show"
    );
    let show = MirroredShow {
        showfile_name: revision.showfile_name.clone(),
        directory,
    };
    Ok(Some((revision, show, unpacked)))
}

/// Submits the PIN and returns the pairing token from the primary's cookie.
async fn pair(
    client: &reqwest::Client,
    base: &str,
    address: &str,
    pin: &str,
) -> Result<String, LinkError> {
    let response = client
        .post(format!("{base}{PAIRING_PATH}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "pin": pin }).to_string())
        .send()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::TOO_MANY_REQUESTS {
        let message = response.text().await.unwrap_or_default();
        return Err(LinkError::Unauthorized(non_empty_or(
            message,
            "The primary rejected the pairing PIN.",
        )));
    }
    if !status.is_success() {
        return Err(LinkError::Failed(format!(
            "The primary answered pairing with {status}."
        )));
    }
    let cookie_name = pairing_cookie_name(address);
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| cookie_value(value, &cookie_name))
        .ok_or_else(|| LinkError::Failed("The primary did not return a pairing token.".into()))
}

/// Extracts a cookie's value from one `Set-Cookie` header.
fn cookie_value(set_cookie: &str, name: &str) -> Option<String> {
    let (cookie_name, rest) = set_cookie.split_once('=')?;
    if cookie_name.trim() != name {
        return None;
    }
    Some(
        rest.split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_string(),
    )
}

/// Saves a fresh pairing token, unless the operator changed primaries in the meantime.
fn store_token(address: &str, token: &str) {
    let path = preferences::preferences_path();
    let (mut stored, _) = preferences::load(path.as_deref());
    if stored.primary_address.as_deref() != Some(address) {
        return;
    }
    stored.pairing_token = Some(token.to_string());
    if let Err(error) = preferences::save(path.as_deref(), &stored) {
        tracing::warn!(%error, "Could not save the backup pairing token");
    }
}

/// Asks the primary for the revision of its live show.
async fn fetch_revision(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
) -> Result<ShowfileRevision, LinkError> {
    let mut request = client.get(format!("{base}{SHOWFILE_REVISION_PATH}"));
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    let response = check_status(response).await?;
    let body = response
        .bytes()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    serde_json::from_slice(&body).map_err(|error| {
        LinkError::Failed(format!(
            "The primary sent a revision this version cannot read: {error}"
        ))
    })
}

/// Downloads the primary's live show as an archive into a temporary file.
async fn download_show(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
    showfile_name: Option<&str>,
) -> Result<tempfile::NamedTempFile, LinkError> {
    // The backup may run on another computer, so assets the show references from outside its
    // folder travel with it.
    let body = serde_json::json!({
        "name": showfile_name.unwrap_or("default"),
        "policy": "allReferences",
    });
    let mut request = client
        .post(format!("{base}{SHOWFILE_EXPORT_PATH}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.to_string());
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    let mut response = check_status(response).await?;
    let live = response
        .headers()
        .get(EXPORT_SOURCE_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(EXPORT_SOURCE_LIVE);
    if !live {
        // A stored fallback can be older than the stage; loading it under the live revision
        // would hide that until the primary's next edit.
        return Err(LinkError::Failed(
            "The primary could not export its live show; trying again.".into(),
        ));
    }
    let mut archive = tempfile::NamedTempFile::new()
        .map_err(|error| LinkError::Failed(format!("Could not store the show: {error}")))?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| LinkError::from_request(&error))?
    {
        archive
            .write_all(&chunk)
            .map_err(|error| LinkError::Failed(format!("Could not store the show: {error}")))?;
    }
    Ok(archive)
}

/// Maps the primary's refusals onto link errors, passing successful responses through.
async fn check_status(response: reqwest::Response) -> Result<reqwest::Response, LinkError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let message = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED {
        return Err(LinkError::Unauthorized(non_empty_or(
            message,
            "The primary asks this backup to pair again.",
        )));
    }
    Err(LinkError::Failed(non_empty_or(
        message,
        &format!("The primary answered with {status}."),
    )))
}

/// Returns `message`, or `fallback` when the primary sent no text.
fn non_empty_or(message: String, fallback: &str) -> String {
    if message.trim().is_empty() {
        fallback.to_string()
    } else {
        message
    }
}

/// Returns the folder that holds unpacked copies of the primary's show.
fn mirror_root() -> Option<PathBuf> {
    nightfall::nightfall_data_dir().map(|data_dir| data_dir.join(MIRROR_DIR_NAME))
}

/// Deletes copies a previous run left behind; the process keeps its newest copy in a static that
/// is never dropped, so none is removed at exit.
fn remove_stale_mirrors() {
    let Some(root) = mirror_root() else {
        return;
    };
    match std::fs::remove_dir_all(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(%error, path = %root.display(), "Could not remove old backup copies");
        }
    }
}

/// Unpacks a downloaded show archive and returns the directory holding the show folder.
pub(crate) fn unpack_show(archive: &Path) -> Result<(tempfile::TempDir, PathBuf), String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| format!("The primary sent an unreadable show: {error}"))?;
    let unpacked = match mirror_root() {
        Some(root) => {
            std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
            tempfile::tempdir_in(root)
        }
        None => tempfile::tempdir(),
    }
    .map_err(|error| format!("Could not unpack the show: {error}"))?;
    zip.extract(unpacked.path())
        .map_err(|error| format!("Could not unpack the show: {error}"))?;
    let directory = std::fs::read_dir(unpacked.path())
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .find(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .ok_or("The primary sent a show archive without a show folder.")?;
    Ok((unpacked, directory))
}

/// Returns the current Unix time in milliseconds.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pairing token is read only from the cookie named for the primary's port.
    #[test]
    fn reads_the_pairing_cookie_for_the_primary_port() {
        let name = pairing_cookie_name("192.0.2.10:3000");
        assert_eq!(name, "nightfall_pairing_3000");
        assert_eq!(
            cookie_value(
                "nightfall_pairing_3000=abc; Path=/; HttpOnly; SameSite=Strict",
                &name
            ),
            Some("abc".to_string())
        );
        assert_eq!(
            cookie_value("nightfall_pairing_4000=abc; Path=/", &name),
            None
        );
    }

    /// Restating the stored primary keeps the connection, while a new PIN or another primary
    /// restarts it.
    #[test]
    fn restating_the_same_primary_keeps_the_link() {
        let (target, mut target_rx) = watch::channel(None);
        let link = BackupLink {
            target,
            shared: Arc::default(),
        };
        let stored = LinkTarget {
            address: "192.0.2.10:3000".into(),
            pin: None,
            token: Some("token".into()),
        };
        link.set_target(Some(stored.clone()));
        assert!(target_rx.has_changed().unwrap());
        target_rx.borrow_and_update();

        link.set_target(Some(stored.clone()));
        assert!(!target_rx.has_changed().unwrap());

        link.set_target(Some(LinkTarget {
            pin: Some("123456".into()),
            ..stored.clone()
        }));
        assert!(target_rx.has_changed().unwrap());
        target_rx.borrow_and_update();

        link.set_target(None);
        assert!(target_rx.has_changed().unwrap());
    }

    /// An archive in the primary's export layout unpacks to its show folder.
    #[test]
    fn unpacks_the_show_folder() {
        let archive = tempfile::NamedTempFile::new().unwrap();
        {
            let mut zip = zip::ZipWriter::new(archive.reopen().unwrap());
            zip.add_directory(
                "live.nightfall-show/",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.start_file(
                "live.nightfall-show/showfile.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }

        let (unpacked, directory) = unpack_show(archive.path()).unwrap();
        assert!(directory.starts_with(unpacked.path()));
        assert_eq!(directory.file_name().unwrap(), "live.nightfall-show");
        assert_eq!(
            std::fs::read_to_string(directory.join("showfile.json")).unwrap(),
            "{}"
        );
    }
}
