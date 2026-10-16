// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Showfile storage for scene object model bundles.
//!
//! Saved shows keep their own copy of every `.robj` bundle a scene object uses, under
//! [`SHOWFILE_OBJECT_SNAPSHOTS_DIR`], so a show keeps rendering after the library bundle
//! changes or disappears. These helpers snapshot library bundles into a show, locate the
//! bundles an imported show carries, and prune copies that no scene object references.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use nightfall_scene_objects::prelude::*;
use uuid::Uuid;

use crate::manager::{
    ObjectLibraryManager, ObjectModelPathScope, decode_object_path, encode_showfile_object_path,
};
use crate::{ObjectLibraryError, Result};

/// Show-data subdirectory holding the scene object bundles a showfile references.
pub const SHOWFILE_OBJECT_SNAPSHOTS_DIR: &str = "scene-objects";

/// A showfile-scoped bundle an imported show references, and where the current show stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedModelBundle {
    /// Bundle inside the imported show's data directory.
    pub source: PathBuf,
    /// Destination inside the current show's data directory.
    pub destination: PathBuf,
    /// Model path token that references the destination bundle.
    pub model_path: String,
}

/// Returns the object-library model path stored on a scene object, if its kind has one.
pub fn scene_object_model_path(scene_object: &SceneObject) -> Option<&str> {
    match &scene_object.properties {
        SceneObjectProperties::StageElement(properties) => Some(&properties.model_path),
        SceneObjectProperties::Custom(properties) => Some(&properties.model_path),
        _ => None,
    }
}

/// Returns the mutable object-library model path stored on a scene object, if its kind has one.
pub fn scene_object_model_path_mut(scene_object: &mut SceneObject) -> Option<&mut String> {
    match &mut scene_object.properties {
        SceneObjectProperties::StageElement(properties) => Some(&mut properties.model_path),
        SceneObjectProperties::Custom(properties) => Some(&mut properties.model_path),
        _ => None,
    }
}

/// Copies a library-scoped bundle into the show and returns the showfile-scoped token for it.
///
/// Returns `Ok(None)` when the token is not a library reference, so callers can pass every
/// model path through unchanged. Each snapshot gets a unique filename, so two library
/// revisions of the same bundle never overwrite each other inside one show.
pub fn snapshot_library_model_path(
    model_path: &str,
    library_path: &Path,
    show_data_dir: &Path,
) -> Result<Option<String>> {
    let Ok(object_model_path) = decode_object_path(model_path) else {
        return Ok(None);
    };
    if object_model_path.scope != ObjectModelPathScope::Library {
        return Ok(None);
    }

    let source_bundle_path = library_path.join(&object_model_path.bundle_filename);
    if !source_bundle_path.exists() {
        return Err(ObjectLibraryError::NotFound {
            name: source_bundle_path.display().to_string(),
        });
    }

    let snapshot_dir = show_data_dir.join(SHOWFILE_OBJECT_SNAPSHOTS_DIR);
    std::fs::create_dir_all(&snapshot_dir).map_err(bundle_error(
        "create object snapshot directory",
        &snapshot_dir,
    ))?;
    let snapshot_path = snapshot_dir.join(format!(
        "{}-{}",
        Uuid::new_v4().simple(),
        object_model_path.bundle_filename
    ));
    std::fs::copy(&source_bundle_path, &snapshot_path)
        .map_err(bundle_error("copy object bundle to", &snapshot_path))?;

    Ok(Some(encode_showfile_object_path(&snapshot_path)))
}

/// Rewrites library-scoped model paths on scene objects to showfile-scoped snapshots.
///
/// Scene objects sharing one library bundle share one snapshot. A bundle that cannot be
/// copied is logged and its scene object keeps the library reference, so saving never fails
/// because one model is missing.
pub fn snapshot_library_models(scene_objects: &mut [SceneObject], show_data_dir: &Path) {
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

    let mut snapshot_model_paths: HashMap<String, String> = HashMap::new();
    for scene_object in scene_objects {
        let Some(model_path) = scene_object_model_path_mut(scene_object) else {
            continue;
        };
        if let Some(snapshot_model_path) = snapshot_model_paths.get(model_path) {
            *model_path = snapshot_model_path.clone();
            continue;
        }

        let original_model_path = model_path.clone();
        match snapshot_library_model_path(&original_model_path, &library_path, show_data_dir) {
            Ok(Some(snapshot_model_path)) => {
                snapshot_model_paths.insert(original_model_path, snapshot_model_path.clone());
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

/// Locates the showfile-scoped bundle an imported model path references.
///
/// Returns `None` for library references and unreadable tokens, which need no copy. The
/// caller copies `source` to `destination` and stores the returned `model_path`.
pub fn imported_model_bundle(
    model_path: &str,
    source_show_data_dir: &Path,
    current_show_data_dir: &Path,
) -> Option<ImportedModelBundle> {
    let object_model_path = decode_object_path(model_path).ok()?;
    if object_model_path.scope != ObjectModelPathScope::ShowfileData {
        return None;
    }

    let destination = current_show_data_dir
        .join(SHOWFILE_OBJECT_SNAPSHOTS_DIR)
        .join(&object_model_path.bundle_filename);
    Some(ImportedModelBundle {
        source: source_show_data_dir
            .join(SHOWFILE_OBJECT_SNAPSHOTS_DIR)
            .join(&object_model_path.bundle_filename),
        model_path: encode_showfile_object_path(&destination),
        destination,
    })
}

/// Deletes `.robj` snapshots in the show that no scene object references.
pub fn remove_orphaned_model_snapshots(
    scene_objects: &[SceneObject],
    show_data_dir: &Path,
) -> Result<()> {
    let snapshot_dir = show_data_dir.join(SHOWFILE_OBJECT_SNAPSHOTS_DIR);
    let read_dir = match std::fs::read_dir(&snapshot_dir) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(bundle_error(
                "read object snapshot directory",
                &snapshot_dir,
            )(error));
        }
    };

    let referenced_bundle_filenames: HashSet<String> = scene_objects
        .iter()
        .filter_map(scene_object_model_path)
        .filter_map(|model_path| decode_object_path(model_path).ok())
        .filter(|path| path.scope == ObjectModelPathScope::ShowfileData)
        .map(|path| path.bundle_filename)
        .collect();

    for entry in read_dir {
        let entry = entry.map_err(bundle_error(
            "read object snapshot directory",
            &snapshot_dir,
        ))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(bundle_error("read file type of object snapshot", &path))?;
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let is_bundle = Path::new(file_name.as_ref())
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("robj"));
        if is_bundle && !referenced_bundle_filenames.contains(file_name.as_ref()) {
            std::fs::remove_file(&path)
                .map_err(bundle_error("remove orphaned object snapshot", &path))?;
        }
    }

    Ok(())
}

/// Builds an error mapper that records which showfile bundle operation failed and on what path.
fn bundle_error(
    action: &'static str,
    path: &Path,
) -> impl FnOnce(std::io::Error) -> ObjectLibraryError {
    let path = path.to_path_buf();
    move |source| ObjectLibraryError::ShowfileBundle {
        action,
        path,
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::encode_object_path;

    /// Verifies a library token is rewritten to a showfile token whose bundle was copied into the show.
    #[test]
    fn snapshot_library_model_path_rewrites_scope_and_copies_bundle() {
        let temp_root = tempfile::tempdir().expect("create temp root");
        let library_path = temp_root.path().join("objects");
        let show_data_dir = temp_root.path().join("default.nightfall-show");
        std::fs::create_dir_all(&library_path).expect("create temp library directory");

        let library_bundle_path = library_path.join("object-a.robj");
        std::fs::write(&library_bundle_path, b"bundle").expect("write temp object bundle");

        let snapshot_model_path = snapshot_library_model_path(
            &encode_object_path(&library_bundle_path),
            &library_path,
            &show_data_dir,
        )
        .expect("snapshot should succeed")
        .expect("library path should be converted to showfile path");

        let decoded =
            decode_object_path(&snapshot_model_path).expect("snapshot path should decode");
        assert_eq!(decoded.scope, ObjectModelPathScope::ShowfileData);
        assert!(decoded.bundle_filename.ends_with("object-a.robj"));
        assert!(
            show_data_dir
                .join(SHOWFILE_OBJECT_SNAPSHOTS_DIR)
                .join(decoded.bundle_filename)
                .exists()
        );
    }

    /// Verifies showfile tokens and unreadable tokens are left for the caller unchanged.
    #[test]
    fn snapshot_library_model_path_ignores_non_library_tokens() {
        let temp_root = tempfile::tempdir().expect("create temp root");
        let showfile_token = encode_showfile_object_path(Path::new("abc-object-a.robj"));

        for token in [showfile_token.as_str(), "not-a-token"] {
            assert_eq!(
                snapshot_library_model_path(token, temp_root.path(), temp_root.path())
                    .expect("non-library tokens never fail"),
                None
            );
        }
    }

    /// Verifies imported showfile tokens map to the same bundle name under the current show.
    #[test]
    fn imported_model_bundle_targets_current_show() {
        let token = encode_showfile_object_path(Path::new("abc-object-a.robj"));
        let bundle = imported_model_bundle(&token, Path::new("/import"), Path::new("/current"))
            .expect("showfile token has a bundle");

        assert_eq!(
            bundle.source,
            Path::new("/import/scene-objects/abc-object-a.robj")
        );
        assert_eq!(
            bundle.destination,
            Path::new("/current/scene-objects/abc-object-a.robj")
        );
        assert_eq!(bundle.model_path, token);
        assert!(
            imported_model_bundle(
                &encode_object_path(Path::new("object-a.robj")),
                Path::new("/import"),
                Path::new("/current"),
            )
            .is_none()
        );
    }
}
