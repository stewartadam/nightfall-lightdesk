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
