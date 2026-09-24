// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Naive reference interpretation of GDTF DMX channel placement.
//!
//! This is intentionally written directly against the parsed `gdtf` model and
//! shares no code with the production converter, so differential tests can
//! compare the two. It handles only what the specification states plainly:
//! a channel's `Offset` lists its 1-based slots most significant first, a
//! channel without `Offset` is virtual, and `DMXBreak` names the footprint the
//! slots belong to.

use gdtf::dmx_mode::{DmxBreak, DmxMode};
use gdtf::fixture_type::FixtureType;
use gdtf::geometry::{AnyGeometry, Geometry, ReferenceGeometry};

/// One DMX channel as the specification places it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceChannel {
    /// Geometry named by the channel.
    pub geometry: String,
    /// Position of this channel among channels naming the same geometry, in file order.
    pub ordinal: usize,
    /// First logical channel's attribute name.
    pub attribute: String,
    /// DMX break, or `None` for `Overwrite`.
    pub dmx_break: Option<i32>,
    /// 1-based footprint slots, most significant first; empty for virtual channels.
    pub slots: Vec<u16>,
}

impl ReferenceChannel {
    /// Reads this channel's DMX integer from a footprint-relative frame.
    pub fn decode(&self, frame: &[u8]) -> u32 {
        self.slots.iter().fold(0u32, |value, slot| {
            (value << 8) | frame.get(*slot as usize - 1).copied().unwrap_or(0) as u32
        })
    }
}

/// Lists a mode's channels with single-level `GeometryReference` expansion applied.
///
/// For each channel whose geometry lives in a referenced top-level template,
/// every reference to that template inside the mode's root tree yields one
/// channel named after the reference (`"Pixel 2"` for the template root,
/// `"Pixel 2/Lens"` for descendants) with the reference's matching `Break`
/// offset added. `Overwrite` channels use the reference's last `Break`.
/// Nested references are out of scope for this reference implementation.
pub fn reference_mode_channels(
    fixture_type: &FixtureType,
    mode: &DmxMode,
) -> Vec<ReferenceChannel> {
    let root = mode
        .geometry
        .as_ref()
        .and_then(|name| fixture_type.root_geometry(name.as_ref()))
        .or_else(|| fixture_type.geometries.first());
    let mut references = Vec::new();
    if let Some(root) = root {
        collect_references(root, &mut references);
    }

    let mut expanded = Vec::new();
    for channel in reference_channels(mode) {
        let template = fixture_type.geometries.iter().find(|top| {
            top.name().map(|name| name.as_ref()) == Some(channel.geometry.as_str())
                || top.nested_child(&channel.geometry).is_some()
        });
        let template_name = template
            .and_then(|top| top.name())
            .map(|name| name.to_string())
            .unwrap_or_default();
        let referencing: Vec<&ReferenceGeometry> = references
            .iter()
            .copied()
            .filter(|reference| {
                reference.geometry.as_ref().map(|name| name.to_string())
                    == Some(template_name.clone())
            })
            .collect();
        if referencing.is_empty() {
            expanded.push(channel);
            continue;
        }
        for reference in referencing {
            let reference_name = reference
                .name
                .as_ref()
                .map(|name| name.to_string())
                .unwrap_or_default();
            let entry = match channel.dmx_break {
                None => reference.breaks.last(),
                Some(number) => reference
                    .breaks
                    .iter()
                    .find(|entry| entry.dmx_break as i32 == number),
            };
            let shift = entry.map_or(0, |entry| entry.dmx_offset.absolute() as u16 - 1);
            expanded.push(ReferenceChannel {
                geometry: if channel.geometry == template_name {
                    reference_name
                } else {
                    format!("{reference_name}/{}", channel.geometry)
                },
                dmx_break: entry
                    .map(|entry| entry.dmx_break as i32)
                    .or(channel.dmx_break),
                slots: channel.slots.iter().map(|slot| slot + shift).collect(),
                ..channel.clone()
            });
        }
    }

    let mut ordinals = std::collections::HashMap::<String, usize>::new();
    for channel in &mut expanded {
        let ordinal = ordinals.entry(channel.geometry.clone()).or_default();
        channel.ordinal = *ordinal;
        *ordinal += 1;
    }
    expanded
}

/// Collects every `GeometryReference` reachable from `geometry` without following references.
fn collect_references<'a>(geometry: &'a Geometry, references: &mut Vec<&'a ReferenceGeometry>) {
    if let Geometry::Reference(reference) = geometry {
        references.push(reference);
    }
    for child in geometry.children() {
        collect_references(child, references);
    }
}

/// Lists a mode's channels in file order with their specification-defined placement.
pub fn reference_channels(mode: &DmxMode) -> Vec<ReferenceChannel> {
    let mut ordinals = std::collections::HashMap::<String, usize>::new();
    mode.dmx_channels
        .iter()
        .map(|channel| {
            let geometry = channel.geometry.to_string();
            let ordinal = ordinals.entry(geometry.clone()).or_default();
            let reference = ReferenceChannel {
                geometry,
                ordinal: *ordinal,
                attribute: channel
                    .logical_channels
                    .first()
                    .map(|logical| logical.attribute.to_string())
                    .unwrap_or_default(),
                dmx_break: match channel.dmx_break {
                    DmxBreak::Value(value) => Some(value),
                    DmxBreak::Overwrite => None,
                },
                slots: channel
                    .offset
                    .as_ref()
                    .map(|offsets| offsets.iter().map(|offset| *offset as u16).collect())
                    .unwrap_or_default(),
            };
            *ordinal += 1;
            reference
        })
        .collect()
}
