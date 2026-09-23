// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Independent channel-set boundaries, physical override and wheel-slot expectations.

use nightfall_fixture_library::gdtf_functions::resolve_functions;
use nightfall_fixture_library::gdtf_resolver::{ResolveLimits, resolve_mode};
use nightfall_fixture_library::gdtf_sets::resolve_sets;

/// Author sets through parser literals so byte mirroring and one-based slots are exercised.
fn description() -> gdtf::Description {
    let mut description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0]
        .channel_functions[0]
        .channel_sets = serde_json::from_value(serde_json::json!([
        {"@Name":"Low","@DMXFrom":"1/1","@PhysicalFrom":90,"@PhysicalTo":-90,"@WheelSlotIndex":1},
        {"@Name":"Inherited","@DMXFrom":"128/1","@WheelSlotIndex":2},
        {"@Name":"Stop","@DMXFrom":"255/1","@PhysicalFrom":0,"@PhysicalTo":0}
    ]))
    .unwrap();
    description
}

/// Sets preserve exact byte boundaries, optional endpoints and already normalized slot indices.
#[test]
fn set_boundaries_and_overrides_are_preserved() {
    let description = description();
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    let sets = resolve_sets(&channels, 3).unwrap();
    let function = &sets[0][0];
    assert!(function.at(256).is_none());
    assert_eq!(
        (function.sets[0].raw_from, function.sets[0].raw_to),
        (257, 32895)
    );
    assert_eq!(
        (function.sets[1].raw_from, function.sets[1].raw_to),
        (32896, 65534)
    );
    assert_eq!(
        (function.sets[2].raw_from, function.sets[2].raw_to),
        (65535, 65535)
    );
    assert_eq!(
        function.at(32896).unwrap().name.as_deref(),
        Some("Inherited")
    );
    assert!(function.at(65536).is_none());
    assert_eq!(
        (function.sets[0].physical_from, function.sets[0].physical_to),
        (Some(90.0), Some(-90.0))
    );
    assert_eq!(function.sets[1].physical_from, None);
    assert_eq!((function.physical_from, function.physical_to), (0.0, 180.0));
    assert_eq!(function.sets[0].wheel_slot, Some(0));
    assert_eq!(function.sets[1].wheel_slot, Some(1));
    assert_eq!(function.sets[2].wheel_slot, None);
    assert_eq!(resolve_sets(&channels, 2).unwrap_err().code, "set_limit");
}

/// Duplicate starts and nonfinite overrides must not become plausible discrete choices.
#[test]
fn invalid_sets_are_diagnosed() {
    for kind in ["order", "physical", "slot"] {
        let mut description = description();
        let sets = &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels
            [0]
        .channel_functions[0]
            .channel_sets;
        let expected = match kind {
            "order" => {
                sets[1].dmx_from = sets[0].dmx_from;
                "invalid_set_order"
            }
            "physical" => {
                sets[0].physical_from = Some(f64::NAN);
                "invalid_set_physical"
            }
            _ => {
                sets[0].wheel_slot_index = Some(-1);
                "invalid_wheel_slot"
            }
        };
        let mode = resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default(),
        )
        .unwrap();
        let channels = resolve_functions(&mode).unwrap();
        assert_eq!(resolve_sets(&channels, 100).unwrap_err().code, expected);
    }
}

/// A channel set cannot extend across its parent function boundary into the next function.
#[test]
fn sets_must_fit_the_parent_function() {
    let mut description = description();
    let logical =
        &mut description.fixture_types[0].dmx_modes[0].dmx_channels[0].logical_channels[0];
    let mut next = logical.channel_functions[0].clone();
    next.channel_sets.clear();
    next.dmx_from = serde_json::from_value(serde_json::json!("128/1")).unwrap();
    logical.channel_functions.push(next);
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let channels = resolve_functions(&mode).unwrap();
    assert_eq!(
        resolve_sets(&channels, 100).unwrap_err().code,
        "invalid_set_range"
    );
}
