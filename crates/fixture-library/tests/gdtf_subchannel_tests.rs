// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Function-specific auxiliary physical behavior over independently checked raw intervals.

use gdtf::attribute::{PhysicalUnit, SubPhysicalUnit, SubPhysicalUnitType};
use nightfall_fixture_library::gdtf_channels::{ChannelLimits, CompiledChannels, compile_channels};
use nightfall_fixture_library::gdtf_resolver::{ResolveError, ResolveLimits, resolve_mode};

/// Declare two auxiliary quantities so explicit overrides can be distinguished from inherited defaults.
fn description() -> gdtf::Description {
    let mut source: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    source.fixture_types[0].attribute_definitions.attributes[0].subphysical_units = vec![
        SubPhysicalUnit {
            type_: SubPhysicalUnitType::Duration,
            physical_unit: PhysicalUnit::Time,
            physical_from: 0.1,
            physical_to: 0.5,
        },
        SubPhysicalUnit {
            type_: SubPhysicalUnitType::Value,
            physical_unit: PhysicalUnit::Angle,
            physical_from: 10.0,
            physical_to: -10.0,
        },
    ];
    source
}

/// Drop all parser data before returning a usable channel program.
fn compile(source: gdtf::Description, limit: usize) -> Result<CompiledChannels, ResolveError> {
    let fixture = &source.fixture_types[0];
    let mode = resolve_mode(fixture, "Nested sparse", ResolveLimits::default())?;
    compile_channels(
        &mode,
        &fixture.attribute_definitions,
        &fixture.physical_descriptions.dmx_profiles,
        ChannelLimits {
            subchannels: limit,
            ..ChannelLimits::default()
        },
    )
}

/// Attach a function-specific range without changing the sibling joint's shared attribute declaration.
fn set_override(source: &mut gdtf::Description, link: &str, profile: Option<&str>) {
    source.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0].channel_functions[0]
        .sub_channel_sets = serde_json::from_value(serde_json::json!([{
        "@Name": "Timed movement", "@PhysicalFrom": 2.0, "@PhysicalTo": 6.0,
        "@SubPhysicalUnit": link, "@DMXProfile": profile,
    }]))
    .unwrap();
}

/// Overridden and default auxiliary values are independent of the main physical value and sibling joints.
#[test]
fn function_overrides_preserve_other_units_and_siblings() {
    let mut source = description();
    set_override(&mut source, "Tilt.Duration", None);
    let program = compile(source, 4).unwrap();
    let mappings = program.physical().auxiliary(0, 0).unwrap();
    assert_eq!(mappings.len(), 2);
    assert_eq!(mappings[0].name.as_deref(), Some("Timed movement"));
    assert_eq!(mappings[0].unit, PhysicalUnit::Time);
    assert!(mappings[0].explicit);
    assert!(!mappings[1].explicit);
    assert!(!program.physical().auxiliary(1, 0).unwrap()[0].explicit);
    let mut raw = program.defaults();
    raw[0] = 65535;
    raw[1] = 65535;
    let values = program.evaluate_physical(&raw).unwrap();
    assert_eq!(values[0][0].value, 180.0);
    assert_eq!(values[0][0].auxiliary, [6.0, -10.0]);
    assert_eq!(values[1][0].auxiliary, [0.5, -10.0]);
    assert_eq!(
        program.physical().evaluate_auxiliary(0, 0, 0, 0).unwrap(),
        2.0
    );
}

/// Auxiliary curves use their own profile and the parent's function interval, not the whole channel.
#[test]
fn auxiliary_profile_scales_with_its_own_endpoints() {
    let mut source = description();
    set_override(&mut source, "Tilt.Duration", Some("Squared"));
    source.fixture_types[0].physical_descriptions.dmx_profiles = serde_json::from_value(serde_json::json!([
        { "@Name": "Squared", "Point": [{ "@DMXPercentage": 0.0, "@CFC0": 0.0, "@CFC1": 0.0, "@CFC2": 100.0, "@CFC3": 0.0 }] }
    ])).unwrap();
    let function = &mut source.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0];
    function.dmx_from = serde_json::from_value(serde_json::json!("255/2")).unwrap();
    let program = compile(source, 4).unwrap();
    // Interval 255..65535 has an exact midpoint at 32895; x^2 maps 0.5 to 25%.
    assert_eq!(
        program
            .physical()
            .evaluate_auxiliary(0, 0, 0, 32895)
            .unwrap(),
        3.0
    );
    assert_eq!(
        program.physical().evaluate_auxiliary(0, 0, 0, 255).unwrap(),
        2.0
    );
    assert_eq!(
        program
            .physical()
            .evaluate_auxiliary(0, 0, 0, 65535)
            .unwrap(),
        6.0
    );
    assert_eq!(
        program
            .physical()
            .evaluate_auxiliary(0, 0, 0, 254)
            .unwrap_err()
            .code,
        "raw_outside_function"
    );
}

/// Malformed or conflicting subchannel links cannot silently use another unit or a linear fallback.
#[test]
fn invalid_subchannels_fail_compilation() {
    for link in [
        "Tilt",
        "Missing.Duration",
        "Tilt.Missing",
        "Tilt.Duration.Extra",
    ] {
        let mut source = description();
        set_override(&mut source, link, None);
        assert_eq!(
            compile(source, 4).unwrap_err().code,
            "invalid_subphysical_link"
        );
    }
    let mut source = description();
    set_override(&mut source, "Tilt.Duration", Some("Missing"));
    assert_eq!(compile(source, 4).unwrap_err().code, "missing_profile");
    let mut source = description();
    set_override(&mut source, "Tilt.Duration", None);
    let sets = &mut source.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0]
        .sub_channel_sets;
    sets.push(sets[0].clone());
    assert_eq!(compile(source, 4).unwrap_err().code, "duplicate_subchannel");
    let mut source = description();
    set_override(&mut source, "Tilt.Duration", None);
    source.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0].channel_functions[0]
        .sub_channel_sets[0]
        .physical_to = f64::INFINITY;
    assert_eq!(
        compile(source, 4).unwrap_err().code,
        "invalid_subchannel_range"
    );
    assert_eq!(
        compile(description(), 3).unwrap_err().code,
        "subchannel_limit"
    );
}

/// Constant and single-value intervals evaluate deterministically; invalid runtime indices return errors.
#[test]
fn degenerate_ranges_and_bad_indices_are_explicit() {
    let mut source = description();
    set_override(&mut source, "Tilt.Duration", None);
    let function = &mut source.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0];
    function.dmx_from = serde_json::from_value(serde_json::json!("65535/2")).unwrap();
    function.sub_channel_sets[0].physical_to = 2.0;
    let program = compile(source, 4).unwrap();
    assert_eq!(
        program
            .physical()
            .evaluate_auxiliary(0, 0, 0, 65535)
            .unwrap(),
        2.0
    );
    assert_eq!(
        program
            .physical()
            .evaluate_auxiliary(0, 0, 1, 65535)
            .unwrap(),
        10.0
    );
    assert_eq!(
        program
            .physical()
            .evaluate_auxiliary(0, 0, 2, 65535)
            .unwrap_err()
            .code,
        "invalid_auxiliary_index"
    );
    assert_eq!(
        program.physical().auxiliary(100, 0).unwrap_err().code,
        "invalid_physical_function"
    );
}
