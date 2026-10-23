// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! JSON preference files stored in the host data directory, independent of any showfile.

use std::{io::Write, path::Path};

use serde::{Serialize, de::DeserializeOwned};

/// Outcome of reading a host preference file.
#[derive(Debug, PartialEq, Eq)]
pub enum LoadedPreferences<T> {
    /// No file exists yet; the caller should use its defaults.
    Missing,
    /// The file was read and parsed.
    Loaded(T),
    /// The file exists but could not be read or parsed; the message explains why.
    Unreadable(String),
}

/// Reads and parses a host preference file, distinguishing a first run from a damaged or
/// inaccessible file so callers can avoid overwriting choices they failed to read.
pub fn load_preferences<T: DeserializeOwned>(path: &Path) -> LoadedPreferences<T> {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => LoadedPreferences::Loaded(value),
            Err(error) => LoadedPreferences::Unreadable(error.to_string()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LoadedPreferences::Missing,
        Err(error) => LoadedPreferences::Unreadable(error.to_string()),
    }
}

/// Atomically replaces a host preference file so an interrupted write leaves the previous
/// contents intact.
pub fn save_preferences<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Host preference path has no directory")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}
