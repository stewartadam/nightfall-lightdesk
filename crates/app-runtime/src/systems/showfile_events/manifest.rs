// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Lightweight sidecar metadata for showfile discovery and draft recovery.

use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::paths::{
    LEGACY_SHOWFILE_DRAFT_METADATA_FILENAME, SHOWFILE_MANIFEST_FILENAME,
    showfile_snapshot_path_in_dir,
};

const SHOWFILE_MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Rebuildable metadata stored beside a showfile snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShowfileManifest {
    schema_version: u32,
    snapshot: ShowfileSnapshotManifest,
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<ShowfileDraftManifest>,
}

/// Snapshot identity and compatibility metadata needed without parsing showfile JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ShowfileSnapshotManifest {
    state_hash: String,
    snapshot_size_bytes: u64,
    snapshot_modified_at_unix_nanos: u64,
    updated_at_unix_ms: u64,
}

/// Draft lineage used to determine whether recovery should interrupt startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ShowfileDraftManifest {
    based_on_state_hash: String,
}

impl ShowfileManifest {
    /// Return when the sidecar was written for operator-facing discovery metadata.
    pub(super) fn updated_at_unix_ms(&self) -> u64 {
        self.snapshot.updated_at_unix_ms
    }

    /// Return the semantic snapshot hash used for saved-to-draft comparisons.
    pub(super) fn state_hash(&self) -> &str {
        &self.snapshot.state_hash
    }

    /// Return whether both sides of a clean draft match an expected semantic state hash.
    pub(super) fn matches_clean_state_hash(&self, expected_state_hash: &str) -> bool {
        self.snapshot.state_hash == expected_state_hash
            && self
                .draft
                .as_ref()
                .is_some_and(|draft| draft.based_on_state_hash == expected_state_hash)
    }
}

/// Return milliseconds since the Unix epoch for sidecar metadata.
fn current_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Format the internal semantic snapshot hash for persisted sidecar metadata.
pub(super) fn snapshot_hash_label(hash: u64) -> String {
    format!("showfile-snapshot-v1:{hash:016x}")
}

/// Write a sidecar corresponding to snapshot JSON already written into a show-data directory.
pub(super) fn write_showfile_manifest_to_dir(
    show_data_dir: &Path,
    state_hash: u64,
    based_on_state_hash: Option<u64>,
) -> Result<(), String> {
    let snapshot_path = showfile_snapshot_path_in_dir(show_data_dir);
    let (snapshot_size_bytes, snapshot_modified_at_unix_nanos) =
        snapshot_file_identity(&snapshot_path)?;
    let manifest = ShowfileManifest {
        schema_version: SHOWFILE_MANIFEST_SCHEMA_VERSION,
        snapshot: ShowfileSnapshotManifest {
            state_hash: snapshot_hash_label(state_hash),
            snapshot_size_bytes,
            snapshot_modified_at_unix_nanos,
            updated_at_unix_ms: current_unix_millis(),
        },
        draft: based_on_state_hash.map(|hash| ShowfileDraftManifest {
            based_on_state_hash: snapshot_hash_label(hash),
        }),
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("failed to serialize showfile manifest: {error}"))?;
    let path = show_data_dir.join(SHOWFILE_MANIFEST_FILENAME);
    std::fs::write(&path, json).map_err(|error| {
        format!(
            "failed to write showfile manifest {}: {error}",
            path.display()
        )
    })?;
    let legacy_path = show_data_dir.join(LEGACY_SHOWFILE_DRAFT_METADATA_FILENAME);
    match std::fs::remove_file(&legacy_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove legacy showfile metadata {}: {error}",
            legacy_path.display()
        )),
    }
}

/// Read a sidecar and reject metadata that cannot describe the adjacent snapshot file.
pub(super) fn read_current_showfile_manifest_from_dir(
    show_data_dir: &Path,
) -> Result<ShowfileManifest, String> {
    let manifest_path = show_data_dir.join(SHOWFILE_MANIFEST_FILENAME);
    let json = std::fs::read_to_string(&manifest_path).map_err(|error| {
        format!(
            "failed to read showfile manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest: ShowfileManifest = serde_json::from_str(&json).map_err(|error| {
        format!(
            "failed to deserialize showfile manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    if manifest.schema_version != SHOWFILE_MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "unsupported showfile manifest version {} in {}",
            manifest.schema_version,
            manifest_path.display()
        ));
    }

    let snapshot_path = showfile_snapshot_path_in_dir(show_data_dir);
    let (snapshot_size_bytes, snapshot_modified_at_unix_nanos) =
        snapshot_file_identity(&snapshot_path)?;
    if snapshot_size_bytes != manifest.snapshot.snapshot_size_bytes {
        return Err(format!(
            "stale showfile manifest {}: expected snapshot size {}, found {}",
            manifest_path.display(),
            manifest.snapshot.snapshot_size_bytes,
            snapshot_size_bytes
        ));
    }
    if snapshot_modified_at_unix_nanos != manifest.snapshot.snapshot_modified_at_unix_nanos {
        return Err(format!(
            "stale showfile manifest {}: expected snapshot modification time {}, found {}",
            manifest_path.display(),
            manifest.snapshot.snapshot_modified_at_unix_nanos,
            snapshot_modified_at_unix_nanos
        ));
    }

    Ok(manifest)
}

/// Return stable filesystem identity fields used to detect an adjacent snapshot change.
fn snapshot_file_identity(snapshot_path: &Path) -> Result<(u64, u64), String> {
    let metadata = snapshot_path.metadata().map_err(|error| {
        format!(
            "failed to read showfile snapshot metadata {}: {error}",
            snapshot_path.display()
        )
    })?;
    let modified_at_unix_nanos = metadata
        .modified()
        .map_err(|error| {
            format!(
                "failed to read showfile snapshot modification time {}: {error}",
                snapshot_path.display()
            )
        })?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            format!(
                "invalid showfile snapshot modification time {}: {error}",
                snapshot_path.display()
            )
        })?
        .as_nanos()
        .try_into()
        .map_err(|_| {
            format!(
                "showfile snapshot modification time is out of range {}",
                snapshot_path.display()
            )
        })?;
    Ok((metadata.len(), modified_at_unix_nanos))
}
