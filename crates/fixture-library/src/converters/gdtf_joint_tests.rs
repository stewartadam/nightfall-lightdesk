// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Joint binding tests: pan and tilt bind to the geometry their channels name.

use nightfall_fixtures::prelude::*;

use super::gdtf::convert_gdtf_to_fixture;
use crate::testing::invariants::check_invariants;
use crate::testing::{BreakSpec, ChannelSpec, GdtfBuilder, GeometrySpec, ModeSpec};

/// Converts the first mode and asserts the result satisfies all invariants.
fn convert(builder: &GdtfBuilder) -> (Fixture, FixtureGeometry) {
    let dir = tempfile::tempdir().unwrap();
    let metadata = builder.write_metadata(dir.path());
    let mode = metadata.modes[0].clone();
    let (fixture, geometry) = convert_gdtf_to_fixture(&metadata, &mode, 1).unwrap();
    let geometry = geometry.expect("geometry");
    assert_eq!(check_invariants(&fixture, Some(&geometry)), vec![]);
    (fixture, geometry)
}

/// Returns `(node name, axis, driving element)` for every joint axis.
fn joints(geometry: &FixtureGeometry) -> Vec<(&str, AxisType, &str)> {
    geometry
        .nodes
        .iter()
        .flat_map(|node| {
            node.axes.iter().filter_map(|axis| {
                Some((
                    node.name.as_str(),
                    *axis,
                    node.controlled_element.as_deref()?,
                ))
            })
        })
        .collect()
}

/// Verifies joints come from channel geometry even with neutral names and plain geometry tags.
#[test]
fn joints_bind_from_channel_geometry_not_names() {
    let builder = GdtfBuilder::new("Test", "Neutral")
        .geometry(
            GeometrySpec::generic("Part A").child(
                GeometrySpec::generic("Part B")
                    .child(GeometrySpec::generic("Part C").child(GeometrySpec::beam("Part D"))),
            ),
        )
        .mode(
            ModeSpec::new("Mode", "Part A")
                .channel(ChannelSpec::new("Part B", "Pan", &[1, 2]))
                .channel(ChannelSpec::new("Part C", "Tilt", &[3, 4]))
                .channel(ChannelSpec::new("Part D", "Dimmer", &[5])),
        );
    let (_, geometry) = convert(&builder);
    assert_eq!(
        joints(&geometry),
        [
            ("Part B", AxisType::Pan, "Part B"),
            ("Part C", AxisType::Tilt, "Part C"),
        ]
    );
}

/// Verifies pan and tilt channels on one geometry make a single two-axis joint, pan first.
#[test]
fn pan_and_tilt_on_one_geometry_bind_both_axes() {
    let builder = GdtfBuilder::new("Test", "Gimbal")
        .geometry(GeometrySpec::generic("Base").child(GeometrySpec::axis("Mover")))
        .mode(
            ModeSpec::new("Mode", "Base")
                .channel(ChannelSpec::new("Mover", "Tilt", &[1]))
                .channel(ChannelSpec::new("Mover", "Pan", &[2])),
        );
    let (_, geometry) = convert(&builder);
    assert_eq!(
        joints(&geometry),
        [
            ("Mover", AxisType::Pan, "Mover"),
            ("Mover", AxisType::Tilt, "Mover"),
        ]
    );
}

/// Verifies axes whose names suggest movement stay static without a movement channel.
#[test]
fn axis_names_without_channels_do_not_move() {
    let builder = GdtfBuilder::new("Test", "Static")
        .geometry(
            GeometrySpec::generic("Base")
                .child(GeometrySpec::axis("Yoke").child(GeometrySpec::axis("Head"))),
        )
        .mode(ModeSpec::new("Mode", "Base").channel(ChannelSpec::new("Base", "Dimmer", &[1])));
    let (_, geometry) = convert(&builder);
    assert!(joints(&geometry).is_empty());
}

/// Verifies each referenced head binds its own tilt joint to its own element.
#[test]
fn referenced_heads_bind_independent_joints() {
    let builder = GdtfBuilder::new("Test", "Heads")
        .geometry(
            GeometrySpec::generic("Base")
                .child(GeometrySpec::reference("Head 1", "Head", &[(1, 1)]))
                .child(GeometrySpec::reference("Head 2", "Head", &[(1, 3)])),
        )
        .geometry(GeometrySpec::axis("Head").child(GeometrySpec::beam("Lens")))
        .mode(
            ModeSpec::new("Mode", "Base")
                .channel(ChannelSpec::new("Head", "Tilt", &[1]).on_break(BreakSpec::Overwrite))
                .channel(ChannelSpec::new("Lens", "Dimmer", &[2]).on_break(BreakSpec::Overwrite)),
        );
    let (_, geometry) = convert(&builder);
    assert_eq!(
        joints(&geometry),
        [
            ("Head 1", AxisType::Tilt, "Head 1"),
            ("Head 2", AxisType::Tilt, "Head 2"),
        ]
    );
    let lens_owners: Vec<&str> = geometry
        .nodes
        .iter()
        .filter(|node| node.geometry_type == GeometryType::Beam)
        .filter_map(|node| node.controlled_element.as_deref())
        .collect();
    assert_eq!(lens_owners, ["Head 1/Lens", "Head 2/Lens"]);
}

/// Converts the first mode and returns fixture, geometry and diagnostics without asserting invariants.
fn convert_with_diagnostics(
    builder: &GdtfBuilder,
) -> (
    Fixture,
    Option<FixtureGeometry>,
    Vec<super::gdtf_resolve::GdtfDiagnostic>,
) {
    let dir = tempfile::tempdir().unwrap();
    let metadata = builder.write_metadata(dir.path());
    let mut gdtf = metadata.reparse().unwrap();
    let mode = metadata.modes[0].clone();
    let converted = super::gdtf::convert_gdtf_mode(&mut gdtf, &metadata, &mode, 1).unwrap();
    (converted.fixture, converted.geometry, converted.diagnostics)
}

/// Verifies channels mirrored onto two geometries keep one output and make the copy virtual.
#[test]
fn shared_slots_become_virtual_with_a_diagnostic() {
    let builder = GdtfBuilder::new("Test", "Mirror")
        .geometry(
            GeometrySpec::generic("Body")
                .child(GeometrySpec::beam("1A"))
                .child(GeometrySpec::beam("1B")),
        )
        .mode(
            ModeSpec::new("Mode", "Body")
                .channel(ChannelSpec::new("1A", "Dimmer", &[1]))
                .channel(ChannelSpec::new("1B", "Dimmer", &[1])),
        );
    let (fixture, geometry, diagnostics) = convert_with_diagnostics(&builder);
    assert_eq!(check_invariants(&fixture, geometry.as_ref()), vec![]);
    assert_eq!(
        fixture.elements[1].parameters[0].dmx_slots,
        DmxSlots::Virtual
    );
    assert!(
        diagnostics.contains(&super::gdtf_resolve::GdtfDiagnostic::SharedSlots {
            instance: "1B".to_string(),
            offsets: vec![1],
        })
    );
}

/// Verifies duplicate geometry names are made unique and only the first binds channels.
#[test]
fn duplicate_geometry_names_are_renamed() {
    let builder = GdtfBuilder::new("Test", "Duplicate")
        .geometry(
            GeometrySpec::generic("Body")
                .child(GeometrySpec::beam("Cell"))
                .child(GeometrySpec::beam("Cell")),
        )
        .mode(ModeSpec::new("Mode", "Body").channel(ChannelSpec::new("Cell", "Dimmer", &[1])));
    let (fixture, geometry, diagnostics) = convert_with_diagnostics(&builder);
    let geometry = geometry.unwrap();
    let names: Vec<&str> = geometry
        .nodes
        .iter()
        .map(|node| node.name.as_str())
        .collect();
    assert_eq!(names, ["Body", "Cell", "Cell #2"]);
    assert_eq!(fixture.elements.len(), 1);
    assert_eq!(check_invariants(&fixture, Some(&geometry)), vec![]);
    assert!(diagnostics.contains(
        &super::gdtf_resolve::GdtfDiagnostic::DuplicateGeometryName {
            name: "Cell".to_string(),
        }
    ));
}

/// Verifies a generated duplicate name never displaces a geometry that authored that name.
///
/// With children `Cell`, `Cell`, `Cell #2`, the authored `Cell #2` keeps its
/// name and still binds its channel; the duplicate `Cell` skips to `Cell #3`.
#[test]
fn generated_duplicate_names_skip_authored_names() {
    let builder = GdtfBuilder::new("Test", "Suffix")
        .geometry(
            GeometrySpec::generic("Body")
                .child(GeometrySpec::beam("Cell"))
                .child(GeometrySpec::beam("Cell"))
                .child(GeometrySpec::beam("Cell #2")),
        )
        .mode(
            ModeSpec::new("Mode", "Body")
                .channel(ChannelSpec::new("Cell", "Dimmer", &[1]))
                .channel(ChannelSpec::new("Cell #2", "Dimmer", &[2])),
        );
    let (fixture, geometry, diagnostics) = convert_with_diagnostics(&builder);
    let geometry = geometry.unwrap();
    let names: Vec<&str> = geometry
        .nodes
        .iter()
        .map(|node| node.name.as_str())
        .collect();
    assert_eq!(names, ["Body", "Cell", "Cell #3", "Cell #2"]);
    let labels: Vec<&str> = fixture
        .elements
        .iter()
        .map(|element| element.label.as_str())
        .collect();
    assert_eq!(labels, ["Cell", "Cell #2"]);
    assert_eq!(check_invariants(&fixture, Some(&geometry)), vec![]);
    assert_eq!(
        diagnostics,
        vec![super::gdtf_resolve::GdtfDiagnostic::DuplicateGeometryName {
            name: "Cell".to_string(),
        }]
    );
}

/// Verifies a mode without channels yields one element named after the root geometry.
#[test]
fn channelless_mode_names_its_element_after_the_root() {
    let builder = GdtfBuilder::new("Test", "Empty")
        .geometry(GeometrySpec::generic("Base"))
        .mode(ModeSpec::new("Mode", "Base"));
    let (fixture, geometry, _) = convert_with_diagnostics(&builder);
    assert_eq!(fixture.elements[0].label, "Base");
    assert_eq!(check_invariants(&fixture, geometry.as_ref()), vec![]);
}

/// Verifies channels beyond one universe are dropped with a diagnostic and own no beam.
#[test]
fn unrepresentable_channels_are_reported() {
    let builder = GdtfBuilder::new("Test", "Huge")
        .geometry(GeometrySpec::generic("Body").child(GeometrySpec::beam("Far")))
        .mode(ModeSpec::new("Mode", "Body").channel(ChannelSpec::new("Far", "Dimmer", &[600])));
    let (fixture, geometry, diagnostics) = convert_with_diagnostics(&builder);
    assert_eq!(check_invariants(&fixture, geometry.as_ref()), vec![]);
    assert!(diagnostics.contains(
        &super::gdtf_resolve::GdtfDiagnostic::UnrepresentableChannel {
            instance: "Far".to_string(),
            offsets: vec![600],
        }
    ));
}

/// Verifies a mode whose root expands to nothing produces no geometry rather than an empty tree.
#[test]
fn dangling_root_produces_no_geometry() {
    let builder = GdtfBuilder::new("Test", "Dangling")
        .geometry(GeometrySpec::reference("Top", "Missing", &[]))
        .mode(ModeSpec::new("Mode", "Top"));
    let (fixture, geometry, _) = convert_with_diagnostics(&builder);
    assert!(geometry.is_none());
    assert_eq!(check_invariants(&fixture, geometry.as_ref()), vec![]);
}
