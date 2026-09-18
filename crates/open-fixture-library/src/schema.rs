// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OFL JSON schema data structures
//!
//! These structures closely match the Open Fixture Library JSON schema.
//! See: https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/fixture-format.md

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Top-level OFL fixture schema
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflFixtureSchema {
    /// Schema version (e.g., "12.1.1")
    #[serde(rename = "$schema")]
    pub schema: String,

    /// Fixture name
    pub name: String,

    /// Short name (optional)
    pub short_name: Option<String>,

    /// Fixture categories
    pub categories: Vec<String>,

    /// Metadata about the fixture definition
    pub meta: OflMeta,

    /// Comment or description (optional)
    pub comment: Option<String>,

    /// Help text (optional)
    pub help_wanted: Option<String>,

    /// Links to related resources
    #[serde(default)]
    pub links: HashMap<String, Vec<String>>,

    /// RDM information (optional)
    pub rdm: Option<OflRdm>,

    /// Physical properties (optional)
    pub physical: Option<OflPhysical>,

    /// Available channels
    pub available_channels: HashMap<String, OflChannel>,

    /// Template channels for matrix fixtures (optional)
    pub template_channels: Option<HashMap<String, OflTemplateChannel>>,

    /// Matrix pixel configuration (optional)
    pub matrix: Option<OflMatrix>,

    /// Available modes
    pub modes: Vec<OflMode>,

    /// Manufacturer key from manufacturers.json
    #[serde(skip)]
    pub manufacturer_key: Option<String>,
}

/// Fixture metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflMeta {
    /// Authors of this fixture definition
    pub authors: Vec<String>,

    /// Creation date (ISO 8601)
    pub create_date: String,

    /// Last modification date (ISO 8601)
    pub last_modify_date: String,

    /// Import comment (optional)
    pub import_comment: Option<String>,
}

/// RDM (Remote Device Management) information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflRdm {
    /// RDM model ID
    pub model_id: u16,

    /// Software version (optional)
    pub software_version: Option<String>,
}

/// Physical properties of the fixture
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflPhysical {
    /// Physical dimensions (optional)
    pub dimensions: Option<[f32; 3]>,

    /// Weight in kg (optional)
    pub weight: Option<f32>,

    /// Power consumption in watts (optional)
    pub power: Option<f32>,

    /// DMX connector type (optional)
    pub dmx_connector: Option<String>,

    /// Bulb/lamp information (optional)
    pub bulb: Option<OflBulb>,

    /// Lens information (optional)
    pub lens: Option<OflLens>,

    /// Focus information (optional)
    pub focus: Option<OflFocus>,
}

/// Bulb/lamp information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflBulb {
    /// Bulb type (e.g., "LED")
    #[serde(rename = "type")]
    pub bulb_type: Option<String>,

    /// Color temperature in Kelvin (optional)
    pub color_temperature: Option<f32>,

    /// Luminous flux in lumens (optional)
    pub lumens: Option<f32>,
}

/// Lens information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflLens {
    /// Lens name (optional)
    pub name: Option<String>,

    /// Degrees of zoom range [min, max] (optional)
    pub degrees_min_max: Option<[f32; 2]>,
}

/// Focus information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflFocus {
    /// Focus type (e.g., "Head")
    #[serde(rename = "type")]
    pub focus_type: String,

    /// Pan range in degrees (optional)
    pub pan_max: Option<f32>,

    /// Tilt range in degrees (optional)
    pub tilt_max: Option<f32>,
}

/// Channel definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflChannel {
    /// DMX value resolution (default: 8)
    #[serde(default = "default_dmx_value_resolution")]
    pub dmx_value_resolution: u8,

    /// Default DMX value (optional)
    pub default_value: Option<serde_json::Value>,

    /// Highlight value (optional)
    pub highlight_value: Option<serde_json::Value>,

    /// Invert DMX value (optional)
    pub invert: Option<bool>,

    /// Constant value (optional)
    pub constant: Option<bool>,

    /// Precedence (HTP/LTP) (optional)
    pub precedence: Option<String>,

    /// Channel capabilities
    #[serde(default)]
    pub capabilities: Vec<OflCapability>,

    /// Fine channel key (for 16-bit) (optional)
    pub fine_channel_aliases: Option<Vec<String>>,

    /// Switching channels (optional)
    pub switching_channels: Option<Vec<String>>,
}

fn default_dmx_value_resolution() -> u8 {
    8
}

/// Template channel for matrix fixtures
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflTemplateChannel {
    /// Template channel name with $pixelKey placeholder
    pub name: Option<String>,

    /// DMX value resolution
    #[serde(default = "default_dmx_value_resolution")]
    pub dmx_value_resolution: u8,

    /// Capabilities
    #[serde(default)]
    pub capabilities: Vec<OflCapability>,
}

/// Channel capability (DMX range with function)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflCapability {
    /// DMX range [min, max]
    pub dmx_range: [u32; 2],

    /// Capability type (e.g., "ColorIntensity", "Pan", "Tilt")
    #[serde(rename = "type")]
    pub capability_type: String,

    /// Comment or label (optional)
    pub comment: Option<String>,

    /// Color (for ColorIntensity) (optional)
    pub color: Option<String>,

    /// Brightness start/end (optional)
    pub brightness_start: Option<String>,
    /// Brightness end (optional)
    pub brightness_end: Option<String>,

    /// Additional properties stored as JSON
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Matrix configuration for pixel fixtures
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflMatrix {
    /// Pixel keys
    pub pixel_keys: Vec<Vec<String>>,

    /// Pixel count
    pub pixel_count: [u32; 3],

    /// Pixel groups (optional)
    pub pixel_groups: Option<HashMap<String, Vec<String>>>,
}

/// DMX mode
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflMode {
    /// Mode name
    pub name: String,

    /// Short name (optional)
    pub short_name: Option<String>,

    /// RDM personality index (optional)
    pub rdm_personality_index: Option<u16>,

    /// Physical overrides for this mode (optional)
    pub physical: Option<OflPhysical>,

    /// Channel list (channel keys or null for gaps)
    pub channels: Vec<Option<String>>,
}
