// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OFL JSON schema data structures
//!
//! These structures follow the Open Fixture Library JSON schema.
//! See: https://github.com/OpenLightingProject/open-fixture-library/tree/master/schemas
//! and https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/fixture-format.md

use std::collections::HashMap;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// Top-level OFL fixture schema
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflFixtureSchema {
    /// Schema URL the definition was written against
    #[serde(rename = "$schema")]
    pub schema: String,

    /// Fixture name
    pub name: String,

    /// Short name (optional)
    pub short_name: Option<String>,

    /// Fixture categories, most important first
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

    /// Channels keyed by channel key. A matrix fixture may define only template channels.
    #[serde(default)]
    pub available_channels: HashMap<String, OflChannel>,

    /// Template channels for matrix fixtures, keyed by a channel key containing `$pixelKey`
    #[serde(default)]
    pub template_channels: HashMap<String, OflChannel>,

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

    /// The import plugin the definition was converted with (optional)
    pub import_plugin: Option<OflImportPlugin>,
}

/// How a fixture definition was imported into OFL
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflImportPlugin {
    /// Import plugin key
    pub plugin: String,

    /// Import date (ISO 8601)
    pub date: String,

    /// Import comment (optional)
    pub comment: Option<String>,
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
    /// Width, height and depth in mm (optional)
    pub dimensions: Option<[f32; 3]>,

    /// Weight in kg (optional)
    pub weight: Option<f32>,

    /// Power consumption in watts (optional)
    pub power: Option<f32>,

    /// Power connectors keyed by connector type, valued by direction (optional)
    pub power_connectors: Option<HashMap<String, String>>,

    /// DMX connector type (optional)
    #[serde(rename = "DMXconnector")]
    pub dmx_connector: Option<String>,

    /// Bulb/lamp information (optional)
    pub bulb: Option<OflBulb>,

    /// Lens information (optional)
    pub lens: Option<OflLens>,

    /// Size and spacing of matrix pixels (optional)
    pub matrix_pixels: Option<OflMatrixPixels>,
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

    /// Beam angle range [min, max] in degrees (optional)
    pub degrees_min_max: Option<[f32; 2]>,
}

/// Size and spacing of matrix pixels
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflMatrixPixels {
    /// Width, height and depth of one pixel in mm (optional)
    pub dimensions: Option<[f32; 3]>,

    /// Spacing between pixels along X, Y and Z in mm (optional)
    pub spacing: Option<[f32; 3]>,
}

/// Channel definition, used both for `availableChannels` and `templateChannels`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflChannel {
    /// Display name; the channel key is used when absent (optional)
    pub name: Option<String>,

    /// Keys of the fine channels, most significant first
    #[serde(default)]
    pub fine_channel_aliases: Vec<String>,

    /// Resolution `dmxRange`, `defaultValue` and `highlightValue` are written in.
    /// Defaults to the channel's full resolution.
    pub dmx_value_resolution: Option<OflDmxValueResolution>,

    /// DMX value the channel rests at (optional, defaults to 0)
    pub default_value: Option<OflDmxValue>,

    /// DMX value that highlights the channel's function (optional, defaults to the maximum)
    pub highlight_value: Option<OflDmxValue>,

    /// Whether the channel should stay at its default value (optional)
    pub constant: Option<bool>,

    /// Merge precedence (optional)
    pub precedence: Option<OflPrecedence>,

    /// The channel's only capability, when it has a single one
    pub capability: Option<OflCapability>,

    /// The channel's capabilities by DMX range, when it has several
    #[serde(default)]
    pub capabilities: Vec<OflCapability>,
}

/// Resolution a channel's DMX values are written in
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OflDmxValueResolution {
    /// One byte
    #[serde(rename = "8bit")]
    Bits8,
    /// Two bytes
    #[serde(rename = "16bit")]
    Bits16,
    /// Three bytes
    #[serde(rename = "24bit")]
    Bits24,
}

impl OflDmxValueResolution {
    /// Returns the number of DMX bytes the resolution spans.
    pub fn bytes(self) -> u8 {
        match self {
            Self::Bits8 => 1,
            Self::Bits16 => 2,
            Self::Bits24 => 3,
        }
    }
}

/// A DMX value written either as a number or as a percentage such as `"50%"`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OflDmxValue {
    /// Raw DMX value in the channel's `dmxValueResolution`
    Dmx(u32),
    /// Percentage of the full DMX range
    Percent(String),
}

/// Merge precedence of a channel
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OflPrecedence {
    /// Latest takes precedence
    #[serde(rename = "LTP")]
    Ltp,
    /// Highest takes precedence
    #[serde(rename = "HTP")]
    Htp,
}

/// Channel capability (DMX range with function)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflCapability {
    /// DMX range [min, max]; absent on a channel's single `capability`
    pub dmx_range: Option<[u32; 2]>,

    /// Capability type (e.g., "ColorIntensity", "Pan", "Tilt")
    #[serde(rename = "type")]
    pub capability_type: String,

    /// Comment or label (optional)
    pub comment: Option<String>,

    /// Color (for ColorIntensity) (optional)
    pub color: Option<String>,

    /// Brightness start (optional)
    pub brightness_start: Option<String>,

    /// Brightness end (optional)
    pub brightness_end: Option<String>,

    /// Fixed rotation angle, such as `"90deg"` or `"50%"` (Pan and Tilt) (optional)
    pub angle: Option<String>,

    /// Rotation angle at the start of the DMX range (Pan and Tilt) (optional)
    pub angle_start: Option<String>,

    /// Rotation angle at the end of the DMX range (Pan and Tilt) (optional)
    pub angle_end: Option<String>,

    /// Switching channel aliases mapped to the channel each one becomes in this
    /// capability's DMX range; `None` maps the alias to an unused slot
    #[serde(default)]
    pub switch_channels: IndexMap<String, Option<String>>,

    /// Additional properties stored as JSON
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Matrix configuration for pixel fixtures
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflMatrix {
    /// Number of pixels along X, Y and Z, for matrices with generated pixel keys
    pub pixel_count: Option<[u32; 3]>,

    /// Pixel keys indexed `[z][y][x]`, with `None` for positions without a pixel
    pub pixel_keys: Option<Vec<Vec<Vec<Option<String>>>>>,

    /// Pixel groups keyed by group key, in definition order
    #[serde(default)]
    pub pixel_groups: IndexMap<String, OflPixelGroup>,
}

/// The pixels a pixel group contains
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OflPixelGroup {
    /// Every pixel of the matrix
    All(OflAllPixels),
    /// Pixel keys listed directly
    Keys(Vec<String>),
    /// Pixels whose position and key satisfy every constraint
    Constraints(OflPixelConstraints),
}

/// The `"all"` pixel group keyword
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OflAllPixels {
    /// Every pixel of the matrix
    #[serde(rename = "all")]
    All,
}

/// Pixel group constraints; a pixel belongs to the group when it satisfies all of them
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OflPixelConstraints {
    /// Constraints on the 1-based X position, such as `"=1"`, `">=2"`, `"<=4"`, `"2n+1"` or `"even"`
    #[serde(default)]
    pub x: Vec<String>,
    /// Constraints on the 1-based Y position
    #[serde(default)]
    pub y: Vec<String>,
    /// Constraints on the 1-based Z position
    #[serde(default)]
    pub z: Vec<String>,
    /// Regular expressions the pixel key must match
    #[serde(default)]
    pub name: Vec<String>,
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

    /// Channel list as written; see [`crate::OflFixture::mode_channel_keys`] for the resolved list
    pub channels: Vec<OflModeChannel>,
}

/// One entry of a mode's channel list
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OflModeChannel {
    /// An unused DMX slot (`null`)
    Unused,
    /// A channel key, fine channel alias, switching channel alias or resolved template channel key
    Key(String),
    /// A block of template channels repeated for several pixels
    Insert(OflMatrixChannelInsert),
}

/// A `matrixChannels` insert block in a mode's channel list
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OflMatrixChannelInsert {
    /// Insert block kind; always `matrixChannels`
    pub insert: OflInsertKind,

    /// The pixels or pixel groups to repeat the template channels for
    pub repeat_for: OflRepeatFor,

    /// Whether to list all channels of one pixel before the next pixel, or one channel for every pixel before the next channel
    pub channel_order: OflChannelOrder,

    /// Template channel keys to insert, with `None` for unused slots
    pub template_channels: Vec<Option<String>>,
}

/// Kind of a mode channel insert block
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OflInsertKind {
    /// Inserts template channels for matrix pixels
    #[serde(rename = "matrixChannels")]
    MatrixChannels,
}

/// The pixels or pixel groups a matrix channel insert repeats for
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OflRepeatFor {
    /// A keyword selecting pixels in an order, or every pixel group
    Order(OflRepeatOrder),
    /// Pixel keys or pixel group keys listed directly
    Keys(Vec<String>),
}

/// Keyword orders for repeating template channels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OflRepeatOrder {
    /// Every pixel, sorted by key in natural order
    #[serde(rename = "eachPixelABC")]
    EachPixelAbc,
    /// Every pixel, X changing fastest, then Y, then Z
    #[serde(rename = "eachPixelXYZ")]
    EachPixelXyz,
    /// Every pixel, X changing fastest, then Z, then Y
    #[serde(rename = "eachPixelXZY")]
    EachPixelXzy,
    /// Every pixel, Y changing fastest, then X, then Z
    #[serde(rename = "eachPixelYXZ")]
    EachPixelYxz,
    /// Every pixel, Y changing fastest, then Z, then X
    #[serde(rename = "eachPixelYZX")]
    EachPixelYzx,
    /// Every pixel, Z changing fastest, then X, then Y
    #[serde(rename = "eachPixelZXY")]
    EachPixelZxy,
    /// Every pixel, Z changing fastest, then Y, then X
    #[serde(rename = "eachPixelZYX")]
    EachPixelZyx,
    /// Every pixel group, in definition order
    #[serde(rename = "eachPixelGroup")]
    EachPixelGroup,
}

/// Channel order inside a matrix channel insert
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OflChannelOrder {
    /// All template channels of one pixel, then the next pixel
    PerPixel,
    /// One template channel for every pixel, then the next template channel
    PerChannel,
}
