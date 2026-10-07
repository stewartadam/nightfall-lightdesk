// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::path::{Path, PathBuf};

use clonetree::{Options, clone_tree};
use jiff::Zoned;

use super::paths::{SHOWFILE_FOLDER_EXTENSION, showfile_backup_root_dir, showfile_name_from_dir};

/// Copy a directory tree recursively, preserving files and subdirectories.
pub(super) fn copy_directory_recursive(
    source_dir: &Path,
    destination_dir: &Path,
) -> Result<(), String> {
    copy_directory_recursive_excluding_names(source_dir, destination_dir, &[])
}

/// Copy a directory tree recursively while skipping entries with excluded names.
pub(super) fn copy_directory_recursive_excluding_names(
    source_dir: &Path,
    destination_dir: &Path,
    excluded_names: &[&str],
) -> Result<(), String> {
    let options = clone_tree_options_excluding_names(excluded_names);
    clone_tree(source_dir, destination_dir, &options).map_err(|error| {
        format!(
            "failed to clone show-data directory {} to {}: {}",
            source_dir.display(),
            destination_dir.display(),
            error
        )
    })
}

/// Build clonetree options that skip any source entry matching an excluded file name.
fn clone_tree_options_excluding_names(excluded_names: &[&str]) -> Options {
    excluded_names.iter().fold(Options::new(), |options, name| {
        options.glob(format!("!{name}"))
    })
}

/// Back up a show-data directory and prune older retained revisions if configured.
pub(super) fn backup_show_data_directory(
    show_data_dir: &Path,
    backups_to_keep: u32,
) -> Result<(), String> {
    if !show_data_dir.exists() {
        return Ok(());
    }

    let backup_dir = next_show_data_backup_dir(show_data_dir)?;
    copy_directory_recursive(show_data_dir, &backup_dir)?;

    if backups_to_keep == 0 {
        return Ok(());
    }

    prune_show_data_backup_directories(show_data_dir, backups_to_keep)
}

/// Resolve a unique timestamped backup directory under the data-dir backups folder.
fn next_show_data_backup_dir(show_data_dir: &Path) -> Result<PathBuf, String> {
    let show_name = showfile_name_from_dir(show_data_dir)?;
    let backup_parent = showfile_backup_root_dir(show_data_dir)?;
    std::fs::create_dir_all(&backup_parent).map_err(|error| {
        format!(
            "failed to create showfile backup directory {}: {}",
            backup_parent.display(),
            error
        )
    })?;
    let timestamp = Zoned::now().strftime("%Y%m%d-%H%M%S").to_string();

    for sequence in 0..1000 {
        let mut candidate_name = format!("{show_name}-{timestamp}");
        if sequence > 0 {
            candidate_name.push_str(&format!("-{sequence}"));
        }
        candidate_name.push_str(&format!(".{SHOWFILE_FOLDER_EXTENSION}"));
        let candidate = backup_parent.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "failed to allocate unique show-data backup directory for {}",
        show_data_dir.display()
    ))
}

/// Return timestamped backup directories for a show folder in oldest-first order.
pub(super) fn list_show_data_backup_directories(
    show_data_dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    let show_name = showfile_name_from_dir(show_data_dir)?;
    let backup_parent = showfile_backup_root_dir(show_data_dir)?;
    if !backup_parent.exists() {
        return Ok(Vec::new());
    }
    let backup_prefix = format!("{show_name}-");

    let mut backup_dirs = Vec::new();
    let entries = std::fs::read_dir(&backup_parent).map_err(|error| {
        format!(
            "failed to read show-data backup parent directory {}: {}",
            backup_parent.display(),
            error
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "failed to read show-data backup entry in {}: {}",
                backup_parent.display(),
                error
            )
        })?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "failed to read show-data backup file type in {}: {}",
                backup_parent.display(),
                error
            )
        })?;
        if !file_type.is_dir() {
            continue;
        }

        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if let Some(sort_key) = show_data_backup_sort_key(file_name, &backup_prefix) {
            backup_dirs.push((sort_key, entry.path()));
        }
    }

    backup_dirs.sort_by_key(|(sort_key, _)| sort_key.clone());
    Ok(backup_dirs.into_iter().map(|(_, path)| path).collect())
}

/// Parse a backup directory name into an oldest-first sortable timestamp and collision suffix.
fn show_data_backup_sort_key(
    file_name: &str,
    backup_prefix: &str,
) -> Option<(String, u32, String)> {
    let suffix = file_name
        .strip_prefix(backup_prefix)?
        .strip_suffix(&format!(".{SHOWFILE_FOLDER_EXTENSION}"))?;
    let timestamp_len = "YYYYMMDD-HHMMSS".len();
    let suffix_bytes = suffix.as_bytes();
    if suffix_bytes.len() < timestamp_len {
        return None;
    }

    let timestamp_bytes = &suffix_bytes[..timestamp_len];
    if !timestamp_bytes[..8]
        .iter()
        .all(|byte| byte.is_ascii_digit())
        || timestamp_bytes[8] != b'-'
        || !timestamp_bytes[9..]
            .iter()
            .all(|byte| byte.is_ascii_digit())
    {
        return None;
    }

    let sequence = match suffix_bytes.get(timestamp_len..) {
        Some([]) => 0,
        Some([b'-', rest @ ..]) if rest.iter().all(|byte| byte.is_ascii_digit()) => {
            std::str::from_utf8(rest).ok()?.parse().ok()?
        }
        Some(_) => return None,
        None => 0,
    };

    let timestamp = std::str::from_utf8(timestamp_bytes).ok()?;
    Some((timestamp.to_string(), sequence, file_name.to_string()))
}

/// Remove oldest timestamped show-data backups until the configured retention count is met.
fn prune_show_data_backup_directories(
    show_data_dir: &Path,
    backups_to_keep: u32,
) -> Result<(), String> {
    let backup_dirs = list_show_data_backup_directories(show_data_dir)?;
    let remove_count = backup_dirs.len().saturating_sub(backups_to_keep as usize);

    for backup_dir in backup_dirs.into_iter().take(remove_count) {
        std::fs::remove_dir_all(&backup_dir).map_err(|error| {
            format!(
                "failed to remove old show-data backup directory {}: {}",
                backup_dir.display(),
                error
            )
        })?;
    }

    Ok(())
}
