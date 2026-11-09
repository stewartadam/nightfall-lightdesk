// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The host's backup role, kept in the host data directory so it survives restarts and never
//! travels inside a showfile, which the backup copies from its primary.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
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

/// The preferences this process last loaded or changed, with the path they belong to.
///
/// The lock also serializes changes, which the world, the link worker and the HTTP routes all
/// make. Keeping the last value means a change that could not be stored still holds for the rest
/// of the session, even after a show load restores the role.
///
/// Kept per path, though the app only uses one, so tests on separate paths stay independent.
static CURRENT: LazyLock<Mutex<HashMap<Option<PathBuf>, BackupPreferences>>> =
    LazyLock::new(Mutex::default);

/// Returns this session's preferences for `path`: the last ones this process loaded or changed,
/// or the stored ones on first use, with the error that kept them from being read, if any.
pub(crate) fn current(path: Option<&Path>) -> (BackupPreferences, Option<String>) {
    let mut current = CURRENT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = path.map(Path::to_path_buf);
    if let Some(preferences) = current.get(&key) {
        return (preferences.clone(), None);
    }
    let (preferences, error) = load(path);
    // Defaults standing in for an unreadable file are not kept, so every restore reports it.
    if error.is_none() {
        current.insert(key, preferences.clone());
    }
    (preferences, error)
}

/// Changes this session's preferences with `update` and stores the result, so a change to one
/// field keeps the others, even while another thread changes a different field.
///
/// Returns the changed preferences with the error that kept them from being stored, if any. The
/// change holds for the rest of the session either way, so a caller can act on it even when the
/// host data directory is unavailable.
pub(crate) fn update(
    path: Option<&Path>,
    update: impl FnOnce(&mut BackupPreferences),
) -> (BackupPreferences, Option<String>) {
    let mut current = CURRENT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = path.map(Path::to_path_buf);
    let mut preferences = match current.get(&key) {
        Some(preferences) => preferences.clone(),
        None => load(path).0,
    };
    update(&mut preferences);
    let error = save(path, &preferences).err();
    current.insert(key, preferences.clone());
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

    /// A change that cannot be stored still holds for the rest of the session, so restoring the
    /// role after a show load does not undo it.
    #[test]
    fn unsaved_change_holds_for_the_session() {
        let directory = tempfile::tempdir().unwrap();
        let blocker = directory.path().join("not-a-directory");
        std::fs::write(&blocker, "").unwrap();
        let path = blocker.join("backup.json");

        let (updated, error) = update(Some(&path), |stored| stored.epoch = 7);
        assert!(error.is_some());
        assert_eq!(updated.epoch, 7);
        assert_eq!(current(Some(&path)), (updated, None));
    }
}
