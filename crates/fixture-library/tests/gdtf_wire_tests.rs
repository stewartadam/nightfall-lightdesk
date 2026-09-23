// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Independent expected wire positions for sparse and referenced channel instances.

use gdtf::dmx_mode::DmxBreak;
use nightfall_fixture_library::gdtf_resolver::{ResolveLimits, resolve_mode};
use nightfall_fixture_library::gdtf_wire::{ChannelWire, ModeWires, resolve_wires};

/// Parse a resource-free mode whose expected physical positions are authored in the test.
fn description() -> gdtf::Description {
    include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap()
}

/// Run both pure compiler passes while preserving structured failures for assertions.
fn wires(
    description: &gdtf::Description,
) -> Result<ModeWires, nightfall_fixture_library::gdtf_resolver::ResolveError> {
    let resolved = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )?;
    resolve_wires(&resolved)
}

/// Build independently expected slots without using compiler mapping logic.
fn physical(dmx_break: u32, offsets: &[u32]) -> Option<ChannelWire> {
    Some(ChannelWire {
        dmx_break,
        offsets: offsets.to_vec(),
    })
}

/// Sparse joint bytes, repeated RGB references, and virtual dimmers retain exact positions.
#[test]
fn sparse_and_referenced_channels_have_independent_expected_addresses() {
    let wires = wires(&description()).unwrap();
    assert_eq!(
        wires.channels,
        [
            physical(1, &[1, 4]),
            physical(1, &[2, 5]),
            None,
            None,
            physical(2, &[10]),
            physical(2, &[20]),
            physical(2, &[11]),
            physical(2, &[21]),
            physical(2, &[12]),
            physical(2, &[22]),
        ]
    );
    assert_eq!(
        wires.footprints.into_iter().collect::<Vec<_>>(),
        [(1, 5), (2, 22)]
    );
}

/// All four byte widths retain significance order even when fine bytes precede coarse bytes.
#[test]
fn channel_width_does_not_determine_slot_order_or_footprint() {
    for offsets in [vec![10], vec![10, 7], vec![10, 7, 4], vec![10, 7, 4, 1]] {
        let mut description = description();
        description.fixture_types[0].dmx_modes[0].dmx_channels[0].offset = Some(offsets.clone());
        let wires = wires(&description).unwrap();
        assert_eq!(
            wires.channels[0],
            physical(1, &offsets.iter().map(|v| *v as u32).collect::<Vec<_>>())
        );
        assert_eq!(wires.footprints[&1], 10);
    }
}

/// Invalid physical definitions cannot silently truncate widths, wrap addresses, or collide.
#[test]
fn malformed_wire_definitions_are_rejected() {
    for (offsets, expected) in [
        (vec![], "invalid_channel_width"),
        (vec![1, 4, 7, 10, 13], "invalid_channel_width"),
        (vec![0], "invalid_offset"),
        (vec![-1], "invalid_offset"),
        (vec![1, 1], "duplicate_byte"),
        (vec![2], "wire_collision"),
    ] {
        let mut description = description();
        description.fixture_types[0].dmx_modes[0].dmx_channels[0].offset = Some(offsets);
        assert_eq!(wires(&description).unwrap_err().code, expected);
    }
}

/// Virtual controls do not require a resolved wire break and never enlarge the footprint.
#[test]
fn virtual_channels_consume_no_slots() {
    let mut description = description();
    for channel in &mut description.fixture_types[0].dmx_modes[0].dmx_channels {
        channel.offset = None;
        channel.dmx_break = DmxBreak::Overwrite;
    }
    let wires = wires(&description).unwrap();
    assert!(wires.channels.iter().all(Option::is_none));
    assert!(wires.footprints.is_empty());
}

/// Unreferenced physical Overwrite and nonpositive break numbers are errors, not defaults.
#[test]
fn physical_channels_require_concrete_positive_breaks() {
    for (dmx_break, expected) in [
        (DmxBreak::Overwrite, "unresolved_break"),
        (DmxBreak::Value(0), "invalid_break"),
        (DmxBreak::Value(-1), "invalid_break"),
    ] {
        let mut description = description();
        description.fixture_types[0].dmx_modes[0].dmx_channels[0].dmx_break = dmx_break;
        assert_eq!(wires(&description).unwrap_err().code, expected);
    }
}

/// Fixed breaks use the matching reference entry rather than the first declared entry.
#[test]
fn fixed_break_numbers_select_their_own_offsets() {
    let mut description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace(
            "<Break DMXBreak=\"2\"",
            "<Break DMXBreak=\"4\" DMXOffset=\"100\"/><Break DMXBreak=\"2\"",
        )
        .parse()
        .unwrap();
    for channel in &mut description.fixture_types[0].dmx_modes[0].dmx_channels[2..] {
        channel.dmx_break = DmxBreak::Value(2);
    }
    assert_eq!(wires(&description).unwrap().channels[4], physical(2, &[10]));
}

/// Reference offsets beyond one universe remain offsets within the same independent break.
#[test]
fn large_offsets_do_not_invent_extra_breaks() {
    let description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace("DMXOffset=\"20\"", "DMXOffset=\"513\"")
        .parse()
        .unwrap();
    let wires = wires(&description).unwrap();
    assert_eq!(wires.channels[5], physical(2, &[513]));
    assert_eq!(wires.footprints[&2], 515);
    assert_eq!(wires.footprints.len(), 2);
}

/// Invalid reference mappings cannot be hidden by arithmetic saturation or an implicit break.
#[test]
fn invalid_reference_offsets_and_mappings_fail_explicitly() {
    for (replacement, expected) in [
        ("<Break DMXBreak=\"2\" DMXOffset=\"0\"/>", "invalid_offset"),
        (
            "<Break DMXBreak=\"2\" DMXOffset=\"4294967295\"/>",
            "offset_overflow",
        ),
        ("<Break DMXBreak=\"0\" DMXOffset=\"10\"/>", "invalid_break"),
        ("", "missing_break"),
    ] {
        let description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
            .replace("<Break DMXBreak=\"2\" DMXOffset=\"10\"/>", replacement)
            .parse()
            .unwrap();
        assert_eq!(wires(&description).unwrap_err().code, expected);
    }
}

/// Nested reference offsets compose inside-out; a reference's own controls remain outside its override.
#[test]
fn nested_reference_scopes_distinguish_template_and_alias_channels() {
    let identity = "{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}";
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml").replace(
        &format!("<Geometry Name=\"Pixel\" Position=\"{identity}\"/>"),
        &format!("<GeometryReference Name=\"Pixel\" Geometry=\"Leaf\" Position=\"{identity}\"><Break DMXBreak=\"2\" DMXOffset=\"3\"/></GeometryReference><Geometry Name=\"Leaf\" Position=\"{identity}\"/>"),
    );
    let mut description: gdtf::Description = xml.parse().unwrap();
    assert_eq!(wires(&description).unwrap().channels[4], physical(2, &[10]));
    for channel in &mut description.fixture_types[0].dmx_modes[0].dmx_channels[2..] {
        channel.geometry = gdtf::values::Name::new("Leaf").unwrap();
    }
    let wires = wires(&description).unwrap();
    assert_eq!(wires.channels[4], physical(2, &[12]));
    assert_eq!(wires.channels[5], physical(2, &[22]));
    assert_eq!(wires.channels[9], physical(2, &[24]));
    assert_eq!(wires.footprints[&2], 24);
}

/// Multiple logical functions sharing one physical channel allocate its bytes only once.
#[test]
fn logical_functions_do_not_duplicate_wire_ownership() {
    let mut description = description();
    let channel = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0];
    channel
        .logical_channels
        .push(channel.logical_channels[0].clone());
    let wires = wires(&description).unwrap();
    assert_eq!(wires.channels.len(), 10);
    assert_eq!(wires.channels[0], physical(1, &[1, 4]));
}

/// Fixed and Overwrite mappings may target the same break with different offsets.
#[test]
fn fixed_and_overwrite_entries_remain_distinct_on_the_same_break() {
    let mut description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace(
            "DMXOffset=\"10\"/>",
            "DMXOffset=\"10\"/><Break DMXBreak=\"2\" DMXOffset=\"100\"/>",
        )
        .replace(
            "DMXOffset=\"20\"/>",
            "DMXOffset=\"20\"/><Break DMXBreak=\"2\" DMXOffset=\"200\"/>",
        )
        .parse()
        .unwrap();
    description.fixture_types[0].dmx_modes[0].dmx_channels[3].dmx_break = DmxBreak::Value(2);
    let wires = wires(&description).unwrap();
    assert_eq!(wires.channels[4], physical(2, &[10]));
    assert_eq!(wires.channels[5], physical(2, &[20]));
    assert_eq!(wires.channels[6], physical(2, &[101]));
    assert_eq!(wires.channels[7], physical(2, &[201]));
}

/// Independently authored buffers verify byte significance, gaps, and exact values at every width.
#[test]
fn raw_codec_preserves_sparse_slots_and_integer_precision() {
    for (offsets, raw, expected) in [
        (vec![4], 0xab, vec![0xee, 0xee, 0xee, 0xab]),
        (vec![4, 1], 0xabcd, vec![0xcd, 0xee, 0xee, 0xab]),
        (vec![4, 1, 3], 0xabcdef, vec![0xcd, 0xee, 0xef, 0xab]),
        (vec![4, 1, 3, 2], 0xabcdef01, vec![0xcd, 0x01, 0xef, 0xab]),
    ] {
        let wire = ChannelWire {
            dmx_break: 7,
            offsets,
        };
        assert_eq!(wire.read_raw(&expected).unwrap(), raw);
        let mut output = vec![0xee; 4];
        wire.write_raw(raw, &mut output).unwrap();
        assert_eq!(output, expected);
        let maximum = u32::MAX >> ((4 - wire.offsets.len()) * 8);
        for value in [0, 1, maximum - 1, maximum] {
            wire.write_raw(value, &mut output).unwrap();
            assert_eq!(wire.read_raw(&output).unwrap(), value);
        }
    }
}

/// Rejected writes are transactional even when a valid byte precedes an invalid one.
#[test]
fn raw_codec_rejects_invalid_layouts_and_overflow_without_partial_writes() {
    for (dmx_break, offsets, raw, expected) in [
        (0, vec![1], 1, "invalid_break"),
        (1, vec![], 1, "invalid_channel_width"),
        (1, vec![1, 2, 3, 4, 5], 1, "invalid_channel_width"),
        (1, vec![1, 0], 1, "invalid_offset"),
        (1, vec![1, 5], 1, "wire_buffer_too_short"),
        (1, vec![1, 1], 1, "duplicate_byte"),
        (1, vec![1], 256, "raw_value_out_of_range"),
        (1, vec![1, 3], 65536, "raw_value_out_of_range"),
        (1, vec![1, 3, 2], 16777216, "raw_value_out_of_range"),
    ] {
        let wire = ChannelWire { dmx_break, offsets };
        let mut output = [0x99; 4];
        assert_eq!(wire.write_raw(raw, &mut output).unwrap_err().code, expected);
        assert_eq!(output, [0x99; 4]);
        if expected != "raw_value_out_of_range" {
            assert_eq!(wire.read_raw(&output).unwrap_err().code, expected);
        }
    }
}

/// Compiled reference mappings write only their selected break and do not allocate virtual slots.
#[test]
fn compiled_channels_encode_independent_break_buffers() {
    let wires = wires(&description()).unwrap();
    let values = [0x1234, 0x5678, 0xffff, 0xffff, 11, 21, 12, 22, 13, 23];
    let mut first = [0xa5; 5];
    let mut second = [0xa5; 22];
    for (wire, value) in wires.channels.iter().zip(values) {
        if let Some(wire) = wire {
            let buffer: &mut [u8] = match wire.dmx_break {
                1 => &mut first,
                2 => &mut second,
                _ => panic!("unexpected break"),
            };
            wire.write_raw(value, buffer).unwrap();
            assert_eq!(wire.read_raw(buffer).unwrap(), value);
        }
    }
    assert_eq!(first, [0x12, 0x56, 0xa5, 0x34, 0x78]);
    assert_eq!(
        second,
        [
            0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 11, 12, 13, 0xa5, 0xa5, 0xa5,
            0xa5, 0xa5, 0xa5, 0xa5, 21, 22, 23
        ]
    );
}
