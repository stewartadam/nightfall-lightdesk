// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Recoverable showfile deletion.
//!
//! Deleting a show moves its saved folder, working draft, and backup revisions into one trash
//! entry that mirrors the app data root layout (`<name>.nightfall-show`, `drafts/…`, `backups/…`).
//! Restoring moves those folders back. Entries expire after [`SHOWFILE_TRASH_RETENTION`] and are
//! purged the next time the trash is listed or another show is deleted.

use std::{
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use jiff::Zoned;
use serde::{Deserialize, Serialize};

use super::{
    backup::list_show_data_backup_directories,
    paths::{
        SHOWFILE_BACKUPS_DIR, SHOWFILE_DRAFTS_DIR, SHOWFILE_TRASH_DIR, showfile_folder_name,
        showfile_name_stem, validate_new_showfile_name_in_root,
    },
};

/// How long a deleted show stays recoverable before it is purged.
pub(super) const SHOWFILE_TRASH_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Metadata file written at the root of every trash entry.
const SHOWFILE_TRASH_ENTRY_FILENAME: &str = "trash-entry.json";

/// Persisted description of one deleted show.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ShowfileTrashEntryMetadata {
    /// Logical showfile name the entry restores to.
    showfile_name: String,
    /// Wall-clock deletion time in milliseconds since the Unix epoch.
    deleted_at_ms: u64,
}

/// A recoverable deleted show as presented by the showfile listing endpoint.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeletedShowfile {
    /// Trash entry folder name used to restore this show.
    pub(super) id: String,
    /// Logical showfile name the entry restores to.
    pub(super) name: String,
    /// Wall-clock deletion time in milliseconds since the Unix epoch.
    pub(super) deleted_at_ms: u64,
    /// Time after which the entry is purged, in milliseconds since the Unix epoch.
    pub(super) expires_at_ms: u64,
}

/// Return the current wall-clock time in milliseconds since the Unix epoch.
pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Resolve the trash folder under a showfile root.
fn trash_root_dir(root: &Path) -> PathBuf {
    root.join(SHOWFILE_TRASH_DIR)
}

/// Collect the existing saved, draft, and backup folders of a show, relative to the root.
fn show_storage_relative_paths(root: &Path, showfile_name: &str) -> Result<Vec<PathBuf>, String> {
    let folder_name = showfile_folder_name(Some(showfile_name))?;
    let saved = PathBuf::from(&folder_name);
    let draft = Path::new(SHOWFILE_DRAFTS_DIR).join(&folder_name);
    let mut relative_paths: Vec<PathBuf> = [saved.clone(), draft]
        .into_iter()
        .filter(|relative| root.join(relative).exists())
        .collect();
    for backup in list_show_data_backup_directories(&root.join(&saved))? {
        let backup_name = backup
            .file_name()
            .ok_or_else(|| format!("invalid showfile backup path {}", backup.display()))?;
        relative_paths.push(Path::new(SHOWFILE_BACKUPS_DIR).join(backup_name));
    }
    Ok(relative_paths)
}

/// Failure to move a set of show folders between two roots.
struct MoveFoldersError {
    message: String,
    /// Whether every folder moved before the failure was put back where it came from.
    rolled_back: bool,
}

/// Move folders between two roots, rolling completed moves back if a later move fails.
fn move_relative_paths(
    relative_paths: &[PathBuf],
    from_root: &Path,
    to_root: &Path,
) -> Result<(), MoveFoldersError> {
    for (index, relative) in relative_paths.iter().enumerate() {
        let source = from_root.join(relative);
        let destination = to_root.join(relative);
        let result = destination
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::rename(&source, &destination));
        if let Err(error) = result {
            let mut rolled_back = true;
            for moved in relative_paths[..index].iter().rev() {
                if let Err(rollback_error) =
                    std::fs::rename(to_root.join(moved), from_root.join(moved))
                {
                    rolled_back = false;
                    tracing::error!(
                        "Failed to roll back showfile move of {}: {}",
                        moved.display(),
                        rollback_error
                    );
                }
            }
            return Err(MoveFoldersError {
                message: format!(
                    "failed to move {} to {}: {}",
                    source.display(),
                    destination.display(),
                    error
                ),
                rolled_back,
            });
        }
    }
    Ok(())
}

/// Allocate a unique, human-readable trash entry folder name for a show.
fn next_trash_entry_id(trash_root: &Path, showfile_name: &str) -> Result<String, String> {
    let timestamp = Zoned::now().strftime("%Y%m%d-%H%M%S").to_string();
    (0..1000)
        .map(|sequence| match sequence {
            0 => format!("{showfile_name}-{timestamp}"),
            _ => format!("{showfile_name}-{timestamp}-{sequence}"),
        })
        .find(|candidate| !trash_root.join(candidate).exists())
        .ok_or_else(|| format!("failed to allocate a trash entry for {showfile_name}"))
}

/// Move a show's saved folder, draft, and backups into a new trash entry.
///
/// Returns the trash entry id. Fails without changing anything when the show has no stored
/// folders.
pub(super) fn trash_showfile_in_root(
    root: &Path,
    showfile_name: Option<&str>,
    deleted_at_ms: u64,
) -> Result<String, String> {
    let showfile_name = showfile_name_stem(showfile_name)?;
    let relative_paths = show_storage_relative_paths(root, &showfile_name)?;
    if relative_paths.is_empty() {
        return Err(format!("showfile not found: {showfile_name}"));
    }

    let trash_root = trash_root_dir(root);
    std::fs::create_dir_all(&trash_root).map_err(|error| {
        format!(
            "failed to create showfile trash directory {}: {}",
            trash_root.display(),
            error
        )
    })?;
    let entry_id = next_trash_entry_id(&trash_root, &showfile_name)?;
    let entry_dir = trash_root.join(&entry_id);
    std::fs::create_dir(&entry_dir).map_err(|error| {
        format!(
            "failed to create showfile trash entry {}: {}",
            entry_dir.display(),
            error
        )
    })?;
    let metadata = ShowfileTrashEntryMetadata {
        showfile_name: showfile_name.clone(),
        deleted_at_ms,
    };
    let write_metadata = serde_json::to_vec_pretty(&metadata)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            std::fs::write(entry_dir.join(SHOWFILE_TRASH_ENTRY_FILENAME), bytes)
                .map_err(|error| error.to_string())
        });
    let moved = write_metadata
        .map_err(|message| MoveFoldersError {
            message,
            rolled_back: true,
        })
        .and_then(|()| move_relative_paths(&relative_paths, root, &entry_dir));
    match moved {
        Ok(()) => Ok(entry_id),
        Err(error) if error.rolled_back => {
            let _ = std::fs::remove_dir_all(&entry_dir);
            Err(format!(
                "failed to delete showfile {showfile_name}: {}",
                error.message
            ))
        }
        // Keep the partially filled entry so its folders stay recoverable from Recently deleted.
        Err(error) => Err(format!(
            "failed to delete showfile {showfile_name}: {}. Some of its folders remain in \
             Recently deleted.",
            error.message
        )),
    }
}

/// Resolve an existing trash entry folder from an id supplied by a client.
fn trash_entry_dir(root: &Path, entry_id: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(entry_id).components();
    let is_single_name = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !entry_id.contains(['/', '\\']);
    let entry_dir = trash_root_dir(root).join(entry_id);
    if !is_single_name || !entry_dir.join(SHOWFILE_TRASH_ENTRY_FILENAME).is_file() {
        return Err(format!("deleted showfile not found: {entry_id}"));
    }
    Ok(entry_dir)
}

/// Read the metadata stored in a trash entry folder.
fn read_trash_entry_metadata(entry_dir: &Path) -> Result<ShowfileTrashEntryMetadata, String> {
    let path = entry_dir.join(SHOWFILE_TRASH_ENTRY_FILENAME);
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("failed to read {}: {}", path.display(), error))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse {}: {}", path.display(), error))
}

/// Collect the folders stored in a trash entry, relative to the entry root.
fn trash_entry_relative_paths(
    entry_dir: &Path,
    showfile_name: &str,
) -> Result<Vec<PathBuf>, String> {
    let mut relative_paths = Vec::new();
    for relative in [
        PathBuf::from(showfile_folder_name(Some(showfile_name))?),
        Path::new(SHOWFILE_DRAFTS_DIR).join(showfile_folder_name(Some(showfile_name))?),
    ] {
        if entry_dir.join(&relative).exists() {
            relative_paths.push(relative);
        }
    }
    let backups_dir = entry_dir.join(SHOWFILE_BACKUPS_DIR);
    if backups_dir.is_dir() {
        let entries = std::fs::read_dir(&backups_dir)
            .map_err(|error| format!("failed to read {}: {}", backups_dir.display(), error))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("failed to read {}: {}", backups_dir.display(), error))?;
            relative_paths.push(Path::new(SHOWFILE_BACKUPS_DIR).join(entry.file_name()));
        }
    }
    Ok(relative_paths)
}

/// Move a trash entry's folders back into the showfile root and remove the entry.
///
/// Returns the restored showfile name. Refuses to restore over a show or draft that now uses
/// the same name.
pub(super) fn restore_trashed_showfile_in_root(
    root: &Path,
    entry_id: &str,
) -> Result<String, String> {
    let entry_dir = trash_entry_dir(root, entry_id)?;
    let metadata = read_trash_entry_metadata(&entry_dir)?;
    let showfile_name = showfile_name_stem(Some(&metadata.showfile_name))?;
    if validate_new_showfile_name_in_root(root, Some(&showfile_name)).is_err() {
        return Err(format!(
            "Cannot restore \"{showfile_name}\" because a show with that name already exists. \
             Delete that show first."
        ));
    }
    let relative_paths = trash_entry_relative_paths(&entry_dir, &showfile_name)?;
    if let Some(occupied) = relative_paths
        .iter()
        .find(|relative| root.join(relative).exists())
    {
        return Err(format!(
            "Cannot restore \"{showfile_name}\": {} already exists",
            root.join(occupied).display()
        ));
    }
    move_relative_paths(&relative_paths, &entry_dir, root).map_err(|error| error.message)?;
    if let Err(error) = std::fs::remove_dir_all(&entry_dir) {
        tracing::warn!(
            "Failed to remove restored showfile trash entry {}: {}",
            entry_dir.display(),
            error
        );
    }
    Ok(showfile_name)
}

/// Remove every trash entry, including unreadable ones.
pub(super) fn empty_showfile_trash_in_root(root: &Path) -> Result<(), String> {
    let trash_root = trash_root_dir(root);
    match std::fs::remove_dir_all(&trash_root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to empty showfile trash {}: {}",
            trash_root.display(),
            error
        )),
    }
}

/// Purge expired entries and return the remaining recoverable shows, newest deletion first.
///
/// Entries whose metadata cannot be read are skipped rather than purged so a damaged entry is
/// never removed by an automatic cleanup; emptying the trash still removes it.
pub(super) fn list_deleted_showfiles_in_root(
    root: &Path,
    now_ms: u64,
) -> Result<Vec<DeletedShowfile>, String> {
    let trash_root = trash_root_dir(root);
    let entries = match std::fs::read_dir(&trash_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "failed to read showfile trash {}: {}",
                trash_root.display(),
                error
            ));
        }
    };

    let retention_ms = SHOWFILE_TRASH_RETENTION.as_millis() as u64;
    let mut deleted = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "failed to read showfile trash entry in {}: {}",
                trash_root.display(),
                error
            )
        })?;
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(metadata) = read_trash_entry_metadata(&entry.path()) else {
            continue;
        };
        let expires_at_ms = metadata.deleted_at_ms.saturating_add(retention_ms);
        if expires_at_ms <= now_ms {
            if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                tracing::warn!(
                    "Failed to purge expired showfile trash entry {}: {}",
                    entry.path().display(),
                    error
                );
            }
            continue;
        }
        deleted.push(DeletedShowfile {
            id,
            name: metadata.showfile_name,
            deleted_at_ms: metadata.deleted_at_ms,
            expires_at_ms,
        });
    }
    deleted.sort_by(|left, right| {
        right
            .deleted_at_ms
            .cmp(&left.deleted_at_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a show folder with a marker file so moves can be verified by content.
    fn write_show_dir(path: &Path, marker: &str) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("showfile.json.gz"), marker).unwrap();
    }

    /// Read back the marker written by [`write_show_dir`].
    fn read_marker(path: &Path) -> String {
        std::fs::read_to_string(path.join("showfile.json.gz")).unwrap()
    }

    /// Lay out a saved show, its draft, one backup, and an unrelated show under one root.
    fn seed_root(root: &Path) {
        write_show_dir(&root.join("Tour.nightfall-show"), "saved");
        write_show_dir(&root.join("drafts/Tour.nightfall-show"), "draft");
        write_show_dir(
            &root.join("backups/Tour-20261001-120000.nightfall-show"),
            "backup",
        );
        write_show_dir(&root.join("Other.nightfall-show"), "other");
        write_show_dir(
            &root.join("backups/Other-20261001-120000.nightfall-show"),
            "other-backup",
        );
    }

    /// Deleting moves the saved folder, draft, and backups together and leaves other shows alone.
    #[test]
    fn trash_moves_saved_draft_and_backups() {
        let root = tempfile::tempdir().unwrap();
        seed_root(root.path());

        let id = trash_showfile_in_root(root.path(), Some("Tour"), 1_000).unwrap();

        assert!(!root.path().join("Tour.nightfall-show").exists());
        assert!(!root.path().join("drafts/Tour.nightfall-show").exists());
        assert!(
            !root
                .path()
                .join("backups/Tour-20261001-120000.nightfall-show")
                .exists()
        );
        let entry = root.path().join("trash").join(&id);
        assert_eq!(read_marker(&entry.join("Tour.nightfall-show")), "saved");
        assert_eq!(
            read_marker(&entry.join("drafts/Tour.nightfall-show")),
            "draft"
        );
        assert_eq!(
            read_marker(&entry.join("backups/Tour-20261001-120000.nightfall-show")),
            "backup"
        );
        assert_eq!(
            read_marker(&root.path().join("Other.nightfall-show")),
            "other"
        );
        assert!(
            root.path()
                .join("backups/Other-20261001-120000.nightfall-show")
                .exists()
        );
    }

    /// A show with only an unsaved draft can still be deleted.
    #[test]
    fn trash_accepts_draft_only_shows() {
        let root = tempfile::tempdir().unwrap();
        write_show_dir(&root.path().join("drafts/Fresh.nightfall-show"), "draft");

        let id = trash_showfile_in_root(root.path(), Some("Fresh"), 1_000).unwrap();

        assert!(!root.path().join("drafts/Fresh.nightfall-show").exists());
        assert!(
            root.path()
                .join("trash")
                .join(id)
                .join("drafts/Fresh.nightfall-show")
                .exists()
        );
    }

    /// Deleting a show that has no stored folders fails without creating a trash entry.
    #[test]
    fn trash_rejects_missing_shows() {
        let root = tempfile::tempdir().unwrap();
        assert!(trash_showfile_in_root(root.path(), Some("Missing"), 1_000).is_err());
        assert!(!root.path().join("trash").exists());
    }

    /// Restoring puts every folder back where it was and removes the trash entry.
    #[test]
    fn restore_round_trips_all_folders() {
        let root = tempfile::tempdir().unwrap();
        seed_root(root.path());
        let id = trash_showfile_in_root(root.path(), Some("Tour"), 1_000).unwrap();

        let restored = restore_trashed_showfile_in_root(root.path(), &id).unwrap();

        assert_eq!(restored, "Tour");
        assert_eq!(
            read_marker(&root.path().join("Tour.nightfall-show")),
            "saved"
        );
        assert_eq!(
            read_marker(&root.path().join("drafts/Tour.nightfall-show")),
            "draft"
        );
        assert_eq!(
            read_marker(
                &root
                    .path()
                    .join("backups/Tour-20261001-120000.nightfall-show")
            ),
            "backup"
        );
        assert!(!root.path().join("trash").join(&id).exists());
    }

    /// Restoring refuses to overwrite a show that reused the deleted name.
    #[test]
    fn restore_rejects_name_collisions() {
        let root = tempfile::tempdir().unwrap();
        seed_root(root.path());
        let id = trash_showfile_in_root(root.path(), Some("Tour"), 1_000).unwrap();
        write_show_dir(&root.path().join("drafts/tour.nightfall-show"), "new");

        assert!(restore_trashed_showfile_in_root(root.path(), &id).is_err());
        assert!(root.path().join("trash").join(&id).exists());
        assert_eq!(
            read_marker(&root.path().join("drafts/tour.nightfall-show")),
            "new"
        );
    }

    /// Client-supplied ids cannot escape the trash folder.
    #[test]
    fn restore_rejects_path_ids() {
        let root = tempfile::tempdir().unwrap();
        seed_root(root.path());
        trash_showfile_in_root(root.path(), Some("Tour"), 1_000).unwrap();
        for id in ["..", "../Other.nightfall-show", "a/b", "", "a\\b"] {
            assert!(restore_trashed_showfile_in_root(root.path(), id).is_err());
        }
    }

    /// Listing reports expiry times, orders newest first, and purges expired entries.
    #[test]
    fn listing_purges_expired_entries() {
        let root = tempfile::tempdir().unwrap();
        seed_root(root.path());
        let retention_ms = SHOWFILE_TRASH_RETENTION.as_millis() as u64;
        let old_id = trash_showfile_in_root(root.path(), Some("Other"), 1_000).unwrap();
        let new_id = trash_showfile_in_root(root.path(), Some("Tour"), 5_000).unwrap();

        let listed = list_deleted_showfiles_in_root(root.path(), 2_000).unwrap();
        assert_eq!(
            listed,
            vec![
                DeletedShowfile {
                    id: new_id.clone(),
                    name: "Tour".to_string(),
                    deleted_at_ms: 5_000,
                    expires_at_ms: 5_000 + retention_ms,
                },
                DeletedShowfile {
                    id: old_id.clone(),
                    name: "Other".to_string(),
                    deleted_at_ms: 1_000,
                    expires_at_ms: 1_000 + retention_ms,
                },
            ]
        );

        let listed = list_deleted_showfiles_in_root(root.path(), 1_000 + retention_ms).unwrap();
        assert_eq!(
            listed.iter().map(|entry| &entry.id).collect::<Vec<_>>(),
            [&new_id]
        );
        assert!(!root.path().join("trash").join(old_id).exists());
    }

    /// Emptying the trash removes every entry immediately.
    #[test]
    fn empty_trash_removes_all_entries() {
        let root = tempfile::tempdir().unwrap();
        seed_root(root.path());
        trash_showfile_in_root(root.path(), Some("Tour"), 1_000).unwrap();

        empty_showfile_trash_in_root(root.path()).unwrap();

        assert!(!root.path().join("trash").exists());
        assert!(
            list_deleted_showfiles_in_root(root.path(), 1_000)
                .unwrap()
                .is_empty()
        );
        empty_showfile_trash_in_root(root.path()).unwrap();
    }
}
