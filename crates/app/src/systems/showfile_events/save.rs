// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Snapshot collection, durable save promotion, and clean-baseline tracking.

use super::*;

/// Saves canonical showfile state to the working draft, then promotes it to a saved folder.
pub(super) fn save_showfile(
    showfile_save_state: &mut ShowfileSaveState,
    showfile_name: Option<&str>,
    save_options: &ShowfileSaveOptions,
) -> Result<ShowfileSnapshot, String> {
    apply_showfile_save_options(&mut showfile_save_state.desk_settings, save_options);
    let mut showfile_snapshot = snapshot_from_save_state(showfile_save_state);
    showfile_snapshot.metadata = current_showfile_metadata();

    let draft_dir = prepare_working_draft_for_save(showfile_name)?;
    normalize_scene_object_model_paths_for_showfile(
        &mut showfile_snapshot.scene_objects,
        &draft_dir,
    );
    let saved_hash =
        hash_showfile_snapshot_with_metadata(&showfile_snapshot, &showfile_snapshot.metadata)?;
    replace_working_draft_with_saved_snapshot(&mut showfile_snapshot, showfile_name, saved_hash)?;

    let saved_dir = showfile_dir_path(showfile_name)?;
    let saved_parent = saved_dir
        .parent()
        .ok_or_else(|| format!("invalid showfile path {}", saved_dir.display()))?;
    std::fs::create_dir_all(saved_parent).map_err(|error| {
        format!(
            "failed to create showfile root directory {}: {}",
            saved_parent.display(),
            error
        )
    })?;
    let temp_saved_dir =
        temporary_showfile_dir(saved_parent, &showfile_folder_name(showfile_name)?);
    if temp_saved_dir.exists() {
        std::fs::remove_dir_all(&temp_saved_dir).map_err(|error| {
            format!(
                "failed to remove stale save temp directory {}: {}",
                temp_saved_dir.display(),
                error
            )
        })?;
    }
    copy_directory_recursive_excluding_names(
        &draft_dir,
        &temp_saved_dir,
        &[
            LEGACY_SHOWFILE_DRAFT_METADATA_FILENAME,
            SHOWFILE_MANIFEST_FILENAME,
            SHOWFILE_SNAPSHOT_FILENAME,
        ],
    )?;
    write_showfile_snapshot_with_manifest_to_dir(
        &showfile_snapshot,
        &temp_saved_dir,
        saved_hash,
        None,
    )?;

    let had_existing_show_data = saved_dir.exists();
    if had_existing_show_data {
        backup_show_data_directory(
            &saved_dir,
            showfile_save_state.desk_settings.showfile_backup_retention,
        )?;
    }
    replace_showfile_dir_with_temp(&temp_saved_dir, &saved_dir)?;

    if let Err(error) =
        remove_orphaned_showfile_object_snapshots(&showfile_snapshot.scene_objects, &saved_dir)
    {
        tracing::warn!(
            "Failed to remove orphaned showfile object snapshots after save: {}",
            error
        );
    }

    if let Err(error) =
        remove_orphaned_timeline_audio_assets_after_save(&showfile_snapshot.timelines, &saved_dir)
    {
        tracing::warn!(
            "Failed to remove orphaned timeline audio assets after save: {}",
            error
        );
    }

    tracing::debug!(
        "Wrote JSON showfile to file {}",
        showfile_path(showfile_name)?.display()
    );
    Ok(showfile_snapshot)
}

/// Updates the clean snapshot hash resource from a snapshot that was loaded or saved.
pub(super) fn update_clean_snapshot_hash(
    clean_snapshot_hash: &mut ShowfileCleanSnapshotHash,
    snapshot: &ShowfileSnapshot,
) -> Result<(), String> {
    clean_snapshot_hash.metadata = snapshot.metadata.clone();
    clean_snapshot_hash.hash = Some(hash_showfile_snapshot_with_metadata(
        snapshot,
        &clean_snapshot_hash.metadata,
    )?);
    Ok(())
}

/// Updates the clean snapshot hash from the canonical saved showfile on disk.
pub(super) fn update_clean_snapshot_hash_from_saved_show(
    clean_snapshot_hash: &mut ShowfileCleanSnapshotHash,
    showfile_name: Option<&str>,
) -> Result<(), String> {
    match read_showfile_snapshot(showfile_name) {
        Ok(snapshot) => {
            update_clean_snapshot_hash(clean_snapshot_hash, &snapshot)?;
            let saved_hash = clean_snapshot_hash
                .hash
                .ok_or_else(|| "clean showfile hash is missing after refresh".to_string())?;
            repair_showfile_manifest_for_existing_snapshot_to_dir(
                &showfile_dir_path(showfile_name)?,
                saved_hash,
                None,
            );
            Ok(())
        }
        Err(error) => {
            clean_snapshot_hash.hash = None;
            clean_snapshot_hash.metadata = ShowfileMetadata::default();
            Err(error)
        }
    }
}

/// Refreshes the clean snapshot hash resource from the current world state.
pub(crate) fn refresh_clean_snapshot_hash_from_world(world: &mut World) -> Result<(), String> {
    let snapshot = snapshot_from_world(world)?;
    let mut clean_snapshot_hash = world
        .get_resource_mut::<ShowfileCleanSnapshotHash>()
        .ok_or_else(|| "showfile clean hash resource is missing".to_string())?;
    update_clean_snapshot_hash(&mut clean_snapshot_hash, &snapshot)
}

/// Persists a newly created showfile as a recoverable draft before its first save.
pub(crate) fn persist_new_showfile_draft_from_world(
    world: &mut World,
    showfile_name: Option<&str>,
    initial_assets: &[InitialShowfileAsset],
) -> Result<(), String> {
    let mut snapshot = snapshot_from_world(world)?;
    snapshot.metadata = current_showfile_metadata();
    let snapshot_hash = hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata)?;
    save_initial_draft_showfile_snapshot(
        &mut snapshot,
        showfile_name,
        snapshot_hash,
        initial_assets,
    )?;

    let mut clean_snapshot_hash = world
        .get_resource_mut::<ShowfileCleanSnapshotHash>()
        .ok_or_else(|| "showfile clean hash resource is missing".to_string())?;
    update_clean_snapshot_hash(&mut clean_snapshot_hash, &snapshot)
}

/// Refreshes the clean snapshot hash after a fresh-world showfile bootstrap.
pub(crate) fn refresh_clean_snapshot_hash_after_showfile_bootstrap(
    world: &mut World,
    showfile_name: Option<&str>,
    source: &std::path::Path,
) -> Result<(), String> {
    if assets::paths_refer_to_same_file(source, &showfile_dir_path(showfile_name)?) {
        refresh_clean_snapshot_hash_from_world(world)
    } else {
        let mut clean_snapshot_hash = world
            .get_resource_mut::<ShowfileCleanSnapshotHash>()
            .ok_or_else(|| "showfile clean hash resource is missing".to_string())?;
        if let Err(error) =
            update_clean_snapshot_hash_from_saved_show(&mut clean_snapshot_hash, showfile_name)
        {
            tracing::warn!(
                "Failed to update clean showfile hash after draft load: {}",
                error
            );
        }
        Ok(())
    }
}

/// Applies save-time options to the live settings baseline used for later snapshots.
pub(in crate::systems::showfile_events) fn apply_showfile_save_options(
    desk_settings: &mut DeskSettings,
    save_options: &ShowfileSaveOptions,
) {
    if let Some(active_panel_layout) = save_options.active_panel_layout.clone() {
        desk_settings.active_panel_layout = Some(active_panel_layout);
    }
}

/// Serializes a standalone world through the runtime showfile snapshot path.
pub(crate) fn serialize_showfile_snapshot_json_from_world(
    world: &mut World,
    last_saved_unix_sec: u64,
) -> Result<String, String> {
    let mut snapshot = snapshot_from_world(world)?;
    snapshot.metadata = ShowfileMetadata {
        last_saved_unix_sec,
        ..current_showfile_metadata()
    };
    serialize_showfile_snapshot_json(&snapshot)
}
