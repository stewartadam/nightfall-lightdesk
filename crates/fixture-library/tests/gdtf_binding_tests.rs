// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Independent selector expectations for repeated pixels and shared controls.

use nightfall_fixture_library::gdtf_activation::compile_activation;
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

/// Selector endpoints are inclusive, and independent pixel values never leak to siblings.
#[test]
fn activation_obeys_local_boundaries_and_snapshot_precision() {
    let description = description(3, "Pixel_Dimmer");
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let bindings = bind_selectors(&mode, &functions).unwrap();
    let program = compile_activation(&functions, &bindings, 100).unwrap();
    let mut values = vec![0; functions.len()];
    for (raw, expected) in [(63, false), (64, true), (128, true), (129, false)] {
        values[2] = raw;
        values[3] = 100;
        let active = program.evaluate(&values).unwrap();
        assert_eq!(!active[4].is_empty(), expected);
        assert_eq!(active[5], vec![0]);
    }
    values[0] = 65535;
    assert!(program.evaluate(&values).is_ok());
    values[0] = 65536;
    assert_eq!(
        program.evaluate(&values).unwrap_err().code,
        "invalid_raw_snapshot"
    );
    assert_eq!(
        program.evaluate(&[]).unwrap_err().code,
        "invalid_raw_snapshot"
    );
    assert_eq!(
        compile_activation(&functions, &bindings, 9)
            .unwrap_err()
            .code,
        "function_limit"
    );
}

/// Function links cascade through activation, while channel links inspect only raw channel values.
#[test]
fn function_dependencies_and_raw_channel_gates_are_distinct() {
    for (target, expected_second) in [
        ("Pixel_ColorAdd_G.ColorAdd_G.ColorAdd_G", false),
        ("Pixel_ColorAdd_G", true),
    ] {
        let mut description = description(3, target);
        let gate = serde_json::from_value(serde_json::json!({
            "@ModeMaster": "Pixel_Dimmer", "@ModeFrom": "64/1", "@ModeTo": "128/1"
        }));
        // Build source selectors through the same authored literal representation as fixtures.
        let green = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[4].logical_channels
            [0]
        .channel_functions[0];
        green.mode_master = Some(gate.unwrap());
        let mode = resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default(),
        )
        .unwrap();
        let functions = resolve_functions(&mode).unwrap();
        let bindings = bind_selectors(&mode, &functions).unwrap();
        let program = compile_activation(&functions, &bindings, 100).unwrap();
        let mut values = vec![0; functions.len()];
        values[2] = 64;
        values[3] = 63;
        values[6] = 64;
        values[7] = 64;
        let active = program.evaluate(&values).unwrap();
        assert_eq!(active[4], vec![0]);
        assert_eq!(!active[5].is_empty(), expected_second);
        assert_eq!(active[6], vec![0]);
        assert!(active[7].is_empty());
    }
}

/// Circular function dependencies fail at compilation, before an evaluation can recurse or hang.
#[test]
fn cyclic_function_selectors_are_rejected() {
    let mut description = description(3, "Pixel_ColorAdd_G.ColorAdd_G.ColorAdd_G");
    description.fixture_types[0].dmx_modes[0].dmx_channels[4].logical_channels[0]
        .channel_functions[0]
        .mode_master = Some(gdtf::dmx_mode::ModeMasterNode {
        node: serde_json::from_value(serde_json::json!("Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R"))
            .unwrap(),
        from: serde_json::from_value(serde_json::json!("0/1")).unwrap(),
        to: serde_json::from_value(serde_json::json!("255/1")).unwrap(),
    });
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let bindings = bind_selectors(&mode, &functions).unwrap();
    assert_eq!(
        compile_activation(&functions, &bindings, 100)
            .unwrap_err()
            .code,
        "selector_cycle"
    );
}

/// A function selector requires the target function's own raw range as well as ModeFrom/ModeTo.
#[test]
fn master_function_range_limits_activation() {
    let mut description = description(3, "Pixel_ColorAdd_G.ColorAdd_G.Low");
    let green = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[4].logical_channels[0];
    green.channel_functions[0].name = Some(gdtf::values::Name::new("Low").unwrap());
    let mut high = green.channel_functions[0].clone();
    high.name = Some(gdtf::values::Name::new("High").unwrap());
    high.dmx_from = serde_json::from_value(serde_json::json!("128/1")).unwrap();
    green.channel_functions.push(high);
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let bindings = bind_selectors(&mode, &functions).unwrap();
    let program = compile_activation(&functions, &bindings, 100).unwrap();
    let mut values = vec![0; functions.len()];
    values[6] = 127;
    values[7] = 128;
    let active = program.evaluate(&values).unwrap();
    assert_eq!(active[4], vec![0]);
    assert!(active[5].is_empty());
    assert_eq!(active[6], vec![0]);
    assert_eq!(active[7], vec![1]);
}

/// Invalid compiled indices and intervals fail explicitly rather than panicking during evaluation.
#[test]
fn malformed_activation_inputs_fail_at_compilation() {
    let description = description(3, "Pixel_Dimmer.Dimmer.Dimmer");
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let mut bindings = bind_selectors(&mode, &functions).unwrap();
    bindings.channels[4][0].as_mut().unwrap().channel = usize::MAX;
    assert_eq!(
        compile_activation(&functions, &bindings, 100)
            .unwrap_err()
            .code,
        "invalid_selector_instance"
    );
    bindings.channels[4][0].as_mut().unwrap().channel = 2;
    bindings.channels[4][0].as_mut().unwrap().function = Some(99);
    assert_eq!(
        compile_activation(&functions, &bindings, 100)
            .unwrap_err()
            .code,
        "invalid_selector_function"
    );
    bindings.channels[4][0].as_mut().unwrap().function = Some(0);
    bindings.channels[4][0].as_mut().unwrap().raw_to = 256;
    assert_eq!(
        compile_activation(&functions, &bindings, 100)
            .unwrap_err()
            .code,
        "invalid_mode_range"
    );
    bindings.channels.pop();
    assert_eq!(
        compile_activation(&functions, &bindings, 100)
            .unwrap_err()
            .code,
        "mismatched_bindings"
    );
}

/// Long dependency chains use bounded heap storage instead of consuming the call stack.
#[test]
fn deep_dependencies_evaluate_and_detect_a_back_edge() {
    use nightfall_fixture_library::gdtf_bindings::{BoundCondition, SelectorBindings};
    use nightfall_fixture_library::gdtf_functions::{ChannelFunctions, FunctionRange};
    let description = description(3, "Pixel_Dimmer");
    let source = &description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0];
    let count = 20_000;
    let channels: Vec<_> = (0..count)
        .map(|index| ChannelFunctions {
            id: format!("c/{index}"),
            bytes: 4,
            initial_function: 0,
            default: 0,
            highlight: None,
            functions: vec![FunctionRange {
                id: format!("c/{index}/f/0"),
                logical_channel: 0,
                function: 0,
                raw_from: 0,
                raw_to: u32::MAX,
                default: 0,
                physical_from: 0.0,
                physical_to: 1.0,
                condition: None,
                source,
            }],
        })
        .collect();
    let mut bindings = SelectorBindings {
        channels: (0..count)
            .map(|index| {
                vec![(index + 1 < count).then_some(BoundCondition {
                    channel: index + 1,
                    function: Some(0),
                    raw_from: 0,
                    raw_to: u32::MAX,
                })]
            })
            .collect(),
    };
    let program = compile_activation(&channels, &bindings, count).unwrap();
    let values = vec![u32::MAX; count];
    assert!(
        program
            .evaluate(&values)
            .unwrap()
            .iter()
            .all(|active| active == &[0])
    );
    bindings.channels[count - 1][0] = Some(BoundCondition {
        channel: 0,
        function: Some(0),
        raw_from: 0,
        raw_to: u32::MAX,
    });
    assert_eq!(
        compile_activation(&channels, &bindings, count)
            .unwrap_err()
            .code,
        "selector_cycle"
    );
}
