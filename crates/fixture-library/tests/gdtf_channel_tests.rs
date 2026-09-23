// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Composed channel compilation and evaluation independent of parser lifetimes.

use nightfall_fixture_library::gdtf_channels::{ChannelLimits, CompiledChannels, compile_channels};
use nightfall_fixture_library::gdtf_resolver::{ResolveError, ResolveLimits, resolve_mode};

/// Resolved references and nested joints encode through explicit patches without flattening offsets.
#[test]
fn compiled_channels_patch_to_independent_universes_and_preserve_virtual_values() {
    use std::collections::BTreeMap;

    use nightfall_dmx::patch::BreakPatch;

    let program = compile(description(), ChannelLimits::default()).unwrap();
    let patch = program
        .wires()
        .patch(&BTreeMap::from([
            (
                1,
                BreakPatch {
                    universe: 42,
                    address: 508,
                },
            ),
            (
                2,
                BreakPatch {
                    universe: 0,
                    address: 200,
                },
            ),
        ]))
        .unwrap();
    let raw = [0x1234, 0xabcd, 128, 255, 1, 2, 3, 4, 5, 6];
    let mut buffers = BTreeMap::from([(42, [0xee; 512]), (0, [0xee; 512])]);
    patch.write_raw(&raw, &mut buffers).unwrap();
    let mut expected_joints = [0xee; 512];
    expected_joints[507..].copy_from_slice(&[0x12, 0xab, 0xee, 0x34, 0xcd]);
    let mut expected_pixels = [0xee; 512];
    expected_pixels[208..211].copy_from_slice(&[1, 3, 5]);
    expected_pixels[218..221].copy_from_slice(&[2, 4, 6]);
    assert_eq!(
        buffers,
        BTreeMap::from([(42, expected_joints), (0, expected_pixels)])
    );
    let decoded = patch.read_raw(&buffers).unwrap();
    assert_eq!(
        decoded,
        [
            Some(0x1234),
            Some(0xabcd),
            None,
            None,
            Some(1),
            Some(2),
            Some(3),
            Some(4),
            Some(5),
            Some(6)
        ]
    );
    let mut received = raw;
    for (target, decoded) in received.iter_mut().zip(decoded) {
        if let Some(value) = decoded {
            *target = value;
        }
    }
    assert_eq!(received, raw);
    assert_eq!(
        program.evaluate_physical(&received).unwrap(),
        program.evaluate_physical(&raw).unwrap()
    );
}

/// Consume the source document so every successful caller exercises an owned result.
fn compile(
    description: gdtf::Description,
    limits: ChannelLimits,
) -> Result<CompiledChannels, ResolveError> {
    let fixture = &description.fixture_types[0];
    let mode = resolve_mode(fixture, "Nested sparse", ResolveLimits::default())?;
    compile_channels(
        &mode,
        &fixture.attribute_definitions,
        &fixture.physical_descriptions.dmx_profiles,
        limits,
    )
}

/// Parse a small reference-expanded mode with two independent tilt controls.
fn description() -> gdtf::Description {
    include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap()
}

/// Owned semantics preserve sparse wire inputs, physical units and independent reference identities.
#[test]
fn owned_program_evaluates_after_source_disposal() {
    let program = compile(description(), ChannelLimits::default()).unwrap();
    assert_eq!(program.channels().len(), 10);
    assert_eq!(program.defaults(), vec![0; 10]);
    let mut raw = program.defaults();
    let input = [0x40, 0xff, 0xaa, 0x00, 0xff];
    raw[0] = program.wires().channels[0]
        .as_ref()
        .unwrap()
        .read_raw(&input)
        .unwrap();
    raw[1] = program.wires().channels[1]
        .as_ref()
        .unwrap()
        .read_raw(&input)
        .unwrap();
    raw[4] = 255;
    let evaluated = program.evaluate_physical(&raw).unwrap();
    assert!((evaluated[0][0].value - (16384.0 / 65535.0 * 180.0)).abs() < 1e-10);
    assert_eq!(evaluated[1][0].value, 180.0);
    assert_eq!(evaluated[4][0].value, 1.0);
    assert_eq!(evaluated[5][0].value, 0.0);
    assert_eq!(
        program.attributes().attributes()[program.channels()[0].functions[0].attribute].name,
        "Tilt"
    );
    assert_eq!(
        program.attributes().attributes()[program.channels()[4].functions[0].attribute].name,
        "ColorAdd_R"
    );
    assert_ne!(
        program.channels()[4].geometry,
        program.channels()[5].geometry
    );
    assert_ne!(program.channels()[4].id, program.channels()[5].id);
    assert_eq!(
        program.channels()[4].geometry,
        program.channels()[2].geometry
    );
    assert!(program.wires().channels[2].is_none());
    assert!(program.relations().relations().is_empty());
    let serialized = serde_json::to_value(&program).unwrap();
    assert_eq!(serialized["channels"][4]["functions"][0]["rawTo"], 255);
}

/// A local virtual selector gates only its own repeated pixel after all passes are composed.
#[test]
fn local_selectors_gate_physical_evaluation() {
    let mut source = description();
    source.fixture_types[0].dmx_modes[0].dmx_channels[3].logical_channels[0].channel_functions[0]
        .mode_master = Some(gdtf::dmx_mode::ModeMasterNode {
        node: serde_json::from_value(serde_json::json!("Pixel_Dimmer")).unwrap(),
        from: serde_json::from_value(serde_json::json!("64/1")).unwrap(),
        to: serde_json::from_value(serde_json::json!("128/1")).unwrap(),
    });
    let program = compile(source, ChannelLimits::default()).unwrap();
    let mut raw = program.defaults();
    raw[2] = 64;
    raw[3] = 129;
    raw[4] = 255;
    raw[5] = 255;
    let values = program.evaluate_physical(&raw).unwrap();
    assert_eq!(values[4][0].value, 1.0);
    assert!(values[5].is_empty());
    raw[2] = 63;
    raw[3] = 128;
    let values = program.evaluate_physical(&raw).unwrap();
    assert!(values[4].is_empty());
    assert_eq!(values[5][0].value, 1.0);
}

/// Overlapping logical functions remain separately observable, never reduced to a winning function.
#[test]
fn all_active_logical_functions_are_retained() {
    let mut source = description();
    let channel = &mut source.fixture_types[0].dmx_modes[0].dmx_channels[0];
    let mut logical = channel.logical_channels[0].clone();
    logical.channel_functions[0].physical_to = 360.0;
    channel.logical_channels.push(logical);
    let program = compile(source, ChannelLimits::default()).unwrap();
    let mut raw = program.defaults();
    raw[0] = 65535;
    let values = program.evaluate_physical(&raw).unwrap();
    assert_eq!(values[0].len(), 2);
    assert_eq!((values[0][0].function, values[0][0].value), (0, 180.0));
    assert_eq!((values[0][1].function, values[0][1].value), (1, 360.0));
}

/// Compilation budgets and snapshot validation remain effective at the composed API boundary.
#[test]
fn composed_program_rejects_invalid_inputs() {
    let limits = ChannelLimits {
        functions: 9,
        ..ChannelLimits::default()
    };
    assert_eq!(
        compile(description(), limits).unwrap_err().code,
        "function_limit"
    );
    let program = compile(description(), ChannelLimits::default()).unwrap();
    assert_eq!(
        program.evaluate_physical(&[]).unwrap_err().code,
        "invalid_raw_snapshot"
    );
    let mut raw = program.defaults();
    raw[4] = 256;
    assert_eq!(
        program.evaluate_physical(&raw).unwrap_err().code,
        "invalid_raw_snapshot"
    );
}

/// A bad function attribute link is diagnosed against the instantiated function rather than guessed.
#[test]
fn function_attribute_links_are_validated_during_compilation() {
    let mut source = description();
    source.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0].channel_functions[0]
        .attribute = serde_json::from_value(serde_json::json!("Missing")).unwrap();
    let error = compile(source, ChannelLimits::default()).unwrap_err();
    assert_eq!(error.code, "invalid_attribute_link");
    assert!(error.message.contains("Missing"));
    assert!(error.path.starts_with("c/0/"));
}
