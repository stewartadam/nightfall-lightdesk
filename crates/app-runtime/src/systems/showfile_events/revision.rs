// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Backup revision resolution and non-destructive loading.

use std::path::PathBuf;

use super::*;

/// Resolve the directory of a selected backup revision without changing canonical showfile storage.
pub(super) fn resolve_showfile_revision_directory(
    selection: &ShowfileRevisionSelection,
) -> Result<PathBuf, String> {
    let showfile_name = showfile_name_stem(Some(&selection.showfile_name))?;
    let parsed_selection = ShowfileRevisionSelection::from_revision_name(&selection.revision_name)?;
    if parsed_selection.showfile_name != showfile_name {
        return Err(format!(
            "showfile revision {} does not belong to {showfile_name}",
            selection.revision_name
        ));
    }
    let show_data_dir = showfile_dir_path(Some(&showfile_name))?;
    let revision_stem = showfile_name_stem(Some(&selection.revision_name))?;
    let revision_name = format!("{revision_stem}.{SHOWFILE_FOLDER_EXTENSION}");
    let revision_dir = list_show_data_backup_directories(&show_data_dir)?
        .into_iter()
        .find(|path| {
            path.file_name().and_then(|file_name| file_name.to_str())
                == Some(revision_name.as_str())
        })
        .ok_or_else(|| format!("showfile revision not found: {revision_name}"))?;

    let revision_snapshot = showfile_snapshot_path_in_dir(&revision_dir);
    if !revision_snapshot.is_file() {
        return Err(format!(
            "showfile revision {} does not contain a snapshot ({})",
            revision_dir.display(),
            revision_snapshot.display()
        ));
    }
    Ok(revision_dir)
}
