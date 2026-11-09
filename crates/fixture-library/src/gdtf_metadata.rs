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

use nightfall_fixtures::library::commands::GdtfRevisionNote;
use serde::{Deserialize, Serialize};

use crate::gdtf_repair::{open_gdtf, open_gdtf_description};
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
    /// Lowercase `FixtureTypeID`, shared by every revision of the fixture type; `None` when
    /// the archive leaves it nil.
    #[serde(default)]
    pub fixture_type_id: Option<String>,
    /// Text of the archive's latest `Revision` entry, which GDTF Share lists as the
    /// revision's name; `None` when the archive records no revision text.
    #[serde(default)]
    pub revision: Option<String>,
    /// Every `Revision` entry with text, oldest first, so an update can show what changed.
    #[serde(default)]
    pub revision_notes: Vec<GdtfRevisionNote>,
    /// File path for on-demand re-parsing
    pub file_path: std::path::PathBuf,
}

impl GdtfMetadata {
    /// Extract metadata from a GDTF file
    pub fn from_file(path: &Path) -> Result<Self> {
        let (gdtf_file, _) = open_gdtf_description(path)
            .map_err(|e| FixtureLibraryError::Gdtf(format!("Failed to parse GDTF file: {}", e)))?;

        // Extract manufacturer and model from description
        let (manufacturer, model) = extract_fixture_info(&gdtf_file);

        // Extract mode names
        let modes = extract_mode_names(&gdtf_file);

        Ok(Self {
            manufacturer,
            model,
            modes,
            fixture_type_id: extract_fixture_type_id(&gdtf_file),
            revision: extract_revision(&gdtf_file),
            revision_notes: extract_revision_notes(&gdtf_file),
            file_path: path.to_path_buf(),
        })
    }

    /// Re-parse the GDTF file for conversion
    pub fn reparse(&self) -> Result<gdtf::GdtfFile> {
        open_gdtf(&self.file_path)
            .map(|(gdtf_file, _)| gdtf_file)
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

/// Extracts the fixture type id, which GDTF Share also lists, so library and online
/// entries for one fixture type can be matched.
fn extract_fixture_type_id(gdtf: &gdtf::GdtfFile) -> Option<String> {
    gdtf.description
        .fixture_types
        .first()
        .map(|fixture_type| fixture_type.fixture_type_id)
        .filter(|id| !id.is_nil())
        .map(|id| id.to_string())
}

/// Extracts the text of the last `Revision` entry, the one written by whoever last edited
/// or uploaded the archive, so a library copy can be matched to the GDTF Share revision
/// it came from.
fn extract_revision(gdtf: &gdtf::GdtfFile) -> Option<String> {
    gdtf.description
        .fixture_types
        .first()?
        .revisions
        .last()
        .map(|revision| revision.text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// Extracts every `Revision` entry that has text, oldest first, trimmed, with the date the
/// archive records for it.
fn extract_revision_notes(gdtf: &gdtf::GdtfFile) -> Vec<GdtfRevisionNote> {
    let Some(fixture_type) = gdtf.description.fixture_types.first() else {
        return Vec::new();
    };
    fixture_type
        .revisions
        .iter()
        .filter(|revision| !revision.text.trim().is_empty())
        .map(|revision| GdtfRevisionNote {
            text: revision.text.trim().to_string(),
            date: revision.date.trim().to_string(),
        })
        .collect()
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
    use super::GdtfRevisionNote;
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

    /// Reads the archive's `FixtureTypeID`, which GDTF Share lists for the same fixture type.
    #[test]
    fn reads_the_fixture_type_id() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Spot")
            .geometry(GeometrySpec::generic("Body"))
            .mode(ModeSpec::new("Mode", "Body"))
            .write_metadata(dir.path());
        assert_eq!(
            metadata.fixture_type_id.as_deref(),
            Some("00000000-0000-0000-0000-000000000001")
        );
    }

    /// Reports the last revision's text, which GDTF Share lists as the revision name, and
    /// nothing for an archive without revisions.
    #[test]
    fn reads_the_latest_revision_text() {
        let dir = tempfile::tempdir().unwrap();
        let builder = GdtfBuilder::new("Test", "Spot")
            .geometry(GeometrySpec::generic("Body"))
            .mode(ModeSpec::new("Mode", "Body"));
        assert_eq!(builder.write_metadata(dir.path()).revision, None);
        let metadata = builder
            .revision("Created")
            .revision("  added white channel ")
            .write_metadata(dir.path());
        assert_eq!(metadata.revision.as_deref(), Some("added white channel"));
    }

    /// Lists every revision with text, oldest first and trimmed, with its recorded date,
    /// skipping entries whose text is blank.
    #[test]
    fn lists_revision_notes_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Spot")
            .geometry(GeometrySpec::generic("Body"))
            .mode(ModeSpec::new("Mode", "Body"))
            .revision("Created")
            .revision("   ")
            .revision(" added white channel ")
            .write_metadata(dir.path());
        let note = |text: &str| GdtfRevisionNote {
            text: text.to_string(),
            date: "2024-01-01T00:00:00".to_string(),
        };
        assert_eq!(
            metadata.revision_notes,
            vec![note("Created"), note("added white channel")]
        );
    }
}
