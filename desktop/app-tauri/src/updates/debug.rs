// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Debug builds only: puts the update status into any state, so About and the update notices
//! can be looked at in every configuration without a published release or an update service.
//!
//! The web inspector console of a debug build gets `window.nightfallUpdates`:
//!
//! ```js
//! nightfallUpdates.presets()              // names of the ready-made states
//! nightfallUpdates.show("check-only-available")
//! nightfallUpdates.set({ phase: "downloading", progress: { downloadedBytes: 1, totalBytes: 4 } })
//! nightfallUpdates.reset()                // back to the real status
//! ```
//!
//! A shown state is only displayed: nothing is saved, and no update is found or downloaded, so
//! Download and Restart to update do nothing for a version the controller never found. Switching
//! `canInstall` does change how real checks behave, so a check from About afterwards acts like a
//! build that can or cannot install updates itself. A preset that is checking, downloading or
//! ready also holds back real checks until `reset()`, as the real phase would.

use std::{
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Deserializer};
use tauri::{AppHandle, Runtime};

use super::{
    ControllerInner, DownloadProgress, UpdateController, UpdateError, UpdateErrorKind, UpdateMode,
    UpdatePhase, UpdateState, broadcast, public_key,
};

/// Script that publishes `window.nightfallUpdates` in every window of a debug build.
const CONSOLE_SCRIPT: &str = include_str!("debug.js");

/// Counts shown presets, so each one offers a version the update notices have not seen yet and
/// announces it again.
static PRESETS_SHOWN: AtomicU32 = AtomicU32::new(0);

/// Names of the ready-made states [`preset`] builds, in the order `presets()` lists them.
const PRESET_NAMES: &[&str] = &[
    "never-checked",
    "up-to-date",
    "checking",
    "available",
    "downloading",
    "downloading-unknown-size",
    "ready",
    "install-failed",
    "installing",
    "updated",
    "check-failed",
    "download-failed",
    "preferences-failed",
    "checks-off",
    "check-only-up-to-date",
    "check-only-available",
    "check-only-failed",
];

/// Changes to the shown update status. A missing field keeps its value; `null` clears a field
/// that can be empty.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateStatePatch {
    can_install: Option<bool>,
    check_for_updates: Option<bool>,
    update_mode: Option<UpdateMode>,
    phase: Option<UpdatePhase>,
    #[serde(default, deserialize_with = "present")]
    version: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    progress: Option<Option<DownloadProgress>>,
    #[serde(default, deserialize_with = "present")]
    last_checked_at: Option<Option<u64>>,
    #[serde(default, deserialize_with = "present")]
    error: Option<Option<UpdateError>>,
    #[serde(default, deserialize_with = "present")]
    updated_to: Option<Option<String>>,
}

/// Reads a field that is present in the patch, so `null` clears it while a missing field, which
/// never reaches this function, keeps it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer).map(Some)
}

impl UpdateStatePatch {
    /// Writes every field the patch carries into `state`.
    fn apply(self, state: &mut UpdateState) {
        /// Replaces `target` with the patched value when the patch carries one.
        fn assign<T>(target: &mut T, value: Option<T>) {
            if let Some(value) = value {
                *target = value;
            }
        }
        assign(&mut state.can_install, self.can_install);
        assign(&mut state.check_for_updates, self.check_for_updates);
        assign(&mut state.update_mode, self.update_mode);
        assign(&mut state.phase, self.phase);
        assign(&mut state.version, self.version);
        assign(&mut state.progress, self.progress);
        assign(&mut state.last_checked_at, self.last_checked_at);
        assign(&mut state.error, self.error);
        assign(&mut state.updated_to, self.updated_to);
    }
}

/// Seconds since the Unix epoch now, for presets that just checked.
fn now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_secs())
}

/// Builds the patch for the preset `name`, applied on top of the real status, or `None` for an
/// unknown name. Each call offers a newer version than the last, because the update notices
/// announce each version only once.
fn preset(name: &str) -> Option<UpdateStatePatch> {
    let shown = PRESETS_SHOWN.fetch_add(1, Ordering::Relaxed);
    let version = || Some(Some(format!("9.9.{shown}")));
    let error = |kind, details: &str| Some(Some(UpdateError::new(kind, details)));
    let check_error = || {
        error(
            UpdateErrorKind::Check,
            "error sending request for url (https://nightfall.live/api/v1/updates/alpha/darwin/aarch64/app/0.1.0): connection refused",
        )
    };
    let base = UpdateStatePatch {
        can_install: Some(true),
        check_for_updates: Some(true),
        phase: Some(UpdatePhase::Idle),
        version: Some(None),
        progress: Some(None),
        last_checked_at: Some(now()),
        error: Some(None),
        updated_to: Some(None),
        ..UpdateStatePatch::default()
    };
    let check_only = UpdateStatePatch {
        can_install: Some(false),
        ..base.clone()
    };
    let patch = match name {
        "never-checked" => UpdateStatePatch {
            last_checked_at: Some(None),
            ..base
        },
        "up-to-date" => base,
        "checking" => UpdateStatePatch {
            phase: Some(UpdatePhase::Checking),
            ..base
        },
        "available" => UpdateStatePatch {
            phase: Some(UpdatePhase::Available),
            version: version(),
            update_mode: Some(UpdateMode::Notify),
            ..base
        },
        "downloading" => UpdateStatePatch {
            phase: Some(UpdatePhase::Downloading),
            version: version(),
            progress: Some(Some(DownloadProgress {
                downloaded_bytes: 20 << 20,
                total_bytes: Some(48 << 20),
            })),
            ..base
        },
        "downloading-unknown-size" => UpdateStatePatch {
            phase: Some(UpdatePhase::Downloading),
            version: version(),
            progress: Some(Some(DownloadProgress {
                downloaded_bytes: 12 << 20,
                total_bytes: None,
            })),
            ..base
        },
        "ready" => UpdateStatePatch {
            phase: Some(UpdatePhase::Ready),
            version: version(),
            ..base
        },
        "install-failed" => {
            let version = version();
            let failed = version.clone().flatten().unwrap_or_default();
            UpdateStatePatch {
                phase: Some(UpdatePhase::Ready),
                error: error(
                    UpdateErrorKind::Install,
                    &format!("Nightfall {failed}: invalid gzip header"),
                ),
                version,
                ..base
            }
        }
        "updated" => UpdateStatePatch {
            updated_to: Some(Some(env!("CARGO_PKG_VERSION").to_owned())),
            ..base
        },
        "installing" => UpdateStatePatch {
            phase: Some(UpdatePhase::Installing),
            version: version(),
            ..base
        },
        "check-failed" => UpdateStatePatch {
            error: check_error(),
            ..base
        },
        "download-failed" => UpdateStatePatch {
            phase: Some(UpdatePhase::Available),
            version: version(),
            error: error(
                UpdateErrorKind::Download,
                "the signature of the downloaded update is invalid",
            ),
            ..base
        },
        "preferences-failed" => UpdateStatePatch {
            error: error(
                UpdateErrorKind::Preferences,
                "Could not save update preferences: Permission denied (os error 13)",
            ),
            ..base
        },
        "checks-off" => UpdateStatePatch {
            check_for_updates: Some(false),
            ..base
        },
        "check-only-up-to-date" => check_only,
        "check-only-available" => UpdateStatePatch {
            phase: Some(UpdatePhase::Available),
            version: version(),
            ..check_only
        },
        "check-only-failed" => UpdateStatePatch {
            error: check_error(),
            ..check_only
        },
        _ => return None,
    };
    Some(patch)
}

impl UpdateController {
    /// Replaces the shown status with `patch` applied to it, leaving any found or downloaded
    /// update and the saved preferences alone.
    fn debug_apply(&self, patch: UpdateStatePatch) -> UpdateState {
        let mut inner = self.lock();
        patch.apply(&mut inner.state);
        inner.state.clone()
    }

    /// Shows the real status again: the saved preferences, whether this build can install
    /// updates, and the update the controller actually found or downloaded.
    fn debug_reset(&self) -> UpdateState {
        let mut inner = self.lock();
        let ControllerInner {
            state,
            stored,
            found,
            ..
        } = &mut *inner;
        state.can_install = public_key().is_some();
        state.check_for_updates = stored.check_for_updates;
        state.update_mode = stored.update_mode;
        state.last_checked_at = stored.last_checked_at;
        state.progress = None;
        state.updated_to = None;
        (state.phase, state.version) = match (stored.downloaded.as_ref(), found.as_ref()) {
            (Some(downloaded), _) => (UpdatePhase::Ready, Some(downloaded.version.clone())),
            (None, Some(update)) => (UpdatePhase::Available, Some(update.version.clone())),
            (None, None) => (UpdatePhase::Idle, None),
        };
        state.error = super::install_error(stored, state.version.as_deref());
        inner.state.clone()
    }
}

/// Builds the plugin that publishes `window.nightfallUpdates` in every window.
pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("update-debug")
        .js_init_script(CONSOLE_SCRIPT.to_owned())
        .build()
}

#[tauri::command]
/// Applies `patch` to the shown update status and tells every window.
pub(crate) fn debug_update_state<R: Runtime>(
    app: AppHandle<R>,
    controller: tauri::State<'_, Arc<UpdateController>>,
    patch: UpdateStatePatch,
) -> UpdateState {
    let state = controller.debug_apply(patch);
    broadcast(&app, &controller);
    state
}

#[tauri::command]
/// Shows the ready-made state `name` and tells every window. Fails for an unknown name, listing
/// the known ones.
pub(crate) fn debug_update_preset<R: Runtime>(
    app: AppHandle<R>,
    controller: tauri::State<'_, Arc<UpdateController>>,
    name: String,
) -> Result<UpdateState, String> {
    let patch = preset(&name).ok_or_else(|| {
        format!(
            "Unknown update preset {name:?}; choose one of {}",
            PRESET_NAMES.join(", ")
        )
    })?;
    let state = controller.debug_apply(patch);
    broadcast(&app, &controller);
    Ok(state)
}

#[tauri::command]
/// Lists the names [`debug_update_preset`] accepts.
pub(crate) fn debug_update_presets() -> &'static [&'static str] {
    PRESET_NAMES
}

#[tauri::command]
/// Shows the real update status again and tells every window.
pub(crate) fn debug_reset_update_state<R: Runtime>(
    app: AppHandle<R>,
    controller: tauri::State<'_, Arc<UpdateController>>,
) -> UpdateState {
    let state = controller.debug_reset();
    broadcast(&app, &controller);
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every listed preset builds, and an unlisted name is refused.
    #[test]
    fn every_listed_preset_exists() {
        for name in PRESET_NAMES {
            assert!(preset(name).is_some(), "{name} should be a preset");
        }
        assert!(preset("no-such-state").is_none());
    }

    /// A patch changes only the fields it carries, and `null` clears an optional field.
    #[test]
    fn patch_changes_only_given_fields() {
        let controller = UpdateController::load_from(None);
        controller.debug_apply(preset("ready").unwrap());
        let patch: UpdateStatePatch =
            serde_json::from_value(serde_json::json!({ "canInstall": false, "version": null }))
                .unwrap();
        let state = controller.debug_apply(patch);
        assert!(!state.can_install);
        assert_eq!(state.version, None);
        assert_eq!(state.phase, UpdatePhase::Ready);
        assert!(state.last_checked_at.is_some());
    }

    /// A misspelled field is refused instead of silently changing nothing.
    #[test]
    fn patch_refuses_unknown_fields() {
        let patch =
            serde_json::from_value::<UpdateStatePatch>(serde_json::json!({ "phaze": "ready" }));
        assert!(patch.is_err());
    }

    /// Resetting forgets a shown state and restores the saved preferences and the real phase.
    #[test]
    fn reset_restores_the_real_status() {
        let controller = UpdateController::load_from(None);
        let real = controller.snapshot();
        controller.debug_apply(preset("check-only-failed").unwrap());
        controller.debug_apply(preset("checks-off").unwrap());
        assert_eq!(controller.debug_reset(), real);
    }

    /// A shown state saves nothing, so the preference file is never written.
    #[test]
    fn shown_states_are_not_saved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(super::super::UPDATES_FILE_NAME);
        let controller = UpdateController::load_from(Some(path.clone()));
        controller.debug_apply(preset("checks-off").unwrap());
        assert!(!path.exists());
    }
}
