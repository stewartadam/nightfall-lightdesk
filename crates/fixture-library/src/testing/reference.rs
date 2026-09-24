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
