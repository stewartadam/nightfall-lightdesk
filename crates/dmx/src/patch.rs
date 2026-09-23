// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Explicit break patching shared by fixture import and runtime byte transport.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::MAX_CHANNELS_PER_UNIVERSE;
use crate::wire::{ChannelWire, ModeWires, WireError};

/// Placement of one independently patched fixture break within a transport's universe space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BreakPatch {
    /// Universe identifier; transport-specific numbering is resolved by the caller.
    pub universe: u16,
    /// One-based starting address. Bytes never wrap into another universe.
    pub address: u16,
}

/// Validated placement of one physical channel, preserving its original break and byte order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchedChannelWire {
    universe: u16,
    wire: ChannelWire,
}

impl PatchedChannelWire {
    /// Return the explicit target universe, without deriving it from the break number.
    pub fn universe(&self) -> u16 {
        self.universe
    }

    /// Inspect absolute one-based addresses in decreasing byte significance.
    pub fn wire(&self) -> &ChannelWire {
        &self.wire
    }
}

/// Immutable validated mode patch, aligned with the compiled physical and virtual channel array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchedModeWires {
    channels: Vec<Option<PatchedChannelWire>>,
}

impl ModeWires {
    /// Resolve every physical break explicitly, rejecting malformed layouts and overlapping bytes.
    /// Failure publishes no partial patch. Unused mappings are rejected to catch stale mode patches.
    pub fn patch(&self, breaks: &BTreeMap<u32, BreakPatch>) -> Result<PatchedModeWires, WireError> {
        let mut footprints = BTreeMap::new();
        let mut occupied = BTreeSet::new();
        let mut channels = Vec::with_capacity(self.channels.len());
        for channel in &self.channels {
            let Some(channel) = channel else {
                channels.push(None);
                continue;
            };
            // Validate public/deserialized source contracts before doing address arithmetic.
            channel.read_raw(&[0; MAX_CHANNELS_PER_UNIVERSE])?;
            let footprint = channel
                .offsets
                .iter()
                .copied()
                .max()
                .expect("validated width");
            let highest = footprints.entry(channel.dmx_break).or_insert(0);
            *highest = (*highest).max(footprint);
            let patch = breaks.get(&channel.dmx_break).ok_or_else(|| {
                patch_error(
                    channel.dmx_break,
                    "missing_break_patch",
                    "Every physical break needs an explicit patch",
                )
            })?;
            if !(1..=MAX_CHANNELS_PER_UNIVERSE as u16).contains(&patch.address) {
                return Err(patch_error(
                    channel.dmx_break,
                    "invalid_patch_address",
                    "Patch start must be between 1 and 512",
                ));
            }
            let mut offsets = Vec::with_capacity(channel.offsets.len());
            for offset in &channel.offsets {
                let address = u32::from(patch.address) + offset - 1;
                if address > MAX_CHANNELS_PER_UNIVERSE as u32 {
                    return Err(patch_error(
                        channel.dmx_break,
                        "patch_out_of_bounds",
                        format!(
                            "Start {} plus offset {offset} needs address {address} in universe {}; choose an earlier start instead of crossing address 512",
                            patch.address, patch.universe
                        ),
                    ));
                }
                if !occupied.insert((patch.universe, address)) {
                    return Err(patch_error(
                        channel.dmx_break,
                        "patch_collision",
                        format!(
                            "Two channels or breaks occupy universe {} address {address}",
                            patch.universe
                        ),
                    ));
                }
                offsets.push(address);
            }
            channels.push(Some(PatchedChannelWire {
                universe: patch.universe,
                wire: ChannelWire {
                    dmx_break: channel.dmx_break,
                    offsets,
                },
            }));
        }
        if footprints != self.footprints {
            return Err(patch_error(
                0,
                "invalid_footprints",
                "Declared footprints must match the highest occupied offset of each physical break",
            ));
        }
        if let Some(&unused) = breaks.keys().find(|key| !footprints.contains_key(key)) {
            return Err(patch_error(
                unused,
                "unused_break_patch",
                "Patch includes a break not present in this mode",
            ));
        }
        Ok(PatchedModeWires { channels })
    }
}

impl PatchedModeWires {
    /// Inspect validated channel destinations; virtual entries remain absent and retain their indices.
    pub fn channels(&self) -> &[Option<PatchedChannelWire>] {
        &self.channels
    }

    /// Decode physical raw values from complete universe snapshots; virtual values have no bytes.
    pub fn read_raw(
        &self,
        universes: &BTreeMap<u16, [u8; MAX_CHANNELS_PER_UNIVERSE]>,
    ) -> Result<Vec<Option<u32>>, WireError> {
        self.channels
            .iter()
            .map(|channel| {
                let Some(channel) = channel else {
                    return Ok(None);
                };
                let buffer = universes.get(&channel.universe).ok_or_else(|| {
                    patch_error(
                        channel.wire.dmx_break,
                        "missing_universe",
                        format!("Universe {} has no input buffer", channel.universe),
                    )
                })?;
                channel.wire.read_raw(buffer).map(Some)
            })
            .collect()
    }

    /// Encode a complete raw channel snapshot, leaving gaps and unrelated slots untouched.
    /// Validate all physical values and required buffers before writing any byte; virtual values are ignored.
    pub fn write_raw(
        &self,
        values: &[u32],
        universes: &mut BTreeMap<u16, [u8; MAX_CHANNELS_PER_UNIVERSE]>,
    ) -> Result<(), WireError> {
        if values.len() != self.channels.len() {
            return Err(patch_error(
                0,
                "channel_count_mismatch",
                "Raw snapshot must match the compiled channel count, including virtual channels",
            ));
        }
        for (channel, &value) in self.channels.iter().zip(values) {
            if let Some(channel) = channel {
                if !universes.contains_key(&channel.universe) {
                    return Err(patch_error(
                        channel.wire.dmx_break,
                        "missing_universe",
                        format!("Universe {} has no output buffer", channel.universe),
                    ));
                }
                let width = channel.wire.offsets.len();
                if width < 4 && value >= 1u32 << (width * 8) {
                    return Err(patch_error(
                        channel.wire.dmx_break,
                        "raw_value_out_of_range",
                        "Raw value exceeds the channel's significant byte width",
                    ));
                }
            }
        }
        for (channel, &value) in self.channels.iter().zip(values) {
            if let Some(channel) = channel {
                channel.wire.write_raw(
                    value,
                    universes
                        .get_mut(&channel.universe)
                        .expect("validated universe"),
                )?;
            }
        }
        Ok(())
    }
}

/// Construct a parser-independent diagnostic while retaining the offending source break when known.
fn patch_error(dmx_break: u32, code: &'static str, message: impl Into<String>) -> WireError {
    WireError {
        code,
        dmx_break,
        message: message.into(),
    }
}
