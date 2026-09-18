// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OFL fixture representation and parsing

use std::path::Path;

use crate::schema::OflFixtureSchema;
use crate::{OflMode, Result};

/// An Open Fixture Library fixture definition
#[derive(Debug, Clone)]
pub struct OflFixture {
    inner: OflFixtureSchema,
    /// Manufacturer extracted from filename or explicitly set
    manufacturer_override: Option<String>,
}

impl OflFixture {
    /// Parse an OFL fixture from a JSON file
    ///
    /// Attempts to extract manufacturer from filename if present in the format:
    /// `manufacturer@fixture.json` or `manufacturer/fixture.json`
    pub fn from_file(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let manufacturer = extract_manufacturer_from_path(path);
        Self::from_json_with_manufacturer(&content, manufacturer)
    }

    /// Parse an OFL fixture from a JSON string
    pub fn from_json(json: &str) -> Result<Self> {
        Self::from_json_with_manufacturer(json, None)
    }

    /// Parse an OFL fixture from a JSON string with optional manufacturer override
    pub fn from_json_with_manufacturer(json: &str, manufacturer: Option<String>) -> Result<Self> {
        let inner: OflFixtureSchema = serde_json::from_str(json)?;
        Ok(Self {
            inner,
            manufacturer_override: manufacturer,
        })
    }

    /// Get the fixture manufacturer name
    ///
    /// Returns the manufacturer from:
    /// 1. Override value (from filename)
    /// 2. manufacturer_key field in JSON
    /// 3. "Unknown" as fallback
    pub fn manufacturer(&self) -> &str {
        self.manufacturer_override
            .as_deref()
            .or(self.inner.manufacturer_key.as_deref())
            .unwrap_or("Unknown")
    }

    /// Get the fixture name/model
    pub fn name(&self) -> &str {
        &self.inner.name
    }

    /// Get short name if available
    pub fn short_name(&self) -> Option<&str> {
        self.inner.short_name.as_deref()
    }

    /// Get fixture categories
    pub fn categories(&self) -> &[String] {
        &self.inner.categories
    }

    /// Get fixture metadata (author, create date, etc.)
    pub fn meta(&self) -> &crate::schema::OflMeta {
        &self.inner.meta
    }

    /// Get available modes for this fixture
    pub fn modes(&self) -> &[OflMode] {
        &self.inner.modes
    }

    /// Get physical properties if available
    pub fn physical(&self) -> Option<&crate::schema::OflPhysical> {
        self.inner.physical.as_ref()
    }

    /// Get available channels definition
    pub fn available_channels(
        &self,
    ) -> &std::collections::HashMap<String, crate::schema::OflChannel> {
        &self.inner.available_channels
    }

    /// Get template channels if any
    pub fn template_channels(
        &self,
    ) -> Option<&std::collections::HashMap<String, crate::schema::OflTemplateChannel>> {
        self.inner.template_channels.as_ref()
    }

    /// Get matrix configuration if any
    pub fn matrix(&self) -> Option<&crate::schema::OflMatrix> {
        self.inner.matrix.as_ref()
    }
}

/// Extract manufacturer from file path
///
/// OFL files are often named with the pattern:
/// - `manufacturer@fixture.json` (e.g., `chauvet-dj@intimidator-spot-260.json`)
/// - Or organized in directories: `manufacturer/fixture.json`
///
/// This function extracts the manufacturer key and converts it to a readable name.
fn extract_manufacturer_from_path(path: &Path) -> Option<String> {
    // Try filename pattern: manufacturer@fixture.json
    if let Some(filename) = path.file_stem().and_then(|s| s.to_str()) {
        if let Some((manufacturer_key, _fixture_name)) = filename.split_once('@') {
            // Convert kebab-case to Title Case (e.g., "chauvet-dj" -> "Chauvet DJ")
            return Some(manufacturer_key_to_name(manufacturer_key));
        }
    }

    // Try directory pattern: manufacturer/fixture.json
    if let Some(parent) = path.parent()
        && let Some(dir_name) = parent.file_name().and_then(|s| s.to_str())
    {
        // Check if this looks like a manufacturer directory (not "fixtures" or similar)
        if !dir_name.eq_ignore_ascii_case("fixtures") && !dir_name.eq_ignore_ascii_case("library") {
            return Some(manufacturer_key_to_name(dir_name));
        }
    }

    None
}

/// Convert manufacturer key to readable name
///
/// Converts kebab-case or snake_case to Title Case.
/// Examples:
/// - "chauvet-dj" -> "Chauvet DJ"
/// - "martin_professional" -> "Martin Professional"
/// - "robe" -> "Robe"
fn manufacturer_key_to_name(key: &str) -> String {
    key.split(['-', '_'])
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
