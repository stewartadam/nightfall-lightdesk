// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The host's backup role, kept in the host data directory so it survives restarts and never
//! travels inside a showfile, which the backup copies from its primary.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use nightfall_websocket::host_preferences::{
    LoadedPreferences, load_preferences, save_preferences,
};
use serde::{Deserialize, Serialize};

/// Which primary this host backs up, if any, the pairing token it was given there, and how it
/// fails over.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub(crate) struct BackupPreferences {
    /// `host:port` of the primary this host follows, or `None` when it runs on its own.
    pub primary_address: Option<String>,
    /// Pairing token the primary issued for this host, sent back as its pairing cookie.
    pub pairing_token: Option<String>,
    /// Takeover epoch: raised by every takeover and adopted from the primary while following,
    /// so the host that took over last can be told apart.
    pub epoch: u64,
    /// `host:port` of the host that last backed this one up, checked while this host runs as a
    /// primary in case it took over meanwhile.
    pub backup_peer: Option<String>,
    /// Whether this host takes over on its own when its primary stops answering.
    pub auto_take_over: bool,
}

impl Default for BackupPreferences {
    /// Runs on its own, with automatic takeover on for whenever it becomes a backup.
    fn default() -> Self {
        Self {
            primary_address: None,
            pairing_token: None,
            epoch: 0,
            backup_peer: None,
            auto_take_over: true,
        }
    }
}

/// Returns the preference file path in the host data directory.
pub(crate) fn preferences_path() -> Option<PathBuf> {
    nightfall::nightfall_data_dir().map(|directory| directory.join("backup.json"))
}

/// Loads the backup role, falling back to running on its own when the file is absent or damaged.
///
/// A damaged file never turns a host into a backup, since that would silence its output.
pub(crate) fn load(path: Option<&Path>) -> (BackupPreferences, Option<String>) {
    let Some(path) = path else {
        return (BackupPreferences::default(), None);
    };
    match load_preferences(path) {
        LoadedPreferences::Loaded(preferences) => (preferences, None),
        LoadedPreferences::Missing => (BackupPreferences::default(), None),
        LoadedPreferences::Unreadable(error) => (
            BackupPreferences::default(),
            Some(format!("Could not read backup preferences: {error}")),
        ),
    }
}

/// Serializes changes to the stored preferences, which the world, the link worker and the HTTP
/// routes all make.
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

/// Loads the stored preferences, changes them with `update`, and stores the result, so a change
/// to one field keeps the others, even while another thread changes a different field.
///
/// Returns the changed preferences with the error that kept them from being stored, if any, so a
/// caller can act on them even when the host data directory is unavailable.
pub(crate) fn update(
    path: Option<&Path>,
    update: impl FnOnce(&mut BackupPreferences),
) -> (BackupPreferences, Option<String>) {
    let _guard = UPDATE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut preferences, _) = load(path);
    update(&mut preferences);
    let error = save(path, &preferences).err();
    (preferences, error)
}

/// Atomically replaces the stored backup role.
pub(crate) fn save(path: Option<&Path>, preferences: &BackupPreferences) -> Result<(), String> {
    let path = path.ok_or("Host data directory is unavailable")?;
    save_preferences(path, preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Preferences round-trip, updates keep the other fields, a file without the automatic
    /// takeover field turns it on, and a damaged file reads as running on its own with an error.
    #[test]
    fn round_trips_and_fails_to_standalone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.json");
        assert_eq!(load(Some(&path)), (BackupPreferences::default(), None));

        let preferences = BackupPreferences {
            primary_address: Some("192.0.2.10:3000".into()),
            pairing_token: Some("token".into()),
            epoch: 3,
            backup_peer: Some("192.0.2.11:3000".into()),
            auto_take_over: false,
        };
        save(Some(&path), &preferences).unwrap();
        assert_eq!(load(Some(&path)), (preferences, None));

        let (updated, error) = update(Some(&path), |stored| stored.epoch = 4);
        assert_eq!(error, None);
        assert_eq!(updated.backup_peer.as_deref(), Some("192.0.2.11:3000"));
        assert_eq!(load(Some(&path)).0.epoch, 4);

        std::fs::write(&path, r#"{"primary_address": null}"#).unwrap();
        assert!(load(Some(&path)).0.auto_take_over);

        std::fs::write(&path, "{ not json").unwrap();
        let (loaded, error) = load(Some(&path));
        assert_eq!(loaded, BackupPreferences::default());
        assert!(error.unwrap().contains("backup preferences"));
    }
}
