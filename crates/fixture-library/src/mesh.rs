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
    /// Failed to open the GDTF file.
    FileNotFound(String),
    /// Failed to parse the GDTF file.
    ParseError(String),
    /// Mesh not found in the GDTF archive.
    MeshNotFound(String),
    /// IO error during extraction.
    IoError(std::io::Error),
}

impl std::fmt::Display for MeshExtractionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MeshExtractionError::FileNotFound(path) => {
                write!(f, "GDTF file not found: {}", path)
            }
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
    fn from(e: std::io::Error) -> Self {
        MeshExtractionError::IoError(e)
    }
}

/// Opens a GDTF archive to read its resources, repairing authoring faults as the library does.
fn open_gdtf_for_resources(gdtf_path: &Path) -> Result<gdtf::GdtfFile, MeshExtractionError> {
    if !gdtf_path.is_file() {
        return Err(MeshExtractionError::FileNotFound(
            gdtf_path.display().to_string(),
        ));
    }
    crate::gdtf_repair::open_gdtf(gdtf_path)
        .map(|(gdtf_file, _)| gdtf_file)
        .map_err(MeshExtractionError::ParseError)
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
    let mut gdtf_file = open_gdtf_for_resources(gdtf_path)?;

    // Try to load GLB format first (preferred)
    if let Ok(mut resource) = gdtf_file.resources.read_model_mesh(
        model_name,
        gdtf::Model3Format::Gltf,
        gdtf::Model3Detail::Default,
    ) {
        let mut data = Vec::with_capacity(resource.size() as usize);
        if resource.read_to_end(&mut data).is_ok() && !data.is_empty() {
            return Ok(ExtractedMesh {
                data,
                format: MeshFormat::Glb,
            });
        }
    }

    // Try to load 3DS format as fallback
    if let Ok(mut resource) = gdtf_file.resources.read_model_mesh(
        model_name,
        gdtf::Model3Format::Max3ds,
        gdtf::Model3Detail::Default,
    ) {
        let mut data = Vec::with_capacity(resource.size() as usize);
        if resource.read_to_end(&mut data).is_ok() && !data.is_empty() {
            return Ok(ExtractedMesh {
                data,
                format: MeshFormat::ThreeDs,
            });
        }
    }

    Err(MeshExtractionError::MeshNotFound(model_name.to_string()))
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

/// Extract a wheel slot image (PNG) from a GDTF file.
///
/// `media_name` is a wheel slot's `MediaFileName`, with or without the
/// `.png` extension some archives include.
pub fn extract_wheel_media_from_gdtf(
    gdtf_path: &Path,
    media_name: &str,
) -> Result<Vec<u8>, MeshExtractionError> {
    let mut gdtf_file = open_gdtf_for_resources(gdtf_path)?;

    let name = media_name.strip_suffix(".png").unwrap_or(media_name);
    let mut resource = gdtf_file
        .resources
        .read_wheel_media(name)
        .map_err(|_| MeshExtractionError::MeshNotFound(media_name.to_string()))?;
    let mut data = Vec::with_capacity(resource.size() as usize);
    resource.read_to_end(&mut data)?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{GdtfBuilder, GeometrySpec};

    /// Verifies wheel images are found with or without a `.png` suffix in the media name.
    #[test]
    fn wheel_media_resolves_with_and_without_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gobo.gdtf");
        GdtfBuilder::new("Test", "Gobo")
            .geometry(GeometrySpec::generic("Base"))
            .file("wheels/stars.png", b"\x89PNG-bytes")
            .write_to(&path);
        assert_eq!(
            extract_wheel_media_from_gdtf(&path, "stars").unwrap(),
            b"\x89PNG-bytes"
        );
        assert!(extract_wheel_media_from_gdtf(&path, "stars.png").is_ok());
        assert!(matches!(
            extract_wheel_media_from_gdtf(&path, "missing"),
            Err(MeshExtractionError::MeshNotFound(_))
        ));
    }
}
