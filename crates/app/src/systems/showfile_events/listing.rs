// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashSet, path::Path, time::UNIX_EPOCH};

use serde::Serialize;

use super::{
    backup::list_show_data_backup_directories,
    manifest::read_current_showfile_manifest_from_dir,
    paths::{
        DEFAULT_SHOWFILE_NAME, SHOWFILE_DRAFTS_DIR, SHOWFILE_FOLDER_EXTENSION,
        SHOWFILE_SNAPSHOT_FILENAME, showfile_draft_dir_path_in_root, showfile_folder_name,
        showfile_name_from_dir, showfile_name_stem,
    },
};

/// Validation state reported by metadata-only showfile discovery.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum AvailableShowfileValidationStatus {
    /// Snapshot contents have not been parsed during discovery.
    Unchecked,
}

/// Metadata for a showfile available in the app data directory.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvailableShowfile {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) has_saved_snapshot: bool,
    pub(super) modified_ms: Option<u64>,
    pub(super) validation_status: AvailableShowfileValidationStatus,
    pub(super) draft: Option<AvailableShowfileDraft>,
    pub(super) revisions: Vec<AvailableShowfileRevision>,
}

/// Metadata for a single recoverable draft available for a showfile.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvailableShowfileDraft {
    pub(super) showfile_name: String,
    pub(super) name: String,
    pub(super) path: String,
    pub(super) modified_ms: Option<u64>,
    pub(super) saved_modified_ms: Option<u64>,
    pub(super) validation_status: AvailableShowfileValidationStatus,
}

/// Metadata for a restorable showfile backup revision.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvailableShowfileRevision {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) modified_ms: Option<u64>,
    pub(super) validation_status: AvailableShowfileValidationStatus,
}

/// Response returned by the available showfiles HTTP endpoint.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvailableShowfilesResponse {
    pub(super) showfiles: Vec<AvailableShowfile>,
}

/// Response returned by the targeted available-draft endpoint.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvailableShowfileDraftResponse {
    pub(super) draft: Option<AvailableShowfileDraft>,
}

/// Discover showfile folders in a root directory.
pub(super) fn list_available_showfiles_in_root(
    root: &Path,
) -> Result<Vec<AvailableShowfile>, String> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "failed to read showfile directory {}: {}",
                root.display(),
                error
            ));
        }
    };

    let mut showfiles = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "failed to read showfile directory entry in {}: {}",
                root.display(),
                error
            )
        })?;
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !file_name.ends_with(&format!(".{SHOWFILE_FOLDER_EXTENSION}")) {
            continue;
        }

        let snapshot_path = path.join(SHOWFILE_SNAPSHOT_FILENAME);
        if !snapshot_path.is_file() {
            continue;
        }

        let name = showfile_name_from_dir(&path)?;
        let modified_ms = snapshot_path
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64);
        let saved_manifest = read_current_showfile_manifest_from_dir(&path).ok();
        let draft = available_showfile_draft_in_root(
            root,
            &name,
            saved_manifest
                .as_ref()
                .map(|manifest| manifest.state_hash()),
            modified_ms,
        )?;
        showfiles.push(AvailableShowfile {
            name,
            path: path.display().to_string(),
            has_saved_snapshot: true,
            modified_ms,
            validation_status: AvailableShowfileValidationStatus::Unchecked,
            draft,
            revisions: list_showfile_revisions(&path)?,
        });
    }

    append_orphaned_showfile_drafts(root, &mut showfiles)?;
    sort_available_showfiles(&mut showfiles);
    Ok(showfiles)
}

/// Discover the recoverable draft relevant to one showfile name.
pub(super) fn available_showfile_draft_for_name_in_root(
    root: &Path,
    requested_name: &str,
) -> Result<Option<AvailableShowfileDraft>, String> {
    let name = showfile_name_stem(Some(requested_name))?;
    let saved_dir = root.join(showfile_folder_name(Some(&name))?);
    let saved_snapshot_path = saved_dir.join(SHOWFILE_SNAPSHOT_FILENAME);
    let saved_modified_ms = snapshot_modified_ms(&saved_snapshot_path);
    let saved_manifest = read_current_showfile_manifest_from_dir(&saved_dir).ok();
    available_showfile_draft_in_root(
        root,
        &name,
        saved_manifest
            .as_ref()
            .map(|manifest| manifest.state_hash()),
        saved_modified_ms,
    )
}

/// Return the single draft metadata for a showfile when its draft folder exists.
fn available_showfile_draft_in_root(
    root: &Path,
    showfile_name: &str,
    saved_state_hash: Option<&str>,
    saved_modified_ms: Option<u64>,
) -> Result<Option<AvailableShowfileDraft>, String> {
    let draft_dir = showfile_draft_dir_path_in_root(root, Some(showfile_name))?;
    available_showfile_draft_from_dir(
        showfile_name,
        &draft_dir,
        saved_state_hash,
        saved_modified_ms,
    )
}

/// Return draft metadata for a draft directory when it is recoverable.
fn available_showfile_draft_from_dir(
    showfile_name: &str,
    draft_dir: &Path,
    saved_state_hash: Option<&str>,
    saved_modified_ms: Option<u64>,
) -> Result<Option<AvailableShowfileDraft>, String> {
    let snapshot_path = draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME);
    if !snapshot_path.is_file() {
        return Ok(None);
    }
    let manifest = read_current_showfile_manifest_from_dir(draft_dir).ok();
    if saved_state_hash.is_some_and(|saved_state_hash| {
        manifest
            .as_ref()
            .is_some_and(|manifest| manifest.matches_clean_state_hash(saved_state_hash))
    }) {
        return Ok(None);
    }

    let name = draft_dir
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| format!("invalid draft showfile directory {}", draft_dir.display()))?
        .to_string();
    let modified_ms = snapshot_modified_ms(&snapshot_path);
    Ok(Some(AvailableShowfileDraft {
        showfile_name: showfile_name.to_string(),
        name,
        path: draft_dir.display().to_string(),
        modified_ms: manifest
            .as_ref()
            .map(|manifest| manifest.updated_at_unix_ms())
            .or(modified_ms),
        saved_modified_ms,
        validation_status: AvailableShowfileValidationStatus::Unchecked,
    }))
}

/// Append draft folders that do not have a corresponding saved showfile folder.
fn append_orphaned_showfile_drafts(
    root: &Path,
    showfiles: &mut Vec<AvailableShowfile>,
) -> Result<(), String> {
    let mut known_showfile_names = showfiles
        .iter()
        .map(|showfile| showfile.name.clone())
        .collect::<HashSet<_>>();
    let drafts_root = root.join(SHOWFILE_DRAFTS_DIR);
    let entries = match std::fs::read_dir(&drafts_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "failed to read showfile drafts directory {}: {}",
                drafts_root.display(),
                error
            ));
        }
    };

    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "failed to read showfile draft directory entry in {}: {}",
                drafts_root.display(),
                error
            )
        })?;
        let draft_dir = entry.path();
        let Some(file_name) = draft_dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !file_name.ends_with(&format!(".{SHOWFILE_FOLDER_EXTENSION}")) {
            continue;
        }

        let showfile_name = showfile_name_from_dir(&draft_dir)?;
        if known_showfile_names.contains(&showfile_name) {
            continue;
        }
        let Some(draft) =
            available_showfile_draft_from_dir(&showfile_name, &draft_dir, None, None)?
        else {
            continue;
        };
        known_showfile_names.insert(showfile_name.clone());

        showfiles.push(AvailableShowfile {
            name: showfile_name.clone(),
            path: root
                .join(format!("{showfile_name}.{SHOWFILE_FOLDER_EXTENSION}"))
                .display()
                .to_string(),
            has_saved_snapshot: false,
            modified_ms: None,
            validation_status: AvailableShowfileValidationStatus::Unchecked,
            draft: Some(draft),
            revisions: Vec::new(),
        });
    }

    Ok(())
}

/// Sort available showfiles with the default show first and names stable after that.
fn sort_available_showfiles(showfiles: &mut [AvailableShowfile]) {
    showfiles.sort_by(|left, right| {
        (
            left.name != DEFAULT_SHOWFILE_NAME,
            left.name.to_ascii_lowercase(),
            &left.name,
        )
            .cmp(&(
                right.name != DEFAULT_SHOWFILE_NAME,
                right.name.to_ascii_lowercase(),
                &right.name,
            ))
    });
}

/// Return backup revisions for one show folder in newest-first order.
fn list_showfile_revisions(show_data_dir: &Path) -> Result<Vec<AvailableShowfileRevision>, String> {
    let mut revision_dirs = list_show_data_backup_directories(show_data_dir)?;
    revision_dirs.reverse();

    let mut revisions = Vec::with_capacity(revision_dirs.len());
    for revision_dir in revision_dirs {
        let snapshot_path = revision_dir.join(SHOWFILE_SNAPSHOT_FILENAME);
        if !snapshot_path.is_file() {
            continue;
        }

        let Some(name) = revision_dir
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .map(str::to_string)
        else {
            continue;
        };

        let modified_ms = snapshot_modified_ms(&snapshot_path);
        revisions.push(AvailableShowfileRevision {
            name,
            path: revision_dir.display().to_string(),
            modified_ms,
            validation_status: AvailableShowfileValidationStatus::Unchecked,
        });
    }

    Ok(revisions)
}

/// Return the filesystem modification timestamp for a snapshot when available.
fn snapshot_modified_ms(snapshot_path: &Path) -> Option<u64> {
    snapshot_path
        .metadata()
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}
