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

use crate::gdtf_archive::{ArchiveLimits, ArchiveSnapshot};
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

    /// Parse a bounded immutable snapshot and return its exact digest for geometry/resource identity.
    pub fn reparse(&self) -> Result<(gdtf::GdtfFile, String)> {
        let limits = ArchiveLimits::default();
        let snapshot = ArchiveSnapshot::read(&self.file_path, limits.archive_bytes)
            .map_err(|error| FixtureLibraryError::Gdtf(error.to_string()))?;
        snapshot
            .open_validated(limits)
            .map_err(|error| FixtureLibraryError::Gdtf(error.to_string()))?;
        let digest = snapshot.sha256().to_owned();
        let file = gdtf::GdtfFile::new(snapshot.into_reader())
            .map_err(|e| FixtureLibraryError::Gdtf(format!("Failed to re-parse GDTF file: {e}")))?;
        Ok((file, digest))
    }
}

/// Extract manufacturer and model from GDTF file
fn extract_fixture_info(gdtf: &gdtf::GdtfFile) -> (String, String) {
    if let Some(fixture_type) = gdtf.description.fixture_types.first() {
        let manufacturer = fixture_type.manufacturer.clone();
        let model = fixture_type.long_name.clone();
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
