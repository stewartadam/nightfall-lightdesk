// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resolve physical wire locations from instantiated GDTF channels.
//!
//! Addresses remain one-based offsets relative to an independently patched break.
//! A break is not a universe, and gaps/fine-byte order must survive compilation.

use std::collections::{BTreeMap, HashMap, HashSet};

use gdtf::dmx_mode::DmxBreak;
use serde::{Deserialize, Serialize};

use crate::gdtf_resolver::{ResolveError, ResolvedMode};

/// Physical slots occupied by one channel, in decreasing byte significance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelWire {
    /// Independently patched DMX break number; never inferred as a universe number.
    pub dmx_break: u32,
    /// One-based offsets retaining gaps and the authored coarse-to-fine order.
    pub offsets: Vec<u32>,
}

impl ChannelWire {
    /// Read an exact unsigned raw value from this break's fixture-relative buffer.
    /// The caller selects the patched break; this method never assumes a universe mapping.
    pub fn read_raw(&self, buffer: &[u8]) -> Result<u32, ResolveError> {
        let slots = self.checked_slots(buffer.len())?;
        Ok(slots[..self.offsets.len()]
            .iter()
            .fold(0u32, |value, &slot| (value << 8) | u32::from(buffer[slot])))
    }

    /// Write an exact raw value, preserving gaps and all other channels in the supplied break.
    /// Invalid layouts, short buffers, and values wider than the channel leave the buffer unchanged.
    pub fn write_raw(&self, value: u32, buffer: &mut [u8]) -> Result<(), ResolveError> {
        let slots = self.checked_slots(buffer.len())?;
        let width = self.offsets.len();
        if width < 4 && value >= (1u32 << (width * 8)) {
            return Err(self.buffer_error(
                "raw_value_out_of_range",
                "Raw value exceeds the channel's significant byte width",
            ));
        }
        let bytes = value.to_be_bytes();
        for (&slot, &byte) in slots[..width].iter().zip(&bytes[4 - width..]) {
            buffer[slot] = byte;
        }
        Ok(())
    }

    /// Validate public/deserialized wire data before indexing or mutating a caller-owned buffer.
    fn checked_slots(&self, buffer_len: usize) -> Result<[usize; 4], ResolveError> {
        if self.dmx_break == 0 {
            return Err(self.buffer_error("invalid_break", "Break numbers must be positive"));
        }
        if !(1..=4).contains(&self.offsets.len()) {
            return Err(self.buffer_error(
                "invalid_channel_width",
                "Physical channel must contain one to four bytes",
            ));
        }
        let mut slots = [0usize; 4];
        for (index, &offset) in self.offsets.iter().enumerate() {
            let slot = offset
                .checked_sub(1)
                .and_then(|slot| usize::try_from(slot).ok())
                .ok_or_else(|| {
                    self.buffer_error("invalid_offset", "Offsets must be positive and addressable")
                })?;
            if slot >= buffer_len {
                return Err(self.buffer_error(
                    "wire_buffer_too_short",
                    format!("Offset {offset} exceeds the supplied {buffer_len}-byte break buffer"),
                ));
            }
            if slots[..index].contains(&slot) {
                return Err(
                    self.buffer_error("duplicate_byte", "A channel cannot reuse a byte offset")
                );
            }
            slots[index] = slot;
        }
        Ok(slots)
    }

    /// Allocate diagnostic context only on failure, keeping successful byte I/O allocation-free.
    fn buffer_error(&self, code: &'static str, message: impl Into<String>) -> ResolveError {
        error(code, &format!("break/{}", self.dmx_break), message)
    }
}

/// Wire contracts aligned with the resolved mode's instantiated channel array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeWires {
    /// Virtual channels have no wire address and occupy no physical slots.
    pub channels: Vec<Option<ChannelWire>>,
    /// Highest occupied slot for each break, including reserved gaps below it.
    pub footprints: BTreeMap<u32, u32>,
}

/// Produce a machine-readable error tied to the instantiated channel identity.
fn error(code: &'static str, path: &str, message: impl Into<String>) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Compile exact byte positions, reference offsets, and per-break footprints.
pub fn resolve_wires(mode: &ResolvedMode<'_>) -> Result<ModeWires, ResolveError> {
    let mut channels = Vec::with_capacity(mode.channels.len());
    let mut footprints: BTreeMap<u32, u32> = BTreeMap::new();
    let mut occupied = HashMap::new();
    for channel in &mode.channels {
        let Some(source_offsets) = &channel.source.offset else {
            channels.push(None);
            continue;
        };
        if !(1..=4).contains(&source_offsets.len()) {
            return Err(error(
                "invalid_channel_width",
                &channel.id,
                "Physical channel must contain one to four bytes",
            ));
        }
        let mut offsets: Vec<u32> = source_offsets
            .iter()
            .map(|&value| {
                u32::try_from(value)
                    .ok()
                    .filter(|&value| value > 0)
                    .ok_or_else(|| {
                        error(
                            "invalid_offset",
                            &channel.id,
                            "DMX offsets must be positive",
                        )
                    })
            })
            .collect::<Result<_, _>>()?;
        let mut seen = HashSet::new();
        if offsets.iter().any(|offset| !seen.insert(*offset)) {
            return Err(error(
                "duplicate_byte",
                &channel.id,
                "A channel cannot reuse the same byte offset",
            ));
        }
        let mut dmx_break = channel.source.dmx_break;
        for reference in mode.channel_scope(channel).iter().rev() {
            let mapping = match dmx_break {
                DmxBreak::Overwrite => reference.breaks.last(),
                // A later Overwrite entry may use the same target break with
                // another offset. Fixed channels use the first matching entry;
                // Overwrite channels use the last entry (also across mode variants).
                DmxBreak::Value(value) => reference
                    .breaks
                    .iter()
                    .find(|b| i32::from(b.dmx_break) == value),
            }
            .ok_or_else(|| {
                error(
                    "missing_break",
                    &channel.id,
                    "Reference has no mapping for this channel's break",
                )
            })?;
            if mapping.dmx_break == 0 {
                return Err(error(
                    "invalid_break",
                    &channel.id,
                    "Reference break numbers must be positive",
                ));
            }
            let addition = mapping
                .dmx_offset
                .absolute()
                .checked_sub(1)
                .ok_or_else(|| {
                    error(
                        "invalid_offset",
                        &channel.id,
                        "Reference DMXOffset must be positive",
                    )
                })?;
            for offset in &mut offsets {
                *offset = offset.checked_add(addition).ok_or_else(|| {
                    error(
                        "offset_overflow",
                        &channel.id,
                        "Reference offset exceeds the address representation",
                    )
                })?;
            }
            if matches!(dmx_break, DmxBreak::Overwrite) {
                dmx_break = DmxBreak::Value(i32::from(mapping.dmx_break));
            }
        }
        let dmx_break = match dmx_break {
            DmxBreak::Value(value) if value > 0 => value as u32,
            DmxBreak::Value(_) => {
                return Err(error(
                    "invalid_break",
                    &channel.id,
                    "Channel break numbers must be positive",
                ));
            }
            DmxBreak::Overwrite => {
                return Err(error(
                    "unresolved_break",
                    &channel.id,
                    "Overwrite requires a geometry reference",
                ));
            }
        };
        for &offset in &offsets {
            if let Some(previous) = occupied.insert((dmx_break, offset), &channel.id) {
                return Err(error(
                    "wire_collision",
                    &channel.id,
                    format!("Break {dmx_break} offset {offset} is also occupied by {previous}"),
                ));
            }
            footprints
                .entry(dmx_break)
                .and_modify(|end| *end = (*end).max(offset))
                .or_insert(offset);
        }
        channels.push(Some(ChannelWire { dmx_break, offsets }));
    }
    Ok(ModeWires {
        channels,
        footprints,
    })
}
