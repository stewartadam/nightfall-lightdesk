// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Establish parser inputs for compiler, wire, and articulation acceptance tests.

use gdtf::geometry::{AnyGeometry, Geometry};
use nightfall_fixture_library::gdtf_resolver::{ResolveLimits, resolve_mode};

/// Parse the repository-owned input without a filesystem archive or vendor dependency.
fn description() -> gdtf::Description {
    include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap()
}

/// Keep two identically attributed nested joints, sparse bytes, and reference overrides intact.
#[test]
fn nested_sparse_description_preserves_compiler_inputs() {
    let description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    let fixture = &description.fixture_types[0];
    let mode = &fixture.dmx_modes[0];
    assert_eq!(mode.name.as_ref().unwrap().as_ref(), "Nested sparse");
    assert_eq!(mode.dmx_channels[0].offset.as_deref(), Some(&[1, 4][..]));
    assert_eq!(mode.dmx_channels[1].offset.as_deref(), Some(&[2, 5][..]));
    assert!(mode.dmx_channels[2].offset.is_none());
    let arm = &fixture.geometries[0].children()[0];
    let head = &arm.children()[0];
    assert_eq!(arm.name().unwrap().as_ref(), "Arm");
    assert_eq!(head.name().unwrap().as_ref(), "Head");
    assert_eq!(head.children().len(), 2);
    for (child, expected_offset) in head.children().iter().zip([10, 20]) {
        let Geometry::Reference(reference) = child else {
            panic!("Expected independently placed pixel references");
        };
        assert_eq!(reference.breaks[0].dmx_break, 2);
        assert_eq!(reference.breaks[0].dmx_offset.absolute(), expected_offset);
        assert_eq!(reference.geometry.as_ref().unwrap().as_ref(), "Pixel");
    }
    assert_eq!(fixture.geometries.len(), 3);
}

/// Select one root, instantiate both references, and keep nested controls distinct.
#[test]
fn selected_mode_expands_instances_and_preserves_control_sources() {
    let description = description();
    let resolved = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    assert_eq!(
        resolved
            .geometries
            .iter()
            .map(|g| g.name.as_str())
            .collect::<Vec<_>>(),
        ["Base", "Arm", "Head", "Pixel 1", "Pixel 2"]
    );
    assert_eq!(
        resolved
            .geometries
            .iter()
            .map(|g| g.parent)
            .collect::<Vec<_>>(),
        [None, Some(0), Some(1), Some(2), Some(2)]
    );
    assert_eq!(resolved.channels.len(), 10);
    assert_eq!(resolved.joints.len(), 2);
    assert_eq!(
        resolved
            .joints
            .iter()
            .map(|j| (j.channel, j.geometry))
            .collect::<Vec<_>>(),
        [(0, 1), (1, 2)]
    );
    assert!(
        resolved
            .joints
            .iter()
            .all(|j| j.axis == nightfall_fixtures::geometry::AxisType::Tilt)
    );
    assert_eq!(resolved.channels[0].geometry, 1);
    assert_eq!(resolved.channels[1].geometry, 2);
    assert_eq!(resolved.channels[0].source.offset, Some(vec![1, 4]));
    assert_eq!(resolved.channels[1].source.offset, Some(vec![2, 5]));
    assert_eq!(resolved.channels[2].geometry, 3);
    assert_eq!(resolved.channels[3].geometry, 4);
    assert!(resolved.channels[2].source.offset.is_none());
    assert!(resolved.channels[3].source.offset.is_none());
    assert_ne!(resolved.channels[2].id, resolved.channels[3].id);
    assert_eq!(
        resolved.geometries[3].references[0].breaks[0]
            .dmx_offset
            .absolute(),
        10
    );
    assert_eq!(
        resolved.geometries[4].references[0].breaks[0]
            .dmx_offset
            .absolute(),
        20
    );
    assert_eq!(
        serde_json::to_value(resolved.geometries[2].position).unwrap(),
        "{1,0,0,0}{0,1,0,0}{0,0,1,1}{0,0,0,1}"
    );
    assert_eq!(
        serde_json::to_value(resolved.geometries[4].position).unwrap(),
        "{1,0,0,1}{0,1,0,0}{0,0,1,0}{0,0,0,1}"
    );
}

/// Display/source renaming cannot alter definition-local structural identities.
#[test]
fn instance_ids_are_deterministic_and_independent_of_labels() {
    let original = description();
    let renamed: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace("Arm", "Outer joint")
        .replace("Head", "Inner joint")
        .parse()
        .unwrap();
    let a = resolve_mode(
        &original.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let b = resolve_mode(
        &renamed.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    assert_eq!(
        a.geometries.iter().map(|g| &g.id).collect::<Vec<_>>(),
        b.geometries.iter().map(|g| &g.id).collect::<Vec<_>>()
    );
    assert_eq!(
        a.channels.iter().map(|c| &c.id).collect::<Vec<_>>(),
        b.channels.iter().map(|c| &c.id).collect::<Vec<_>>()
    );
}

/// References to an active root fail before recursive expansion can exhaust memory.
#[test]
fn cyclic_reference_reports_its_instance_path() {
    let cyclic: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace(
            "Geometry=\"Pixel\" Position=",
            "Geometry=\"Base\" Position=",
        )
        .parse()
        .unwrap();
    let error = resolve_mode(
        &cyclic.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "reference_cycle");
    assert_eq!(error.path, "g/0/0/0/0");
}

/// Each resource budget fails explicitly without producing a partial passing definition.
#[test]
fn resolver_enforces_independent_expansion_limits() {
    let description = description();
    for (limits, expected) in [
        (
            ResolveLimits {
                depth: 3,
                ..Default::default()
            },
            "depth_limit",
        ),
        (
            ResolveLimits {
                geometries: 4,
                ..Default::default()
            },
            "geometry_limit",
        ),
        (
            ResolveLimits {
                channels: 9,
                ..Default::default()
            },
            "channel_limit",
        ),
    ] {
        assert_eq!(
            resolve_mode(&description.fixture_types[0], "Nested sparse", limits)
                .unwrap_err()
                .code,
            expected
        );
    }
}

/// Inactive geometries cannot quietly supply channels to a selected mode.
#[test]
fn unreachable_channel_is_not_silently_dropped() {
    let mut description = description();
    description.fixture_types[0].dmx_modes[0].dmx_channels[0].geometry =
        gdtf::values::Name::new("Unused").unwrap();
    assert_eq!(
        resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default()
        )
        .unwrap_err()
        .code,
        "unreachable_channel"
    );
}

/// Chained references retain alias controls and use the nearest explicit model override.
#[test]
fn reference_chains_preserve_overrides_and_alias_targets() {
    let identity = "{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}";
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace(&format!("<Geometry Name=\"Pixel\" Position=\"{identity}\"/>"),
                 &format!("<GeometryReference Name=\"Pixel\" Geometry=\"Template\" Model=\"Inner\" Position=\"{identity}\"/><Geometry Name=\"Template\" Model=\"TemplateModel\" Position=\"{identity}\"/>"))
        .replace("Name=\"Pixel 2\" Geometry=", "Model=\"Outer\" Name=\"Pixel 2\" Geometry=");
    let description: gdtf::Description = xml.parse().unwrap();
    let resolved = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    assert_eq!(resolved.geometries.len(), 5);
    assert_eq!(resolved.channels.len(), 10);
    assert_eq!(resolved.geometries[3].model.unwrap().as_ref(), "Inner");
    assert_eq!(resolved.geometries[4].model.unwrap().as_ref(), "Outer");
    assert_eq!(resolved.geometries[4].source_name, "Template");
    assert_eq!(resolved.geometries[4].name, "Pixel 2");
    assert_eq!(resolved.geometries[4].references.len(), 2);
}

/// Ambiguous source links are rejected rather than silently binding unrelated parts together.
#[test]
fn duplicate_source_names_are_diagnosed() {
    let mut description = description();
    let template = description.fixture_types[0].geometries[1].clone();
    description.fixture_types[0].geometries.push(template);
    assert_eq!(
        resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default()
        )
        .unwrap_err()
        .code,
        "ambiguous_reference"
    );
    let duplicate: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace("Name=\"Head\"", "Name=\"Arm\"")
        .parse()
        .unwrap();
    assert_eq!(
        resolve_mode(
            &duplicate.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default()
        )
        .unwrap_err()
        .code,
        "ambiguous_geometry"
    );
}

/// Position attributes also bind generic geometry whose XML type and name imply no axis.
#[test]
fn generic_geometry_gets_joint_semantics_from_channels() {
    let generic: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace("<Axis ", "<Geometry ")
        .replace("</Axis>", "</Geometry>")
        .parse()
        .unwrap();
    let resolved = resolve_mode(
        &generic.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    assert_eq!(resolved.joints.len(), 2);
    assert_eq!(resolved.joints[0].geometry, 1);
    assert_eq!(resolved.joints[1].geometry, 2);
}

/// The permissive source parser must not let NaN transforms enter a resolved scene.
#[test]
fn non_finite_transform_is_rejected() {
    let invalid: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replacen("{1,0,0,0}", "{NaN,0,0,0}", 1)
        .parse()
        .unwrap();
    let error = resolve_mode(
        &invalid.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_transform");
    assert_eq!(error.path, "g/0");
}
