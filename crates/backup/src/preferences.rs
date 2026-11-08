// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The host's backup role, kept in the host data directory so it survives restarts and never
//! travels inside a showfile, which the backup copies from its primary.

use std::path::{Path, PathBuf};

use nightfall_websocket::host_preferences::{
    LoadedPreferences, load_preferences, save_preferences,
};
use serde::{Deserialize, Serialize};

/// Which primary this host backs up, if any, and the pairing token it was given there.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub(crate) struct BackupPreferences {
    /// `host:port` of the primary this host follows, or `None` when it runs on its own.
    pub primary_address: Option<String>,
    /// Pairing token the primary issued for this host, sent back as its pairing cookie.
    pub pairing_token: Option<String>,
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

/// Atomically replaces the stored backup role.
pub(crate) fn save(path: Option<&Path>, preferences: &BackupPreferences) -> Result<(), String> {
    let path = path.ok_or("Host data directory is unavailable")?;
    save_preferences(path, preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Preferences round-trip, and a damaged file reads as running on its own with an error.
    #[test]
    fn round_trips_and_fails_to_standalone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.json");
        assert_eq!(load(Some(&path)), (BackupPreferences::default(), None));

        let preferences = BackupPreferences {
            primary_address: Some("192.0.2.10:3000".into()),
            pairing_token: Some("token".into()),
        };
        save(Some(&path), &preferences).unwrap();
        assert_eq!(load(Some(&path)), (preferences, None));

        std::fs::write(&path, "{ not json").unwrap();
        let (loaded, error) = load(Some(&path));
        assert_eq!(loaded, BackupPreferences::default());
        assert!(error.unwrap().contains("backup preferences"));
    }
}
