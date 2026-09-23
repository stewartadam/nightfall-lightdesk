// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Integer boundary and function-selection tests independent of vendor defaults.

use gdtf::values::DmxValue;
use nightfall_fixture_library::gdtf_functions::{normalize_value, resolve_functions};
use nightfall_fixture_library::gdtf_resolver::{ResolveLimits, resolve_mode};

/// Parse a small fixture containing two independent fine tilt controls.
fn description() -> gdtf::Description {
    include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap()
}

/// Parse authored DMX literals through the dependency, then normalize separately.
fn literal(value: &str) -> DmxValue {
    serde_json::from_value(serde_json::Value::String(value.into())).unwrap()
}

/// Mirroring, zero-extension by shifting, and truncation retain their specified bytes.
#[test]
fn dmx_literals_have_independent_integer_expectations() {
    for (value, bytes, expected) in [
        ("255/1", 2, 0xffff),
        ("255/1s", 2, 0xff00),
        ("255/1", 4, 0xffff_ffff),
        ("255/1s", 4, 0xff00_0000),
        ("4660/2", 3, 0x12_34_12),
        ("4660/2", 4, 0x1234_1234),
        ("1193046/3", 4, 0x1234_5612),
        ("1193046/3s", 4, 0x1234_5600),
        ("305419896/4", 2, 0x1234),
        ("4294967295/4", 4, u32::MAX),
    ] {
        assert_eq!(
            normalize_value(literal(value), bytes).unwrap(),
            expected,
            "{value} at {bytes} bytes"
        );
    }
    assert_eq!(
        normalize_value(literal("256/1"), 2).unwrap_err().code,
        "invalid_dmx_value"
    );
    assert_eq!(
        normalize_value(literal("1/1"), 0).unwrap_err().code,
        "invalid_value_width"
    );
}

/// Function ranges use inclusive integer boundaries and InitialFunction chooses its own default.
#[test]
fn ranges_defaults_and_highlight_use_the_channel_resolution() {
    let mut description = description();
    let channel = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0];
    let first = &mut channel.logical_channels[0].channel_functions[0];
    first.name = Some(gdtf::values::Name::new("Low").unwrap());
    first.default = literal("64/1");
    first.physical_from = 90.0;
    first.physical_to = -90.0;
    let mut second = first.clone();
    second.name = Some(gdtf::values::Name::new("High").unwrap());
    second.dmx_from = literal("128/1s");
    second.default = literal("192/1");
    channel.logical_channels[0].channel_functions.push(second);
    channel.initial_function =
        Some(serde_json::from_value(serde_json::json!("Arm_Tilt.Tilt.High")).unwrap());
    channel.highlight = Some(literal("255/1"));
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    let channel = &channels[0];
    assert_eq!(channel.bytes, 2);
    assert_eq!(channel.initial_function, 1);
    assert_eq!(channel.default, 0xc0c0);
    assert_eq!(channel.highlight, Some(65535));
    assert_eq!(
        (channel.functions[0].raw_from, channel.functions[0].raw_to),
        (0, 32767)
    );
    assert_eq!(
        (channel.functions[1].raw_from, channel.functions[1].raw_to),
        (32768, 65535)
    );
    assert_eq!(
        (
            channel.functions[0].physical_from,
            channel.functions[0].physical_to
        ),
        (90.0, -90.0)
    );
    assert_eq!(channels[1].highlight, None);
}

/// Mutually exclusive logical channels can each span the entire raw range.
#[test]
fn overlapping_logical_channels_are_not_flattened() {
    let mut description = description();
    let channel = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0];
    let mut logical = channel.logical_channels[0].clone();
    logical.attribute = serde_json::from_value(serde_json::json!("OtherTilt")).unwrap();
    channel.logical_channels.push(logical);
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    assert_eq!(channels[0].functions.len(), 2);
    assert_eq!(channels[0].functions[0].raw_to, 65535);
    assert_eq!(channels[0].functions[1].raw_to, 65535);
    assert_ne!(channels[0].functions[0].id, channels[0].functions[1].id);
}

/// Empty functions, invalid ordering and unresolved initial links produce explicit errors.
#[test]
fn malformed_functions_are_not_replaced_by_a_linear_slider() {
    for scenario in 0..3 {
        let mut description = description();
        let channel = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0];
        let expected = match scenario {
            0 => {
                channel.logical_channels[0].channel_functions.clear();
                "missing_function"
            }
            1 => {
                let duplicate = channel.logical_channels[0].channel_functions[0].clone();
                channel.logical_channels[0]
                    .channel_functions
                    .push(duplicate);
                "invalid_function_order"
            }
            _ => {
                channel.initial_function = Some(
                    serde_json::from_value(serde_json::json!("Arm_Tilt.Tilt.Missing")).unwrap(),
                );
                "invalid_initial_function"
            }
        };
        let mode = resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default(),
        )
        .unwrap();
        assert_eq!(resolve_functions(&mode).unwrap_err().code, expected);
    }
}

/// Adjacent 32-bit boundaries above f32 precision remain distinguishable.
#[test]
fn full_resolution_ranges_do_not_round_through_floats() {
    let mut description = description();
    let channel = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0];
    channel.offset = Some(vec![1, 4, 7, 10]);
    let mut second = channel.logical_channels[0].channel_functions[0].clone();
    second.dmx_from = literal("16777217/4");
    second.default = literal("4294967295/4");
    channel.logical_channels[0].channel_functions.push(second);
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    assert_eq!(functions[0].functions[0].raw_to, 16_777_216);
    assert_eq!(functions[0].functions[1].raw_from, 16_777_217);
    assert_eq!(functions[0].functions[1].raw_to, u32::MAX);
    assert_eq!(functions[0].functions[1].default, u32::MAX);
}

/// Virtual precision follows declared values and retains independent reference-instance identities.
#[test]
fn virtual_functions_preserve_declared_precision() {
    let mut description = description();
    description.fixture_types[0].dmx_modes[0].dmx_channels[2].logical_channels[0]
        .channel_functions[0]
        .default = literal("65535/2");
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    assert_eq!(functions[2].bytes, 2);
    assert_eq!(functions[2].default, 65535);
    assert_eq!(functions[3].default, 65535);
    assert_ne!(functions[2].functions[0].id, functions[3].functions[0].id);
}

/// Invalid physical endpoints fail before they enter serialized compiler results.
#[test]
fn non_finite_physical_values_are_rejected() {
    let mut description = description();
    description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0]
        .physical_to = f64::NAN;
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    assert_eq!(
        resolve_functions(&mode).unwrap_err().code,
        "invalid_physical_range"
    );
}

/// Selector alternatives may restart the controlled range; equivalent selector literals share a group.
#[test]
fn conditional_functions_have_separate_ranges_at_the_master_precision() {
    let mut description = description();
    let channel = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0];
    channel.offset = Some(vec![1]);
    let template = channel.logical_channels[0].channel_functions[0].clone();
    channel.logical_channels[0].channel_functions = (0..4)
        .map(|index| {
            let mut function = template.clone();
            function.dmx_from = literal(if index % 2 == 0 { "0/1" } else { "255/1" });
            function.mode_master = Some(serde_json::from_value(serde_json::json!({
            "@ModeMaster": "Head_Tilt",
            "@ModeFrom": if index < 2 { if index == 0 { "0/1" } else { "0/2" } } else { "32768/2" },
            "@ModeTo": if index < 2 { "32767/2" } else { "65535/2" },
        })).unwrap());
            function
        })
        .collect();
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let ranges = &functions[0].functions;
    assert_eq!(
        ranges
            .iter()
            .map(|f| (f.raw_from, f.raw_to))
            .collect::<Vec<_>>(),
        [(0, 254), (255, 255), (0, 254), (255, 255)]
    );
    assert_eq!(ranges[0].condition, ranges[1].condition);
    assert_eq!(ranges[0].condition.as_ref().unwrap().raw_to, 32767);
    assert_eq!(ranges[2].condition.as_ref().unwrap().raw_from, 32768);
    assert_eq!(ranges[2].condition.as_ref().unwrap().source_channel, 1);
}

/// Function selectors resolve an exact source function and reject missing targets or reversed ranges.
#[test]
fn selector_links_are_validated_without_guessing_a_target() {
    for (link, from, to, expected) in [
        ("Head_Tilt.Tilt.Tilt", "0/2", "65535/2", None),
        ("Missing", "0/2", "65535/2", Some("invalid_mode_master")),
        (
            "Head_Tilt.Tilt.Missing",
            "0/2",
            "65535/2",
            Some("invalid_mode_master"),
        ),
        ("Head_Tilt", "100/2", "99/2", Some("invalid_mode_range")),
    ] {
        let mut description = description();
        description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
            .channel_functions[0]
            .mode_master = Some(
            serde_json::from_value(serde_json::json!({
                "@ModeMaster": link, "@ModeFrom": from, "@ModeTo": to,
            }))
            .unwrap(),
        );
        let mode = resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default(),
        )
        .unwrap();
        let result = resolve_functions(&mode);
        if let Some(code) = expected {
            assert_eq!(result.unwrap_err().code, code);
        } else {
            let functions = result.unwrap();
            let condition = functions[0].functions[0].condition.as_ref().unwrap();
            assert_eq!(condition.source_channel, 1);
            assert_eq!(condition.source_function, Some((0, 0)));
            assert_eq!(condition.raw_to, 65535);
        }
    }
}
