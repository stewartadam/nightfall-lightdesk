// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Wire-format tests for GDTF conversion.
//!
//! The differential tests encode random values through the production layout
//! and byte splitter, then decode the frame with the independent reference
//! decoder in [`crate::testing::reference`]. Any disagreement means the engine
//! would put bytes somewhere other than where the GDTF file says they belong.

use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::wire_layout::{dmx_max, split_dmx_value};

use super::gdtf::convert_gdtf_to_fixture;
use crate::testing::reference::{ReferenceChannel, reference_channels};
use crate::testing::{BreakSpec, ChannelSpec, GdtfBuilder, GeometrySpec, ModeSpec};

/// Converts a mode of a synthetic archive and returns the fixture with the reference channels.
fn convert(builder: &GdtfBuilder, mode: &str) -> (Fixture, Vec<ReferenceChannel>) {
    let dir = tempfile::tempdir().expect("temp dir");
    let metadata = builder.write_metadata(dir.path());
    let (fixture, _) = convert_gdtf_to_fixture(&metadata, mode, 1).expect("conversion");
    let gdtf = builder.parse();
    let fixture_type = &gdtf.description.fixture_types[0];
    let dmx_mode = fixture_type
        .dmx_modes
        .iter()
        .find(|candidate| candidate.name.as_ref().map(|name| name.as_ref()) == Some(mode))
        .expect("mode");
    (fixture, reference_channels(dmx_mode))
}

/// Minimal deterministic pseudo-random generator so failures are reproducible without extra dependencies.
struct Lcg(u64);

impl Lcg {
    /// Returns the next pseudo-random 32-bit value.
    fn next_u32(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 32) as u32
    }

    /// Returns a pseudo-random value in `0..bound`.
    fn below(&mut self, bound: usize) -> usize {
        self.next_u32() as usize % bound
    }
}

/// Encodes random DMX integers for every parameter through the production layout and
/// asserts the reference decoder reads each one back from the file-declared slots.
fn assert_round_trip(fixture: &Fixture, references: &[ReferenceChannel], seed: u64) {
    let mut rng = Lcg(seed);
    let parameters: Vec<(&str, usize, &ParameterMetadata)> = fixture
        .elements
        .iter()
        .flat_map(|element| {
            element
                .parameters
                .iter()
                .enumerate()
                .map(|(ordinal, metadata)| (element.label.as_str(), ordinal, metadata))
        })
        .collect();

    let values: Vec<u32> = parameters
        .iter()
        .map(|(_, _, metadata)| rng.next_u32() & dmx_max(metadata.resolution))
        .collect();
    let layout = WireLayout::new(
        parameters
            .iter()
            .enumerate()
            .map(|(index, (_, _, metadata))| (index, *metadata)),
    );
    let mut frame = [0u8; 512];
    for placed in &layout.parameters {
        let metadata = parameters[placed.target].2;
        for (slot, byte) in placed
            .slots
            .iter()
            .zip(split_dmx_value(values[placed.target], metadata.resolution))
        {
            frame[*slot as usize] = byte;
        }
    }

    for (index, (geometry, ordinal, metadata)) in parameters.iter().enumerate() {
        let reference = references
            .iter()
            .find(|reference| reference.geometry == *geometry && reference.ordinal == *ordinal)
            .unwrap_or_else(|| panic!("no reference channel for {geometry}#{ordinal}"));
        if reference.slots.is_empty() {
            assert_eq!(
                metadata.dmx_slots,
                DmxSlots::Virtual,
                "{geometry}#{ordinal}"
            );
            continue;
        }
        assert_eq!(
            reference.decode(&frame),
            values[index],
            "{geometry}#{ordinal} ({}) decoded from slots {:?}",
            reference.attribute,
            reference.slots
        );
    }
}

/// Builds two heads whose channels are interleaved by function, with fine bytes at the end.
fn interleaved_heads() -> GdtfBuilder {
    GdtfBuilder::new("Test", "Interleaved")
        .geometry(
            GeometrySpec::generic("Base")
                .child(GeometrySpec::axis("Head 1"))
                .child(GeometrySpec::axis("Head 2")),
        )
        .mode(
            ModeSpec::new("Interleaved", "Base")
                .channel(ChannelSpec::new("Head 1", "Tilt", &[1, 7]))
                .channel(ChannelSpec::new("Head 2", "Tilt", &[2, 8]))
                .channel(ChannelSpec::new("Head 1", "Dimmer", &[3]))
                .channel(ChannelSpec::new("Head 2", "Dimmer", &[4]))
                .channel(ChannelSpec::new("Base", "Shutter1", &[6]))
                .channel(ChannelSpec::virtual_channel("Base", "Dimmer")),
        )
}

/// Verifies interleaved heads keep the file's slots instead of being packed per geometry.
#[test]
fn interleaved_heads_keep_file_slots() {
    let (fixture, _) = convert(&interleaved_heads(), "Interleaved");
    let head_2 = fixture
        .elements
        .iter()
        .find(|element| element.label == "Head 2")
        .expect("Head 2 element");
    assert_eq!(
        head_2.parameters[0].dmx_slots,
        DmxSlots::Explicit {
            dmx_break: 1,
            offsets: vec![2, 8],
        }
    );
    let base = fixture
        .elements
        .iter()
        .find(|element| element.label == "Base")
        .expect("Base element");
    assert_eq!(base.parameters[1].dmx_slots, DmxSlots::Virtual);

    let layout = WireLayout::new(
        fixture
            .elements
            .iter()
            .flat_map(|element| element.parameters.iter())
            .map(|metadata| ((), metadata)),
    );
    assert_eq!(
        layout.footprint(),
        8,
        "slot 5 is a gap but still in the footprint"
    );
}

/// Verifies engine encoding matches the reference decoder for interleaved, gapped and virtual channels.
#[test]
fn interleaved_heads_round_trip_through_reference_decoder() {
    let (fixture, references) = convert(&interleaved_heads(), "Interleaved");
    for seed in 0..16 {
        assert_round_trip(&fixture, &references, seed);
    }
}

/// Verifies 24- and 32-bit channels with out-of-order bytes round-trip through the reference decoder.
#[test]
fn wide_channels_round_trip_through_reference_decoder() {
    let builder = GdtfBuilder::new("Test", "Wide")
        .geometry(GeometrySpec::generic("Base"))
        .mode(
            ModeSpec::new("Wide", "Base")
                .channel(ChannelSpec::new("Base", "Pan", &[9, 2, 5]))
                .channel(ChannelSpec::new("Base", "Tilt", &[1, 3, 4, 8])),
        );
    let (fixture, references) = convert(&builder, "Wide");
    assert_eq!(
        fixture.elements[0].parameters[1].resolution,
        DmxValueResolution::Uber
    );
    for seed in 0..16 {
        assert_round_trip(&fixture, &references, seed);
    }
}

/// Property test: random slot permutations across several heads always round-trip.
///
/// Each generated mode assigns a random permutation of footprint slots to
/// channels of random widths on random geometries, so fine bytes land before,
/// after and between other channels' bytes.
#[test]
fn random_layouts_round_trip_through_reference_decoder() {
    let mut rng = Lcg(0x5EED);
    for case in 0..64 {
        let head_count = 1 + rng.below(4);
        let mut geometry = GeometrySpec::generic("Base");
        for head in 1..=head_count {
            geometry = geometry.child(GeometrySpec::axis(&format!("Head {head}")));
        }

        let widths: Vec<usize> = (0..2 + rng.below(8)).map(|_| 1 + rng.below(4)).collect();
        let total: usize = widths.iter().sum::<usize>() + rng.below(4);
        let mut slots: Vec<i32> = (1..=total as i32).collect();
        for index in (1..slots.len()).rev() {
            slots.swap(index, rng.below(index + 1));
        }

        let attributes = ["Dimmer", "Pan", "Tilt", "Zoom", "ColorAdd_R", "Shutter1"];
        let mut mode = ModeSpec::new("Random", "Base");
        let mut next = 0;
        for width in widths {
            let target = match rng.below(head_count + 1) {
                0 => "Base".to_string(),
                head => format!("Head {head}"),
            };
            let attribute = attributes[rng.below(attributes.len())];
            mode = mode.channel(ChannelSpec::new(
                &target,
                attribute,
                &slots[next..next + width],
            ));
            next += width;
        }

        let builder = GdtfBuilder::new("Test", &format!("Random {case}"))
            .geometry(geometry)
            .mode(mode);
        let (fixture, references) = convert(&builder, "Random");
        assert_round_trip(&fixture, &references, case);
    }
}

/// Verifies channels on `GeometryReference` templates are skipped instead of being placed
/// at their reference-relative offsets, where they would collide with the fixture's own
/// break-1 channels.
#[test]
fn template_geometry_channels_do_not_collide_with_regular_channels() {
    let builder = GdtfBuilder::new("Test", "Pixel Bar")
        .geometry(
            GeometrySpec::generic("Body")
                .child(GeometrySpec::reference("Pixel 1", "Pixel", &[(1, 2)]))
                .child(GeometrySpec::reference("Pixel 2", "Pixel", &[(1, 3)])),
        )
        .geometry(GeometrySpec::generic("Pixel").child(GeometrySpec::beam("Pixel Beam")))
        .mode(
            ModeSpec::new("Bar", "Body")
                .channel(ChannelSpec::new("Body", "Dimmer", &[1]))
                .channel(ChannelSpec::new("Pixel", "ColorAdd_R", &[1]))
                .channel(
                    ChannelSpec::new("Pixel Beam", "ColorAdd_G", &[2])
                        .on_break(BreakSpec::Overwrite),
                ),
        );
    let (fixture, _) = convert(&builder, "Bar");

    let parameters: Vec<_> = fixture
        .elements
        .iter()
        .flat_map(|element| element.parameters.iter())
        .collect();
    assert_eq!(parameters.len(), 1, "only the Body dimmer is placed");
    assert_eq!(parameters[0].attribute, Attribute::Intensity);
    assert_eq!(
        parameters[0].dmx_slots,
        DmxSlots::Explicit {
            dmx_break: 1,
            offsets: vec![1],
        }
    );
}
