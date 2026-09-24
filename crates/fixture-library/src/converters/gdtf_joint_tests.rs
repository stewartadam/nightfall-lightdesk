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

/// Returns `(node name, axis, driving element)` for every joint node.
fn joints(geometry: &FixtureGeometry) -> Vec<(&str, AxisType, &str)> {
    geometry
        .nodes
        .iter()
        .filter_map(|node| {
            Some((
                node.name.as_str(),
                node.axis?,
                node.controlled_element.as_deref()?,
            ))
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
