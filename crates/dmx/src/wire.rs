// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Exact physical channel addresses shared by importers and the DMX runtime.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// Invalid wire layout, raw value or caller-provided buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError {
    /// Stable diagnostic category for callers and tests.
    pub code: &'static str,
    /// Fixture-relative break whose byte operation failed.
    pub dmx_break: u32,
    /// Human-readable explanation of the failure.
    pub message: String,
}

impl fmt::Display for WireError {
    /// Include the break and diagnostic category without depending on importer source paths.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} at break/{}: {}",
            self.code, self.dmx_break, self.message
        )
    }
}

impl std::error::Error for WireError {}

/// Physical slots occupied by one channel, in decreasing byte significance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
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
    pub fn read_raw(&self, buffer: &[u8]) -> Result<u32, WireError> {
        let slots = self.checked_slots(buffer.len())?;
        Ok(slots[..self.offsets.len()]
            .iter()
            .fold(0u32, |value, &slot| (value << 8) | u32::from(buffer[slot])))
    }

    /// Write an exact raw value, preserving gaps and all other channels in the supplied break.
    /// Invalid layouts, short buffers, and values wider than the channel leave the buffer unchanged.
    pub fn write_raw(&self, value: u32, buffer: &mut [u8]) -> Result<(), WireError> {
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
    fn checked_slots(&self, buffer_len: usize) -> Result<[usize; 4], WireError> {
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
    fn buffer_error(&self, code: &'static str, message: impl Into<String>) -> WireError {
        WireError {
            code,
            dmx_break: self.dmx_break,
            message: message.into(),
        }
    }
}

/// Wire contracts aligned with the resolved mode's instantiated channel array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct ModeWires {
    /// Virtual channels have no wire address and occupy no physical slots.
    #[typeshare(typescript(type = "Array<ChannelWire | null>"))]
    pub channels: Vec<Option<ChannelWire>>,
    /// Highest occupied slot for each break, including reserved gaps below it.
    #[typeshare(typescript(type = "Record<string, number>"))]
    pub footprints: BTreeMap<u32, u32>,
}
