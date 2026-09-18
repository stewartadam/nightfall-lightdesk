// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use nightfall_showfile::{parse_showfile_snapshot_json, serialize_showfile_snapshot_json};

use super::{
    ShowfileMetadata, ShowfileSnapshot,
    manifest::write_showfile_manifest_to_dir,
    paths::{SHOWFILE_SNAPSHOT_FILENAME, showfile_path, showfile_snapshot_path_from_path},
};

/// Replace a show-data directory with a prepared temporary directory.
pub(super) fn replace_showfile_dir_with_temp(
    temp_dir: &Path,
    destination_dir: &Path,
) -> Result<(), String> {
    if destination_dir.exists() {
        std::fs::remove_dir_all(destination_dir).map_err(|error| {
            format!(
                "failed to replace existing showfile directory {}: {}",
                destination_dir.display(),
                error
            )
        })?;
    }
    std::fs::rename(temp_dir, destination_dir).map_err(|error| {
        format!(
            "failed to move showfile directory {} to {}: {}",
            temp_dir.display(),
            destination_dir.display(),
            error
        )
    })
}

/// Build a unique temporary directory path beside a show-data directory.
pub(super) fn temporary_showfile_dir(parent: &Path, folder_name: &str) -> PathBuf {
    parent.join(format!(
        ".{folder_name}.tmp-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ))
}

/// Write a snapshot and its matching discovery sidecar into a show-data directory.
pub(super) fn write_showfile_snapshot_with_manifest_to_dir(
    showfile_snapshot: &ShowfileSnapshot,
    show_data_dir: &Path,
    state_hash: u64,
    based_on_state_hash: Option<u64>,
) -> Result<(), String> {
    std::fs::create_dir_all(show_data_dir).map_err(|error| {
        format!(
            "failed to create showfile directory {}: {}",
            show_data_dir.display(),
            error
        )
    })?;
    let path = show_data_dir.join(SHOWFILE_SNAPSHOT_FILENAME);
    let json = serialize_showfile_snapshot_json(showfile_snapshot)?;
    std::fs::write(&path, json)
        .map_err(|error| format!("failed to write showfile {}: {}", path.display(), error))?;
    write_showfile_manifest_to_dir(show_data_dir, state_hash, based_on_state_hash)
}

/// Best-effort repair a sidecar for a selected snapshot already parsed from disk.
pub(super) fn repair_showfile_manifest_for_existing_snapshot_to_dir(
    show_data_dir: &Path,
    state_hash: u64,
    based_on_state_hash: Option<u64>,
) {
    if let Err(error) = write_showfile_manifest_for_existing_snapshot_to_dir(
        show_data_dir,
        state_hash,
        based_on_state_hash,
    ) {
        tracing::warn!(
            show_data_dir = %show_data_dir.display(),
            "Failed to repair rebuildable showfile manifest: {error}"
        );
    }
}

/// Write a sidecar for a selected snapshot that has already been parsed from disk.
fn write_showfile_manifest_for_existing_snapshot_to_dir(
    show_data_dir: &Path,
    state_hash: u64,
    based_on_state_hash: Option<u64>,
) -> Result<(), String> {
    write_showfile_manifest_to_dir(show_data_dir, state_hash, based_on_state_hash)
}

/// Read and deserialize a canonical or named showfile JSON from disk.
pub(super) fn read_showfile_snapshot(name: Option<&str>) -> Result<ShowfileSnapshot, String> {
    let path = showfile_path(name)?;
    read_showfile_snapshot_from_path(&path)
}

/// Read and deserialize a showfile snapshot from an explicit path.
pub(super) fn read_showfile_snapshot_from_path(path: &Path) -> Result<ShowfileSnapshot, String> {
    let path = showfile_snapshot_path_from_path(path);
    let filename = path.display().to_string();

    tracing::debug!("Loading showfile: {}", filename);
    let json = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to open showfile {}: {}", filename, error))?;

    parse_showfile_snapshot_json(&json, &filename)
}

/// Hash a showfile snapshot after replacing volatile save metadata with a stable baseline.
pub(super) fn hash_showfile_snapshot_with_metadata(
    snapshot: &ShowfileSnapshot,
    metadata: &ShowfileMetadata,
) -> Result<u64, String> {
    let mut snapshot = snapshot.clone();
    snapshot.metadata = metadata.clone();
    let json = serialize_showfile_snapshot_json(&snapshot)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    json.hash(&mut hasher);
    Ok(hasher.finish())
}
