// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Object library manager

use std::collections::HashMap;
use std::io::{Read, Write as IoWrite};
use std::path::{Path, PathBuf};

use bevy_ecs::prelude::*;
use uuid::Uuid;

use crate::metadata::ObjectMetadata;
use crate::{ObjectLibraryError, Result};

const SHOWFILE_OBJECT_SNAPSHOTS_DIR: &str = "scene-objects";
const OBJECT_PATH_SCOPE_LIBRARY: &str = "lib";
const OBJECT_PATH_SCOPE_SHOWFILE: &str = "show";

/// A profile for an object in the library
#[derive(Debug, Clone)]
pub struct ObjectProfile {
    /// Object metadata
    pub metadata: ObjectMetadata,
    /// Path to the .robj file
    pub file_path: PathBuf,
}

impl ObjectProfile {
    /// Get the object name
    pub fn name(&self) -> &str {
        &self.metadata.name
    }

    /// Get the object category
    pub fn category(&self) -> &str {
        &self.metadata.category
    }
}

/// Object library manager
///
/// Manages a collection of object definitions from .robj bundle files.
#[derive(Resource, Clone)]
pub struct ObjectLibraryManager {
    /// Indexed objects by name
    objects: HashMap<String, ObjectProfile>,
    /// Library directory path
    library_path: PathBuf,
}

impl ObjectLibraryManager {
    /// Create a new object library manager with the default library path
    pub fn new() -> Result<Self> {
        let library_path = Self::get_library_path()?;
        Self::with_path(library_path)
    }

    /// Create a new object library manager with a custom library path
    pub fn with_path(library_path: PathBuf) -> Result<Self> {
        let mut manager = Self {
            objects: HashMap::new(),
            library_path,
        };

        // Create library directory if it doesn't exist
        if !manager.library_path.exists() {
            std::fs::create_dir_all(&manager.library_path)?;
            tracing::info!(
                library_path = %manager.library_path.display(),
                "Created object library directory"
            );
        }

        // Scan for objects
        manager.scan()?;

        Ok(manager)
    }

    /// Get the platform-specific library path
    pub fn get_library_path() -> Result<PathBuf> {
        let data_dir = nightfall::nightfall_data_dir().ok_or_else(|| {
            ObjectLibraryError::InvalidDataDirectory(
                "Could not determine project directories".to_string(),
            )
        })?;

        Ok(data_dir.join("objects"))
    }

    /// Get the library directory path
    pub fn library_path(&self) -> &Path {
        &self.library_path
    }

    /// Scan the library directory for objects
    pub fn scan(&mut self) -> Result<()> {
        self.objects.clear();

        let scanner = crate::scanner::ObjectScanner::new(&self.library_path);
        let profiles = scanner.scan()?;

        for profile in profiles {
            self.objects.insert(profile.name().to_string(), profile);
        }

        tracing::info!("Loaded {} objects from object library", self.objects.len());

        Ok(())
    }

    /// List all available objects
    pub fn list_objects(&self) -> Vec<&ObjectProfile> {
        self.objects.values().collect()
    }

    /// Find an object by name
    pub fn find_object(&self, name: &str) -> Option<&ObjectProfile> {
        self.objects.get(name)
    }

    /// Get the number of objects in the library
    pub fn object_count(&self) -> usize {
        self.objects.len()
    }

    /// Extract the GLB model from an object bundle
    pub fn extract_model(&self, name: &str) -> Result<Vec<u8>> {
        let profile = self
            .find_object(name)
            .ok_or_else(|| ObjectLibraryError::NotFound {
                name: name.to_string(),
            })?;

        extract_model_from_bundle(&profile.file_path)
    }

    /// Upload an object bundle to the library.
    ///
    /// Writes the file content to the library directory with the given filename.
    /// The file watcher will automatically detect the new file and trigger a rescan.
    pub fn upload_object(&self, filename: &str, content: &[u8]) -> Result<PathBuf> {
        // Validate filename extension
        let extension = Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());

        match extension.as_deref() {
            Some("robj") => {}
            _ => {
                return Err(ObjectLibraryError::InvalidDataDirectory(format!(
                    "Unsupported file format: {}. Only .robj files are supported.",
                    filename
                )));
            }
        }

        // Sanitize filename to prevent path traversal
        let safe_filename = Path::new(filename)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| {
                ObjectLibraryError::InvalidDataDirectory(format!("Invalid filename: {}", filename))
            })?;

        let dest_path = self.library_path.join(safe_filename);

        // Write the file
        std::fs::write(&dest_path, content)?;

        tracing::info!(path = %dest_path.display(), "Uploaded object file");

        Ok(dest_path)
    }

    /// Create a new object bundle from a GLB file and metadata.
    ///
    /// Creates a .robj bundle containing the GLB model and object.json metadata.
    pub fn create_object(&self, metadata: &ObjectMetadata, glb_content: &[u8]) -> Result<PathBuf> {
        // Create a safe filename from the object name
        let safe_name: String = metadata
            .name
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();

        let filename = format!("{}.robj", safe_name);
        let dest_path = self.library_path.join(&filename);

        // Create the ZIP archive
        let file = std::fs::File::create(&dest_path)?;
        let mut zip = zip::ZipWriter::new(file);

        // Add object.json
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("object.json", options)
            .map_err(|e| ObjectLibraryError::Archive(e.to_string()))?;

        let metadata_json = serde_json::to_string_pretty(metadata)?;
        zip.write_all(metadata_json.as_bytes())?;

        // Add model.glb
        zip.start_file("model.glb", options)
            .map_err(|e| ObjectLibraryError::Archive(e.to_string()))?;
        zip.write_all(glb_content)?;

        zip.finish()
            .map_err(|e| ObjectLibraryError::Archive(e.to_string()))?;

        tracing::info!(path = %dest_path.display(), "Created object bundle");

        Ok(dest_path)
    }

    /// Delete an object from the library by name.
    ///
    /// Removes the object file from disk. The file watcher will automatically
    /// detect the removal and trigger a rescan.
    pub fn delete_object(&mut self, name: &str) -> Result<()> {
        let profile = self
            .objects
            .get(name)
            .ok_or_else(|| ObjectLibraryError::NotFound {
                name: name.to_string(),
            })?;

        let file_path = profile.file_path.clone();

        // Remove from our cache first
        self.objects.remove(name);

        // Delete the file
        if file_path.exists() {
            std::fs::remove_file(&file_path)?;
            tracing::info!(
                path = %file_path.display(),
                name,
                "Deleted object file"
            );
        } else {
            tracing::warn!(
                path = %file_path.display(),
                name,
                "Object file was already removed"
            );
        }

        Ok(())
    }
}

/// Compute a deterministic content fingerprint for an object bundle file.
pub fn object_bundle_version(bundle_path: &Path) -> Result<String> {
    let bytes = std::fs::read(bundle_path)?;
    Ok(fnv1a64_hex(&bytes))
}

fn fnv1a64_hex(bytes: &[u8]) -> String {
    // Stable, dependency-free fingerprint for version comparisons.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

impl Default for ObjectLibraryManager {
    fn default() -> Self {
        Self::new().expect("Failed to create object library manager")
    }
}

/// Source scope for object model bundles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectModelPathScope {
    /// Object bundle stored in the global object library directory.
    Library,
    /// Object bundle snapshot stored under show-data.
    ShowfileData,
}

/// Decoded object model path token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectModelPath {
    /// Source scope for the bundle.
    pub scope: ObjectModelPathScope,
    /// Basename of the `.robj` bundle file.
    pub bundle_filename: String,
}

/// Extract the GLB model data from an object bundle file
pub fn extract_model_from_bundle(bundle_path: &Path) -> Result<Vec<u8>> {
    let file = std::fs::File::open(bundle_path).map_err(|_| ObjectLibraryError::NotFound {
        name: bundle_path.display().to_string(),
    })?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| ObjectLibraryError::Archive(format!("Failed to open archive: {}", e)))?;

    // Look for model.glb
    let mut model_file = archive
        .by_name("model.glb")
        .map_err(|_| ObjectLibraryError::ModelNotFound("model.glb".to_string()))?;

    let mut data = Vec::with_capacity(model_file.size() as usize);
    model_file.read_to_end(&mut data)?;

    Ok(data)
}

/// Resolve showfile object snapshot directory under nightfall data dir.
pub fn showfile_object_snapshot_dir() -> Result<PathBuf> {
    let show_data_dir = nightfall::active_show_data_dir().ok_or_else(|| {
        ObjectLibraryError::InvalidDataDirectory(
            "Could not determine active show data directory".to_string(),
        )
    })?;

    Ok(show_data_dir.join(SHOWFILE_OBJECT_SNAPSHOTS_DIR))
}

/// Copy a `.robj` bundle into show-data for showfile-stable object references.
pub fn copy_object_bundle_to_showfile_data(source_bundle_path: &Path) -> Result<PathBuf> {
    let destination_dir = showfile_object_snapshot_dir()?;
    copy_object_bundle_to_directory(source_bundle_path, &destination_dir)
}

fn copy_object_bundle_to_directory(
    source_bundle_path: &Path,
    destination_dir: &Path,
) -> Result<PathBuf> {
    let source_filename = validated_bundle_filename_from_path(source_bundle_path)?;
    std::fs::create_dir_all(destination_dir)?;

    let destination_filename = format!("{}-{}", Uuid::new_v4().simple(), source_filename);
    let destination_path = destination_dir.join(destination_filename);
    std::fs::copy(source_bundle_path, &destination_path)?;

    Ok(destination_path)
}

/// Encode a library object path for use in URLs (base64url encoding).
pub fn encode_object_path(path: &Path) -> String {
    let bundle_filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    encode_object_path_with_scope(ObjectModelPathScope::Library, &bundle_filename)
}

/// Encode a showfile object snapshot path for use in URLs (base64url encoding).
pub fn encode_showfile_object_path(path: &Path) -> String {
    let bundle_filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    encode_object_path_with_scope(ObjectModelPathScope::ShowfileData, &bundle_filename)
}

fn encode_object_path_with_scope(scope: ObjectModelPathScope, bundle_filename: &str) -> String {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    // Encode only bundle scope + filename so persisted references stay portable
    // across machines with different data directory roots.
    let scope_prefix = match scope {
        ObjectModelPathScope::Library => OBJECT_PATH_SCOPE_LIBRARY,
        ObjectModelPathScope::ShowfileData => OBJECT_PATH_SCOPE_SHOWFILE,
    };
    URL_SAFE_NO_PAD.encode(format!("{}:{}", scope_prefix, bundle_filename))
}

/// Decode an object bundle filename token from URL (base64url decoding)
pub fn decode_object_path(encoded: &str) -> Result<ObjectModelPath> {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ObjectLibraryError::Metadata("Invalid base64 encoding".to_string()))?;

    let decoded = String::from_utf8(bytes)
        .map_err(|_| ObjectLibraryError::Metadata("Invalid UTF-8 in path".to_string()))?;

    let (scope, bundle_filename) = match decoded.split_once(':') {
        Some((OBJECT_PATH_SCOPE_LIBRARY, filename)) => (ObjectModelPathScope::Library, filename),
        Some((OBJECT_PATH_SCOPE_SHOWFILE, filename)) => {
            (ObjectModelPathScope::ShowfileData, filename)
        }
        Some((_, _)) => {
            return Err(ObjectLibraryError::Metadata(
                "Invalid object model token source".to_string(),
            ));
        }
        // Backwards-compatible path: treat old filename-only tokens as library-scoped.
        None => (ObjectModelPathScope::Library, decoded.as_str()),
    };

    validate_bundle_filename(bundle_filename)?;

    Ok(ObjectModelPath {
        scope,
        bundle_filename: bundle_filename.to_string(),
    })
}

fn validated_bundle_filename_from_path(path: &Path) -> Result<String> {
    let bundle_filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            ObjectLibraryError::Metadata("Invalid object bundle filename".to_string())
        })?;

    validate_bundle_filename(bundle_filename)?;
    Ok(bundle_filename.to_string())
}

fn validate_bundle_filename(bundle_filename: &str) -> Result<()> {
    use std::path::{Component, Path as StdPath};

    if bundle_filename.contains('/') || bundle_filename.contains('\\') {
        return Err(ObjectLibraryError::Metadata(
            "Invalid object model token".to_string(),
        ));
    }

    let path = StdPath::new(bundle_filename);
    let mut components = path.components();
    let is_single_normal_component = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    );

    if !is_single_normal_component {
        return Err(ObjectLibraryError::Metadata(
            "Invalid object model token".to_string(),
        ));
    }

    let extension = path.extension().and_then(|ext| ext.to_str());
    if !matches!(extension, Some(ext) if ext.eq_ignore_ascii_case("robj")) {
        return Err(ObjectLibraryError::Metadata(
            "Invalid object bundle extension".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        ObjectModelPath, ObjectModelPathScope, copy_object_bundle_to_directory, decode_object_path,
        encode_object_path, encode_showfile_object_path,
    };

    #[test]
    fn encode_library_path_includes_scope_and_bundle_filename() {
        let encoded = encode_object_path(Path::new("/tmp/object-library/road_case.robj"));
        let decoded = decode_object_path(&encoded).expect("token should decode");
        assert_eq!(
            decoded,
            ObjectModelPath {
                scope: ObjectModelPathScope::Library,
                bundle_filename: "road_case.robj".to_string(),
            }
        );
    }

    #[test]
    fn encode_showfile_path_includes_showfile_scope() {
        let encoded = encode_showfile_object_path(Path::new(
            "/tmp/show-data/scene-objects/abc-road_case.robj",
        ));
        let decoded = decode_object_path(&encoded).expect("token should decode");
        assert_eq!(
            decoded,
            ObjectModelPath {
                scope: ObjectModelPathScope::ShowfileData,
                bundle_filename: "abc-road_case.robj".to_string(),
            }
        );
    }

    #[test]
    fn decode_legacy_filename_token_defaults_to_library_scope() {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

        let encoded = URL_SAFE_NO_PAD.encode("road_case.robj");
        let decoded = decode_object_path(&encoded).expect("token should decode");
        assert_eq!(
            decoded,
            ObjectModelPath {
                scope: ObjectModelPathScope::Library,
                bundle_filename: "road_case.robj".to_string(),
            }
        );
    }

    #[test]
    fn decode_rejects_path_separators() {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

        let encoded = URL_SAFE_NO_PAD.encode("../nested/object.robj");
        let result = decode_object_path(&encoded);
        assert!(result.is_err());

        let encoded = URL_SAFE_NO_PAD.encode("nested\\object.robj");
        let result = decode_object_path(&encoded);
        assert!(result.is_err());
    }

    #[test]
    fn decode_rejects_non_robj_extensions() {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

        let encoded = URL_SAFE_NO_PAD.encode("object.glb");
        let result = decode_object_path(&encoded);
        assert!(result.is_err());
    }

    #[test]
    fn decode_rejects_unknown_scope_prefix() {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

        let encoded = URL_SAFE_NO_PAD.encode("other:object.robj");
        let result = decode_object_path(&encoded);
        assert!(result.is_err());
    }

    #[test]
    fn copy_object_bundle_to_directory_creates_snapshot_copy() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let source_bundle = temp_dir.path().join("road_case.robj");
        std::fs::write(&source_bundle, b"snapshot-bytes").expect("write source bundle");

        let destination_dir = temp_dir.path().join("show-data").join("scene-objects");
        let copied_path = copy_object_bundle_to_directory(&source_bundle, &destination_dir)
            .expect("copy into destination directory");

        assert!(copied_path.starts_with(&destination_dir));
        assert_ne!(copied_path, source_bundle);

        let copied_name = copied_path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("copied bundle name");
        assert!(copied_name.ends_with("-road_case.robj"));

        let copied_contents = std::fs::read(&copied_path).expect("read copied bundle");
        assert_eq!(copied_contents, b"snapshot-bytes");
    }

    #[test]
    fn copy_object_bundle_to_directory_uses_unique_names() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let source_bundle = temp_dir.path().join("road_case.robj");
        std::fs::write(&source_bundle, b"snapshot-bytes").expect("write source bundle");

        let destination_dir = temp_dir.path().join("show-data").join("scene-objects");
        let copy_a = copy_object_bundle_to_directory(&source_bundle, &destination_dir)
            .expect("copy A should succeed");
        let copy_b = copy_object_bundle_to_directory(&source_bundle, &destination_dir)
            .expect("copy B should succeed");

        assert_ne!(copy_a, copy_b);
        assert_eq!(
            std::fs::read(copy_a).expect("read copy A"),
            std::fs::read(copy_b).expect("read copy B")
        );
    }
}
