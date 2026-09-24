// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! GDTF metadata extraction
//!
//! Since `gdtf::GdtfFile` contains non-Clone, non-Send types (ZIP archive handles),
//! we extract only the metadata we need into cloneable structures.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{FixtureLibraryError, Result};

/// Metadata extracted from a GDTF file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GdtfMetadata {
    /// Manufacturer name
    pub manufacturer: String,
    /// Fixture model name
    pub model: String,
    /// Available DMX modes
    pub modes: Vec<String>,
    /// File path for on-demand re-parsing
    pub file_path: std::path::PathBuf,
}

impl GdtfMetadata {
    /// Extract metadata from a GDTF file
    pub fn from_file(path: &Path) -> Result<Self> {
        let file = std::fs::File::open(path)?;
        let gdtf_file = gdtf::GdtfFile::new(file)
            .map_err(|e| FixtureLibraryError::Gdtf(format!("Failed to parse GDTF file: {}", e)))?;

        // Extract manufacturer and model from description
        let (manufacturer, model) = extract_fixture_info(&gdtf_file);

        // Extract mode names
        let modes = extract_mode_names(&gdtf_file);

        Ok(Self {
            manufacturer,
            model,
            modes,
            file_path: path.to_path_buf(),
        })
    }

    /// Re-parse the GDTF file for conversion
    pub fn reparse(&self) -> Result<gdtf::GdtfFile> {
        let file = std::fs::File::open(&self.file_path)?;
        gdtf::GdtfFile::new(file)
            .map_err(|e| FixtureLibraryError::Gdtf(format!("Failed to re-parse GDTF file: {}", e)))
    }
}

/// Extract manufacturer and model from GDTF file
fn extract_fixture_info(gdtf: &gdtf::GdtfFile) -> (String, String) {
    if let Some(fixture_type) = gdtf.description.fixture_types.first() {
        let manufacturer = fixture_type.manufacturer.clone();
        // Some archives leave LongName empty; the required Name identifies the type.
        let model = if fixture_type.long_name.trim().is_empty() {
            fixture_type
                .name
                .as_ref()
                .map(|name| name.to_string())
                .unwrap_or_default()
        } else {
            fixture_type.long_name.clone()
        };
        return (manufacturer, model);
    }

    // Fallback
    ("Unknown".to_string(), "Unknown".to_string())
}

/// Extract DMX mode names from GDTF file
fn extract_mode_names(gdtf: &gdtf::GdtfFile) -> Vec<String> {
    if let Some(fixture_type) = gdtf.description.fixture_types.first() {
        return fixture_type
            .dmx_modes
            .iter()
            .filter_map(|mode| mode.name.as_ref().map(|n| n.to_string()))
            .collect();
    }

    vec![]
}

#[cfg(test)]
mod tests {
    use crate::testing::{GdtfBuilder, GeometrySpec, ModeSpec};

    /// Verifies an empty `LongName` falls back to the fixture type's `Name`.
    #[test]
    fn empty_long_name_falls_back_to_name() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Pixel Line")
            .long_name("")
            .geometry(GeometrySpec::generic("Body"))
            .mode(ModeSpec::new("Mode", "Body"))
            .write_metadata(dir.path());
        assert_eq!(metadata.model, "Pixel Line");
    }
}
