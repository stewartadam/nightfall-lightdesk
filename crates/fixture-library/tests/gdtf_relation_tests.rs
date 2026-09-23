// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Independent relation targets for local virtual masters and shared physical controls.

use gdtf::dmx_mode::RelationType;
use nightfall_fixture_library::gdtf_functions::resolve_functions;
use nightfall_fixture_library::gdtf_relations::resolve_relations;
use nightfall_fixture_library::gdtf_resolver::{ResolveLimits, resolve_mode};

/// Attach one authored relation before repeated geometry expansion.
fn description(master: &str, follower: &str, operation: &str) -> gdtf::Description {
    let mut description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    description.fixture_types[0].dmx_modes[0].relations =
        serde_json::from_value(serde_json::json!([
            {"@Name":"Master","@Master":master,"@Follower":follower,"@Type":operation}
        ]))
        .unwrap();
    description
}

/// Each red pixel gets its own virtual dimmer instead of a fixture-wide first match.
#[test]
fn virtual_relations_bind_each_repeated_pixel() {
    let description = description(
        "Pixel_Dimmer",
        "Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R",
        "Multiply",
    );
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let relations = resolve_relations(&mode, &functions, 2).unwrap();
    assert_eq!(relations.len(), 2);
    for (relation, (master, follower)) in relations.iter().zip([(2, 4), (3, 5)]) {
        assert_eq!(
            (relation.master, relation.follower, relation.function),
            (master, follower, 0)
        );
        assert_eq!(relation.operation, RelationType::Multiply);
        assert!(relation.master_virtual);
        assert!(!relation.follower_virtual);
    }
    assert_ne!(relations[0].id, relations[1].id);
    assert_eq!(
        resolve_relations(&mode, &functions, 1).unwrap_err().code,
        "relation_limit"
    );
}

/// Shared physical masters and override operations remain distinguishable from virtual multiplication.
#[test]
fn shared_physical_override_is_preserved() {
    let description = description("Arm_Tilt", "Pixel_Dimmer.Dimmer.Dimmer", "Override");
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let relations = resolve_relations(&mode, &functions, 2).unwrap();
    for (relation, follower) in relations.iter().zip([2, 3]) {
        assert_eq!((relation.master, relation.follower), (0, follower));
        assert_eq!(relation.operation, RelationType::Override);
        assert!(!relation.master_virtual);
        assert!(relation.follower_virtual);
    }
}

/// Malformed or ambiguous links never silently choose a sibling or missing function.
#[test]
fn malformed_and_ambiguous_relations_fail() {
    for (master, follower, expected) in [
        (
            "Pixel_Dimmer",
            "Arm_Tilt.Tilt.Tilt",
            "ambiguous_relation_instance",
        ),
        ("Missing", "Arm_Tilt.Tilt.Tilt", "invalid_source_link"),
        ("Arm_Tilt", "Pixel_Dimmer", "invalid_relation_link"),
        (
            "Arm_Tilt.Tilt.Tilt",
            "Pixel_Dimmer.Dimmer.Dimmer",
            "invalid_relation_link",
        ),
        (
            "Arm_Tilt",
            "Pixel_Dimmer.Dimmer.Missing",
            "invalid_source_link",
        ),
    ] {
        let description = description(master, follower, "Multiply");
        let mode = resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default(),
        )
        .unwrap();
        let functions = resolve_functions(&mode).unwrap();
        assert_eq!(
            resolve_relations(&mode, &functions, 100).unwrap_err().code,
            expected
        );
    }
}

/// Duplicate relations must not square a dimmer merely because the same edge appears twice.
#[test]
fn duplicate_relations_and_mismatched_passes_are_rejected() {
    let mut description = description(
        "Pixel_Dimmer",
        "Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R",
        "Multiply",
    );
    let source = &mut description.fixture_types[0].dmx_modes[0].relations;
    source.push(source[0].clone());
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let mut functions = resolve_functions(&mode).unwrap();
    assert_eq!(
        resolve_relations(&mode, &functions, 100).unwrap_err().code,
        "duplicate_relation"
    );
    functions.swap(0, 1);
    assert_eq!(
        resolve_relations(&mode, &functions, 100).unwrap_err().code,
        "mismatched_functions"
    );
}
