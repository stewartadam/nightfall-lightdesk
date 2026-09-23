// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Operator groups preserve physical independence without making every mesh selectable.

use nightfall_fixture_library::gdtf_compiler::{CompileLimits, CompiledMode, compile_mode};
use nightfall_fixture_library::gdtf_controls::ControlTarget;

/// Compile a resource-free mode and drop its source before inspecting operator data.
fn compile(xml: &str) -> CompiledMode {
    let source: gdtf::Description = xml.parse().unwrap();
    compile_mode(
        &source.fixture_types[0],
        "Nested sparse",
        CompileLimits::default(),
    )
    .unwrap()
}

/// Nested joints remain independent; repeated pixels gather virtual dimmer and physical RGB channels once.
#[test]
fn groups_cover_channels_once_and_omit_uncontrolled_parts() {
    let mode = compile(include_str!("fixtures/gdtf/nested-sparse.xml"));
    let controls = mode.controls();
    assert_eq!(mode.geometry().nodes().len(), 5);
    assert_eq!(controls.groups().len(), 4);
    let expected = [
        ("Arm", 1, vec![0]),
        ("Head", 2, vec![1]),
        ("Pixel 1", 3, vec![2, 4, 6, 8]),
        ("Pixel 2", 4, vec![3, 5, 7, 9]),
    ];
    for (group, (label, geometry, channels)) in controls.groups().iter().zip(expected) {
        assert_eq!(group.label, label);
        assert_eq!(group.geometry, geometry);
        assert_eq!(group.channels, channels);
        assert_eq!(controls.element(group.element).unwrap().id, group.id);
        for &channel in &group.channels {
            assert_eq!(mode.channels().channels()[channel].geometry, group.geometry);
            assert_eq!(
                controls.channel_group(channel),
                Some(group.element as usize - 1)
            );
        }
    }
    let mut owned: Vec<_> = controls
        .groups()
        .iter()
        .flat_map(|group| group.channels.clone())
        .collect();
    owned.sort_unstable();
    assert_eq!(owned, (0..10).collect::<Vec<_>>());
    assert_eq!(
        controls.attribute_targets(1, "Tilt"),
        [ControlTarget {
            channel: 0,
            function: 0
        }]
    );
    assert_eq!(
        controls.attribute_targets(2, "Tilt"),
        [ControlTarget {
            channel: 1,
            function: 0
        }]
    );
    assert_eq!(
        controls.attribute_targets(3, "ColorAdd_R"),
        [ControlTarget {
            channel: 4,
            function: 0
        }]
    );
    assert_eq!(
        controls.attribute_targets(4, "ColorAdd_R"),
        [ControlTarget {
            channel: 5,
            function: 0
        }]
    );
}

/// Display renaming cannot change dotted element numbers, structural group identities or channel targeting.
#[test]
fn labels_do_not_determine_identity_or_order() {
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml");
    let original = compile(xml);
    let renamed = compile(
        &xml.replace("Arm", "Upper hinge")
            .replace("Head", "Lower hinge")
            .replace("Pixel 1", "Pixel 10"),
    );
    for (original, renamed) in original
        .controls()
        .groups()
        .iter()
        .zip(renamed.controls().groups())
    {
        assert_eq!(original.id, renamed.id);
        assert_eq!(original.element, renamed.element);
        assert_eq!(original.channels, renamed.channels);
    }
    assert_eq!(renamed.controls().groups()[2].label, "Pixel 10");
    assert_eq!(renamed.controls().groups()[3].label, "Pixel 2");
}

/// Operator ordering follows authored control occurrence rather than the order physical parts are traversed.
#[test]
fn channel_order_controls_first_element_occurrence() {
    let mut source: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    source.fixture_types[0].dmx_modes[0].dmx_channels.swap(0, 1);
    let mode = compile_mode(
        &source.fixture_types[0],
        "Nested sparse",
        CompileLimits::default(),
    )
    .unwrap();
    assert_eq!(mode.geometry().nodes()[1].name, "Arm");
    assert_eq!(mode.controls().groups()[0].label, "Head");
    assert_eq!(mode.controls().groups()[0].geometry, 2);
    assert_eq!(mode.controls().groups()[1].label, "Arm");
}

/// Multiple logical functions remain candidates on a single channel, never duplicated physical outputs.
#[test]
fn attribute_lookup_retains_all_candidates_without_picking_a_winner() {
    let mut source: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    let channel = &mut source.fixture_types[0].dmx_modes[0].dmx_channels[0];
    channel
        .logical_channels
        .push(channel.logical_channels[0].clone());
    let mode = compile_mode(
        &source.fixture_types[0],
        "Nested sparse",
        CompileLimits::default(),
    )
    .unwrap();
    assert_eq!(mode.controls().groups()[0].channels, [0]);
    assert_eq!(
        mode.controls().attribute_targets(1, "Tilt"),
        [
            ControlTarget {
                channel: 0,
                function: 0
            },
            ControlTarget {
                channel: 0,
                function: 1
            }
        ]
    );
    assert!(mode.controls().element(0).is_none());
    assert!(mode.controls().element(5).is_none());
    assert!(mode.controls().channel_group(10).is_none());
    assert!(mode.controls().attribute_targets(1, "tilt").is_empty());
    assert!(mode.controls().attribute_targets(0, "Tilt").is_empty());
    assert!(mode.controls().attribute_targets(99, "Tilt").is_empty());
}
