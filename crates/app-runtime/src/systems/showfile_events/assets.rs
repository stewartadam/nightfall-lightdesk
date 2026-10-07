// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#[cfg(feature = "object-library")]
use std::collections::HashMap;
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use nightfall::prelude::*;
use nightfall_desk::prelude::*;
#[cfg(feature = "object-library")]
use nightfall_object_library::manager::{
    ObjectLibraryManager, ObjectModelPathScope, decode_object_path, encode_showfile_object_path,
};
use nightfall_scene_objects::prelude::*;
use nightfall_timeline::prelude::*;
use uuid::Uuid;

use super::{ShowfileSnapshot, import::validate_showfile_import_options, paths::*};

/// Copy imported showfile-scoped assets that will be referenced by the merged snapshot.
pub(super) fn prepare_imported_showfile_assets(
    incoming: &mut ShowfileSnapshot,
    current: &ShowfileSnapshot,
    options: &ShowfileImportOptions,
    import_path: &Path,
    current_show_data_dir: &Path,
) -> Result<(), String> {
    validate_showfile_import_options(options)?;

    let source_show_data_dir = showfile_snapshot_dir_from_path(import_path)?;

    copy_imported_timeline_audio_assets(
        &current.timelines,
        &mut incoming.timelines,
        options.timelines,
        source_show_data_dir,
        current_show_data_dir,
    )?;
    copy_imported_scene_object_assets(
        &current.scene_objects,
        &mut incoming.scene_objects,
        options.scene_objects,
        source_show_data_dir,
        current_show_data_dir,
    )?;

    Ok(())
}

/// Copy imported timeline audio files for timeline rows selected by the import policy.
fn copy_imported_timeline_audio_assets(
    current: &[Timeline],
    incoming: &mut [Timeline],
    policy: ShowfileImportPolicy,
    source_show_data_dir: &Path,
    current_show_data_dir: &Path,
) -> Result<(), String> {
    let imported_uids = imported_identified_uids(current, incoming, policy);
    for timeline in incoming {
        if !imported_uids.contains(&timeline.identifiers().uid) {
            continue;
        }

        let audio_path = timeline.audio_path.trim();
        if !audio_path.starts_with(&format!("{SHOWFILE_TIMELINE_AUDIO_DIR}/")) {
            continue;
        }

        let relative_path = Path::new(audio_path);
        if !is_safe_relative_showfile_path(relative_path) {
            return Err(format!(
                "invalid imported timeline audio path: {audio_path}"
            ));
        }

        copy_imported_showfile_asset_file(
            &source_show_data_dir.join(relative_path),
            &current_show_data_dir.join(relative_path),
            "timeline audio",
        )?;
    }

    Ok(())
}

/// Copy imported showfile-scoped scene object bundles for selected scene objects.
pub(super) fn copy_imported_scene_object_assets(
    current: &[SceneObject],
    incoming: &mut [SceneObject],
    policy: ShowfileImportPolicy,
    source_show_data_dir: &Path,
    current_show_data_dir: &Path,
) -> Result<(), String> {
    #[cfg(feature = "object-library")]
    {
        let imported_uids = imported_identified_uids(current, incoming, policy);
        let mut migrated_model_paths: HashMap<String, String> = HashMap::new();

        for scene_object in incoming {
            if !imported_uids.contains(&scene_object.identifiers().uid) {
                continue;
            }

            let Some(model_path) = scene_object_model_path_mut(scene_object) else {
                continue;
            };

            if let Some(migrated_model_path) = migrated_model_paths.get(model_path) {
                *model_path = migrated_model_path.clone();
                continue;
            }

            let original_model_path = model_path.clone();
            if let Some(migrated_model_path) = copy_imported_showfile_object_model_path(
                &original_model_path,
                source_show_data_dir,
                current_show_data_dir,
            )? {
                migrated_model_paths.insert(original_model_path, migrated_model_path.clone());
                *model_path = migrated_model_path;
            }
        }
    }

    #[cfg(not(feature = "object-library"))]
    {
        let _ = (
            current,
            incoming,
            policy,
            source_show_data_dir,
            current_show_data_dir,
        );
    }

    Ok(())
}

/// Select incoming identified rows that can contribute data under the import policy.
fn imported_identified_uids<T>(
    current: &[T],
    incoming: &[T],
    policy: ShowfileImportPolicy,
) -> HashSet<Uuid>
where
    T: HasIdentifiers,
{
    match policy {
        ShowfileImportPolicy::Skip => HashSet::new(),
        ShowfileImportPolicy::Overwrite | ShowfileImportPolicy::Replace => {
            incoming.iter().map(|item| item.identifiers().uid).collect()
        }
        ShowfileImportPolicy::Merge => {
            let current_uids: HashSet<Uuid> =
                current.iter().map(|item| item.identifiers().uid).collect();
            incoming
                .iter()
                .filter_map(|item| {
                    let uid = item.identifiers().uid;
                    (!current_uids.contains(&uid)).then_some(uid)
                })
                .collect()
        }
    }
}

/// Copy an imported showfile-scoped scene object model bundle and return its current token.
#[cfg(feature = "object-library")]
fn copy_imported_showfile_object_model_path(
    model_path: &str,
    source_show_data_dir: &Path,
    current_show_data_dir: &Path,
) -> Result<Option<String>, String> {
    let object_model_path = match decode_object_path(model_path) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };

    if object_model_path.scope != ObjectModelPathScope::ShowfileData {
        return Ok(None);
    }

    let source_bundle_path = source_show_data_dir
        .join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR)
        .join(&object_model_path.bundle_filename);
    let destination_bundle_path = current_show_data_dir
        .join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR)
        .join(&object_model_path.bundle_filename);

    copy_imported_showfile_asset_file(
        &source_bundle_path,
        &destination_bundle_path,
        "scene object bundle",
    )?;

    Ok(Some(encode_showfile_object_path(&destination_bundle_path)))
}

/// Copy one showfile-scoped asset unless the source and destination are the same file.
fn copy_imported_showfile_asset_file(
    source_path: &Path,
    destination_path: &Path,
    label: &str,
) -> Result<(), String> {
    if paths_refer_to_same_file(source_path, destination_path) {
        return Ok(());
    }

    if !source_path.exists() {
        return Err(format!(
            "imported {label} {} does not exist",
            source_path.display()
        ));
    }

    if let Some(parent) = destination_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create imported {label} directory {}: {}",
                parent.display(),
                error
            )
        })?;
    }

    std::fs::copy(source_path, destination_path).map_err(|error| {
        format!(
            "failed to copy imported {label} {} to {}: {}",
            source_path.display(),
            destination_path.display(),
            error
        )
    })?;

    Ok(())
}

/// Return true when two paths resolve to the same existing file.
pub(super) fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }

    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Return true when a showfile-stored relative path cannot escape show-data.
fn is_safe_relative_showfile_path(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// Return the mutable object-library model path stored on a scene object.
#[cfg(feature = "object-library")]
fn scene_object_model_path_mut(scene_object: &mut SceneObject) -> Option<&mut String> {
    match &mut scene_object.properties {
        SceneObjectProperties::StageElement(properties) => Some(&mut properties.model_path),
        SceneObjectProperties::Custom(properties) => Some(&mut properties.model_path),
        _ => None,
    }
}

/// Return the object-library model path stored on a scene object.
#[cfg(feature = "object-library")]
pub(super) fn scene_object_model_path(scene_object: &SceneObject) -> Option<&str> {
    match &scene_object.properties {
        SceneObjectProperties::StageElement(properties) => Some(&properties.model_path),
        SceneObjectProperties::Custom(properties) => Some(&properties.model_path),
        _ => None,
    }
}

/// Copy a library object bundle into the showfile and return the showfile-scoped model token.
#[cfg(feature = "object-library")]
pub(super) fn snapshot_library_model_path_for_showfile(
    model_path: &str,
    library_path: &Path,
    show_data_dir: &Path,
) -> Result<Option<String>, String> {
    let object_model_path = match decode_object_path(model_path) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };

    if object_model_path.scope != ObjectModelPathScope::Library {
        return Ok(None);
    }

    let source_bundle_path = library_path.join(&object_model_path.bundle_filename);
    if !source_bundle_path.exists() {
        return Err(format!(
            "library bundle {} does not exist",
            source_bundle_path.display()
        ));
    }

    let snapshot_dir = show_data_dir.join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR);
    std::fs::create_dir_all(&snapshot_dir).map_err(|error| {
        format!(
            "failed to create showfile object snapshot directory {}: {}",
            snapshot_dir.display(),
            error
        )
    })?;

    let snapshot_filename = format!(
        "{}-{}",
        Uuid::new_v4().simple(),
        object_model_path.bundle_filename
    );
    let snapshot_path = snapshot_dir.join(snapshot_filename);
    std::fs::copy(&source_bundle_path, &snapshot_path).map_err(|error| {
        format!(
            "failed to copy object bundle {} to {}: {}",
            source_bundle_path.display(),
            snapshot_path.display(),
            error
        )
    })?;

    Ok(Some(encode_showfile_object_path(&snapshot_path)))
}

/// Convert library-scoped scene object paths into showfile-scoped asset snapshots.
pub(super) fn normalize_scene_object_model_paths_for_showfile(
    scene_objects: &mut [SceneObject],
    show_data_dir: &Path,
) {
    #[cfg(feature = "object-library")]
    {
        let library_path = match ObjectLibraryManager::get_library_path() {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(
                    "Failed to resolve object library path for showfile model snapshots: {}",
                    error
                );
                return;
            }
        };

        let mut migrated_model_paths: HashMap<String, String> = HashMap::new();
        for scene_object in scene_objects {
            let Some(model_path) = scene_object_model_path_mut(scene_object) else {
                continue;
            };

            if let Some(migrated_path) = migrated_model_paths.get(model_path) {
                *model_path = migrated_path.clone();
                continue;
            }

            let original_model_path = model_path.clone();
            match snapshot_library_model_path_for_showfile(
                &original_model_path,
                &library_path,
                show_data_dir,
            ) {
                Ok(Some(snapshot_model_path)) => {
                    migrated_model_paths.insert(original_model_path, snapshot_model_path.clone());
                    *model_path = snapshot_model_path;
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(
                        "Failed to snapshot scene object model path {}: {}",
                        original_model_path,
                        error
                    );
                }
            }
        }
    }

    #[cfg(not(feature = "object-library"))]
    {
        let _ = (scene_objects, show_data_dir);
    }
}

/// Remove showfile-scoped scene object bundles that no saved scene object references.
pub(super) fn remove_orphaned_showfile_object_snapshots(
    scene_objects: &[SceneObject],
    show_data_dir: &Path,
) -> Result<(), String> {
    #[cfg(feature = "object-library")]
    {
        let snapshot_dir = show_data_dir.join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR);
        let read_dir = match std::fs::read_dir(&snapshot_dir) {
            Ok(read_dir) => read_dir,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!(
                    "failed to read showfile object snapshot directory {}: {}",
                    snapshot_dir.display(),
                    error
                ));
            }
        };

        let mut referenced_bundle_filenames: HashSet<String> = HashSet::new();
        for scene_object in scene_objects {
            let Some(model_path) = scene_object_model_path(scene_object) else {
                continue;
            };
            let Ok(decoded_path) = decode_object_path(model_path) else {
                continue;
            };
            if decoded_path.scope == ObjectModelPathScope::ShowfileData {
                referenced_bundle_filenames.insert(decoded_path.bundle_filename);
            }
        }

        for entry in read_dir {
            let entry = entry.map_err(|error| {
                format!(
                    "failed to read entry in showfile object snapshot directory {}: {}",
                    snapshot_dir.display(),
                    error
                )
            })?;

            let file_type = entry.file_type().map_err(|error| {
                format!(
                    "failed to read file type for showfile object snapshot {}: {}",
                    entry.path().display(),
                    error
                )
            })?;
            if !file_type.is_file() {
                continue;
            }

            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            let extension = Path::new(file_name.as_ref())
                .extension()
                .and_then(|extension| extension.to_str());
            if !matches!(extension, Some(extension) if extension.eq_ignore_ascii_case("robj")) {
                continue;
            }
            if referenced_bundle_filenames.contains(file_name.as_ref()) {
                continue;
            }

            std::fs::remove_file(entry.path()).map_err(|error| {
                format!(
                    "failed to remove orphaned showfile object snapshot {}: {}",
                    entry.path().display(),
                    error
                )
            })?;
        }
    }

    #[cfg(not(feature = "object-library"))]
    {
        let _ = (scene_objects, show_data_dir);
    }

    Ok(())
}

/// Return true when a path names a supported timeline audio asset file.
fn is_showfile_timeline_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp3" | "wav" | "m4a" | "mp4"
            )
        })
}

/// Remove unreferenced timeline audio files and report whether the directory is empty.
fn remove_orphaned_timeline_audio_entries(
    show_data_dir: &Path,
    directory: &Path,
    referenced_audio_paths: &HashSet<PathBuf>,
) -> Result<bool, String> {
    let read_dir = match std::fs::read_dir(directory) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => {
            return Err(format!(
                "failed to read timeline audio directory {}: {}",
                directory.display(),
                error
            ));
        }
    };

    let mut is_empty = true;
    for entry in read_dir {
        let entry = entry.map_err(|error| {
            format!(
                "failed to read entry in timeline audio directory {}: {}",
                directory.display(),
                error
            )
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "failed to read file type for timeline audio asset {}: {}",
                path.display(),
                error
            )
        })?;

        if file_type.is_dir() {
            if remove_orphaned_timeline_audio_entries(show_data_dir, &path, referenced_audio_paths)?
            {
                std::fs::remove_dir(&path).map_err(|error| {
                    format!(
                        "failed to remove empty timeline audio directory {}: {}",
                        path.display(),
                        error
                    )
                })?;
            } else {
                is_empty = false;
            }
            continue;
        }

        if !file_type.is_file() || !is_showfile_timeline_audio_file(&path) {
            is_empty = false;
            continue;
        }

        let relative_path = path.strip_prefix(show_data_dir).map_err(|error| {
            format!(
                "failed to resolve timeline audio asset {} relative to {}: {}",
                path.display(),
                show_data_dir.display(),
                error
            )
        })?;
        if referenced_audio_paths.contains(relative_path) {
            is_empty = false;
            continue;
        }

        std::fs::remove_file(&path).map_err(|error| {
            format!(
                "failed to remove orphaned timeline audio asset {}: {}",
                path.display(),
                error
            )
        })?;
    }

    Ok(is_empty)
}

/// Remove showfile-scoped timeline audio files that no saved timeline references.
pub(super) fn remove_orphaned_timeline_audio_assets(
    timelines: &[Timeline],
    show_data_dir: &Path,
) -> Result<(), String> {
    let audio_root = show_data_dir.join(SHOWFILE_TIMELINE_AUDIO_DIR);
    if !audio_root.exists() {
        return Ok(());
    }

    let timeline_audio_prefix = format!("{SHOWFILE_TIMELINE_AUDIO_DIR}/");
    let mut referenced_audio_paths: HashSet<PathBuf> = HashSet::new();
    for timeline in timelines {
        let audio_path = timeline.audio_path.trim();
        if !audio_path.starts_with(&timeline_audio_prefix) {
            continue;
        }

        let relative_path = Path::new(audio_path);
        if !is_safe_relative_showfile_path(relative_path) {
            return Err(format!("invalid saved timeline audio path: {audio_path}"));
        }
        referenced_audio_paths.insert(relative_path.to_path_buf());
    }

    remove_orphaned_timeline_audio_entries(show_data_dir, &audio_root, &referenced_audio_paths)?;
    Ok(())
}

/// Remove timeline audio orphans from runtime storage and the saved show copy.
pub(super) fn remove_orphaned_timeline_audio_assets_in_save_dirs(
    timelines: &[Timeline],
    runtime_show_data_dir: &Path,
    saved_show_data_dir: &Path,
) -> Result<(), String> {
    remove_orphaned_timeline_audio_assets(timelines, runtime_show_data_dir)?;
    if !paths_refer_to_same_file(runtime_show_data_dir, saved_show_data_dir) {
        remove_orphaned_timeline_audio_assets(timelines, saved_show_data_dir)?;
    }

    Ok(())
}

/// Remove timeline audio orphans after saving a showfile snapshot.
pub(super) fn remove_orphaned_timeline_audio_assets_after_save(
    timelines: &[Timeline],
    saved_show_data_dir: &Path,
) -> Result<(), String> {
    let runtime_show_data_dir = show_data_dir_path()?;
    remove_orphaned_timeline_audio_assets_in_save_dirs(
        timelines,
        &runtime_show_data_dir,
        saved_show_data_dir,
    )
}
