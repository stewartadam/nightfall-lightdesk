// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::path::{Component, Path, PathBuf};

pub(super) const SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR: &str = "scene-objects";
pub(super) const SHOWFILE_TIMELINE_AUDIO_DIR: &str = "timeline-audio";
pub(super) const SHOWFILE_BACKUPS_DIR: &str = "backups";
pub(super) const SHOWFILE_DRAFTS_DIR: &str = "drafts";
pub(super) const SHOWFILE_FOLDER_EXTENSION: &str = "nightfall-show";
pub(super) const SHOWFILE_SNAPSHOT_FILENAME: &str = "showfile.json";
pub(super) const SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME: &str = "showfile.json.gz";
pub(super) const SHOWFILE_MANIFEST_FILENAME: &str = "showfile-manifest.json";
pub(super) const LEGACY_SHOWFILE_DRAFT_METADATA_FILENAME: &str = "metadata.json";
pub(super) const DEFAULT_SHOWFILE_NAME: &str = "default";

/// Resolve the on-disk path for the canonical or named showfile JSON snapshot.
pub(super) fn showfile_path(name: Option<&str>) -> Result<PathBuf, String> {
    Ok(showfile_snapshot_path_in_dir(&showfile_dir_path(name)?))
}

/// Normalize a loaded showfile name for active runtime state.
pub(super) fn current_showfile_name(name: Option<&str>) -> Result<Option<String>, String> {
    let stem = showfile_name_stem(name)?;
    if stem == DEFAULT_SHOWFILE_NAME {
        Ok(None)
    } else {
        Ok(Some(stem))
    }
}

/// Resolve the folder for the canonical or named showfile.
pub(super) fn showfile_dir_path(name: Option<&str>) -> Result<PathBuf, String> {
    Ok(showfile_root_dir_path()?.join(showfile_folder_name(name)?))
}

/// Build the folder name used for the canonical or named showfile.
pub(super) fn showfile_folder_name(name: Option<&str>) -> Result<String, String> {
    let stem = showfile_name_stem(name)?;
    Ok(format!("{stem}.{SHOWFILE_FOLDER_EXTENSION}"))
}

/// Build the logical name stem used for showfile folders and backup folders.
pub(super) fn showfile_name_stem(name: Option<&str>) -> Result<String, String> {
    let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(DEFAULT_SHOWFILE_NAME.to_string());
    };

    let path = Path::new(name);
    let mut components = path.components();
    let Some(Component::Normal(filename)) = components.next() else {
        return Err(format!("invalid showfile name: {name}"));
    };
    if components.next().is_some() {
        return Err(format!("invalid showfile name: {name}"));
    }

    let filename = filename
        .to_str()
        .ok_or_else(|| format!("invalid showfile name: {name}"))?;
    if filename.contains('/') || filename.contains('\\') {
        return Err(format!("invalid showfile name: {name}"));
    }

    let extension = format!(".{SHOWFILE_FOLDER_EXTENSION}");
    let stem = if let Some(stem) = filename.strip_suffix(&extension) {
        stem
    } else {
        filename
    };
    if stem.trim().is_empty() {
        return Err(format!("invalid showfile name: {name}"));
    }

    Ok(stem.to_string())
}

/// Return the logical showfile name stem for a show folder path.
pub(super) fn showfile_name_from_dir(show_data_dir: &Path) -> Result<String, String> {
    let file_name = show_data_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid showfile directory {}", show_data_dir.display()))?;
    file_name
        .strip_suffix(&format!(".{SHOWFILE_FOLDER_EXTENSION}"))
        .filter(|stem| !stem.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("invalid showfile directory {}", show_data_dir.display()))
}

/// Resolve the backups directory for a show folder.
pub(super) fn showfile_backup_root_dir(show_data_dir: &Path) -> Result<PathBuf, String> {
    Ok(show_data_dir
        .parent()
        .ok_or_else(|| format!("invalid showfile directory {}", show_data_dir.display()))?
        .join(SHOWFILE_BACKUPS_DIR))
}

/// Resolve the root folder that contains one draft folder per showfile.
pub(super) fn showfile_drafts_root_dir() -> Result<PathBuf, String> {
    Ok(showfile_root_dir_path()?.join(SHOWFILE_DRAFTS_DIR))
}

/// Resolve the draft folder for a showfile in the configured app data root.
pub(super) fn showfile_draft_dir_path(name: Option<&str>) -> Result<PathBuf, String> {
    Ok(showfile_drafts_root_dir()?.join(showfile_folder_name(name)?))
}

/// Resolve the draft folder for a showfile under an explicit showfile root.
pub(super) fn showfile_draft_dir_path_in_root(
    root: &Path,
    name: Option<&str>,
) -> Result<PathBuf, String> {
    Ok(root
        .join(SHOWFILE_DRAFTS_DIR)
        .join(showfile_folder_name(name)?))
}

/// Resolve the stored gzip snapshot, or the plain JSON interchange snapshot in a show folder.
pub(super) fn showfile_snapshot_path_in_dir(path: &Path) -> PathBuf {
    let compressed = path.join(SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME);
    if compressed.exists() {
        compressed
    } else {
        path.join(SHOWFILE_SNAPSHOT_FILENAME)
    }
}

/// Resolve a snapshot path from either a show folder or a direct JSON or gzip path.
pub(super) fn showfile_snapshot_path_from_path(path: &Path) -> PathBuf {
    if path.is_dir() {
        showfile_snapshot_path_in_dir(path)
    } else {
        path.to_path_buf()
    }
}

/// Resolve the show folder containing a snapshot path.
pub(super) fn showfile_snapshot_dir_from_path(path: &Path) -> Result<&Path, String> {
    if path.is_dir() {
        return Ok(path);
    }

    path.parent().ok_or_else(|| {
        format!(
            "failed to resolve import showfile directory for {}",
            path.display()
        )
    })
}

/// Resolve the mounted showfile data directory for runtime asset writes.
pub(super) fn show_data_dir_path() -> Result<PathBuf, String> {
    nightfall::active_show_data_dir()
        .ok_or_else(|| "could not determine active show data directory".to_string())
}

/// Resolve the root directory that contains showfile folders.
pub(super) fn showfile_root_dir_path() -> Result<PathBuf, String> {
    nightfall::nightfall_data_dir()
        .ok_or_else(|| "could not determine Nightfall app data directory".to_string())
}

/// Reject names already occupied by saved shows or working drafts, including case variants.
pub(super) fn validate_new_showfile_name(name: Option<&str>) -> Result<(), String> {
    validate_new_showfile_name_in_root(&showfile_root_dir_path()?, name)
}

/// Check both storage locations without relying on readable snapshot or manifest contents.
fn validate_new_showfile_name_in_root(root: &Path, name: Option<&str>) -> Result<(), String> {
    let folder = showfile_folder_name(name)?.to_lowercase();
    for directory in [root.to_path_buf(), root.join(SHOWFILE_DRAFTS_DIR)] {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Cannot check existing show names: {error}")),
        };
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Cannot check existing show names: {error}"))?;
            if entry.file_name().to_string_lossy().to_lowercase() == folder {
                return Err(format!(
                    "A show named \"{}\" already exists. Choose a different name.",
                    showfile_name_stem(name)?
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod name_tests {
    use super::*;

    /// Saved folders and orphan drafts reserve names regardless of casing or snapshot validity.
    #[test]
    fn new_names_reject_saved_and_draft_collisions() {
        let root = tempfile::tempdir().unwrap();
        for parent in [
            root.path().to_path_buf(),
            root.path().join(SHOWFILE_DRAFTS_DIR),
        ] {
            std::fs::create_dir_all(&parent).unwrap();
            let existing = parent.join("Tour.nightfall-show");
            std::fs::create_dir(&existing).unwrap();
            std::fs::write(existing.join("showfile.json"), b"preserve me").unwrap();
            for name in ["Tour", " tour ", "Tour.nightfall-show"] {
                assert!(validate_new_showfile_name_in_root(root.path(), Some(name)).is_err());
            }
            assert!(validate_new_showfile_name_in_root(root.path(), Some("Other")).is_ok());
            assert_eq!(
                std::fs::read(existing.join("showfile.json")).unwrap(),
                b"preserve me"
            );
            std::fs::remove_dir_all(existing).unwrap();
        }
    }
}
