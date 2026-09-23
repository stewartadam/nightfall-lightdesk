// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Independent selector expectations for repeated pixels and shared controls.

use nightfall_fixture_library::gdtf_bindings::bind_selectors;
use nightfall_fixture_library::gdtf_functions::resolve_functions;
use nightfall_fixture_library::gdtf_resolver::{ResolveLimits, resolve_mode};

/// Add a selector to one authored channel before geometry expansion.
fn description(channel: usize, target: &str) -> gdtf::Description {
    let mut description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    description.fixture_types[0].dmx_modes[0].dmx_channels[channel].logical_channels[0]
        .channel_functions[0]
        .mode_master = Some(gdtf::dmx_mode::ModeMasterNode {
        node: serde_json::from_value(serde_json::json!(target)).unwrap(),
        from: serde_json::from_value(serde_json::json!("64/1")).unwrap(),
        to: serde_json::from_value(serde_json::json!("128/1")).unwrap(),
    });
    description
}

/// Each red pixel binds to its own virtual dimmer, including explicit function links.
#[test]
fn repeated_pixels_keep_local_selectors() {
    for target in ["Pixel_Dimmer", "Pixel_Dimmer.Dimmer.Dimmer"] {
        let description = description(3, target);
        let mode = resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default(),
        )
        .unwrap();
        let functions = resolve_functions(&mode).unwrap();
        let bindings = bind_selectors(&mode, &functions).unwrap();
        for (channel, master) in [(4, 2), (5, 3)] {
            let bound = bindings.channels[channel][0].as_ref().unwrap();
            assert_eq!(bound.channel, master);
            assert_eq!((bound.raw_from, bound.raw_to), (64, 128));
            assert_eq!(bound.function, target.contains('.').then_some(0));
        }
    }
}

/// A shared head selector retains its own precision and gates both pixel instances.
#[test]
fn shared_master_applies_to_each_pixel() {
    let description = description(3, "Head_Tilt");
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let bindings = bind_selectors(&mode, &functions).unwrap();
    for channel in [4, 5] {
        let bound = bindings.channels[channel][0].as_ref().unwrap();
        assert_eq!(bound.channel, 1);
        assert_eq!((bound.raw_from, bound.raw_to), (0x4040, 0x8080));
    }
}

/// A shared control cannot arbitrarily choose one of several repeated masters.
#[test]
fn ambiguous_repeated_master_is_rejected() {
    let description = description(0, "Pixel_Dimmer");
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    assert_eq!(
        bind_selectors(&mode, &functions).unwrap_err().code,
        "ambiguous_selector_instance"
    );
}

/// Compiler passes cannot silently combine different channel orders.
#[test]
fn mismatched_channel_order_is_rejected() {
    let description = description(3, "Pixel_Dimmer");
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let mut functions = resolve_functions(&mode).unwrap();
    functions.swap(0, 1);
    assert_eq!(
        bind_selectors(&mode, &functions).unwrap_err().code,
        "mismatched_functions"
    );
}

/// Repeated outer assemblies distinguish instances even when their inner references share source nodes.
#[test]
fn nested_assemblies_bind_the_nearest_enclosing_master() {
    let position = "{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}";
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace("<Geometries>", &format!("<Geometries><Geometry Name=\"Rig\" Position=\"{position}\"><GeometryReference Name=\"Left\" Geometry=\"Base\" Position=\"{position}\"/><GeometryReference Name=\"Right\" Geometry=\"Base\" Position=\"{position}\"/></Geometry>"))
        .replace("Geometry=\"Base\">", "Geometry=\"Rig\">");
    let selector = description(3, "Head_Tilt")
        .fixture_types
        .remove(0)
        .dmx_modes
        .remove(0)
        .dmx_channels
        .remove(3)
        .logical_channels
        .remove(0)
        .channel_functions
        .remove(0)
        .mode_master;
    let mut description: gdtf::Description = xml.parse().unwrap();
    description.fixture_types[0].dmx_modes[0].dmx_channels[3].logical_channels[0]
        .channel_functions[0]
        .mode_master = selector;
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let bindings = bind_selectors(&mode, &functions).unwrap();
    for (channel, master) in [(8, 2), (9, 2), (10, 3), (11, 3)] {
        assert_eq!(
            bindings.channels[channel][0].as_ref().unwrap().channel,
            master
        );
    }
}
