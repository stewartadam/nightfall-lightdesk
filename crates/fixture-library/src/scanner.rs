// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! File system scanner for fixture files

use std::path::{Path, PathBuf};

use crate::gdtf_metadata::GdtfMetadata;
use crate::{FixtureProfile, FixtureSource, Result};

/// Fixture file scanner
pub struct FixtureScanner {
    library_path: PathBuf,
}

impl FixtureScanner {
    /// Create a new scanner for the given library path
    pub fn new(library_path: &Path) -> Self {
        Self {
            library_path: library_path.to_path_buf(),
        }
    }

    /// Scan the library directory for fixture files
    pub fn scan(&self) -> Result<Vec<FixtureProfile>> {
        let mut profiles = Vec::new();

        if !self.library_path.exists() {
            return Ok(profiles);
        }

        for entry in std::fs::read_dir(&self.library_path)? {
            let entry = entry?;
            let path = entry.path();

            if !path.is_file() {
                continue;
            }

            match self.try_parse_file(&path) {
                Ok(Some(profile)) => {
                    tracing::trace!(
                        make = %profile.make,
                        model = %profile.model,
                        file_path = ?profile.file_path,
                        "Found fixture"
                    );
                    profiles.push(profile)
                }
                Ok(None) => {} // Not a fixture file, skip silently
                Err(e) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %e,
                        "Failed to parse fixture file"
                    );
                }
            }
        }

        Ok(profiles)
    }

    /// Try to parse a file as a fixture definition
    /// Returns Ok(None) if the file is not a recognized fixture format
    /// Returns Err on parsing errors
    fn try_parse_file(&self, path: &Path) -> Result<Option<FixtureProfile>> {
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());

        match extension.as_deref() {
            Some("gdtf") => self.parse_gdtf(path).map(Some),
            Some("json") if is_visualizer_definition(path)? => Ok(None),
            Some("json") => self.parse_ofl(path).map(Some),
            _ => Ok(None),
        }
    }

    /// Parse a GDTF file
    fn parse_gdtf(&self, path: &Path) -> Result<FixtureProfile> {
        // Extract metadata from GDTF file
        let metadata = GdtfMetadata::from_file(path)?;

        let make = metadata.manufacturer.clone();
        let model = metadata.model.clone();

        Ok(FixtureProfile {
            source: FixtureSource::Gdtf(metadata),
            make,
            model,
            revision: crate::manager::fixture_source_version(path)?,
            file_path: path.to_path_buf(),
        })
    }

    /// Parse an OFL JSON file
    fn parse_ofl(&self, path: &Path) -> Result<FixtureProfile> {
        let ofl_fixture = open_fixture_library::OflFixture::from_file(path)?;

        let make = ofl_fixture.manufacturer().to_string();
        let model = ofl_fixture.name().to_string();

        Ok(FixtureProfile {
            source: FixtureSource::Ofl(Box::new(ofl_fixture)),
            make,
            model,
            revision: crate::manager::fixture_source_version(path)?,
            file_path: path.to_path_buf(),
        })
    }
}

/// Identify Nightfall visualizer JSON without accepting it as an OFL profile.
/// Files declaring an OFL schema always go through the OFL parser so malformed
/// fixture definitions still produce the scanner's normal warning.
fn is_visualizer_definition(path: &Path) -> Result<bool> {
    let content = std::fs::read_to_string(path)?;
    let definition: serde_json::Value =
        serde_json::from_str(&content).map_err(open_fixture_library::OflError::from)?;

    Ok(definition.get("$schema").is_none()
        && definition["schemaVersion"].is_u64()
        && definition["make"].is_string()
        && definition["model"].is_string()
        && definition["behavior"].is_string()
        && definition["geometry"].is_object())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an OFL document with all required fields for scanner tests.
    fn ofl_definition() -> serde_json::Value {
        serde_json::json!({
            "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
            "name": "Test Fixture",
            "categories": ["Other"],
            "meta": {
                "authors": ["Nightfall"],
                "createDate": "2026-09-05",
                "lastModifyDate": "2026-09-05"
            },
            "availableChannels": {},
            "modes": []
        })
    }

    /// Scanning a mixed library skips generic visualizer samples and loads OFL.
    #[test]
    fn scan_skips_visualizer_definitions() {
        let library = tempfile::tempdir().unwrap();
        let scanner = FixtureScanner::new(library.path());
        let definitions = [
            include_str!("../tests/fixtures/visualizer/strobe-matrix.json"),
            include_str!("../tests/fixtures/visualizer/moving-head-spot.json"),
            include_str!("../tests/fixtures/visualizer/rgb-pixel-tape.json"),
            include_str!("../tests/fixtures/visualizer/led-bar.json"),
        ];
        for (index, definition) in definitions.iter().enumerate() {
            let path = library.path().join(format!("visualizer-{index}.json"));
            std::fs::write(&path, definition).unwrap();
            assert!(scanner.try_parse_file(&path).unwrap().is_none());
        }

        let ofl_path = library.path().join("test-maker@test-fixture.json");
        std::fs::write(&ofl_path, ofl_definition().to_string()).unwrap();
        let profiles = scanner.scan().unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].make, "Test Maker");
        assert_eq!(profiles[0].model, "Test Fixture");
        assert_eq!(profiles[0].file_path, ofl_path);
    }

    /// Invalid JSON and OFL documents must remain errors instead of being skipped.
    #[test]
    fn scan_preserves_json_and_ofl_errors() {
        let library = tempfile::tempdir().unwrap();
        let scanner = FixtureScanner::new(library.path());
        let path = library.path().join("invalid.json");
        std::fs::write(&path, "{").unwrap();
        assert!(scanner.try_parse_file(&path).is_err());

        let mut definition = ofl_definition();
        definition.as_object_mut().unwrap().remove("$schema");
        std::fs::write(&path, definition.to_string()).unwrap();
        assert!(scanner.try_parse_file(&path).is_err());

        let mut definition: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/visualizer/moving-head-spot.json"
        ))
        .unwrap();
        definition["$schema"] = ofl_definition()["$schema"].clone();
        std::fs::write(&path, definition.to_string()).unwrap();
        assert!(scanner.try_parse_file(&path).is_err());
    }
}
