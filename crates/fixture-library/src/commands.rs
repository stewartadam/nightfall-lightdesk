// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket commands for fixture library operations

use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::{Fixture, FixtureGeometry};
use serde::{Deserialize, Serialize};

/// Commands for fixture library operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FixtureLibraryCommand {
    /// List all available fixtures in the library
    ListAvailableFixtures,

    /// Get detailed information about a specific fixture
    GetFixtureProfile {
        /// Manufacturer name
        make: String,
        /// Model name
        model: String,
        /// Optional DMX mode name (if not provided, uses first/default mode)
        #[serde(default)]
        mode: Option<String>,
        /// Library revision to inspect; the default revision when omitted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset_etag: Option<String>,
    },

    /// Refresh the fixture library by rescanning the directory
    RefreshLibrary,

    /// Create a fixture from the library
    CreateFixtureFromLibrary {
        /// Fixture ID
        id: u32,
        /// Manufacturer name
        make: String,
        /// Model name
        model: String,
        /// DMX mode name
        mode: String,
        /// Library revision to create from; the default revision when omitted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset_etag: Option<String>,
        /// Optional user-defined label for the fixture
        #[serde(default)]
        label: Option<String>,
        /// Existing fixture IDs to update to this library asset version
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        update_existing_ids: Vec<u32>,
        /// Update existing fixtures without creating a new fixture instance.
        #[serde(default)]
        update_existing_only: bool,
    },

    /// Upload a fixture file to the library
    UploadFixture {
        /// Original filename (used to determine format and as storage name)
        filename: String,
        /// File content as bytes
        content: Vec<u8>,
    },

    /// Delete fixtures from the library
    DeleteFixtures(Vec<FixtureLibraryEntry>),
}

impl IngressCommand for FixtureLibraryCommand {}

/// Identifies a fixture in the library by make and model
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixtureLibraryEntry {
    /// Manufacturer name
    pub make: String,
    /// Model name
    pub model: String,
    /// Revision to delete; the default revision when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_etag: Option<String>,
}

/// Information about an available fixture
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct AvailableFixtureInfo {
    /// Manufacturer name
    pub make: String,
    /// Model name
    pub model: String,
    /// Available modes
    pub modes: Vec<String>,
    /// Source format (GDTF, OFL, or built-in)
    pub source_format: String,
    /// Deterministic content fingerprint of the fixture source file
    pub asset_etag: String,
}

/// Response for ListAvailableFixtures command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ListAvailableFixturesResponse {
    /// List of available fixtures
    pub fixtures: Vec<AvailableFixtureInfo>,
}

/// Response for GetFixtureProfile command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GetFixtureProfileResponse {
    /// Fixture information
    pub info: AvailableFixtureInfo,
    /// DMX mode requested for this profile response after applying the default mode fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_mode: Option<String>,
    /// Parsed fixture data for the requested mode (for visualization preview).
    /// This is an ephemeral fixture with ID 0 - not stored in the show.
    #[serde(default)]
    pub fixture: Option<Fixture>,
    /// Geometry data for the fixture (GDTF only).
    /// Used by the visualizer to render an accurate 3D model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<FixtureGeometry>,
}
