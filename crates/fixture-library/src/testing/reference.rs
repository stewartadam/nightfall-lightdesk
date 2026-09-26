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
    /// Whether the channel's geometry lies in the mode's geometry tree. The
    /// specification requires it, but some published archives name geometries
    /// outside the tree. Only [`reference_mode_channels`] resolves the tree;
    /// [`reference_channels`] reports `true`.
    pub in_mode_tree: bool,
}

impl ReferenceChannel {
    /// Reads this channel's DMX integer from a footprint-relative frame.
    pub fn decode(&self, frame: &[u8]) -> u32 {
        self.slots.iter().fold(0u32, |value, slot| {
            (value << 8) | frame.get(*slot as usize - 1).copied().unwrap_or(0) as u32
        })
    }
}

/// Reference nesting depth beyond which the walk stops, guarding against reference cycles.
const MAX_REFERENCE_NESTING: usize = 16;

/// One geometry reached from a mode's root, with the references it was reached through.
struct Occurrence<'a> {
    /// Name of the geometry definition.
    geometry: String,
    /// Reference-qualified instance name (`"Row 2/Cell B"`).
    instance: String,
    /// Enclosing references, outermost first.
    references: Vec<&'a ReferenceGeometry>,
}

/// Lists a mode's channels with `GeometryReference` expansion applied at any nesting depth.
///
/// Every place a channel's geometry is reached from the mode root yields one
/// channel. Inside references the channel is named after the reference path
/// (`"Pixel 2"` for a template root, `"Pixel 2/Lens"` for its descendants,
/// `"Row 2/Cell B"` for nested references). Its slots are shifted by the
/// matching `Break` of every enclosing reference, innermost first: a fixed
/// break selects the `Break` with the same number, and `Overwrite` takes the
/// innermost reference's last `Break`, whose number the outer references then
/// match.
pub fn reference_mode_channels(
    fixture_type: &FixtureType,
    mode: &DmxMode,
) -> Vec<ReferenceChannel> {
    let root = mode
        .geometry
        .as_ref()
        .and_then(|name| fixture_type.root_geometry(name.as_ref()))
        .or_else(|| fixture_type.geometries.first());
    let mut occurrences = Vec::new();
    if let Some(root) = root {
        collect_occurrences(fixture_type, root, "", &[], &mut occurrences);
    }

    let mut expanded = Vec::new();
    for channel in reference_channels(mode) {
        let matching: Vec<&Occurrence> = occurrences
            .iter()
            .filter(|occurrence| occurrence.geometry == channel.geometry)
            .collect();
        if matching.is_empty() {
            expanded.push(ReferenceChannel {
                in_mode_tree: false,
                ..channel
            });
            continue;
        }
        for occurrence in matching {
            let mut dmx_break = channel.dmx_break;
            let mut shift = 0u16;
            for reference in occurrence.references.iter().rev() {
                let entry = match dmx_break {
                    None => reference.breaks.last(),
                    Some(number) => reference
                        .breaks
                        .iter()
                        .find(|entry| entry.dmx_break as i32 == number),
                };
                if let Some(entry) = entry {
                    dmx_break = Some(entry.dmx_break as i32);
                    shift += entry.dmx_offset.absolute() as u16 - 1;
                }
            }
            expanded.push(ReferenceChannel {
                geometry: occurrence.instance.clone(),
                dmx_break,
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

/// Records `geometry` and its descendants, following references into their templates.
///
/// `scope` is the reference path enclosing `geometry` (empty outside
/// references) and `references` the chain of references that led here.
/// Dangling references are skipped.
fn collect_occurrences<'a>(
    fixture_type: &'a FixtureType,
    geometry: &'a Geometry,
    scope: &str,
    references: &[&'a ReferenceGeometry],
    occurrences: &mut Vec<Occurrence<'a>>,
) {
    /// Prefixes `name` with the enclosing reference path, if any.
    fn qualify(scope: &str, name: &str) -> String {
        if scope.is_empty() {
            name.to_string()
        } else {
            format!("{scope}/{name}")
        }
    }

    let (definition, instance, references, child_scope) = match geometry {
        Geometry::Reference(reference) => {
            if references.len() >= MAX_REFERENCE_NESTING {
                return;
            }
            let Some(template) = reference
                .geometry
                .as_ref()
                .and_then(|target| fixture_type.root_geometry(target.as_ref()))
            else {
                return;
            };
            let name = reference
                .name
                .as_ref()
                .map(|name| name.to_string())
                .unwrap_or_default();
            let instance = qualify(scope, &name);
            let mut nested = references.to_vec();
            nested.push(reference);
            (template, instance.clone(), nested, instance)
        }
        _ => {
            let name = geometry
                .name()
                .map(|name| name.to_string())
                .unwrap_or_default();
            (
                geometry,
                qualify(scope, &name),
                references.to_vec(),
                scope.to_string(),
            )
        }
    };
    occurrences.push(Occurrence {
        geometry: definition
            .name()
            .map(|name| name.to_string())
            .unwrap_or_default(),
        instance,
        references: references.clone(),
    });
    for child in definition.children() {
        collect_occurrences(fixture_type, child, &child_scope, &references, occurrences);
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
                in_mode_tree: true,
            };
            *ordinal += 1;
            reference
        })
        .collect()
}
