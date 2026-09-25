// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Placement of parameter bytes within a fixture's DMX footprint.
//!
//! Profiles either declare explicit footprint slots per parameter (GDTF
//! `Offset`) or rely on parameters being packed back to back in fixture DMX
//! order. Every consumer that maps parameters to DMX addresses — output
//! binding, input decoding, patch validation and console addresses — lays out
//! slots through this module so they agree on the wire format.

use nightfall_dmx::prelude::*;

use crate::parameter::{DmxSlots, ParameterMetadata};

/// Byte placement of one parameter within a laid-out footprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedParameter<T> {
    /// Caller-supplied handle identifying the parameter.
    pub target: T,
    /// Zero-based footprint slot of every byte, most significant first.
    pub slots: Vec<u16>,
}

/// Laid-out parameters of a fixture or a selection of its elements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireLayout<T> {
    /// Parameters that occupy DMX slots, in fixture DMX order.
    pub parameters: Vec<PlacedParameter<T>>,
}

impl<T> Default for WireLayout<T> {
    fn default() -> Self {
        Self {
            parameters: Vec::new(),
        }
    }
}

impl<T> WireLayout<T> {
    /// Lays out parameters given in fixture DMX order.
    ///
    /// Sequential parameters are packed after the highest slot used so far.
    /// Explicit parameters use their declared slots; missing trailing bytes
    /// continue after the last declared slot. Virtual parameters and
    /// parameters on additional DMX breaks are omitted.
    pub fn new<'a>(parameters: impl IntoIterator<Item = (T, &'a ParameterMetadata)>) -> Self {
        let mut next_free = 0u16;
        let mut placed = Vec::new();
        for (target, metadata) in parameters {
            if !metadata.occupies_primary_footprint() {
                continue;
            }
            let width = metadata.resolution.channel_width();
            let slots: Vec<u16> = match &metadata.dmx_slots {
                DmxSlots::Explicit { offsets, .. } if !offsets.is_empty() => {
                    let mut slots: Vec<u16> = offsets
                        .iter()
                        .take(width as usize)
                        .map(|offset| offset.saturating_sub(1))
                        .collect();
                    while slots.len() < width as usize {
                        let last = *slots.last().unwrap_or(&0);
                        slots.push(last.saturating_add(1));
                    }
                    slots
                }
                _ => (0..width)
                    .map(|byte| next_free.saturating_add(byte))
                    .collect(),
            };
            if let Some(max) = slots.iter().max() {
                next_free = next_free.max(max.saturating_add(1));
            }
            placed.push(PlacedParameter { target, slots });
        }
        Self { parameters: placed }
    }

    /// Returns the number of slots from the first slot through the highest used slot.
    pub fn footprint(&self) -> u16 {
        self.parameters
            .iter()
            .flat_map(|parameter| parameter.slots.iter())
            .max()
            .map_or(0, |max| max.saturating_add(1))
    }

    /// Shifts slots so the lowest used slot becomes zero.
    ///
    /// Used when a binding patches only some elements or parameters: the
    /// selection starts at the binding's address rather than at the fixture's
    /// full-footprint offset.
    pub fn rebased(mut self) -> Self {
        let Some(min) = self
            .parameters
            .iter()
            .flat_map(|parameter| parameter.slots.iter())
            .min()
            .copied()
        else {
            return self;
        };
        for parameter in &mut self.parameters {
            for slot in &mut parameter.slots {
                *slot -= min;
            }
        }
        self
    }
}

/// Returns the largest DMX integer representable at a resolution.
pub fn dmx_max(resolution: DmxValueResolution) -> u32 {
    match resolution {
        DmxValueResolution::Coarse => 0xFF,
        DmxValueResolution::Fine => 0xFFFF,
        DmxValueResolution::UltraFine => 0xFF_FFFF,
        DmxValueResolution::Uber => u32::MAX,
    }
}

/// Splits a DMX integer into bytes, most significant first.
pub fn split_dmx_value(value: u32, resolution: DmxValueResolution) -> Vec<u8> {
    let width = resolution.channel_width();
    (0..width)
        .map(|byte| (value >> (8 * (width - 1 - byte))) as u8)
        .collect()
}

/// Combines bytes, most significant first, into a DMX integer.
pub fn combine_dmx_bytes(bytes: impl IntoIterator<Item = u8>) -> u32 {
    bytes
        .into_iter()
        .fold(0u32, |value, byte| (value << 8) | byte as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds metadata with the given resolution and slot placement.
    fn metadata(resolution: DmxValueResolution, dmx_slots: DmxSlots) -> ParameterMetadata {
        ParameterMetadata {
            resolution,
            dmx_slots,
            ..Default::default()
        }
    }

    /// Builds explicit break-1 slots from 1-based offsets.
    fn explicit(offsets: &[u16]) -> DmxSlots {
        DmxSlots::Explicit {
            dmx_break: 1,
            offsets: offsets.to_vec(),
        }
    }

    /// Verifies sequential parameters pack back to back using their byte width.
    #[test]
    fn sequential_parameters_pack_contiguously() {
        let params = [
            metadata(DmxValueResolution::Fine, DmxSlots::Sequential),
            metadata(DmxValueResolution::Coarse, DmxSlots::Sequential),
        ];
        let layout = WireLayout::new(params.iter().enumerate());
        assert_eq!(layout.parameters[0].slots, vec![0, 1]);
        assert_eq!(layout.parameters[1].slots, vec![2]);
        assert_eq!(layout.footprint(), 3);
    }

    /// Verifies explicit offsets place interleaved and separated fine bytes exactly.
    #[test]
    fn explicit_offsets_place_separated_fine_bytes_and_gaps() {
        let params = [
            metadata(DmxValueResolution::Fine, explicit(&[1, 5])),
            metadata(DmxValueResolution::Coarse, explicit(&[3])),
            metadata(DmxValueResolution::Coarse, explicit(&[8])),
        ];
        let layout = WireLayout::new(params.iter().enumerate());
        assert_eq!(layout.parameters[0].slots, vec![0, 4]);
        assert_eq!(layout.parameters[1].slots, vec![2]);
        assert_eq!(layout.parameters[2].slots, vec![7]);
        assert_eq!(layout.footprint(), 8);
    }

    /// Verifies virtual and secondary-break parameters are left out of the primary footprint.
    #[test]
    fn virtual_and_secondary_break_parameters_are_skipped() {
        let params = [
            metadata(DmxValueResolution::Coarse, DmxSlots::Virtual),
            metadata(
                DmxValueResolution::Coarse,
                DmxSlots::Explicit {
                    dmx_break: 2,
                    offsets: vec![1],
                },
            ),
            ParameterMetadata {
                attribute: Attribute::VirtualIntensity,
                ..Default::default()
            },
            metadata(DmxValueResolution::Coarse, explicit(&[2])),
        ];
        let layout = WireLayout::new(params.iter().enumerate());
        assert_eq!(layout.parameters.len(), 1);
        assert_eq!(layout.parameters[0].target, 3);
        assert_eq!(layout.footprint(), 2);
    }

    /// Verifies rebasing makes a partial selection start at slot zero.
    #[test]
    fn rebased_selection_starts_at_zero() {
        let params = [metadata(DmxValueResolution::Fine, explicit(&[4, 9]))];
        let layout = WireLayout::new(params.iter().enumerate()).rebased();
        assert_eq!(layout.parameters[0].slots, vec![0, 5]);
    }

    /// Verifies DMX integers split and recombine big-endian at every resolution.
    #[test]
    fn dmx_values_round_trip_through_bytes() {
        for (resolution, value) in [
            (DmxValueResolution::Coarse, 0xAB),
            (DmxValueResolution::Fine, 0xABCD),
            (DmxValueResolution::UltraFine, 0xABCDEF),
            (DmxValueResolution::Uber, 0xABCD_EF01),
        ] {
            let bytes = split_dmx_value(value, resolution);
            assert_eq!(bytes.len(), resolution.channel_width() as usize);
            assert_eq!(bytes[0], 0xAB);
            assert_eq!(combine_dmx_bytes(bytes), value);
        }
    }
}
