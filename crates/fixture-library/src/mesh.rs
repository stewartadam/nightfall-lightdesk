// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Mesh extraction from GDTF files.
//!
//! This module provides functionality to extract 3D mesh data from GDTF fixture files
//! for use in visualization.

use std::io::Read;
use std::path::Path;

use crate::gdtf_archive::{ArchiveLimits, ArchiveSnapshot};
use crate::gdtf_resolver::ResolveError;

/// Format of the extracted mesh data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshFormat {
    /// GLTF binary format (preferred)
    Glb,
    /// 3DS Max format (fallback)
    ThreeDs,
}

impl MeshFormat {
    /// Returns the MIME type for this mesh format.
    pub fn content_type(&self) -> &'static str {
        match self {
            MeshFormat::Glb => "model/gltf-binary",
            MeshFormat::ThreeDs => "model/x.3ds",
        }
    }
}

/// Result of extracting a mesh from a GDTF file.
#[derive(Debug)]
pub struct ExtractedMesh {
    /// The mesh data bytes.
    pub data: Vec<u8>,
    /// The format of the mesh data.
    pub format: MeshFormat,
}

/// Error types for mesh extraction.
#[derive(Debug)]
pub enum MeshExtractionError {
    /// The indexed path no longer contains the revision requested by the geometry.
    RevisionUnavailable,
    /// Resource names must remain a single archive-local model stem.
    InvalidModelName,
    /// Shared archive validation rejected a resource request.
    ArchiveError(ResolveError),
    /// Failed to parse the GDTF file.
    ParseError(String),
    /// Mesh not found in the GDTF archive.
    MeshNotFound(String),
    /// IO error during extraction.
    IoError(std::io::Error),
}

impl std::fmt::Display for MeshExtractionError {
    /// Describe extraction failures without erasing bounded-archive diagnostic context.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RevisionUnavailable => write!(f, "Requested archive revision is unavailable"),
            Self::InvalidModelName => {
                write!(f, "Model name must be a single nonempty resource stem")
            }
            Self::ArchiveError(error) => write!(f, "{error}"),
            MeshExtractionError::ParseError(msg) => {
                write!(f, "Failed to parse GDTF file: {}", msg)
            }
            MeshExtractionError::MeshNotFound(model) => {
                write!(f, "Mesh '{}' not found in GDTF archive", model)
            }
            MeshExtractionError::IoError(e) => {
                write!(f, "IO error: {}", e)
            }
        }
    }
}

impl std::error::Error for MeshExtractionError {}

impl From<std::io::Error> for MeshExtractionError {
    /// Preserve decompression or resource-read failures rather than silently trying another format.
    fn from(e: std::io::Error) -> Self {
        MeshExtractionError::IoError(e)
    }
}

/// Extract a mesh from a GDTF file.
///
/// Attempts to load the mesh in GLB format first (preferred), falling back to 3DS format.
///
/// # Arguments
///
/// * `gdtf_path` - Path to the GDTF file
/// * `model_name` - Name of the model/mesh to extract
///
/// # Returns
///
/// The extracted mesh data and format, or an error if extraction failed.
pub fn extract_mesh_from_gdtf(
    gdtf_path: &Path,
    model_name: &str,
) -> Result<ExtractedMesh, MeshExtractionError> {
    extract_mesh_with_limits(gdtf_path, model_name, ArchiveLimits::default())
}

/// Load an immutable bounded archive snapshot and extract only the requested model resource.
/// GLB is preferred; missing or empty GLB permits 3DS fallback, but corrupt/oversized data is an error.
pub fn extract_mesh_with_limits(
    gdtf_path: &Path,
    model_name: &str,
    limits: ArchiveLimits,
) -> Result<ExtractedMesh, MeshExtractionError> {
    let snapshot = ArchiveSnapshot::read(gdtf_path, limits.archive_bytes)
        .map_err(MeshExtractionError::ArchiveError)?;
    extract_mesh_from_snapshot(&snapshot, model_name, limits)
}

/// Serve only bytes from the requested archive revision, even if its indexed path was replaced.
pub fn extract_mesh_from_revision(
    gdtf_path: &Path,
    archive_sha256: &str,
    model_name: &str,
) -> Result<ExtractedMesh, MeshExtractionError> {
    let limits = ArchiveLimits::default();
    let snapshot = ArchiveSnapshot::read(gdtf_path, limits.archive_bytes)
        .map_err(MeshExtractionError::ArchiveError)?;
    if snapshot.sha256() != archive_sha256 {
        return Err(MeshExtractionError::RevisionUnavailable);
    }
    extract_mesh_from_snapshot(&snapshot, model_name, limits)
}

/// Extract a resource from retained source bytes, sharing the same path for current and pinned archives.
pub fn extract_mesh_from_snapshot(
    snapshot: &ArchiveSnapshot,
    model_name: &str,
    limits: ArchiveLimits,
) -> Result<ExtractedMesh, MeshExtractionError> {
    if model_name.is_empty()
        || matches!(model_name, "." | "..")
        || model_name.contains(['/', '\\', '\0'])
    {
        return Err(MeshExtractionError::InvalidModelName);
    }
    let mut archive = snapshot
        .open_validated(limits)
        .map_err(MeshExtractionError::ArchiveError)?;
    for (path, format) in [
        (format!("models/gltf/{model_name}.glb"), MeshFormat::Glb),
        (format!("models/3ds/{model_name}.3ds"), MeshFormat::ThreeDs),
    ] {
        let resource = match archive.by_name(&path) {
            Ok(resource) => resource,
            Err(zip::result::ZipError::FileNotFound) => continue,
            Err(error) => return Err(MeshExtractionError::ParseError(error.to_string())),
        };
        let mut data = Vec::new();
        resource
            .take(limits.entry_bytes.saturating_add(1))
            .read_to_end(&mut data)?;
        if data.len() as u64 > limits.entry_bytes {
            return Err(MeshExtractionError::ArchiveError(ResolveError {
                code: "resource_size_limit",
                path,
                message: "Decoded mesh exceeds the resource byte budget".into(),
            }));
        }
        if !data.is_empty() {
            return Ok(ExtractedMesh { data, format });
        }
    }
    Err(MeshExtractionError::MeshNotFound(model_name.into()))
}

/// Decode a base64url-encoded GDTF path.
///
/// The path is encoded to be safely used in URLs.
pub fn decode_gdtf_path(encoded: &str) -> Result<String, MeshExtractionError> {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| MeshExtractionError::ParseError("Invalid base64 encoding".to_string()))?;

    String::from_utf8(bytes)
        .map_err(|_| MeshExtractionError::ParseError("Invalid UTF-8 in path".to_string()))
}
