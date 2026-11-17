// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Client-facing view of a draft: the parts of its GDTF description the editor shows and edits.

use gdtf::dmx_mode::{ChannelFunction, DmxChannel, DmxMode, LogicalChannel};
use gdtf::fixture_type::FixtureType;
use gdtf::geometry::AnyGeometry;
use gdtf::values::DmxValue;
use gdtf::wheel::{Wheel, WheelSlotOptic};
use serde::{Deserialize, Serialize};

use super::commands::{BodyShape, DraftId, DraftSource};
use super::draft::FixtureDraft;

/// Names and description of the fixture type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftInfo {
    /// Fixture type name, unique per manufacturer.
    pub name: String,
    /// Short name shown where space is tight.
    pub short_name: String,
    /// Full product name.
    pub long_name: String,
    /// Manufacturer name.
    pub manufacturer: String,
    /// Free-form description.
    pub description: String,
}

/// Everything a client needs to show and edit one draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixtureDraftView {
    /// Draft identity used by edit commands.
    pub draft_id: DraftId,
    /// What the draft was opened from.
    pub origin: DraftSource,
    /// Library file a save writes, when one is chosen yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// Whether the draft differs from what was opened or last saved.
    pub dirty: bool,
    /// Counts changes since the draft opened; edits can name the version they were made against.
    pub version: u32,
    /// Whether an edit can be reverted.
    pub can_undo: bool,
    /// Whether a reverted edit can be reapplied.
    pub can_redo: bool,
    /// Names and description.
    pub info: DraftInfo,
    /// Body shape the geometry was built from; none for geometry from a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<BodyShape>,
    /// DMX modes in file order.
    pub modes: Vec<DraftMode>,
    /// Wheels in file order.
    pub wheels: Vec<DraftWheel>,
    /// Names of the attributes the fixture type defines.
    pub attributes: Vec<String>,
    /// Names of every geometry, depth first.
    pub geometries: Vec<String>,
    /// Problems found in the current draft; errors block saving.
    pub problems: Vec<DraftProblem>,
    /// Parts of the source file a save drops, as element paths.
    pub lost_content: Vec<String>,
}

/// One DMX mode of a draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftMode {
    /// Mode name.
    pub name: String,
    /// Root geometry the mode controls.
    pub geometry: String,
    /// Number of DMX addresses the mode uses.
    pub footprint: u32,
    /// Channels in file order.
    pub channels: Vec<DraftChannel>,
}

/// One DMX channel of a mode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftChannel {
    /// Channel name, derived from its geometry and first attribute.
    pub name: String,
    /// Geometry the channel controls.
    pub geometry: String,
    /// DMX addresses from most to least significant byte, counted from 1; empty for virtual channels.
    pub offset: Vec<u32>,
    /// Bytes per value.
    pub resolution: u8,
    /// Value output while highlighted, at the channel's resolution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<u32>,
    /// Logical channels in file order.
    pub logical_channels: Vec<DraftLogicalChannel>,
}

/// One logical channel: a group of functions sharing an attribute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftLogicalChannel {
    /// Attribute the logical channel controls.
    pub attribute: String,
    /// Whether values jump instead of fading.
    pub snap: bool,
    /// Functions in ascending DMX order.
    pub functions: Vec<DraftFunction>,
}

/// One channel function: a DMX range mapped onto an attribute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftFunction {
    /// Function name.
    pub name: String,
    /// Attribute the function controls.
    pub attribute: String,
    /// First DMX value, at the channel's resolution.
    pub dmx_from: u32,
    /// Resting DMX value, at the channel's resolution.
    pub default: u32,
    /// Physical value at the start of the range.
    pub physical_from: f64,
    /// Physical value at the end of the range.
    pub physical_to: f64,
    /// Wheel whose slots the function selects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel: Option<String>,
    /// Named ranges in ascending DMX order.
    pub sets: Vec<DraftSet>,
}

/// One named DMX range within a function.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftSet {
    /// Range name.
    pub name: String,
    /// First DMX value, at the channel's resolution.
    pub dmx_from: u32,
    /// Wheel slot the range selects, counted from 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel_slot: Option<i32>,
}

/// One wheel and its slots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftWheel {
    /// Wheel name.
    pub name: String,
    /// Slots in wheel order.
    pub slots: Vec<DraftSlot>,
}

/// One wheel slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftSlot {
    /// Slot name.
    pub name: String,
    /// Slot color as CIE x, y and Y; none for filter slots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<[f64; 3]>,
    /// Image file shipped in the archive for the slot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
}

/// How serious a draft problem is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum ProblemSeverity {
    /// The draft cannot be saved until this is fixed.
    Error,
    /// The draft saves, but may not behave as expected.
    Warning,
}

/// One problem found in a draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftProblem {
    /// How serious the problem is.
    pub severity: ProblemSeverity,
    /// Operator-facing explanation.
    pub message: String,
    /// Mode the problem is in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    /// Channel the problem is in, within `mode`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<u32>,
}

/// Builds the view of a draft, including its current problems.
pub(super) fn draft_view(draft: &FixtureDraft) -> FixtureDraftView {
    let fixture_type = draft.fixture_type();
    FixtureDraftView {
        draft_id: draft.id,
        origin: draft.origin.clone(),
        file_name: draft.file_name.clone(),
        dirty: draft.is_dirty(),
        version: draft.version(),
        can_undo: draft.can_undo(),
        can_redo: draft.can_redo(),
        info: draft_info(fixture_type),
        body: draft.body(),
        modes: fixture_type.dmx_modes.iter().map(mode_view).collect(),
        wheels: fixture_type.wheels.iter().map(wheel_view).collect(),
        attributes: fixture_type
            .attribute_definitions
            .attributes
            .iter()
            .filter_map(|attribute| attribute.name.as_ref().map(ToString::to_string))
            .collect(),
        geometries: geometry_names(fixture_type),
        problems: draft.problems().to_vec(),
        lost_content: draft.lost_content.clone(),
    }
}

/// Reads the names and description of a fixture type.
pub(super) fn draft_info(fixture_type: &FixtureType) -> DraftInfo {
    DraftInfo {
        name: name_text(fixture_type.name.as_ref()),
        short_name: fixture_type.short_name.clone(),
        long_name: fixture_type.long_name.clone(),
        manufacturer: fixture_type.manufacturer.clone(),
        description: fixture_type.description.clone(),
    }
}

/// Names of every geometry of a fixture type, depth first.
pub(super) fn geometry_names(fixture_type: &FixtureType) -> Vec<String> {
    /// Appends a geometry's name and then its descendants' names.
    fn visit(geometry: &gdtf::geometry::Geometry, names: &mut Vec<String>) {
        if let Some(name) = geometry.name() {
            names.push(name.to_string());
        }
        for child in geometry.children() {
            visit(child, names);
        }
    }
    let mut names = Vec::new();
    for geometry in &fixture_type.geometries {
        visit(geometry, &mut names);
    }
    names
}

/// Builds the view of one DMX mode.
fn mode_view(mode: &DmxMode) -> DraftMode {
    DraftMode {
        name: name_text(mode.name.as_ref()),
        geometry: name_text(mode.geometry.as_ref()),
        footprint: footprint(mode),
        channels: mode.dmx_channels.iter().map(channel_view).collect(),
    }
}

/// Highest DMX address any channel of the mode uses.
pub(super) fn footprint(mode: &DmxMode) -> u32 {
    mode.dmx_channels
        .iter()
        .flat_map(|channel| channel.offset.iter().flatten())
        .map(|&address| address.max(0) as u32)
        .max()
        .unwrap_or(0)
}

/// Builds the view of one DMX channel.
fn channel_view(channel: &DmxChannel) -> DraftChannel {
    let resolution = channel_resolution(channel);
    DraftChannel {
        name: channel.name().to_string(),
        geometry: channel.geometry.to_string(),
        offset: channel
            .offset
            .iter()
            .flatten()
            .map(|&address| address.max(0) as u32)
            .collect(),
        resolution,
        highlight: channel.highlight.map(|value| value_at(value, resolution)),
        logical_channels: channel
            .logical_channels
            .iter()
            .map(|logical| logical_view(logical, resolution))
            .collect(),
    }
}

/// Builds the view of one logical channel.
fn logical_view(logical: &LogicalChannel, resolution: u8) -> DraftLogicalChannel {
    DraftLogicalChannel {
        attribute: logical.attribute.to_string(),
        snap: logical.snap,
        functions: logical
            .channel_functions
            .iter()
            .map(|function| function_view(function, resolution))
            .collect(),
    }
}

/// Builds the view of one channel function.
fn function_view(function: &ChannelFunction, resolution: u8) -> DraftFunction {
    DraftFunction {
        name: name_text(function.name.as_ref()),
        attribute: function.attribute.to_string(),
        dmx_from: value_at(function.dmx_from, resolution),
        default: value_at(function.default, resolution),
        physical_from: function.physical_from,
        physical_to: function.physical_to,
        wheel: function.wheel.as_ref().map(ToString::to_string),
        sets: function
            .channel_sets
            .iter()
            .map(|set| DraftSet {
                name: name_text(set.name.as_ref()),
                dmx_from: value_at(set.dmx_from, resolution),
                wheel_slot: set.wheel_slot_index,
            })
            .collect(),
    }
}

/// Builds the view of one wheel.
fn wheel_view(wheel: &Wheel) -> DraftWheel {
    DraftWheel {
        name: name_text(wheel.name.as_ref()),
        slots: wheel
            .slots
            .iter()
            .map(|slot| DraftSlot {
                name: name_text(slot.name.as_ref()),
                color: match &slot.optic {
                    WheelSlotOptic::Color(color) => Some([color.x, color.y, color.z]),
                    WheelSlotOptic::Filter(_) => None,
                },
                media: slot.media_name.clone(),
            })
            .collect(),
    }
}

/// Bytes per value of a channel: its address count, or its first function's size when virtual.
pub(super) fn channel_resolution(channel: &DmxChannel) -> u8 {
    match &channel.offset {
        Some(offset) if !offset.is_empty() => offset.len().min(4) as u8,
        _ => channel
            .logical_channels
            .iter()
            .flat_map(|logical| &logical.channel_functions)
            .next()
            .map_or(1, |function| function.dmx_from.bytes().get().min(4)),
    }
}

/// Expresses a DMX value at a channel resolution of up to four bytes, as the library converts it.
pub(super) fn value_at(value: DmxValue, resolution: u8) -> u32 {
    crate::converters::gdtf_functions::scaled_to_bytes(value, resolution)
}

/// Text of an optional GDTF name, empty when unset.
fn name_text(name: Option<&gdtf::values::Name>) -> String {
    name.map(ToString::to_string).unwrap_or_default()
}
