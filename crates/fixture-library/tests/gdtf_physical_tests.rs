// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Physical conversion tests with independent signed ranges, curves and inverse expectations.

use nightfall_fixture_library::gdtf_functions::resolve_functions;
use nightfall_fixture_library::gdtf_physical::compile_physical;
use nightfall_fixture_library::gdtf_profiles::compile_profiles;
use nightfall_fixture_library::gdtf_resolver::{ResolveLimits, resolve_mode};

/// Load a small mode whose first channel is a sixteen-bit tilt.
fn description() -> gdtf::Description {
    include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap()
}

/// Descending physical ranges preserve direction and exact 32-bit raw endpoints.
#[test]
fn linear_mapping_round_trips_full_resolution() {
    let mut description = description();
    let channel = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0];
    channel.offset = Some(vec![1, 2, 3, 4]);
    channel.logical_channels[0].channel_functions[0].physical_from = 270.0;
    channel.logical_channels[0].channel_functions[0].physical_to = -270.0;
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    let physical =
        compile_physical(&channels, compile_profiles(&[], 0).unwrap(), 100, 100).unwrap();
    assert_eq!(physical.evaluate_function(0, 0, 0).unwrap(), 270.0);
    assert_eq!(physical.evaluate_function(0, 0, u32::MAX).unwrap(), -270.0);
    for raw in [0, 1, 65535, 0x8000_0000, u32::MAX - 1, u32::MAX] {
        let value = physical.evaluate_function(0, 0, raw).unwrap();
        assert_eq!(physical.encode_linear(0, 0, value).unwrap(), raw);
    }
    assert_eq!(physical.encode_linear(0, 0, 0.0).unwrap(), 0x8000_0000);
    assert_eq!(
        physical.encode_linear(0, 0, 271.0).unwrap_err().code,
        "physical_outside_function"
    );
}

/// Curves use Min/Max instead of the linear endpoints and do not invent an inverse.
#[test]
fn curve_scales_into_explicit_physical_limits() {
    let mut description = description();
    let source = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0];
    source.dmx_profile = Some(serde_json::from_value(serde_json::json!("Squared")).unwrap());
    source.min = Some(-10.0);
    source.max = Some(30.0);
    let profiles: Vec<gdtf::physical_descriptions::DmxProfile> = serde_json::from_value(
        serde_json::json!([{"@Name":"Squared","Point":[{"@DMXPercentage":0,"@CFC2":100}]}]),
    )
    .unwrap();
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    let physical =
        compile_physical(&channels, compile_profiles(&profiles, 1).unwrap(), 100, 100).unwrap();
    assert_eq!(physical.evaluate_function(0, 0, 0).unwrap(), -10.0);
    assert_eq!(physical.evaluate_function(0, 0, 65535).unwrap(), 30.0);
    // 21845 is exactly one third of 65535; the squared profile yields one ninth.
    assert!((physical.evaluate_function(0, 0, 21845).unwrap() - (-50.0 / 9.0)).abs() < 1e-12);
    assert_eq!(
        physical.encode_linear(0, 0, 0.0).unwrap_err().code,
        "profile_inverse_unavailable"
    );
    assert_eq!(
        physical.evaluate_function(0, 0, 65536).unwrap_err().code,
        "raw_outside_function"
    );
}

/// Missing curve references and malformed endpoints fail compilation rather than becoming linear controls.
#[test]
fn malformed_mapping_and_budget_are_rejected() {
    let mut description = description();
    description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0]
        .dmx_profile = Some(serde_json::from_value(serde_json::json!("Missing")).unwrap());
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    assert_eq!(
        compile_physical(&channels, compile_profiles(&[], 0).unwrap(), 100, 100)
            .unwrap_err()
            .code,
        "missing_profile"
    );
    assert_eq!(
        compile_physical(&channels, compile_profiles(&[], 0).unwrap(), 0, 100)
            .unwrap_err()
            .code,
        "function_limit"
    );
}

/// A constant function must not silently choose an arbitrary raw command for an inverse request.
#[test]
fn constant_mapping_reports_ambiguity() {
    let mut description = description();
    description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0]
        .physical_to = 0.0;
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    let physical =
        compile_physical(&channels, compile_profiles(&[], 0).unwrap(), 100, 100).unwrap();
    assert_eq!(physical.evaluate_function(0, 0, 42000).unwrap(), 0.0);
    assert_eq!(
        physical.encode_linear(0, 0, 0.0).unwrap_err().code,
        "ambiguous_physical_inverse"
    );
    assert_eq!(
        physical.evaluate_function(999, 0, 0).unwrap_err().code,
        "missing_physical_mapping"
    );
}

/// Single-slot functions have only one representable physical value, and overflowing spans are invalid.
#[test]
fn degenerate_raw_intervals_and_extreme_spans_are_explicit() {
    let description = description();
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let mut channels = resolve_functions(&mode).unwrap();
    channels[0].functions[0].raw_from = 42;
    channels[0].functions[0].raw_to = 42;
    let physical =
        compile_physical(&channels, compile_profiles(&[], 0).unwrap(), 100, 100).unwrap();
    assert_eq!(physical.evaluate_function(0, 0, 42).unwrap(), 0.0);
    assert_eq!(physical.encode_linear(0, 0, 0.0).unwrap(), 42);
    assert_eq!(
        physical.encode_linear(0, 0, 90.0).unwrap_err().code,
        "unrepresentable_physical_value"
    );
    channels[0].functions[0].physical_from = -f64::MAX;
    channels[0].functions[0].physical_to = f64::MAX;
    assert_eq!(
        compile_physical(&channels, compile_profiles(&[], 0).unwrap(), 100, 100)
            .unwrap_err()
            .code,
        "invalid_physical_mapping"
    );
}

/// Labels retain the parent ramp while explicit and partially inherited endpoints use set-local ranges.
#[test]
fn channel_set_overrides_do_not_restart_inherited_ranges() {
    let mut description = description();
    let channel = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0];
    channel.offset = Some(vec![1]);
    let function = &mut channel.logical_channels[0].channel_functions[0];
    function.physical_to = 255.0;
    function.channel_sets = serde_json::from_value(serde_json::json!([
        {"@Name":"Label","@DMXFrom":"10/1"},
        {"@Name":"Reverse","@DMXFrom":"100/1","@PhysicalFrom":90,"@PhysicalTo":-90},
        {"@Name":"Partial","@DMXFrom":"200/1","@PhysicalFrom":300},
        {"@Name":"Stop","@DMXFrom":"255/1","@PhysicalFrom":0,"@PhysicalTo":0}
    ]))
    .unwrap();
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    let physical =
        compile_physical(&channels, compile_profiles(&[], 0).unwrap(), 100, 100).unwrap();
    for (raw, expected) in [
        (0, 0.0),
        (10, 10.0),
        (99, 99.0),
        (100, 90.0),
        (199, -90.0),
        (200, 300.0),
        (254, 255.0),
        (255, 0.0),
    ] {
        assert_eq!(physical.evaluate(0, 0, raw).unwrap(), expected);
    }
    assert_eq!(physical.evaluate_function(0, 0, 100).unwrap(), 100.0);
    assert_eq!(
        physical.encode_linear(0, 0, 100.0).unwrap_err().code,
        "set_inverse_unavailable"
    );
    assert_eq!(
        compile_physical(&channels, compile_profiles(&[], 0).unwrap(), 100, 3)
            .unwrap_err()
            .code,
        "set_limit"
    );
}

/// Inherited sets preserve curve shape; explicit overrides on a curve are diagnosed pending composition support.
#[test]
fn curves_and_overrides_do_not_silently_double_apply() {
    let mut description = description();
    let source = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0];
    source.dmx_profile = Some(serde_json::from_value(serde_json::json!("Squared")).unwrap());
    source.physical_to = 100.0;
    source.channel_sets = serde_json::from_value(serde_json::json!([
        {"@DMXFrom":"0/1"},
        {"@DMXFrom":"128/1","@PhysicalFrom":10,"@PhysicalTo":20}
    ]))
    .unwrap();
    let profiles: Vec<gdtf::physical_descriptions::DmxProfile> =
        serde_json::from_value(serde_json::json!([
            {"@Name":"Squared","Point":[{"@DMXPercentage":0,"@CFC2":100}]}
        ]))
        .unwrap();
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    let physical =
        compile_physical(&channels, compile_profiles(&profiles, 1).unwrap(), 100, 100).unwrap();
    assert!((physical.evaluate(0, 0, 21845).unwrap() - 100.0 / 9.0).abs() < 1e-12);
    assert_eq!(
        physical.evaluate(0, 0, 65535).unwrap_err().code,
        "profile_set_composition_unavailable"
    );
}
