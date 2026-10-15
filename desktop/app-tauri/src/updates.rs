// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Checks for, downloads, and installs desktop updates from the Nightfall update service.
//!
//! An update is never installed while the app is in use, so a running show is never interrupted.
//! A newer version downloads on its own unless the operator turned automatic downloads off, in
//! which case it waits for them to download it. Once downloaded it waits until the operator
//! chooses to restart or, when they allow automatic installs, until the app next quits.
//!
//! A downloaded update is saved in the data directory, so it survives a restart and is never
//! downloaded twice. Before installing, the version being installed is recorded; the next launch
//! compares it with its own version to tell the operator the update installed, or that it failed.
//! A version that failed to install is never installed or downloaded again on its own, so a
//! broken update cannot loop; the operator retries it from About, and a newer release replaces it.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use nightfall_websocket::host_preferences::{
    LoadedPreferences, load_preferences, save_preferences,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

#[cfg(debug_assertions)]
pub(crate) mod debug;

/// File name of the update preferences inside the host data directory.
const UPDATES_FILE_NAME: &str = "updates.json";
/// Folder beside the preferences that holds the downloaded update.
const DOWNLOADS_DIR_NAME: &str = "updates";
/// Event that carries every [`UpdateState`] change to the desktop windows.
const UPDATE_STATE_EVENT: &str = "nightfall:update-state";
/// Pause before the first check, so startup work and the operator's first actions come first.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
/// Time between checks, kept across restarts so the service is asked at most once a day.
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Wait before retrying a check that could not reach the update service, such as while offline.
const RETRY_DELAY: Duration = Duration::from_secs(60 * 60);

/// Returns the key that update packages must be signed with, or `None` when this build cannot
/// install updates itself.
///
/// The release workflow compiles `NIGHTFALL_UPDATER_PUBKEY` into published releases only, so
/// development, pull request, and fork builds only check for newer versions and never download
/// one.
fn public_key() -> Option<&'static str> {
    option_env!("NIGHTFALL_UPDATER_PUBKEY").filter(|key| !key.trim().is_empty())
}

/// Builds the updater plugin. Builds without a public key can still check, because the key is
/// only needed to verify a download.
pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    let builder = tauri_plugin_updater::Builder::new();
    match public_key() {
        Some(key) => builder.pubkey(key),
        None => builder,
    }
    .build()
}

/// On-disk form of the operator's update preferences, and of the update downloaded or being
/// installed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct StoredUpdatePreferences {
    check_for_updates: bool,
    /// What happens when a check finds a newer version.
    update_mode: UpdateMode,
    /// Seconds since the Unix epoch of the last check that reached the update service. Failed
    /// checks are not recorded, so they are retried sooner.
    last_checked_at: Option<u64>,
    /// Verified update saved on disk and waiting to install.
    downloaded: Option<DownloadedUpdate>,
    /// Install started as the app last quit, settled by the next launch.
    install_attempt: Option<InstallAttempt>,
    /// Version that failed to install, which is never installed or downloaded again on its own.
    failed_install: Option<FailedInstall>,
}

/// A verified update package saved on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct DownloadedUpdate {
    version: String,
    /// The saved package.
    file: PathBuf,
    /// The update service's answer that announced this version, from which the update is
    /// restored and verified again before it installs.
    manifest: serde_json::Value,
}

/// A downloaded update that started installing as the app quit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct InstallAttempt {
    version: String,
    /// Why installing failed before the app quit. A failure the app does not see, such as a
    /// Windows installer that is cancelled after the app has exited, leaves this empty.
    error: Option<String>,
}

/// A version whose install failed, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FailedInstall {
    version: String,
    details: String,
}

/// Returns whether `candidate` is a newer version than `current`. Versions that are not semantic
/// versions are compared as text, so a different one counts as newer.
fn is_newer(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(current),
    ) {
        (Ok(candidate), Ok(current)) => candidate > current,
        _ => candidate != current,
    }
}

impl Default for StoredUpdatePreferences {
    /// Checks and downloads are on until the operator turns them off; installing waits for the
    /// operator's confirmation until they choose to install on quit.
    fn default() -> Self {
        Self {
            check_for_updates: true,
            update_mode: UpdateMode::default(),
            last_checked_at: None,
            downloaded: None,
            install_attempt: None,
            failed_install: None,
        }
    }
}

/// What happens when a check finds a newer version. Updates never install while the app runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdateMode {
    /// Say a newer version is available and wait for the operator to download it.
    Notify,
    /// Download it in the background, then wait for the operator to restart into it.
    #[default]
    Download,
    /// Download it in the background and install it the next time the app quits.
    Install,
}

impl UpdateMode {
    /// Whether a newer version downloads as soon as a check finds it, without asking first.
    fn downloads_automatically(self) -> bool {
        matches!(self, Self::Download | Self::Install)
    }

    /// Whether a downloaded update installs on any quit, not only when the operator restarts.
    fn installs_on_quit(self) -> bool {
        self == Self::Install
    }
}

/// Where an update currently stands.
#[cfg_attr(debug_assertions, derive(Deserialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdatePhase {
    /// Nothing is in progress and no update is waiting.
    Idle,
    /// Asking the update service for a newer version.
    Checking,
    /// A newer version was found and waits for the operator to download it, because automatic
    /// downloads are off or the last download failed.
    Available,
    /// Downloading and verifying a newer version.
    Downloading,
    /// A verified update is downloaded and waits for the operator to restart, or for the app to
    /// quit when automatic installs are allowed.
    Ready,
    /// The app is stopping to install the update.
    Installing,
}

/// What failed, so the window can explain it in plain words and keep the details for later.
#[cfg_attr(debug_assertions, derive(Deserialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdateErrorKind {
    /// The update service could not be reached, or its answer could not be used.
    Check,
    /// The newer version could not be downloaded or failed verification.
    Download,
    /// The update preferences could not be read or saved.
    Preferences,
    /// The downloaded update could not be installed, so the previous version kept running.
    Install,
}

/// Why the last check, download, or preference change failed.
#[cfg_attr(debug_assertions, derive(Deserialize))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateError {
    kind: UpdateErrorKind,
    /// The underlying error, shown on request for troubleshooting.
    details: String,
}

impl UpdateError {
    /// Describes a failure of `kind` caused by `details`.
    fn new(kind: UpdateErrorKind, details: impl ToString) -> Self {
        Self {
            kind,
            details: details.to_string(),
        }
    }
}

/// Update status shown in the About dialog and the update notices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateState {
    /// Whether this build can download and install updates itself; only published releases
    /// can. Other builds still check, and point the operator to the downloads page.
    can_install: bool,
    /// Whether the operator allows checking the update service.
    check_for_updates: bool,
    /// What happens when a check finds a newer version.
    update_mode: UpdateMode,
    phase: UpdatePhase,
    /// Version found, being downloaded, or waiting to install.
    version: Option<String>,
    /// How much of the update has downloaded, while [`UpdatePhase::Downloading`].
    progress: Option<DownloadProgress>,
    /// Seconds since the Unix epoch of the last check that reached the update service.
    last_checked_at: Option<u64>,
    /// Why the last check, download, install or preference change failed.
    error: Option<UpdateError>,
    /// Version this launch was updated to, so the windows can say the update installed.
    updated_to: Option<String>,
}

/// Bytes of an update downloaded so far.
#[cfg_attr(debug_assertions, derive(Deserialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgress {
    downloaded_bytes: u64,
    /// Size of the package, when the update service reports it.
    total_bytes: Option<u64>,
}

/// What a check that reached the update service means for the version the controller holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckResolution {
    /// The downloaded update stays ready to install.
    KeepDownloaded,
    /// The found version is offered. A downloaded update stays ready to install until the found
    /// version has downloaded, so a failed download never leaves nothing to install.
    Offer,
    /// Nothing newer is available and nothing is downloaded.
    NothingNewer,
}

/// Decides what a check's result means, given the version already downloaded, if any, and the
/// version the update service offers, if any. Only a strictly newer version replaces a
/// downloaded one, so a release pulled from the service cannot swap it for an older version.
fn resolve_check(downloaded: Option<&str>, found: Option<&str>) -> CheckResolution {
    match (downloaded, found) {
        (Some(downloaded), Some(found)) if is_newer(found, downloaded) => CheckResolution::Offer,
        (Some(_), _) => CheckResolution::KeepDownloaded,
        (None, Some(_)) => CheckResolution::Offer,
        (None, None) => CheckResolution::NothingNewer,
    }
}

/// Mutable controller state, kept under one lock so the phase and the update it refers to agree.
struct ControllerInner {
    state: UpdateState,
    /// Preferences as last loaded or saved, so each change saves them whole.
    stored: StoredUpdatePreferences,
    /// Whether the preference file could not be read. Background checks then leave it alone, so
    /// only a setting the operator changes replaces it.
    preferences_unreadable: bool,
    /// Newer version found but not downloaded, while [`UpdatePhase::Available`] or
    /// [`UpdatePhase::Downloading`].
    found: Option<Update>,
    /// Whether the operator chose to restart into the downloaded update.
    install_requested: bool,
}

/// What to do with a downloaded update once the backend has stopped.
struct ExitInstall {
    downloaded: DownloadedUpdate,
    /// Whether to start the app again afterwards: only when the operator chose to restart.
    restart: bool,
}

/// Settles what the last session left behind for an app now running `current_version`, and
/// returns the version it was updated to, if the last session installed one.
///
/// An install attempt that matches the running version succeeded, so its download is deleted.
/// One that does not failed: the reason is kept, along with the download so the operator can
/// retry it. A saved download whose file is gone, or that is no newer than the running version,
/// is forgotten.
fn settle_previous_session(
    stored: &mut StoredUpdatePreferences,
    current_version: &str,
) -> Option<String> {
    let mut updated_to = None;
    if let Some(attempt) = stored.install_attempt.take() {
        if attempt.version == current_version {
            stored.failed_install = None;
            updated_to = Some(attempt.version);
        } else {
            let details = attempt.error.unwrap_or_else(|| {
                format!(
                    "Nightfall {} did not start after the update, so the installer did not finish.",
                    attempt.version
                )
            });
            stored.failed_install = Some(FailedInstall {
                version: attempt.version,
                details,
            });
        }
    }
    if let Some(downloaded) = &stored.downloaded
        && (!is_newer(&downloaded.version, current_version) || !downloaded.file.is_file())
    {
        remove_file_quietly(&downloaded.file);
        stored.downloaded = None;
    }
    if stored
        .failed_install
        .as_ref()
        .is_some_and(|failed| !is_newer(&failed.version, current_version))
    {
        stored.failed_install = None;
    }
    updated_to
}

/// The install error to show while `shown_version` is the version that failed to install.
fn install_error(
    stored: &StoredUpdatePreferences,
    shown_version: Option<&str>,
) -> Option<UpdateError> {
    let failed = stored.failed_install.as_ref()?;
    (shown_version == Some(failed.version.as_str())).then(|| {
        UpdateError::new(
            UpdateErrorKind::Install,
            format!("Nightfall {}: {}", failed.version, failed.details),
        )
    })
}

/// Deletes a file that is no longer needed. A file that cannot be deleted is only logged, since
/// it does no harm beyond the space it takes.
fn remove_file_quietly(path: &std::path::Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "Could not delete an old update")
        }
    }
}

/// Owns the update preferences and lifecycle for the desktop process.
pub(crate) struct UpdateController {
    /// Preference file, or `None` when the data directory cannot be resolved.
    path: Option<PathBuf>,
    inner: Mutex<ControllerInner>,
    /// Wakes the check loop early, for example when checks are turned back on.
    wake: Notify,
}

impl UpdateController {
    /// Loads the operator's preferences from the data directory.
    pub(crate) fn load() -> Self {
        Self::load_from(nightfall::nightfall_data_dir().map(|dir| dir.join(UPDATES_FILE_NAME)))
    }

    /// Loads preferences from `path` for this build's version.
    fn load_from(path: Option<PathBuf>) -> Self {
        Self::load_for_version(path, env!("CARGO_PKG_VERSION"))
    }

    /// Loads preferences from `path`, reporting an unreadable file instead of replacing it, and
    /// settles what happened since the last session for an app now running `current_version`:
    /// an install that finished or failed, and a saved download that is gone or no longer newer.
    fn load_for_version(path: Option<PathBuf>, current_version: &str) -> Self {
        let (mut stored, error) = match path
            .as_deref()
            .map(load_preferences::<StoredUpdatePreferences>)
        {
            Some(LoadedPreferences::Loaded(stored)) => (stored, None),
            Some(LoadedPreferences::Missing) | None => (StoredUpdatePreferences::default(), None),
            Some(LoadedPreferences::Unreadable(error)) => (
                StoredUpdatePreferences::default(),
                Some(UpdateError::new(
                    UpdateErrorKind::Preferences,
                    format!("Could not read update preferences: {error}"),
                )),
            ),
        };
        let preferences_unreadable = error.is_some();
        let before = stored.clone();
        let updated_to = settle_previous_session(&mut stored, current_version);
        let mut state = UpdateState {
            can_install: public_key().is_some(),
            check_for_updates: stored.check_for_updates,
            update_mode: stored.update_mode,
            phase: UpdatePhase::Idle,
            version: None,
            progress: None,
            last_checked_at: stored.last_checked_at,
            error,
            updated_to,
        };
        if let Some(downloaded) = &stored.downloaded {
            state.phase = UpdatePhase::Ready;
            state.version = Some(downloaded.version.clone());
        }
        if state.error.is_none() {
            state.error = install_error(&stored, state.version.as_deref());
        }
        let controller = Self {
            path,
            inner: Mutex::new(ControllerInner {
                state,
                stored,
                preferences_unreadable,
                found: None,
                install_requested: false,
            }),
            wake: Notify::new(),
        };
        {
            let mut inner = controller.lock();
            if !inner.preferences_unreadable
                && inner.stored != before
                && let Some(error) = controller.save(&inner)
            {
                inner.state.error = Some(error);
            }
        }
        controller
    }

    /// Folder for the downloaded update, beside the preference file.
    fn downloads_dir(&self) -> Option<PathBuf> {
        Some(self.path.as_deref()?.parent()?.join(DOWNLOADS_DIR_NAME))
    }

    /// Locks the controller state.
    fn lock(&self) -> std::sync::MutexGuard<'_, ControllerInner> {
        self.inner
            .lock()
            .expect("update controller lock should not be poisoned")
    }

    /// Returns the current update status.
    pub(crate) fn snapshot(&self) -> UpdateState {
        self.lock().state.clone()
    }

    /// Saves the preferences in `inner`, returning why saving failed, if it did.
    fn save(&self, inner: &ControllerInner) -> Option<UpdateError> {
        let path = self.path.as_deref()?;
        save_preferences(path, &inner.stored).err().map(|error| {
            UpdateError::new(
                UpdateErrorKind::Preferences,
                format!("Could not save update preferences: {error}"),
            )
        })
    }

    /// Saves what the controller records on its own, such as a download or an install attempt,
    /// logging `failure` when that fails. An unreadable preference file is left alone until the
    /// operator changes a setting, so the record lasts for this session only.
    fn save_record(&self, inner: &ControllerInner, failure: &str) {
        if inner.preferences_unreadable {
            return;
        }
        if let Some(error) = self.save(inner) {
            tracing::warn!(error = %error.details, "{failure}");
        }
    }

    /// Applies one preference change, saves the preferences, and returns the new status. The
    /// change applies for this session even when saving fails, so turning something off always
    /// takes effect.
    fn change_preference(
        &self,
        change: impl FnOnce(&mut UpdateState, &mut StoredUpdatePreferences),
    ) -> UpdateState {
        let mut inner = self.lock();
        let ControllerInner { state, stored, .. } = &mut *inner;
        change(state, stored);
        match self.save(&inner) {
            Some(error) => inner.state.error = Some(error),
            // A check or download error stays shown; only an earlier preferences error is fixed.
            None => {
                inner.preferences_unreadable = false;
                inner
                    .state
                    .error
                    .take_if(|error| error.kind == UpdateErrorKind::Preferences);
            }
        }
        inner.state.clone()
    }

    /// Records whether checks are allowed and saves the choice. Turning checks off also forgets a
    /// found version that was not downloaded, so nothing contacts the update service afterwards.
    fn set_check_for_updates(&self, enabled: bool) -> UpdateState {
        if !enabled {
            let mut inner = self.lock();
            if inner.state.phase == UpdatePhase::Available {
                inner.found = None;
                // An update downloaded earlier stays ready to install.
                let downloaded = inner
                    .stored
                    .downloaded
                    .as_ref()
                    .map(|downloaded| downloaded.version.clone());
                inner.state.phase = if downloaded.is_some() {
                    UpdatePhase::Ready
                } else {
                    UpdatePhase::Idle
                };
                inner.state.version = downloaded;
                inner
                    .state
                    .error
                    .take_if(|error| error.kind != UpdateErrorKind::Preferences);
                if inner.state.error.is_none() {
                    inner.state.error =
                        install_error(&inner.stored, inner.state.version.as_deref());
                }
            }
        }
        let state = self.change_preference(|state, stored| {
            state.check_for_updates = enabled;
            stored.check_for_updates = enabled;
        });
        if enabled {
            self.wake.notify_one();
        }
        state
    }

    /// Records what happens when a check finds a newer version and saves the choice.
    fn set_update_mode(&self, mode: UpdateMode) -> UpdateState {
        self.change_preference(|state, stored| {
            state.update_mode = mode;
            stored.update_mode = mode;
        })
    }

    /// Returns how long to wait before the next check is due: a day after the last check that
    /// reached the update service, or no wait when there was none.
    fn delay_until_due(&self) -> Duration {
        let Some(last) = self.lock().stored.last_checked_at else {
            return Duration::ZERO;
        };
        // A time too far ahead to represent is treated like any future time: capped below.
        let Some(due) = Duration::from_secs(last)
            .checked_add(CHECK_INTERVAL)
            .and_then(|since_epoch| UNIX_EPOCH.checked_add(since_epoch))
        else {
            return CHECK_INTERVAL;
        };
        // Capped at one interval, so a clock set back after a check cannot postpone the next.
        due.duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO)
            .min(CHECK_INTERVAL)
    }

    /// Moves to [`UpdatePhase::Checking`] when a check is allowed and no check, download or
    /// install is in progress. A found version that was not downloaded, or a downloaded one
    /// waiting to install, is checked again, so a newer release replaces it. Returns whether the
    /// caller should check.
    fn begin_check(&self) -> bool {
        let mut inner = self.lock();
        let state = &mut inner.state;
        if !state.check_for_updates
            || !matches!(
                state.phase,
                UpdatePhase::Idle | UpdatePhase::Available | UpdatePhase::Ready
            )
        {
            return false;
        }
        state.phase = UpdatePhase::Checking;
        true
    }

    /// Records the outcome of a check: a newer version waiting to download, nothing newer, or
    /// the error that stopped it. A downloaded update stays ready to install until a strictly
    /// newer version has downloaded. A check that reached the service is remembered, so the next
    /// one waits a day.
    fn finish_check(&self, outcome: Result<Option<Update>, String>) {
        let mut inner = self.lock();
        // The operator chose to restart into the downloaded update while this check ran: the app
        // is quitting to install it, so the result must not replace it or change the phase.
        if inner.state.phase == UpdatePhase::Installing {
            return;
        }
        let downloaded_version = inner
            .stored
            .downloaded
            .as_ref()
            .map(|downloaded| downloaded.version.clone());
        let found = match outcome {
            Ok(found) => found,
            Err(error) => {
                // A downloaded update stays ready, and a version found earlier stays available.
                inner.state.phase = if downloaded_version.is_some() {
                    UpdatePhase::Ready
                } else if inner.found.is_some() {
                    UpdatePhase::Available
                } else {
                    UpdatePhase::Idle
                };
                // An unreadable preference file stays reported until the operator fixes it.
                if !inner.preferences_unreadable {
                    inner.state.error = Some(UpdateError::new(UpdateErrorKind::Check, error));
                }
                return;
            }
        };
        let resolution = resolve_check(
            downloaded_version.as_deref(),
            found.as_ref().map(|update| update.version.as_str()),
        );
        match (resolution, found) {
            (CheckResolution::KeepDownloaded, _) => {
                inner.state.phase = UpdatePhase::Ready;
                inner.state.version = downloaded_version;
                inner.found = None;
            }
            (CheckResolution::Offer, Some(update)) => {
                inner.state.phase = UpdatePhase::Available;
                inner.state.version = Some(update.version.clone());
                inner.found = Some(update);
            }
            (CheckResolution::Offer | CheckResolution::NothingNewer, _) => {
                inner.state.phase = UpdatePhase::Idle;
                inner.state.version = None;
                inner.found = None;
            }
        }
        inner.stored.last_checked_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|elapsed| elapsed.as_secs());
        inner.state.last_checked_at = inner.stored.last_checked_at;
        // An unreadable preference file stays untouched and reported until the operator changes
        // a setting, so the check is remembered for this session only.
        // A new check result replaces any earlier check or download error; an install failure
        // stays shown while its version is still the one offered.
        inner
            .state
            .error
            .take_if(|error| error.kind != UpdateErrorKind::Preferences);
        if inner.state.error.is_none() {
            inner.state.error = install_error(&inner.stored, inner.state.version.as_deref());
        }
        if inner.preferences_unreadable {
            return;
        }
        // Saving every preference also records any choice whose earlier save failed. Failing to
        // remember the check only means the next start checks again.
        if let Some(error) = self.save(&inner) {
            tracing::warn!(error = %error.details, "Could not record the update check");
        }
    }

    /// Returns whether the found version failed to install before, so it only installs again
    /// when the operator asks.
    fn found_version_failed(inner: &ControllerInner) -> bool {
        match (&inner.stored.failed_install, inner.state.version.as_deref()) {
            (Some(failed), Some(version)) => failed.version == version,
            _ => false,
        }
    }

    /// Returns whether a found version should download without asking: this build can install
    /// it, checks are on, it is waiting with no failed download to retry by hand, it has not
    /// failed to install before, and either automatic downloads are on or it replaces an update
    /// that was already downloaded.
    fn should_download_automatically(&self) -> bool {
        let inner = self.lock();
        let state = &inner.state;
        state.can_install
            && state.phase == UpdatePhase::Available
            && (state.update_mode.downloads_automatically() || inner.stored.downloaded.is_some())
            && state.check_for_updates
            && !Self::found_version_failed(&inner)
            && state
                .error
                .as_ref()
                .is_none_or(|error| error.kind != UpdateErrorKind::Download)
    }

    /// Moves a found version to [`UpdatePhase::Downloading`] and returns it, or `None` when no
    /// version is waiting to download or this build cannot install it.
    fn begin_download(&self) -> Option<Update> {
        let mut inner = self.lock();
        if !inner.state.can_install
            || inner.state.phase != UpdatePhase::Available
            || !inner.state.check_for_updates
        {
            return None;
        }
        let update = inner.found.clone()?;
        inner.state.phase = UpdatePhase::Downloading;
        inner.state.progress = Some(DownloadProgress {
            downloaded_bytes: 0,
            total_bytes: None,
        });
        if inner
            .state
            .error
            .as_ref()
            .is_some_and(|error| error.kind == UpdateErrorKind::Download)
        {
            inner.state.error = None;
        }
        Some(update)
    }

    /// Adds a downloaded chunk to the progress. Returns whether the windows should be told: when
    /// another whole percent has arrived, or another mebibyte when the size is unknown, so a fast
    /// download does not flood them with events.
    fn record_download(&self, chunk_bytes: usize, total_bytes: Option<u64>) -> bool {
        let mut inner = self.lock();
        let Some(progress) = inner.state.progress.as_mut() else {
            return false;
        };
        let before = progress.downloaded_bytes;
        progress.downloaded_bytes = before.saturating_add(chunk_bytes as u64);
        progress.total_bytes = total_bytes.filter(|total| *total > 0);
        let step = |bytes: u64| match progress.total_bytes {
            Some(total) => bytes.saturating_mul(100) / total,
            None => bytes >> 20,
        };
        step(progress.downloaded_bytes) != step(before)
    }

    /// Records the outcome of a download: a verified update saved on disk and waiting to
    /// install, replacing any older one, or the error that stopped it. After a failed download
    /// the version stays available to download again, and an update downloaded earlier stays
    /// ready to install.
    fn finish_download(&self, outcome: Result<DownloadedUpdate, String>) {
        let mut inner = self.lock();
        inner.state.progress = None;
        match outcome {
            // The app is quitting to install the update downloaded earlier, which must stay as it
            // is; the newer one is found again by the next launch.
            Ok(downloaded) if inner.state.phase == UpdatePhase::Installing => {
                remove_file_quietly(&downloaded.file);
            }
            Err(_) if inner.state.phase == UpdatePhase::Installing => {}
            Ok(downloaded) => {
                inner.found = None;
                inner
                    .state
                    .error
                    .take_if(|error| error.kind == UpdateErrorKind::Download);
                // A newer version than one that failed to install replaces it, so it may install.
                if inner
                    .stored
                    .failed_install
                    .as_ref()
                    .is_some_and(|failed| failed.version != downloaded.version)
                {
                    inner.stored.failed_install = None;
                    inner
                        .state
                        .error
                        .take_if(|error| error.kind == UpdateErrorKind::Install);
                }
                if let Some(previous) = inner.stored.downloaded.take()
                    && previous.file != downloaded.file
                {
                    remove_file_quietly(&previous.file);
                }
                inner.state.phase = UpdatePhase::Ready;
                inner.state.version = Some(downloaded.version.clone());
                inner.stored.downloaded = Some(downloaded);
                // The update still installs from this session; only a restart forgets it.
                self.save_record(&inner, "Could not record the downloaded update");
            }
            Err(error) => {
                inner.state.error = Some(UpdateError::new(UpdateErrorKind::Download, error));
                match inner
                    .stored
                    .downloaded
                    .as_ref()
                    .map(|downloaded| downloaded.version.clone())
                {
                    Some(version) => {
                        inner.state.phase = UpdatePhase::Ready;
                        inner.state.version = Some(version);
                    }
                    None => inner.state.phase = UpdatePhase::Available,
                }
            }
        }
    }

    /// Marks the downloaded update for installation once the backend has stopped. Fails when no
    /// update is waiting. Restarting is how the operator retries an update that failed to
    /// install.
    fn request_install(&self) -> Result<UpdateState, String> {
        let mut inner = self.lock();
        if inner.stored.downloaded.is_none() {
            return Err("No downloaded update is waiting to install".into());
        }
        inner.install_requested = true;
        inner.state.phase = UpdatePhase::Installing;
        Ok(inner.state.clone())
    }

    /// Returns the downloaded update when it should install as the app exits: always when the
    /// operator asked to restart into it, and on any quit when automatic installs are allowed,
    /// unless that version already failed to install. The install is recorded first, so the
    /// next launch can tell whether it worked.
    fn take_exit_install(&self) -> Option<ExitInstall> {
        let mut inner = self.lock();
        let downloaded = inner.stored.downloaded.clone()?;
        let restart = inner.install_requested;
        let failed_before = inner
            .stored
            .failed_install
            .as_ref()
            .is_some_and(|failed| failed.version == downloaded.version);
        if !restart && (!inner.state.update_mode.installs_on_quit() || failed_before) {
            return None;
        }
        inner.stored.install_attempt = Some(InstallAttempt {
            version: downloaded.version.clone(),
            error: None,
        });
        self.save_record(&inner, "Could not record the update install");
        Some(ExitInstall {
            downloaded,
            restart,
        })
    }

    /// Records why installing failed, for the next launch to report.
    fn record_install_failure(&self, error: String) {
        let mut inner = self.lock();
        if let Some(attempt) = inner.stored.install_attempt.as_mut() {
            attempt.error = Some(error);
        }
        self.save_record(&inner, "Could not record the failed update install");
    }
}

/// Sends the current status to every desktop window.
fn broadcast<R: Runtime>(app: &AppHandle<R>, controller: &UpdateController) {
    if let Err(error) = app.emit(UPDATE_STATE_EVENT, controller.snapshot()) {
        tracing::warn!(%error, "Could not send the update status to the desktop window");
    }
}

/// Starts the background loop that checks for updates once a day while checks are allowed.
///
/// The first check waits until a day has passed since the last check that reached the service,
/// and at least [`FIRST_CHECK_DELAY`] after startup. Turning checks back on runs any check that
/// is already due.
pub(crate) fn start<R: Runtime>(app: &AppHandle<R>, controller: Arc<UpdateController>) {
    if tauri::is_dev() {
        return;
    }
    remove_installer_leftovers(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = tokio::time::Instant::now();
        let mut delay = controller.delay_until_due().max(FIRST_CHECK_DELAY);
        loop {
            tokio::select! {
                () = tokio::time::sleep(delay) => {
                    check_once(&app, &controller).await;
                    // A failed check is not recorded, so it is retried after the shorter wait.
                    delay = controller.delay_until_due().max(RETRY_DELAY);
                }
                () = controller.wake.notified() => {
                    delay = controller
                        .delay_until_due()
                        .max(FIRST_CHECK_DELAY.saturating_sub(started.elapsed()));
                }
            }
        }
    });
}

/// Asks the update service for a newer version, and downloads it when automatic downloads are
/// on. Returns whether a check reached the service.
async fn check_once<R: Runtime>(app: &AppHandle<R>, controller: &UpdateController) -> bool {
    if !controller.begin_check() {
        return false;
    }
    broadcast(app, controller);
    let outcome = find_newer_version(app)
        .await
        .map_err(|error| error.to_string());
    let reached = outcome.is_ok();
    match &outcome {
        Ok(Some(update)) => tracing::info!(version = %update.version, "Update available"),
        Ok(None) => tracing::debug!("No newer version is available"),
        Err(error) => tracing::warn!(%error, "Could not check for updates"),
    }
    controller.finish_check(outcome);
    broadcast(app, controller);
    if controller.should_download_automatically() {
        download_found_update(app, controller).await;
    }
    reached
}

/// Asks the update service whether a newer, correctly signed version exists.
async fn find_newer_version<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri_plugin_updater::Result<Option<Update>> {
    // On Windows the installer replaces the running app by exiting the process directly, so
    // pending reports are written first.
    app.updater_builder()
        .on_before_exit(app_runtime::flush_reports)
        .build()?
        .check()
        .await
}

/// Downloads and verifies the version a check found, reporting progress to the windows, and
/// saves it in the data directory. Does nothing when no version is waiting to download.
async fn download_found_update<R: Runtime>(app: &AppHandle<R>, controller: &UpdateController) {
    let Some(update) = controller.begin_download() else {
        return;
    };
    broadcast(app, controller);
    let outcome = async {
        let bytes = update
            .download(
                |chunk_bytes, total_bytes| {
                    if controller.record_download(chunk_bytes, total_bytes) {
                        broadcast(app, controller);
                    }
                },
                || {},
            )
            .await
            .map_err(|error| error.to_string())?;
        let directory = controller
            .downloads_dir()
            .ok_or("Nightfall's data folder could not be found, so the update cannot be saved")?;
        save_package(&directory, &update.version, &bytes)
            .await
            .map(|file| DownloadedUpdate {
                version: update.version.clone(),
                file,
                manifest: update.raw_json.clone(),
            })
            .map_err(|error| format!("Could not save the update: {error}"))
    }
    .await;
    match &outcome {
        Ok(_) => tracing::info!(version = %update.version, "Update downloaded"),
        Err(error) => tracing::warn!(%error, "Could not download the update"),
    }
    controller.finish_download(outcome);
    broadcast(app, controller);
}

/// Returns the file name for the package of `version`, keeping only characters that are safe in
/// a file name, since the version comes from the update service.
fn package_file_name(version: &str) -> String {
    let version: String = version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("Nightfall-{version}.update")
}

/// Writes a verified package into `directory` and returns its path. It is written beside its
/// final name first, so an interrupted write never leaves a partial package that looks complete.
async fn save_package(
    directory: &std::path::Path,
    version: &str,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    tokio::fs::create_dir_all(directory).await?;
    let file = directory.join(package_file_name(version));
    let partial = file.with_extension("part");
    tokio::fs::write(&partial, bytes).await?;
    tokio::fs::rename(&partial, &file).await?;
    Ok(file)
}

/// Deletes installer folders the updater left in the temporary directory by earlier updates.
/// The Windows installer runs after the app has exited, so its folder is never removed by the
/// update that created it.
fn remove_installer_leftovers<R: Runtime>(app: &AppHandle<R>) {
    let prefix = format!("{}-", app.package_info().name);
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix)
            && name.contains("-updater-")
            && entry.file_type().is_ok_and(|kind| kind.is_dir())
            && let Err(error) = std::fs::remove_dir_all(entry.path())
        {
            tracing::warn!(%error, folder = %name, "Could not delete an old update installer");
        }
    }
}

/// Restores the saved update from the update service's answer and reads its package. The
/// package is verified again as it installs.
fn load_saved_update<R: Runtime>(
    app: &AppHandle<R>,
    downloaded: &DownloadedUpdate,
) -> Result<(Update, Vec<u8>), String> {
    let update = app
        .updater_builder()
        .on_before_exit(app_runtime::flush_reports)
        .build()
        .and_then(|updater| updater.restore_update(downloaded.manifest.clone()))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Nightfall {} is no longer an update", downloaded.version))?;
    let bytes = std::fs::read(&downloaded.file)
        .map_err(|error| format!("Could not read the downloaded update: {error}"))?;
    Ok((update, bytes))
}

/// Installs a downloaded update after the backend has stopped: the one the operator chose to
/// restart into, or any downloaded update when automatic installs are allowed. Returns `true`
/// when the app is restarting, so the caller must not exit it; otherwise the caller exits
/// normally.
///
/// After a restart request the app restarts even when installing fails, so the operator is never
/// left without it; the failure is recorded, and the next launch reports it and keeps the
/// previous version. On Windows the installer ends the process itself, and starts the new
/// version only after a restart request.
pub(crate) fn install_pending_update<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(controller) = app.try_state::<Arc<UpdateController>>() else {
        return false;
    };
    let Some(ExitInstall {
        downloaded,
        restart,
    }) = controller.take_exit_install()
    else {
        return false;
    };
    tracing::info!(version = %downloaded.version, restart, "Installing update");
    let installed = load_saved_update(app, &downloaded).and_then(|(update, bytes)| {
        update
            .restart_after_install(restart)
            .install(&bytes)
            .map_err(|error| error.to_string())
    });
    if let Err(error) = installed {
        tracing::error!(%error, "Could not install the update; keeping the current version");
        controller.record_install_failure(error);
    }
    if restart {
        app.request_restart();
    }
    restart
}

#[tauri::command]
/// Returns the current update status for the About dialog and the update notices.
pub(crate) fn update_state(controller: tauri::State<'_, Arc<UpdateController>>) -> UpdateState {
    controller.snapshot()
}

#[tauri::command]
/// Turns update checks on or off and tells every window about the change.
pub(crate) fn set_update_checks<R: Runtime>(
    app: AppHandle<R>,
    controller: tauri::State<'_, Arc<UpdateController>>,
    enabled: bool,
) -> UpdateState {
    let state = controller.set_check_for_updates(enabled);
    broadcast(&app, &controller);
    state
}

#[tauri::command]
/// Chooses what happens when a check finds a newer version, and tells every window. Choosing a
/// mode that downloads starts downloading a version that is already waiting.
pub(crate) fn set_update_mode<R: Runtime>(
    app: AppHandle<R>,
    controller: tauri::State<'_, Arc<UpdateController>>,
    mode: UpdateMode,
) -> UpdateState {
    let state = controller.set_update_mode(mode);
    broadcast(&app, &controller);
    if controller.should_download_automatically() {
        let controller = Arc::clone(&controller);
        tauri::async_runtime::spawn(async move {
            download_found_update(&app, &controller).await;
        });
    }
    state
}

#[tauri::command]
/// Checks for a newer version now, when the operator asks from the About dialog, and downloads
/// it when automatic downloads are on. Refused while checks are off in Settings > Privacy. A
/// check, download or install already in progress is left as it is; a downloaded update waiting
/// to install stays ready unless the service now offers a different version.
pub(crate) async fn check_for_updates<R: Runtime>(
    app: AppHandle<R>,
    controller: tauri::State<'_, Arc<UpdateController>>,
) -> Result<UpdateState, String> {
    let state = controller.snapshot();
    if !state.check_for_updates {
        return Err("Update checks are off in Settings > Privacy".into());
    }
    // A check that reached the service restarts the daily schedule from now. A refused or failed
    // one leaves the background schedule as it was, so it does not immediately retry.
    if check_once(&app, &controller).await {
        controller.wake.notify_one();
    }
    Ok(controller.snapshot())
}

#[tauri::command]
/// Downloads the newer version a check found, when the operator asks. Fails when no version is
/// waiting to download.
pub(crate) async fn download_update<R: Runtime>(
    app: AppHandle<R>,
    controller: tauri::State<'_, Arc<UpdateController>>,
) -> Result<UpdateState, String> {
    let state = controller.snapshot();
    if !state.can_install {
        return Err("This build of Nightfall cannot install updates itself".into());
    }
    if !state.check_for_updates {
        return Err("Update checks are off in Settings > Privacy".into());
    }
    if state.phase != UpdatePhase::Available {
        return Err("No newer version is waiting to download".into());
    }
    download_found_update(&app, &controller).await;
    Ok(controller.snapshot())
}

#[tauri::command]
/// Quits the app so the downloaded update installs, then starts the new version. The backend
/// saves the operator's work as on any other quit before the update is installed.
pub(crate) fn restart_to_update<R: Runtime>(
    app: AppHandle<R>,
    controller: tauri::State<'_, Arc<UpdateController>>,
) -> Result<(), String> {
    controller.request_install()?;
    broadcast(&app, &controller);
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A first run checks for and downloads updates, and writes nothing until the operator
    /// changes a choice.
    #[test]
    fn missing_file_checks_by_default_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let state = UpdateController::load_from(Some(path.clone())).snapshot();
        assert!(state.check_for_updates);
        assert_eq!(state.update_mode, UpdateMode::Download);
        assert_eq!(state.phase, UpdatePhase::Idle);
        assert_eq!(state.error, None);
        assert!(!path.exists());
    }

    /// Turning checks off is saved and reloaded by the next session.
    #[test]
    fn turning_checks_off_survives_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_from(Some(path.clone()));
        let state = controller.set_check_for_updates(false);
        assert!(!state.check_for_updates);
        assert_eq!(state.error, None);
        assert!(
            !UpdateController::load_from(Some(path))
                .snapshot()
                .check_for_updates
        );
    }

    /// An unreadable preference file is reported as a preferences error, kept on disk, and
    /// treated as the default.
    #[test]
    fn unreadable_file_is_reported_and_kept() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        std::fs::write(&path, "not json").unwrap();
        let state = UpdateController::load_from(Some(path.clone())).snapshot();
        assert!(state.check_for_updates);
        let error = state.error.unwrap();
        assert_eq!(error.kind, UpdateErrorKind::Preferences);
        assert!(
            error
                .details
                .starts_with("Could not read update preferences")
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), "not json");
    }

    /// Checks never start when checks are off or while another check is in progress, and builds
    /// that cannot install updates still check.
    #[test]
    fn checks_start_only_when_allowed_and_idle() {
        let controller = UpdateController::load_from(None);
        assert!(controller.begin_check());
        assert!(!controller.begin_check(), "a check is already running");
        controller.finish_check(Ok(None));
        controller.set_check_for_updates(false);
        assert!(!controller.begin_check(), "checks are turned off");
        controller.set_check_for_updates(true);
        controller.lock().state.can_install = false;
        assert!(
            controller.begin_check(),
            "builds that cannot install still check"
        );
    }

    /// A check that finishes after the operator chose to restart into the downloaded update
    /// leaves the install alone, whatever it found.
    #[test]
    fn checks_finishing_during_an_install_change_nothing() {
        let controller = UpdateController::load_from(None);
        controller.lock().state.phase = UpdatePhase::Installing;
        controller.lock().state.version = Some("1.2.0".into());
        controller.finish_check(Ok(None));
        controller.finish_check(Err("offline".into()));
        let state = controller.snapshot();
        assert_eq!(state.phase, UpdatePhase::Installing);
        assert_eq!(state.version.as_deref(), Some("1.2.0"));
        assert_eq!(state.error, None);
    }

    /// A downloaded update waiting to install can be checked again, but a download or install
    /// in progress cannot.
    #[test]
    fn checks_run_while_an_update_waits_to_install() {
        let controller = UpdateController::load_from(None);
        for (phase, allowed) in [
            (UpdatePhase::Ready, true),
            (UpdatePhase::Downloading, false),
            (UpdatePhase::Installing, false),
        ] {
            controller.lock().state.phase = phase;
            assert_eq!(controller.begin_check(), allowed, "{phase:?}");
        }
    }

    /// A downloaded update stays ready when the service offers it again or nothing newer, and a
    /// different version replaces it.
    #[test]
    fn checks_keep_a_downloaded_update_unless_another_is_offered() {
        assert_eq!(
            resolve_check(Some("1.2.0"), Some("1.2.0")),
            CheckResolution::KeepDownloaded
        );
        assert_eq!(
            resolve_check(Some("1.2.0"), None),
            CheckResolution::KeepDownloaded
        );
        assert_eq!(
            resolve_check(Some("1.2.0"), Some("1.3.0")),
            CheckResolution::Offer
        );
        assert_eq!(
            resolve_check(Some("1.2.0"), Some("1.1.0")),
            CheckResolution::KeepDownloaded,
            "an older release never replaces a downloaded one"
        );
        assert_eq!(resolve_check(None, Some("1.3.0")), CheckResolution::Offer);
        assert_eq!(resolve_check(None, None), CheckResolution::NothingNewer);
    }

    /// A build that cannot install updates reports a found version but never downloads it, so
    /// the operator is pointed to the downloads page instead.
    #[test]
    fn builds_without_a_key_never_download() {
        let controller = UpdateController::load_from(None);
        {
            let mut inner = controller.lock();
            inner.state.can_install = false;
            inner.state.phase = UpdatePhase::Available;
        }
        assert!(!controller.should_download_automatically());
        assert!(controller.begin_download().is_none());
        assert_eq!(controller.snapshot().phase, UpdatePhase::Available);
    }

    /// A failed check reports a check error and returns to idle so the next check can run.
    #[test]
    fn failed_check_reports_error_and_returns_to_idle() {
        let controller = UpdateController::load_from(None);
        assert!(controller.begin_check());
        controller.finish_check(Err("offline".into()));
        let state = controller.snapshot();
        assert_eq!(state.phase, UpdatePhase::Idle);
        assert_eq!(state.version, None);
        assert_eq!(
            state.error,
            Some(UpdateError::new(UpdateErrorKind::Check, "offline"))
        );
        assert!(controller.begin_check());
    }

    /// Downloading and restarting are refused until a version has been found or downloaded, and
    /// nothing is installed on exit unless the operator asked for it.
    #[test]
    fn install_requires_a_downloaded_update() {
        let controller = UpdateController::load_from(None);
        controller.lock().state.can_install = true;
        assert!(controller.begin_download().is_none());
        assert!(controller.request_install().is_err());
        controller.set_update_mode(UpdateMode::Install);
        assert!(controller.take_exit_install().is_none());
        assert_eq!(controller.snapshot().phase, UpdatePhase::Idle);
    }

    /// The update mode is saved alongside the check choice and reloaded by the next session.
    #[test]
    fn update_mode_survives_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_from(Some(path.clone()));
        controller.set_check_for_updates(false);
        let state = controller.set_update_mode(UpdateMode::Notify);
        assert_eq!(state.update_mode, UpdateMode::Notify);
        assert_eq!(state.error, None);
        let reloaded = UpdateController::load_from(Some(path)).snapshot();
        assert_eq!(reloaded.update_mode, UpdateMode::Notify);
        assert!(!reloaded.check_for_updates);
    }

    /// Only the install mode installs on a plain quit; every other mode keeps a downloaded update
    /// until the operator restarts into it.
    #[test]
    fn only_install_mode_installs_on_quit() {
        assert!(!UpdateMode::Notify.downloads_automatically());
        assert!(UpdateMode::Download.downloads_automatically());
        assert!(UpdateMode::Install.downloads_automatically());
        assert!(!UpdateMode::Notify.installs_on_quit());
        assert!(!UpdateMode::Download.installs_on_quit());
        assert!(UpdateMode::Install.installs_on_quit());
    }

    /// A check that finds nothing newer is remembered across restarts and delays the next one by
    /// a day; with no remembered check, or one over a day old, a check is due at once.
    #[test]
    fn checks_run_at_most_once_a_day() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_from(Some(path.clone()));
        assert_eq!(controller.delay_until_due(), Duration::ZERO);
        assert!(controller.begin_check());
        controller.finish_check(Ok(None));
        let reloaded = UpdateController::load_from(Some(path));
        let delay = reloaded.delay_until_due();
        assert!(
            delay > CHECK_INTERVAL - Duration::from_secs(60),
            "{delay:?}"
        );
        assert!(delay <= CHECK_INTERVAL, "{delay:?}");
        reloaded.lock().stored.last_checked_at = Some(0);
        assert_eq!(reloaded.delay_until_due(), Duration::ZERO);
        reloaded.lock().stored.last_checked_at = Some(u64::MAX);
        assert_eq!(reloaded.delay_until_due(), CHECK_INTERVAL);
    }

    /// Background checks never overwrite an unreadable preference file or hide its error; a
    /// setting the operator changes replaces it.
    #[test]
    fn checks_leave_an_unreadable_file_alone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        std::fs::write(&path, "not json").unwrap();
        let controller = UpdateController::load_from(Some(path.clone()));
        assert!(controller.begin_check());
        controller.finish_check(Ok(None));
        assert!(controller.snapshot().error.is_some());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
        controller.set_update_mode(UpdateMode::Install);
        assert_eq!(
            UpdateController::load_from(Some(path))
                .snapshot()
                .update_mode,
            UpdateMode::Install
        );
    }

    /// Download progress is reported once per whole percent, or per mebibyte when the size is
    /// unknown, and is cleared when the download ends.
    #[test]
    fn download_progress_is_reported_in_steps() {
        let controller = UpdateController::load_from(None);
        assert!(
            !controller.record_download(10, Some(1000)),
            "not downloading"
        );
        {
            let mut inner = controller.lock();
            inner.state.phase = UpdatePhase::Downloading;
            inner.state.progress = Some(DownloadProgress {
                downloaded_bytes: 0,
                total_bytes: None,
            });
        }
        assert!(!controller.record_download(5, Some(1000)));
        assert!(controller.record_download(5, Some(1000)));
        assert_eq!(
            controller.snapshot().progress,
            Some(DownloadProgress {
                downloaded_bytes: 10,
                total_bytes: Some(1000),
            })
        );
        assert!(!controller.record_download(1 << 19, None));
        assert!(controller.record_download(1 << 19, None));
        controller.finish_download(Err("connection reset".into()));
        let state = controller.snapshot();
        assert_eq!(state.progress, None);
        assert_eq!(state.phase, UpdatePhase::Available);
        assert_eq!(
            state.error,
            Some(UpdateError::new(
                UpdateErrorKind::Download,
                "connection reset"
            ))
        );
    }

    /// A version that failed to download is not retried automatically; the operator downloads
    /// it by hand, which clears the error.
    #[test]
    fn failed_download_waits_for_the_operator() {
        let controller = UpdateController::load_from(None);
        controller.lock().state.can_install = true;
        controller.lock().state.phase = UpdatePhase::Available;
        assert!(controller.should_download_automatically());
        controller.finish_download(Err("connection reset".into()));
        assert!(!controller.should_download_automatically());
        controller.set_update_mode(UpdateMode::Notify);
        assert!(!controller.should_download_automatically());
    }

    /// A found version that was not downloaded is checked again later, keeps its download offer
    /// when that check fails, and is forgotten when checks are turned off.
    #[test]
    fn available_versions_are_rechecked_and_forgotten_when_checks_stop() {
        let controller = UpdateController::load_from(None);
        controller.lock().state.can_install = true;
        controller.lock().state.phase = UpdatePhase::Available;
        controller.lock().state.version = Some("1.2.3".into());
        assert!(controller.begin_check());
        controller.finish_check(Err("offline".into()));
        assert_eq!(
            controller.snapshot().phase,
            UpdatePhase::Idle,
            "nothing was found"
        );
        controller.lock().state.phase = UpdatePhase::Available;
        controller.lock().state.version = Some("1.2.3".into());
        let state = controller.set_check_for_updates(false);
        assert_eq!(state.phase, UpdatePhase::Idle);
        assert_eq!(state.version, None);
        assert!(controller.begin_download().is_none());
    }

    /// Changing a setting keeps a download error, which also keeps the failed version from
    /// downloading again on its own; a check error never hides an unreadable preference file.
    #[test]
    fn errors_survive_unrelated_changes() {
        let controller = UpdateController::load_from(None);
        controller.lock().state.can_install = true;
        controller.lock().state.phase = UpdatePhase::Available;
        controller.finish_download(Err("connection reset".into()));
        let state = controller.set_update_mode(UpdateMode::Install);
        assert_eq!(
            state.error.map(|error| error.kind),
            Some(UpdateErrorKind::Download)
        );
        assert!(!controller.should_download_automatically());

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        std::fs::write(&path, "not json").unwrap();
        let controller = UpdateController::load_from(Some(path));
        assert!(controller.begin_check());
        controller.finish_check(Err("offline".into()));
        assert_eq!(
            controller.snapshot().error.map(|error| error.kind),
            Some(UpdateErrorKind::Preferences)
        );
    }

    /// A failed check is not remembered, so the next start checks again.
    #[test]
    fn failed_check_is_not_remembered() {
        let controller = UpdateController::load_from(None);
        assert!(controller.begin_check());
        controller.finish_check(Err("offline".into()));
        assert_eq!(controller.lock().stored.last_checked_at, None);
        assert_eq!(controller.snapshot().last_checked_at, None);
    }

    /// Saves a stand-in package for `version` beside the preference file at `path` and returns
    /// what a finished download records for it.
    fn saved_download(path: &std::path::Path, version: &str) -> DownloadedUpdate {
        let directory = path.parent().unwrap().join(DOWNLOADS_DIR_NAME);
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join(package_file_name(version));
        std::fs::write(&file, b"package").unwrap();
        DownloadedUpdate {
            version: version.into(),
            file,
            manifest: serde_json::json!({ "version": version }),
        }
    }

    /// A downloaded update is kept on disk, so after a restart it is ready to install again
    /// without downloading it twice.
    #[test]
    fn downloaded_updates_survive_a_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        controller.finish_download(Ok(saved_download(&path, "2.0.0")));
        let state = UpdateController::load_for_version(Some(path), "1.0.0").snapshot();
        assert_eq!(state.phase, UpdatePhase::Ready);
        assert_eq!(state.version.as_deref(), Some("2.0.0"));
        assert_eq!(state.error, None);
    }

    /// A saved download whose file is gone, or that is no newer than the running version, is
    /// forgotten and its file deleted.
    #[test]
    fn stale_downloads_are_forgotten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        let downloaded = saved_download(&path, "2.0.0");
        controller.finish_download(Ok(downloaded.clone()));
        let state = UpdateController::load_for_version(Some(path.clone()), "2.0.0").snapshot();
        assert_eq!(state.phase, UpdatePhase::Idle);
        assert!(!downloaded.file.exists());

        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        let downloaded = saved_download(&path, "3.0.0");
        controller.finish_download(Ok(downloaded.clone()));
        std::fs::remove_file(&downloaded.file).unwrap();
        let state = UpdateController::load_for_version(Some(path), "1.0.0").snapshot();
        assert_eq!(state.phase, UpdatePhase::Idle);
    }

    /// A newer download replaces the one waiting to install and deletes its file, while a
    /// failed download leaves the earlier update ready to install.
    #[test]
    fn downloads_replace_older_updates_only_once_finished() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        let first = saved_download(&path, "2.0.0");
        controller.finish_download(Ok(first.clone()));
        controller.finish_download(Err("connection reset".into()));
        let state = controller.snapshot();
        assert_eq!(state.phase, UpdatePhase::Ready);
        assert_eq!(state.version.as_deref(), Some("2.0.0"));
        assert_eq!(
            state.error.map(|error| error.kind),
            Some(UpdateErrorKind::Download)
        );
        assert!(first.file.exists());

        controller.finish_download(Ok(saved_download(&path, "2.1.0")));
        assert_eq!(controller.snapshot().version.as_deref(), Some("2.1.0"));
        assert!(!first.file.exists());
    }

    /// An install that the next launch confirms is reported once and its download deleted.
    #[test]
    fn successful_installs_are_reported_and_cleaned_up() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        let downloaded = saved_download(&path, "2.0.0");
        controller.finish_download(Ok(downloaded.clone()));
        controller.request_install().unwrap();
        assert!(controller.take_exit_install().is_some());

        let state = UpdateController::load_for_version(Some(path.clone()), "2.0.0").snapshot();
        assert_eq!(state.updated_to.as_deref(), Some("2.0.0"));
        assert_eq!(state.phase, UpdatePhase::Idle);
        assert_eq!(state.error, None);
        assert!(!downloaded.file.exists());
        let state = UpdateController::load_for_version(Some(path), "2.0.0").snapshot();
        assert_eq!(state.updated_to, None, "reported once");
    }

    /// A failed install is reported on the next launch, keeps its download for a retry, and is
    /// never installed again on quit; restarting into it retries it.
    #[test]
    fn failed_installs_wait_for_the_operator() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        controller.set_update_mode(UpdateMode::Install);
        controller.finish_download(Ok(saved_download(&path, "2.0.0")));
        assert!(controller.take_exit_install().is_some(), "installs on quit");
        controller.record_install_failure("invalid gzip header".into());

        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        let state = controller.snapshot();
        assert_eq!(state.phase, UpdatePhase::Ready);
        assert_eq!(state.updated_to, None);
        let error = state.error.unwrap();
        assert_eq!(error.kind, UpdateErrorKind::Install);
        assert!(
            error.details.contains("invalid gzip header"),
            "{}",
            error.details
        );
        assert!(
            controller.take_exit_install().is_none(),
            "not retried on quit"
        );
        controller.request_install().unwrap();
        assert!(
            controller.take_exit_install().is_some(),
            "retried on restart"
        );

        // An install the app never saw fail, such as a cancelled Windows installer, is reported
        // once the next launch is still on the old version.
        let state = UpdateController::load_for_version(Some(path), "1.0.0").snapshot();
        assert!(
            state
                .error
                .is_some_and(|error| error.details.contains("did not start after the update"))
        );
    }

    /// A version that failed to install never downloads again on its own; a newer one does.
    #[test]
    fn failed_versions_do_not_download_on_their_own() {
        let controller = UpdateController::load_for_version(None, "1.0.0");
        {
            let mut inner = controller.lock();
            inner.state.can_install = true;
            inner.state.phase = UpdatePhase::Available;
            inner.state.version = Some("2.0.0".into());
            inner.stored.failed_install = Some(FailedInstall {
                version: "2.0.0".into(),
                details: "invalid gzip header".into(),
            });
        }
        assert!(!controller.should_download_automatically());
        controller.lock().state.version = Some("2.1.0".into());
        assert!(controller.should_download_automatically());
    }

    /// Only characters that are safe in a file name reach the saved package's name.
    #[test]
    fn package_names_keep_only_safe_characters() {
        assert_eq!(
            package_file_name("1.2.0-alpha.4"),
            "Nightfall-1.2.0-alpha.4.update"
        );
        assert_eq!(package_file_name("../../x"), "Nightfall-.._.._x.update");
    }

    /// A failure stays recorded until a newer version has actually downloaded, so an update that
    /// failed to install never installs on quit again just because a newer one was offered.
    #[test]
    fn failures_clear_only_once_a_newer_version_downloads() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        controller.set_update_mode(UpdateMode::Install);
        controller.finish_download(Ok(saved_download(&path, "2.0.0")));
        assert!(controller.take_exit_install().is_some());
        controller.record_install_failure("invalid gzip header".into());

        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        {
            let mut inner = controller.lock();
            inner.state.can_install = true;
            inner.state.phase = UpdatePhase::Available;
            inner.state.version = Some("2.1.0".into());
        }
        controller.finish_download(Err("connection reset".into()));
        assert_eq!(controller.snapshot().version.as_deref(), Some("2.0.0"));
        assert!(
            controller.take_exit_install().is_none(),
            "2.0.0 still failed"
        );

        controller.finish_download(Ok(saved_download(&path, "2.1.0")));
        let state = controller.snapshot();
        assert_eq!(state.error, None);
        assert!(
            controller.take_exit_install().is_some(),
            "2.1.0 installs on quit"
        );
    }

    /// Turning checks off while a newer version is offered keeps the downloaded update ready.
    #[test]
    fn turning_checks_off_keeps_a_downloaded_update() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        controller.finish_download(Ok(saved_download(&path, "2.0.0")));
        controller.lock().state.phase = UpdatePhase::Available;
        controller.lock().state.version = Some("2.1.0".into());
        let state = controller.set_check_for_updates(false);
        assert_eq!(state.phase, UpdatePhase::Ready);
        assert_eq!(state.version.as_deref(), Some("2.0.0"));
    }

    /// A download that finishes while the app quits to install the earlier one changes nothing,
    /// so the earlier package is still there to install.
    #[test]
    fn downloads_finishing_during_an_install_change_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        let first = saved_download(&path, "2.0.0");
        controller.finish_download(Ok(first.clone()));
        controller.request_install().unwrap();
        let second = saved_download(&path, "2.1.0");
        controller.finish_download(Ok(second.clone()));
        assert_eq!(controller.snapshot().phase, UpdatePhase::Installing);
        assert!(first.file.exists());
        assert!(!second.file.exists());
        assert_eq!(
            controller
                .take_exit_install()
                .map(|install| install.downloaded.version),
            Some("2.0.0".into())
        );
    }

    /// Records the controller keeps on its own never overwrite an unreadable preference file.
    #[test]
    fn downloads_leave_an_unreadable_file_alone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATES_FILE_NAME);
        std::fs::write(&path, "not json").unwrap();
        let controller = UpdateController::load_for_version(Some(path.clone()), "1.0.0");
        controller.finish_download(Ok(saved_download(&path, "2.0.0")));
        assert_eq!(controller.snapshot().phase, UpdatePhase::Ready);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }
}
