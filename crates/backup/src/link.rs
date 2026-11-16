// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The process-lifetime connection a backup keeps to its primary.
//!
//! A worker thread pairs with the primary, polls the revision of its live show, and downloads
//! and stores it in the failover folder whenever the revision changes. The world picks up each
//! stored show and loads it. The link outlives world swaps, which the backup itself causes on
//! every load.
//!
//! Alongside, the worker sends the primary a heartbeat, which tells the world when the primary
//! went silent. While the host follows no one, the worker instead checks whether the backup that
//! last followed it took over meanwhile.

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
    BackupLinkStatus, EXPORT_SOURCE_HEADER, EXPORT_SOURCE_LIVE, FORWARDED_COMMANDS_PATH,
    LIVE_STATE_PATH, LIVE_STATE_WAIT_HEADER, PAIRING_PATH, SHOWFILE_EXPORT_PATH,
    SHOWFILE_REVISION_PATH, ShowfileRevision,
    failover::{
        self, BACKUP_PORT_HEADER, HEARTBEAT_INTERVAL, HOST_STATUS_PATH, HostStatus,
        PEER_CHECK_INTERVAL, STATUS_TIMEOUT,
    },
    forwarding::{ForwardCursor, ForwardedBatch, commands_through},
};

/// Time between revision checks while the link is healthy.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Time between live state checkpoints once the backup holds the primary's show.
const CHECKPOINT_INTERVAL: Duration = Duration::from_millis(500);

/// Longest a copied show counts as loading. A load that fails leaves the current world in place,
/// so no new world ends the wait; after this the link reports its plain status again.
const MIRROR_LOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// Longest a request for forwarded commands may take: the primary holds it open for up to
/// [`crate::FORWARDED_WAIT`] while nothing happens.
const FORWARDED_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Time between looks for a checkpoint to start reading forwarded commands from.
const CURSOR_START_POLL: Duration = Duration::from_millis(100);

/// Forwarded entries the link holds for a world that is not taking them, before it gives up on
/// replaying them.
const MAX_QUEUED_FORWARDED: usize = 4096;

/// Sequence of the newest checkpoint received, shared by every primary this process follows, so
/// a world that applied a checkpoint from an earlier link never mistakes a new one for stale.
static CHECKPOINT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Time before retrying a primary that could not be reached.
const RETRY_INTERVAL: Duration = Duration::from_secs(3);

/// Upper bound for a single request, including a show download.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Upper bound for each request that checks a primary before following it, so an address that
/// never answers fails while the operator still waits on the form.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Folder in the failover folder where a show from the primary is unpacked before it is stored.
const INCOMING_DIR_NAME: &str = ".incoming";

/// Suffix of a show folder.
const SHOW_FOLDER_SUFFIX: &str = ".nightfall-show";

/// Name of the primary's pairing cookie, which carries its port.
fn pairing_cookie_name(address: &str) -> String {
    let port = address.rsplit_once(':').map_or("", |(_, port)| port);
    format!("nightfall_pairing_{port}")
}

/// The primary a backup follows and how it authenticates there. Pairing with a PIN happens
/// before a host follows, in [`BackupLink::probe`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinkTarget {
    /// `host:port` of the primary.
    pub address: String,
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

/// A show copied from the primary into the failover folder, ready for the world to load.
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

/// How long the primary has been silent, for a world deciding whether to take over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrimarySilence {
    /// Time since the primary last answered a heartbeat.
    pub silent_for: Duration,
    /// The primary's last heartbeat answer.
    pub primary: HostStatus,
}

/// State the worker shares with the world.
#[derive(Debug, Default)]
struct LinkShared {
    /// When the primary last answered a heartbeat, and with what.
    heartbeat: Option<(Instant, HostStatus)>,
    /// How long the primary's last heartbeat answer took.
    primary_latency: Option<Duration>,
    /// Whether the primary answered that it left the pair, until the world takes it.
    primary_left: bool,
    /// The backup that last followed this host, found running as a newer primary, with its epoch.
    rejoin: Option<(String, u64)>,
    /// Whether the check for a backup that took over finished at least once in this process.
    peer_checked: bool,
    /// The backup last checked and what the check found.
    peer_check: Option<(String, failover::PeerCheck)>,
    /// How long the backup last checked took to answer, if it answered.
    peer_latency: Option<Duration>,
    /// Number of the newest probe of a primary before following it; a probe whose number is no
    /// longer this one was replaced or cancelled, and its outcome is dropped.
    probe_generation: u64,
    /// The number of the last finished probe, and the pairing token it got or why the primary
    /// cannot be followed.
    probe: Option<(u64, Result<Option<String>, String>)>,
    report: LinkReport,
    mirror: Option<MirroredShow>,
    checkpoint: Option<LiveCheckpoint>,
    /// Forwarded commands the world has not taken yet, oldest first.
    forwarded: Vec<ForwardedBatch>,
    /// When the world took the newest copied show to load, until a world with it starts.
    loading_since: Option<Instant>,
    /// Whether forwarded commands are held back while a checkpoint is requested.
    holding: bool,
}

impl LinkShared {
    /// Queues a forwarded batch for the world. When the world has stopped taking them, as while
    /// it loads a show, the oldest are replaced by a gap, so the world waits for a checkpoint
    /// rather than replaying a partial history.
    fn queue_forwarded(&mut self, batch: ForwardedBatch) {
        self.forwarded.push(batch);
        let queued: usize = self.forwarded.iter().map(|batch| batch.entries.len()).sum();
        if queued > MAX_QUEUED_FORWARDED
            && let Some(newest) = self.forwarded.pop()
        {
            self.forwarded.clear();
            self.forwarded.push(ForwardedBatch {
                entries: Vec::new(),
                gap: true,
                ..newest
            });
        }
    }
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
                    current.address != next.address || current.token != next.token
                }
                (None, None) => false,
                _ => true,
            };
            if changed {
                *current = target;
                if let Ok(mut shared) = self.shared.lock() {
                    shared.mirror = None;
                    shared.checkpoint = None;
                    shared.forwarded.clear();
                    shared.loading_since = None;
                    shared.holding = false;
                    shared.heartbeat = None;
                    shared.primary_latency = None;
                    shared.primary_left = false;
                    shared.rejoin = None;
                    shared.report = LinkReport::default();
                }
            }
            changed
        });
    }

    /// Returns the latest link progress.
    ///
    /// While a copied show is still loading, a link in step reports [`BackupLinkStatus::Loading`]
    /// instead, so the backup is not called in step before it holds the show.
    pub(crate) fn report(&self) -> LinkReport {
        let Ok(shared) = self.shared.lock() else {
            return LinkReport::default();
        };
        let mut report = shared.report.clone();
        let loading = shared
            .loading_since
            .is_some_and(|since| since.elapsed() < MIRROR_LOAD_TIMEOUT);
        if loading && report.status == BackupLinkStatus::Synced {
            report.status = BackupLinkStatus::Loading;
        }
        // A primary waiting at startup for a show answers, but has nothing to copy yet.
        let waiting_for_show = shared
            .heartbeat
            .as_ref()
            .is_some_and(|(heard_at, primary)| {
                !primary.show_open && heard_at.elapsed() < failover::FAILOVER_TIMEOUT
            });
        if waiting_for_show
            && matches!(
                report.status,
                BackupLinkStatus::Connecting | BackupLinkStatus::Unreachable
            )
        {
            report.status = BackupLinkStatus::WaitingForShow;
            report.error = None;
        }
        report
    }

    /// Takes the show copied since the previous call, if any, and counts it as loading until
    /// [`Self::finish_mirror_load`].
    pub(crate) fn take_mirror(&self) -> Option<MirroredShow> {
        let mut shared = self.shared.lock().ok()?;
        let mirror = shared.mirror.take()?;
        shared.loading_since = Some(Instant::now());
        Some(mirror)
    }

    /// Records that a new world started, which ends any copied show's load.
    pub(crate) fn finish_mirror_load(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.loading_since = None;
        }
    }

    /// Takes the commands forwarded since the previous call, oldest first, or none while a
    /// checkpoint is being requested.
    pub(crate) fn take_forwarded(&self) -> Vec<ForwardedBatch> {
        self.shared
            .lock()
            .ok()
            .filter(|shared| !shared.holding)
            .map(|mut shared| std::mem::take(&mut shared.forwarded))
            .unwrap_or_default()
    }

    /// Returns how long the primary has been silent, once the link heard from it and holds a
    /// loaded copy of its show; before that a takeover would have nothing to output.
    pub(crate) fn primary_silence(&self) -> Option<PrimarySilence> {
        let shared = self.shared.lock().ok()?;
        let loading = shared
            .loading_since
            .is_some_and(|since| since.elapsed() < MIRROR_LOAD_TIMEOUT);
        if loading || shared.report.synced_at_ms.is_none() {
            return None;
        }
        let (heard_at, primary) = shared.heartbeat.as_ref()?;
        Some(PrimarySilence {
            silent_for: heard_at.elapsed(),
            primary: primary.clone(),
        })
    }

    /// Returns how long the primary took to answer its last heartbeat, while it still answers.
    pub(crate) fn primary_latency(&self) -> Option<Duration> {
        let shared = self.shared.lock().ok()?;
        let (heard_at, _) = shared.heartbeat.as_ref()?;
        (heard_at.elapsed() < failover::FAILOVER_TIMEOUT)
            .then_some(shared.primary_latency)
            .flatten()
    }

    /// Returns how long the backup at `address` took to answer its last check, if it answered.
    pub(crate) fn peer_latency(&self, address: &str) -> Option<Duration> {
        let shared = self.shared.lock().ok()?;
        shared
            .peer_check
            .as_ref()
            .filter(|(checked, _)| checked == address)
            .and(shared.peer_latency)
    }

    /// Takes whether the primary answered that it left the pair.
    pub(crate) fn take_primary_left(&self) -> bool {
        self.shared
            .lock()
            .is_ok_and(|mut shared| std::mem::take(&mut shared.primary_left))
    }

    /// Returns the epoch the primary last reported.
    pub(crate) fn primary_epoch(&self) -> Option<u64> {
        let shared = self.shared.lock().ok()?;
        shared.heartbeat.as_ref().map(|(_, status)| status.epoch)
    }

    /// Returns what the last check of the backup at `address` found, if it was checked.
    pub(crate) fn peer_check(&self, address: &str) -> Option<failover::PeerCheck> {
        let shared = self.shared.lock().ok()?;
        shared
            .peer_check
            .as_ref()
            .filter(|(checked, _)| checked == address)
            .map(|(_, check)| *check)
    }

    /// Takes the backup found running as a newer primary, with its epoch, if any.
    pub(crate) fn take_rejoin(&self) -> Option<(String, u64)> {
        self.shared.lock().ok()?.rejoin.take()
    }

    /// Rejoins as the backup of `address`, which took over with `epoch` and asked this host to
    /// step down.
    pub(crate) fn request_rejoin(&self, address: String, epoch: u64) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.rejoin = Some((address, epoch));
        }
    }

    /// Checks on a separate thread that the host at `address` is a primary this host can follow,
    /// pairing with `pin` when given, and returns the probe's number. [`Self::take_probe`]
    /// returns the outcome; a newer probe or [`Self::cancel_probe`] drops this one.
    pub(crate) fn probe(&self, address: String, pin: Option<String>) -> u64 {
        let generation = {
            let mut shared = self
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            shared.probe_generation += 1;
            shared.probe = None;
            shared.probe_generation
        };
        let shared = Arc::clone(&self.shared);
        let spawned = std::thread::Builder::new()
            .name("backup-probe".into())
            .spawn(move || {
                let result = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime.block_on(probe_primary(&address, pin.as_deref())),
                    Err(error) => Err(format!("Could not reach the primary: {error}")),
                };
                finish_probe(&shared, generation, result);
            });
        if let Err(error) = spawned {
            tracing::error!(%error, "Could not start checking the primary");
            finish_probe(
                &self.shared,
                generation,
                Err(format!("Could not start checking the primary: {error}")),
            );
        }
        generation
    }

    /// Tells the primary at `address` that this host, its backup, left the pair, so it forgets
    /// this host straight away. Runs in the background and only logs a failure: a primary that
    /// misses the notice still sees this host is no longer following it.
    pub(crate) fn tell_primary_of_leave(&self, address: String, key: String) {
        let Some(port) = failover::own_port() else {
            tracing::debug!("No own port to tell the primary this host left the pair with");
            return;
        };
        let spawned = std::thread::Builder::new()
            .name("backup-leave".into())
            .spawn(move || {
                match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime.block_on(send_leave_notice(&address, port, key)),
                    Err(error) => {
                        tracing::warn!(%error, "Could not tell the primary this host left")
                    }
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "Could not tell the primary this host left");
        }
    }

    /// Takes the outcome of probe `generation` once it finished: the pairing token to follow the
    /// primary with, or why it cannot be followed.
    pub(crate) fn take_probe(&self, generation: u64) -> Option<Result<Option<String>, String>> {
        let mut shared = self.shared.lock().ok()?;
        if shared.probe.as_ref()?.0 != generation {
            return None;
        }
        shared.probe.take().map(|(_, result)| result)
    }

    /// Ends the running probe, if any, with `reason` as its outcome, so the follow it was for
    /// fails instead of starting after the operator moved on.
    pub(crate) fn cancel_probe(&self, reason: &str) {
        if let Ok(mut shared) = self.shared.lock() {
            let generation = shared.probe_generation;
            shared.probe_generation += 1;
            shared.probe = Some((generation, Err(reason.to_string())));
        }
    }

    /// Counts the check for a backup that took over as done, so output is not held for it.
    pub(crate) fn mark_peer_checked(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.peer_checked = true;
        }
    }

    /// Returns whether the check for a backup that took over finished at least once and left no
    /// rejoin for the world to apply, so output may start.
    pub(crate) fn peer_checked(&self) -> bool {
        self.shared
            .lock()
            .is_ok_and(|shared| shared.peer_checked && shared.rejoin.is_none())
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

/// Runs the worker: follows each target until it changes, and watches the host's backup while
/// there is none.
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
                    tokio::select! {
                        () = watch_backup_peer(&shared) => {}
                        changed = target_rx.changed() => {
                            if changed.is_err() {
                                return;
                            }
                        }
                    }
                }
                Some(target) => {
                    tokio::select! {
                        () = follow(&target, &shared) => {}
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

/// Returns an HTTP client for talking to other Nightfall hosts, bypassing any system proxy.
fn host_client(timeout: Duration) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
}

/// Checks the backup that last followed this host, while this host runs as a primary, and
/// queues a rejoin when the backup took over since. Never returns.
///
/// Each check counts as done whether or not the backup answered, so a host whose backup is
/// switched off is not held back.
async fn watch_backup_peer(shared: &Mutex<LinkShared>) {
    let client = match host_client(STATUS_TIMEOUT) {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "Could not start checking this host's backup");
            if let Ok(mut shared) = shared.lock() {
                shared.peer_checked = true;
            }
            return std::future::pending().await;
        }
    };
    loop {
        let own = failover::host_status();
        let mut rejoin = None;
        let mut check = None;
        let mut latency = None;
        if let Some(peer) = failover::backup_peer().filter(|_| !own.following) {
            let base = format!("http://{peer}");
            let sent_at = Instant::now();
            let answer = fetch_host_status(&client, &base, "this host's backup").await;
            if answer.is_ok() {
                latency = Some(sent_at.elapsed());
            }
            let found = match answer {
                Ok(status) if failover::should_rejoin(own.epoch, &status) => {
                    tracing::warn!(
                        %peer,
                        epoch = status.epoch,
                        "This host's backup took over; rejoining as its backup"
                    );
                    rejoin = Some((peer.clone(), status.epoch));
                    failover::PeerCheck::Primary
                }
                Ok(status) if status.following => failover::PeerCheck::Following,
                Ok(status) => {
                    if failover::should_ask_to_step_down(own.epoch, &status) {
                        ask_to_step_down(&client, &base, &peer, own.epoch).await;
                    }
                    if status.show_open {
                        failover::PeerCheck::Primary
                    } else {
                        failover::PeerCheck::Idle
                    }
                }
                Err(error) => {
                    tracing::debug!(?error, %peer, "backup_peer_check_failed");
                    failover::PeerCheck::Unreachable
                }
            };
            check = Some((peer, found));
        }
        // One lock, so the world never sees the check done without the rejoin it found.
        if let Ok(mut shared) = shared.lock() {
            if rejoin.is_some() {
                shared.rejoin = rejoin;
            }
            shared.peer_check = check;
            shared.peer_latency = latency;
            shared.peer_checked = true;
        }
        tokio::time::sleep(PEER_CHECK_INTERVAL).await;
    }
}

/// Asks the primary this host replaced, at `base`, to step down and follow this host, so it goes
/// silent even when it cannot reach this host to find out on its own. The request carries the key
/// the two share, which that host checks.
async fn ask_to_step_down(client: &reqwest::Client, base: &str, peer: &str, epoch: u64) {
    let (Some(port), Some(key)) = (failover::own_port(), failover::pair_key()) else {
        tracing::debug!(%peer, "No pair key to ask the replaced primary to step down with");
        return;
    };
    let request = client
        .post(format!("{base}{}", failover::STEP_DOWN_PATH))
        .header(header::CONTENT_TYPE, "application/json")
        .body(
            serde_json::to_string(&failover::StepDownRequest { epoch, port, key })
                .unwrap_or_default(),
        );
    match request.send().await {
        Ok(response) if response.status().is_success() => {
            tracing::info!(%peer, "Asked the replaced primary to step down");
        }
        Ok(response) => {
            // Repeats every check while that host refuses, so it stays out of the warnings.
            tracing::debug!(%peer, status = %response.status(), "The replaced primary refused to step down");
        }
        Err(error) => tracing::debug!(%error, %peer, "step_down_request_failed"),
    }
}

/// Sends the primary at `address` the notice that this host, listening on `port`, left the pair,
/// with the `key` the two shared.
async fn send_leave_notice(address: &str, port: u16, key: String) {
    let client = match host_client(STATUS_TIMEOUT) {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, %address, "Could not tell the primary this host left");
            return;
        }
    };
    let body = serde_json::to_string(&failover::LeaveRequest { port, key }).unwrap_or_default();
    for attempt in 1..=LEAVE_NOTICE_ATTEMPTS {
        let request = client
            .post(format!("http://{address}{}", failover::LEAVE_PATH))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.clone());
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                tracing::info!(%address, "Told the primary this host left the pair");
                return;
            }
            // A refusal will not change on a retry.
            Ok(response) => {
                tracing::warn!(%address, status = %response.status(), "The primary refused the leave notice");
                return;
            }
            Err(error) if attempt == LEAVE_NOTICE_ATTEMPTS => {
                tracing::warn!(%error, %address, "Could not tell the primary this host left");
            }
            Err(error) => {
                tracing::debug!(%error, %address, attempt, "leave_notice_failed");
                tokio::time::sleep(PEER_CHECK_INTERVAL).await;
            }
        }
    }
}

/// How many times a backup that leaves tries to tell its primary before giving up.
const LEAVE_NOTICE_ATTEMPTS: u32 = 5;

/// Records the outcome of probe `generation`, unless a newer probe or a cancel replaced it.
fn finish_probe(
    shared: &Mutex<LinkShared>,
    generation: u64,
    result: Result<Option<String>, String>,
) {
    if let Ok(mut shared) = shared.lock()
        && shared.probe_generation == generation
    {
        shared.probe = Some((generation, result));
    }
}

/// Checks that the host at `address` is a primary this host can follow: it answers, it does not
/// follow another host, and it shares a pair key, after pairing with `pin` when given, or with
/// the key this host shares with its backup when `address` is that backup. Returns the new key, or why the host
/// cannot be followed.
async fn probe_primary(address: &str, pin: Option<&str>) -> Result<Option<String>, String> {
    let client = host_client(PROBE_TIMEOUT)
        .map_err(|error| format!("Could not reach the primary: {error}"))?;
    let base = format!("http://{address}");
    let status = fetch_host_status(&client, &base, address)
        .await
        .map_err(|error| match error {
            LinkError::Unauthorized(message) | LinkError::Failed(message) => format!(
                "{message} Check the address, and that External control is on at {address}."
            ),
        })?;
    if status.following {
        return Err(format!(
            "{address} is a backup itself. Follow its primary instead."
        ));
    }
    let token = match pin {
        Some(pin) => Some(pair(&client, &base, address, pin).await.map_err(
            |error| match error {
                LinkError::Unauthorized(message) | LinkError::Failed(message) => message,
            },
        )?),
        // This host's backup accepts the key the two share, so following it needs no PIN. The
        // key goes to no other host, since it also pairs a device with this host.
        None if failover::backup_peer().as_deref() == Some(address) => failover::pair_key(),
        None => None,
    };
    let cookie = token
        .as_ref()
        .map(|token| format!("{}={token}", pairing_cookie_name(address)));
    match request_pair_key(&client, &base, address, cookie.as_deref()).await {
        Ok(key) => Ok(Some(key)),
        Err(LinkError::Unauthorized(_)) => Err(format!("{address} needs its pairing PIN.")),
        Err(LinkError::Failed(message)) => Err(message),
    }
}

/// Asks the primary at `base`, called `host` in errors, for the key it will share with this host,
/// which this host then sends instead of a pairing token so the two stay paired across restarts.
async fn request_pair_key(
    client: &reqwest::Client,
    base: &str,
    host: &str,
    cookie: Option<&str>,
) -> Result<String, LinkError> {
    let mut request = client.post(format!("{base}{}", failover::PAIR_KEY_PATH));
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| LinkError::from_request_to(&error, host))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED {
        return Err(LinkError::Unauthorized(text));
    }
    if !status.is_success() || text.trim().is_empty() {
        return Err(LinkError::Failed(non_empty_or(
            text,
            "The primary did not share a pair key.",
        )));
    }
    Ok(text.trim().to_string())
}

/// Asks the host at `base`, called `host` in errors, for its role and epoch.
async fn fetch_host_status(
    client: &reqwest::Client,
    base: &str,
    host: &str,
) -> Result<HostStatus, LinkError> {
    let response = client
        .get(format!("{base}{HOST_STATUS_PATH}"))
        .send()
        .await
        .map_err(|error| LinkError::from_request_to(&error, host))?;
    let body = check_status(response)
        .await?
        .bytes()
        .await
        .map_err(|error| LinkError::from_request_to(&error, host))?;
    serde_json::from_slice(&body).map_err(|error| {
        LinkError::Failed(format!(
            "The host sent a status this version cannot read: {error}"
        ))
    })
}

/// Sends the primary a heartbeat every [`HEARTBEAT_INTERVAL`] and records each answer, so the
/// world can tell when the primary went silent. Never returns.
async fn follow_heartbeat(base: &str, shared: &Mutex<LinkShared>) {
    let Ok(client) = host_client(STATUS_TIMEOUT) else {
        return std::future::pending().await;
    };
    loop {
        let sent_at = Instant::now();
        match fetch_host_status(&client, base, "the primary").await {
            Ok(status) => {
                if let Ok(mut shared) = shared.lock() {
                    shared.heartbeat = Some((Instant::now(), status));
                    shared.primary_latency = Some(sent_at.elapsed());
                }
            }
            Err(error) => tracing::debug!(?error, "backup_heartbeat_failed"),
        }
        tokio::time::sleep(HEARTBEAT_INTERVAL).await;
    }
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
    /// Describes a transport failure talking to the primary without exposing request internals.
    fn from_request(error: &reqwest::Error) -> Self {
        Self::from_request_to(error, "the primary")
    }

    /// Describes a transport failure talking to `host`, such as "the primary" or an address,
    /// without exposing request internals.
    fn from_request_to(error: &reqwest::Error, host: &str) -> Self {
        let message = if error.is_timeout() {
            format!("No answer from {host} in time.")
        } else if error.is_connect() {
            format!("Could not connect to {host}.")
        } else {
            format!("Request to {host} failed: {error}")
        };
        Self::Failed(message)
    }
}

/// Sends the primary heartbeats while keeping the backup's copy of its show in step, until the
/// caller drops it for a new target.
async fn follow(target: &LinkTarget, shared: &Mutex<LinkShared>) {
    let base = format!("http://{}", target.address);
    tokio::join!(
        follow_heartbeat(&base, shared),
        follow_with_token(target, &base, shared),
    );
}

/// Follows the primary's show, checkpoints and commands with the target's pairing token. Never
/// returns.
async fn follow_with_token(target: &LinkTarget, base: &str, shared: &Mutex<LinkShared>) {
    let client = match host_client(REQUEST_TIMEOUT) {
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
    set_report(
        shared,
        LinkReport {
            status: BackupLinkStatus::Connecting,
            ..LinkReport::default()
        },
    );

    let cookie = target
        .token
        .as_ref()
        .map(|token| format!("{}={token}", pairing_cookie_name(&target.address)));
    tokio::join!(
        follow_show_and_checkpoints(&client, base, cookie.as_deref(), shared),
        follow_commands(&client, base, cookie.as_deref(), shared),
    );
}

/// Keeps the backup's copy of the show in step with the primary's revisions and fetches live
/// state checkpoints while a show is loaded. Never returns.
async fn follow_show_and_checkpoints(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
    shared: &Mutex<LinkShared>,
) {
    let mut loaded_revision: Option<String> = None;
    let mut next_revision_check = Instant::now();
    loop {
        if Instant::now() >= next_revision_check {
            let wait = check_revision(client, base, cookie, &mut loaded_revision, shared).await;
            next_revision_check = Instant::now() + wait;
        }
        if loaded_revision.is_some() {
            // Forwarded commands wait while the checkpoint is requested, so every one the world
            // replays was recorded before the primary captured it: the checkpoint is never older
            // than what the world already applied.
            set_holding(shared, true);
            let requested_at = Instant::now();
            let fetched = fetch_live_state(client, base, cookie).await;
            if let Ok(mut shared) = shared.lock() {
                shared.holding = false;
                match fetched {
                    Ok(LiveStateAnswer::LeftPair) => shared.primary_left = true,
                    Ok(LiveStateAnswer::Checkpoint(snapshot, primary_wait)) => {
                        if shared.report.status == BackupLinkStatus::PairingRequired {
                            shared.report.status = BackupLinkStatus::Synced;
                            shared.report.error = None;
                        }
                        let round_trip = requested_at.elapsed().saturating_sub(primary_wait);
                        shared.checkpoint = Some(LiveCheckpoint {
                            sequence: CHECKPOINT_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
                            snapshot,
                            received_at: Instant::now(),
                            transit: round_trip / 2,
                        });
                    }
                    // The show itself may still be readable, as on the same computer where
                    // pairing is skipped, but without checkpoints this host is not in step.
                    Err(LinkError::Unauthorized(message)) => {
                        shared.report.status = BackupLinkStatus::PairingRequired;
                        shared.report.error = Some(message);
                    }
                    Err(error) => {
                        tracing::debug!(?error, "backup_live_state_fetch_failed");
                    }
                }
            }
        }
        tokio::time::sleep(CHECKPOINT_INTERVAL).await;
    }
}

/// Holds forwarded commands back from the world, or releases them.
fn set_holding(shared: &Mutex<LinkShared>, holding: bool) {
    if let Ok(mut shared) = shared.lock() {
        shared.holding = holding;
    }
}

/// Returns where to start reading forwarded commands: just after the commands the newest
/// checkpoint reflects, when it is newer than `used`, the checkpoint an earlier start came from.
fn start_cursor(shared: &Mutex<LinkShared>, used: Option<u64>) -> Option<(u64, ForwardCursor)> {
    let shared = shared.lock().ok()?;
    let checkpoint = shared.checkpoint.as_ref()?;
    if used >= Some(checkpoint.sequence) {
        return None;
    }
    let through = commands_through(&checkpoint.snapshot)?;
    Some((
        checkpoint.sequence,
        ForwardCursor {
            session: through.session,
            after: through.sequence,
        },
    ))
}

/// Reads the commands the primary forwards as they happen and queues them for the world.
///
/// Reading starts right after the commands a checkpoint reflects, so nothing between the
/// checkpoint and the first forwarded command is missed. After a gap it starts again from the
/// next checkpoint. Never returns.
async fn follow_commands(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
    shared: &Mutex<LinkShared>,
) {
    let mut cursor: Option<ForwardCursor> = None;
    let mut started_from: Option<u64> = None;
    loop {
        let Some(current) = cursor else {
            match start_cursor(shared, started_from) {
                Some((checkpoint, start)) => {
                    started_from = Some(checkpoint);
                    cursor = Some(start);
                }
                None => tokio::time::sleep(CURSOR_START_POLL).await,
            }
            continue;
        };
        match fetch_forwarded(client, base, cookie, Some(current)).await {
            Ok(batch) => {
                cursor = (!batch.gap).then_some(ForwardCursor {
                    session: batch.session,
                    after: batch.latest,
                });
                if (batch.gap || !batch.entries.is_empty())
                    && let Ok(mut shared) = shared.lock()
                {
                    shared.queue_forwarded(batch);
                }
            }
            Err(error) => {
                tracing::debug!(?error, "backup_forwarded_fetch_failed");
                tokio::time::sleep(RETRY_INTERVAL).await;
            }
        }
    }
}

/// Waits for the primary to forward commands after `cursor`.
async fn fetch_forwarded(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
    cursor: Option<ForwardCursor>,
) -> Result<ForwardedBatch, LinkError> {
    let query = cursor.map_or_else(String::new, |cursor| {
        format!("?session={}&after={}", cursor.session, cursor.after)
    });
    let mut request = client
        .get(format!("{base}{FORWARDED_COMMANDS_PATH}{query}"))
        .timeout(FORWARDED_REQUEST_TIMEOUT);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    let body = check_status(response)
        .await?
        .bytes()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    serde_json::from_slice(&body).map_err(|error| {
        LinkError::Failed(format!(
            "The primary forwarded commands this version cannot read: {error}"
        ))
    })
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
        Ok(Some((revision, show))) => {
            *loaded_revision = Some(revision.revision);
            if let Ok(mut shared) = shared.lock() {
                shared.mirror = Some(show);
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

/// What the primary answered to a checkpoint request.
enum LiveStateAnswer {
    /// A checkpoint, with how long the primary waited for its engine before capturing it.
    Checkpoint(LiveStateSnapshot, Duration),
    /// The primary left the pair and no longer serves this host.
    LeftPair,
}

/// Asks the primary for a checkpoint of its live state.
async fn fetch_live_state(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
) -> Result<LiveStateAnswer, LinkError> {
    let mut request = client.get(format!("{base}{LIVE_STATE_PATH}"));
    if let Some(port) = failover::own_port() {
        request = request.header(BACKUP_PORT_HEADER, port);
    }
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| LinkError::from_request(&error))?;
    if response.status() == StatusCode::GONE {
        return Ok(LiveStateAnswer::LeftPair);
    }
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
    Ok(LiveStateAnswer::Checkpoint(snapshot, primary_wait))
}

/// Checks the primary's revision and, when it differs from the loaded one, downloads the show and
/// stores it in the failover folder. Returns `None` when the backup is already up to date.
async fn sync_once(
    client: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
    loaded_revision: &Option<String>,
) -> Result<Option<(ShowfileRevision, MirroredShow)>, LinkError> {
    let revision = fetch_revision(client, base, cookie).await?;
    if loaded_revision.as_ref() == Some(&revision.revision) {
        return Ok(None);
    }
    let failover_root = nightfall::failover_data_dir().ok_or_else(|| {
        LinkError::Failed("Could not find the app data folder to store the show in.".to_string())
    })?;
    let archive = download_show(client, base, cookie, revision.showfile_name.as_deref()).await?;
    let directory =
        tokio::task::spawn_blocking(move || install_show(archive.path(), &failover_root))
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
    Ok(Some((revision, show)))
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

/// Returns the folder that holds a show while it is unpacked, before it replaces the copy in the
/// failover folder.
fn incoming_root(failover_root: &Path) -> PathBuf {
    failover_root.join(INCOMING_DIR_NAME)
}

/// Deletes partly unpacked shows a previous run left behind.
fn remove_stale_mirrors() {
    let Some(root) = nightfall::failover_data_dir().map(|root| incoming_root(&root)) else {
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

/// Unpacks a downloaded show archive and moves its show folder into `failover_root`, replacing
/// the earlier copy of the same show. Returns the installed show folder. This computer's own
/// showfiles are never touched.
pub(crate) fn install_show(archive: &Path, failover_root: &Path) -> Result<PathBuf, String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| format!("The primary sent an unreadable show: {error}"))?;
    let incoming = incoming_root(failover_root);
    std::fs::create_dir_all(&incoming)
        .map_err(|error| format!("Could not unpack the show: {error}"))?;
    let unpacked = tempfile::tempdir_in(&incoming)
        .map_err(|error| format!("Could not unpack the show: {error}"))?;
    zip.extract(unpacked.path())
        .map_err(|error| format!("Could not unpack the show: {error}"))?;
    let directory = std::fs::read_dir(unpacked.path())
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .find(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .ok_or("The primary sent a show archive without a show folder.")?;
    let folder_name = directory
        .file_name()
        .filter(|name| name.to_string_lossy().ends_with(SHOW_FOLDER_SUFFIX))
        .ok_or("The primary sent a show archive without a show folder.")?;
    let installed = failover_root.join(folder_name);
    let replaced = unpacked.path().join(".replaced");
    if installed.exists() {
        std::fs::rename(&installed, &replaced)
            .map_err(|error| format!("Could not replace the earlier copy: {error}"))?;
    }
    if let Err(error) = std::fs::rename(&directory, &installed) {
        // Keep the earlier copy, which would otherwise go with the unpacking folder.
        if replaced.exists() {
            let _ = std::fs::rename(&replaced, &installed);
        }
        return Err(format!("Could not store the copied show: {error}"));
    }
    Ok(installed)
}

/// Returns the current Unix time in milliseconds.
pub(crate) fn now_ms() -> u64 {
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

    /// A primary that answers its heartbeat without a show open reads as waiting for its show
    /// rather than unreachable, and as unreachable again once its answers stop or it opens one.
    #[test]
    fn a_primary_without_a_show_reads_as_waiting() {
        let link = BackupLink {
            target: watch::channel(None).0,
            shared: Arc::new(Mutex::new(LinkShared::default())),
        };
        let primary = |show_open| HostStatus {
            show_open,
            ..HostStatus::default()
        };
        set_report(
            &link.shared,
            LinkReport {
                status: BackupLinkStatus::Unreachable,
                error: Some("The primary has no show open yet.".into()),
                ..LinkReport::default()
            },
        );
        link.shared.lock().unwrap().heartbeat = Some((Instant::now(), primary(false)));
        let report = link.report();
        assert_eq!(report.status, BackupLinkStatus::WaitingForShow);
        assert_eq!(report.error, None);

        link.shared.lock().unwrap().heartbeat = Some((Instant::now(), primary(true)));
        assert_eq!(link.report().status, BackupLinkStatus::Unreachable);

        // A clock younger than the timeout cannot hold an answer that old.
        if let Some(heard_at) = Instant::now().checked_sub(failover::FAILOVER_TIMEOUT) {
            link.shared.lock().unwrap().heartbeat = Some((heard_at, primary(false)));
            assert_eq!(link.report().status, BackupLinkStatus::Unreachable);
        }
    }

    /// Restating the stored primary keeps the connection, while a new pairing token or another
    /// primary restarts it.
    #[test]
    fn restating_the_same_primary_keeps_the_link() {
        let (target, mut target_rx) = watch::channel(None);
        let link = BackupLink {
            target,
            shared: Arc::default(),
        };
        let stored = LinkTarget {
            address: "192.0.2.10:3000".into(),
            token: Some("token".into()),
        };
        link.set_target(Some(stored.clone()));
        assert!(target_rx.has_changed().unwrap());
        target_rx.borrow_and_update();

        link.set_target(Some(stored.clone()));
        assert!(!target_rx.has_changed().unwrap());

        link.set_target(Some(LinkTarget {
            token: Some("new-token".into()),
            ..stored.clone()
        }));
        assert!(target_rx.has_changed().unwrap());
        target_rx.borrow_and_update();

        link.set_target(None);
        assert!(target_rx.has_changed().unwrap());
    }

    /// Writes an archive in the primary's export layout holding one show folder whose snapshot
    /// is `snapshot`.
    fn show_archive(snapshot: &[u8]) -> tempfile::NamedTempFile {
        let archive = tempfile::NamedTempFile::new().unwrap();
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
        zip.write_all(snapshot).unwrap();
        zip.finish().unwrap();
        archive
    }

    /// A copied show lands as a show folder in the failover folder, a newer copy replaces it,
    /// and nothing is left behind in the unpacking folder.
    #[test]
    fn stores_the_show_in_the_failover_folder() {
        let failover = tempfile::tempdir().unwrap();

        let directory = install_show(show_archive(b"{}").path(), failover.path()).unwrap();
        assert_eq!(directory, failover.path().join("live.nightfall-show"));
        assert_eq!(
            std::fs::read_to_string(directory.join("showfile.json")).unwrap(),
            "{}"
        );

        let directory = install_show(show_archive(b"[]").path(), failover.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.join("showfile.json")).unwrap(),
            "[]"
        );
        let incoming: Vec<_> = std::fs::read_dir(incoming_root(failover.path()))
            .unwrap()
            .collect();
        assert!(incoming.is_empty());
    }
}
