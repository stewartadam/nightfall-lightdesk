// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{
    InitialShowfileAsset, ShowfileCleanSnapshotHash, ShowfileSaveOptions, ShowfileSaveState,
    ShowfileSnapshot, apply_showfile_save_options,
    assets::{
        normalize_scene_object_model_paths_for_showfile, paths_refer_to_same_file,
        remove_orphaned_showfile_object_snapshots, remove_orphaned_timeline_audio_assets,
    },
    backup::copy_directory_recursive_excluding_names,
    current_showfile_metadata,
    manifest::{read_current_showfile_manifest_from_dir, snapshot_hash_label},
    paths::{
        LEGACY_SHOWFILE_DRAFT_METADATA_FILENAME, SHOWFILE_MANIFEST_FILENAME, show_data_dir_path,
        showfile_draft_dir_path, showfile_folder_name,
    },
    snapshot_from_save_state,
    storage::{
        hash_showfile_snapshot_with_metadata, read_showfile_snapshot,
        read_showfile_snapshot_from_path, repair_showfile_manifest_for_existing_snapshot_to_dir,
        replace_showfile_dir_with_temp, temporary_showfile_dir,
        write_showfile_snapshot_with_manifest_to_dir,
    },
    validate_showfile_asset_versions,
};

/// Result of a draft save attempt after comparing runtime state to the clean baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DraftSaveOutcome {
    /// Runtime state and the mounted draft already match the clean snapshot.
    SkippedClean,
    /// Runtime state is clean, but the draft files were rewritten to match the clean baseline.
    NormalizedCleanDraft,
    /// Runtime state differs from the clean snapshot and was preserved as a dirty draft.
    SavedDirtyDraft,
}

/// Controls how draft saves seed files before writing the canonical snapshot.
#[derive(Debug, Clone, Copy)]
enum DraftAssetSource<'a> {
    /// Copy the currently mounted show data directory so referenced assets are preserved.
    ActiveShowDataDir,
    /// Start with a fresh directory and install only the supplied bundled files.
    InitialAssets(&'a [InitialShowfileAsset]),
}

/// Copy the active show root into the target draft folder when saving under a new name.
pub(super) fn prepare_working_draft_for_save(
    showfile_name: Option<&str>,
) -> Result<PathBuf, String> {
    let draft_dir = showfile_draft_dir_path(showfile_name)?;
    let active_dir = show_data_dir_path()?;
    if paths_refer_to_same_file(&active_dir, &draft_dir) {
        std::fs::create_dir_all(&draft_dir).map_err(|error| {
            format!(
                "failed to create working draft directory {}: {}",
                draft_dir.display(),
                error
            )
        })?;
        return Ok(draft_dir);
    }

    let draft_parent = draft_dir
        .parent()
        .ok_or_else(|| format!("invalid showfile draft path {}", draft_dir.display()))?;
    std::fs::create_dir_all(draft_parent).map_err(|error| {
        format!(
            "failed to create showfile drafts directory {}: {}",
            draft_parent.display(),
            error
        )
    })?;

    let temp_dir = temporary_showfile_dir(draft_parent, &showfile_folder_name(showfile_name)?);
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir).map_err(|error| {
            format!(
                "failed to remove stale draft temp directory {}: {}",
                temp_dir.display(),
                error
            )
        })?;
    }
    if active_dir.exists() {
        copy_directory_recursive_excluding_names(
            &active_dir,
            &temp_dir,
            &[
                LEGACY_SHOWFILE_DRAFT_METADATA_FILENAME,
                SHOWFILE_MANIFEST_FILENAME,
            ],
        )?;
    } else {
        std::fs::create_dir_all(&temp_dir).map_err(|error| {
            format!(
                "failed to create working draft directory {}: {}",
                temp_dir.display(),
                error
            )
        })?;
    }

    replace_showfile_dir_with_temp(&temp_dir, &draft_dir)?;
    nightfall::set_active_show_data_dir(draft_dir.clone());
    Ok(draft_dir)
}

/// Prepare editable session storage from a selected directory and a separate save target.
/// Existing working storage is resumed in place; other directories are copied after validation.
pub(super) fn prepare_showfile_session(
    source_dir: &std::path::Path,
    showfile_name: Option<&str>,
) -> Result<ShowfileSnapshot, String> {
    let snapshot = read_showfile_snapshot_from_path(source_dir)?;
    validate_showfile_asset_versions(&snapshot)?;
    let draft_dir = showfile_draft_dir_path(showfile_name)?;
    if paths_refer_to_same_file(source_dir, &draft_dir) {
        nightfall::set_active_show_data_dir(draft_dir);
        return Ok(snapshot);
    }
    let source_hash = hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata)?;
    let saved_dir = super::paths::showfile_dir_path(showfile_name)?;
    let saved_hash = if paths_refer_to_same_file(source_dir, &saved_dir) {
        repair_showfile_manifest_for_existing_snapshot_to_dir(&saved_dir, source_hash, None);
        Some(source_hash)
    } else {
        read_showfile_snapshot(showfile_name)
            .and_then(|saved| hash_showfile_snapshot_with_metadata(&saved, &saved.metadata))
            .ok()
    };
    replace_working_draft_from_source(
        showfile_name,
        source_dir,
        &snapshot,
        source_hash,
        saved_hash,
    )?;
    Ok(snapshot)
}

/// Replace one showfile's working draft from a parsed source directory.
fn replace_working_draft_from_source(
    showfile_name: Option<&str>,
    source_dir: &std::path::Path,
    source_snapshot: &ShowfileSnapshot,
    source_hash: u64,
    based_on_hash: Option<u64>,
) -> Result<(), String> {
    let draft_dir = showfile_draft_dir_path(showfile_name)?;
    let draft_parent = draft_dir
        .parent()
        .ok_or_else(|| format!("invalid showfile draft path {}", draft_dir.display()))?;
    std::fs::create_dir_all(draft_parent).map_err(|error| {
        format!(
            "failed to create showfile drafts directory {}: {}",
            draft_parent.display(),
            error
        )
    })?;

    let temp_dir = temporary_showfile_dir(draft_parent, &showfile_folder_name(showfile_name)?);
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir).map_err(|error| {
            format!(
                "failed to remove stale draft temp directory {}: {}",
                temp_dir.display(),
                error
            )
        })?;
    }
    copy_directory_recursive_excluding_names(
        source_dir,
        &temp_dir,
        &[
            LEGACY_SHOWFILE_DRAFT_METADATA_FILENAME,
            SHOWFILE_MANIFEST_FILENAME,
        ],
    )?;
    write_showfile_snapshot_with_manifest_to_dir(
        source_snapshot,
        &temp_dir,
        source_hash,
        based_on_hash,
    )?;
    replace_showfile_dir_with_temp(&temp_dir, &draft_dir)?;
    nightfall::set_active_show_data_dir(draft_dir);

    Ok(())
}

/// Save a draft for the target showfile if current state differs from the clean baseline.
pub(crate) fn save_draft_showfile_if_dirty(
    showfile_save_state: &mut ShowfileSaveState,
    showfile_name: Option<&str>,
    clean_snapshot_hash: &mut ShowfileCleanSnapshotHash,
    save_options: &ShowfileSaveOptions,
) -> Result<DraftSaveOutcome, String> {
    if save_options.active_panel_layout.is_some() {
        apply_showfile_save_options(&mut showfile_save_state.desk_settings, save_options);
    }
    let mut showfile_snapshot = snapshot_from_save_state(showfile_save_state);
    let current_hash =
        hash_showfile_snapshot_with_metadata(&showfile_snapshot, &clean_snapshot_hash.metadata)?;
    if let Some(clean_hash) = clean_snapshot_hash.hash {
        if current_hash == clean_hash {
            normalize_clean_snapshot_hash_metadata(clean_snapshot_hash, &showfile_snapshot)?;
            let clean_hash = clean_snapshot_hash.hash.ok_or_else(|| {
                "clean showfile hash was cleared while normalizing metadata".to_string()
            })?;
            if working_draft_matches_snapshot_hash(showfile_name, clean_hash) {
                return Ok(DraftSaveOutcome::SkippedClean);
            }
            showfile_snapshot.metadata = clean_snapshot_hash.metadata.clone();
            save_draft_showfile_snapshot(
                &mut showfile_snapshot,
                showfile_name,
                clean_hash,
                clean_hash,
                DraftAssetSource::ActiveShowDataDir,
            )?;
            return Ok(DraftSaveOutcome::NormalizedCleanDraft);
        }
    }

    showfile_snapshot.metadata = current_showfile_metadata();
    save_draft_showfile_snapshot(
        &mut showfile_snapshot,
        showfile_name,
        clean_snapshot_hash.hash.unwrap_or(current_hash),
        current_hash,
        DraftAssetSource::ActiveShowDataDir,
    )?;
    Ok(DraftSaveOutcome::SavedDirtyDraft)
}

/// Save a freshly constructed showfile snapshot as the initial working draft.
pub(super) fn save_initial_draft_showfile_snapshot(
    showfile_snapshot: &mut ShowfileSnapshot,
    showfile_name: Option<&str>,
    snapshot_hash: u64,
    initial_assets: &[InitialShowfileAsset],
) -> Result<(), String> {
    save_draft_showfile_snapshot(
        showfile_snapshot,
        showfile_name,
        snapshot_hash,
        snapshot_hash,
        DraftAssetSource::InitialAssets(initial_assets),
    )
}

/// Atomically replace the prepared working draft with a clean saved snapshot pair.
pub(super) fn replace_working_draft_with_saved_snapshot(
    showfile_snapshot: &mut ShowfileSnapshot,
    showfile_name: Option<&str>,
    snapshot_hash: u64,
) -> Result<(), String> {
    save_draft_showfile_snapshot(
        showfile_snapshot,
        showfile_name,
        snapshot_hash,
        snapshot_hash,
        DraftAssetSource::ActiveShowDataDir,
    )
}

/// Promote an unversioned clean metadata baseline before writing clean draft files.
pub(super) fn normalize_clean_snapshot_hash_metadata(
    clean_snapshot_hash: &mut ShowfileCleanSnapshotHash,
    showfile_snapshot: &ShowfileSnapshot,
) -> Result<(), String> {
    if clean_snapshot_hash.metadata.showfile_version != 0 {
        return Ok(());
    }

    let metadata = current_showfile_metadata();
    let hash = hash_showfile_snapshot_with_metadata(showfile_snapshot, &metadata)?;
    clean_snapshot_hash.metadata = metadata;
    clean_snapshot_hash.hash = Some(hash);
    Ok(())
}

/// Save a draft snapshot to the single draft folder for the target showfile.
fn save_draft_showfile_snapshot(
    showfile_snapshot: &mut ShowfileSnapshot,
    showfile_name: Option<&str>,
    based_on_snapshot_hash: u64,
    draft_snapshot_hash: u64,
    asset_source: DraftAssetSource<'_>,
) -> Result<(), String> {
    if matches!(asset_source, DraftAssetSource::InitialAssets(_)) {
        super::paths::validate_new_showfile_name(showfile_name)?;
    }
    let draft_dir = showfile_draft_dir_path(showfile_name)?;
    let draft_parent = draft_dir
        .parent()
        .ok_or_else(|| format!("invalid showfile draft path {}", draft_dir.display()))?;
    std::fs::create_dir_all(draft_parent).map_err(|error| {
        format!(
            "failed to create showfile drafts directory {}: {}",
            draft_parent.display(),
            error
        )
    })?;

    let temp_dir = draft_parent.join(format!(
        ".{}.tmp-{}-{}",
        showfile_folder_name(showfile_name)?,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir).map_err(|error| {
            format!(
                "failed to remove stale draft temp directory {}: {}",
                temp_dir.display(),
                error
            )
        })?;
    }
    match asset_source {
        DraftAssetSource::ActiveShowDataDir => {
            let active_dir = show_data_dir_path()?;
            if active_dir.exists() {
                copy_directory_recursive_excluding_names(
                    &active_dir,
                    &temp_dir,
                    &[
                        LEGACY_SHOWFILE_DRAFT_METADATA_FILENAME,
                        SHOWFILE_MANIFEST_FILENAME,
                    ],
                )?;
            } else {
                std::fs::create_dir_all(&temp_dir).map_err(|error| {
                    format!(
                        "failed to create showfile draft directory {}: {}",
                        temp_dir.display(),
                        error
                    )
                })?;
            }
        }
        DraftAssetSource::InitialAssets(_) => {
            std::fs::create_dir_all(&temp_dir).map_err(|error| {
                format!(
                    "failed to create initial showfile draft directory {}: {}",
                    temp_dir.display(),
                    error
                )
            })?;
        }
    }
    if let DraftAssetSource::InitialAssets(initial_assets) = asset_source {
        for asset in initial_assets {
            let relative_path = std::path::Path::new(asset.relative_path);
            if relative_path.as_os_str().is_empty()
                || !relative_path
                    .components()
                    .all(|component| matches!(component, std::path::Component::Normal(_)))
            {
                return Err(format!(
                    "invalid bundled show asset path: {}",
                    asset.relative_path
                ));
            }
            let destination = temp_dir.join(relative_path);
            std::fs::create_dir_all(destination.parent().expect("asset has a staging parent"))
                .and_then(|()| std::fs::copy(&asset.source_path, &destination))
                .map_err(|error| {
                    format!(
                        "failed to install bundled show asset {}: {error}",
                        destination.display()
                    )
                })?;
        }
    }
    normalize_scene_object_model_paths_for_showfile(
        &mut showfile_snapshot.scene_objects,
        &temp_dir,
    );

    write_showfile_snapshot_with_manifest_to_dir(
        showfile_snapshot,
        &temp_dir,
        draft_snapshot_hash,
        Some(based_on_snapshot_hash),
    )?;

    if let Err(error) =
        remove_orphaned_showfile_object_snapshots(&showfile_snapshot.scene_objects, &temp_dir)
    {
        tracing::warn!(
            "Failed to remove orphaned showfile object draft snapshots: {}",
            error
        );
    }
    if let Err(error) =
        remove_orphaned_timeline_audio_assets(&showfile_snapshot.timelines, &temp_dir)
    {
        tracing::warn!(
            "Failed to remove orphaned draft timeline audio assets: {}",
            error
        );
    }

    if matches!(asset_source, DraftAssetSource::InitialAssets(_)) {
        // Reserve the destination exclusively; never remove another show's directory.
        let mut reserved_destination = false;
        let publish = (|| -> Result<(), String> {
            super::paths::validate_new_showfile_name(showfile_name)?;
            std::fs::create_dir(&draft_dir)
                .map_err(|error| format!("Cannot create new show: {error}"))?;
            reserved_destination = true;
            for entry in std::fs::read_dir(&temp_dir).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                std::fs::rename(entry.path(), draft_dir.join(entry.file_name()))
                    .map_err(|error| format!("Cannot install new show: {error}"))?;
            }
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&temp_dir);
        if publish.is_err() && reserved_destination {
            let _ = std::fs::remove_dir_all(&draft_dir);
        }
        publish?;
    } else {
        replace_showfile_dir_with_temp(&temp_dir, &draft_dir)?;
    }
    nightfall::set_active_show_data_dir(draft_dir.clone());

    tracing::debug!("Wrote draft showfile to {}", draft_dir.display());
    Ok(())
}

/// Return whether the draft sidecar describes the saved snapshot hash without parsing JSON.
fn working_draft_matches_snapshot_hash(showfile_name: Option<&str>, snapshot_hash: u64) -> bool {
    let Ok(draft_dir) = showfile_draft_dir_path(showfile_name) else {
        return false;
    };
    let expected_state_hash = snapshot_hash_label(snapshot_hash);
    read_current_showfile_manifest_from_dir(&draft_dir)
        .is_ok_and(|manifest| manifest.matches_clean_state_hash(&expected_state_hash))
}

/// Remove the draft folder for the target showfile when one exists.
pub(super) fn remove_draft_showfile(showfile_name: Option<&str>) -> Result<(), String> {
    let draft_dir = showfile_draft_dir_path(showfile_name)?;
    if !draft_dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&draft_dir).map_err(|error| {
        format!(
            "failed to remove showfile draft {}: {}",
            draft_dir.display(),
            error
        )
    })
}
