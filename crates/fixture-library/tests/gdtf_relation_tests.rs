// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Independent relation targets for local virtual masters and shared physical controls.

use gdtf::dmx_mode::RelationType;
use nightfall_fixture_library::gdtf_functions::resolve_functions;
use nightfall_fixture_library::gdtf_relations::{plan_relations, resolve_relations};
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

/// Chained virtual relationships have a deterministic order with shared masters before local followers.
#[test]
fn relationship_plan_orders_chains_without_dropping_independent_channels() {
    let mut description = description(
        "Pixel_Dimmer",
        "Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R",
        "Multiply",
    );
    description.fixture_types[0].dmx_modes[0].relations.push(
        serde_json::from_value(serde_json::json!({
            "@Master":"Arm_Tilt","@Follower":"Pixel_Dimmer.Dimmer.Dimmer","@Type":"Multiply"
        }))
        .unwrap(),
    );
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let plan = plan_relations(
        &functions,
        resolve_relations(&mode, &functions, 100).unwrap(),
    )
    .unwrap();
    let order = plan.channel_order();
    assert_eq!(order.len(), functions.len());
    let position = |channel| order.iter().position(|c| *c == channel).unwrap();
    assert!(position(0) < position(2) && position(2) < position(4));
    assert!(position(0) < position(3) && position(3) < position(5));
    assert_eq!(plan.incoming(4), Some([0].as_slice()));
    assert_eq!(plan.relations()[plan.incoming(2).unwrap()[0]].master, 0);
    assert_eq!(plan.incoming(1), Some([].as_slice()));
    assert_eq!(plan.incoming(999), None);
    let mut values = vec![1.0; functions.len()];
    values[0] = 0.5;
    values[2] = 0.5;
    values[3] = 0.25;
    values[4] = 0.8;
    values[5] = 0.8;
    let mut active = vec![vec![0]; functions.len()];
    let evaluated = plan.evaluate_normalized(&values, &active).unwrap();
    assert_eq!(
        (
            evaluated.output[2],
            evaluated.output[4],
            evaluated.output[5]
        ),
        (0.5, 0.4, 0.2)
    );
    assert_eq!(
        (
            evaluated.visual[2],
            evaluated.visual[4],
            evaluated.visual[5]
        ),
        (0.25, 0.2, 0.1)
    );
    assert_eq!(values[4], 0.8);
    active[5].clear();
    let evaluated = plan.evaluate_normalized(&values, &active).unwrap();
    assert_eq!((evaluated.output[5], evaluated.visual[5]), (0.8, 0.8));
}

/// Reciprocal and self-dependent relations cannot be evaluated by repeatedly applying incoming masters.
#[test]
fn relationship_cycles_and_invalid_edges_are_rejected() {
    let mut description = description(
        "Pixel_Dimmer",
        "Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R",
        "Multiply",
    );
    description.fixture_types[0].dmx_modes[0].relations.push(
        serde_json::from_value(serde_json::json!({
            "@Master":"Pixel_ColorAdd_R","@Follower":"Pixel_Dimmer.Dimmer.Dimmer","@Type":"Multiply"
        }))
        .unwrap(),
    );
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let bindings = resolve_relations(&mode, &functions, 100).unwrap();
    assert_eq!(
        plan_relations(&functions, bindings).unwrap_err().code,
        "relation_dependency_cycle"
    );
    let mut bindings = resolve_relations(&mode, &functions, 100).unwrap();
    bindings.truncate(1);
    bindings[0].master = bindings[0].follower;
    assert_eq!(
        plan_relations(&functions, bindings).unwrap_err().code,
        "relation_dependency_cycle"
    );
    let mut bindings = resolve_relations(&mode, &functions, 100).unwrap();
    bindings[0].function = usize::MAX;
    assert_eq!(
        plan_relations(&functions, bindings).unwrap_err().code,
        "invalid_relation_binding"
    );
}

/// A sole override copies its master; physical masters affect simulation without being baked into output.
#[test]
fn overrides_and_snapshot_validation_are_explicit() {
    for (master, virtual_master) in [("Arm_Tilt", false), ("Pixel_Dimmer", true)] {
        let description = description(master, "Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R", "Override");
        let mode = resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default(),
        )
        .unwrap();
        let functions = resolve_functions(&mode).unwrap();
        let plan = plan_relations(
            &functions,
            resolve_relations(&mode, &functions, 100).unwrap(),
        )
        .unwrap();
        let mut values = vec![0.8; functions.len()];
        values[0] = 0.25;
        values[2] = 0.25;
        values[3] = 0.5;
        let active = vec![vec![0]; functions.len()];
        let evaluated = plan.evaluate_normalized(&values, &active).unwrap();
        assert_eq!(evaluated.visual[4], 0.25);
        assert_eq!(evaluated.output[4], if virtual_master { 0.25 } else { 0.8 });
        assert_eq!(
            plan.evaluate_normalized(&[], &active).unwrap_err().code,
            "invalid_relation_snapshot"
        );
        values[0] = f64::NAN;
        assert_eq!(
            plan.evaluate_normalized(&values, &active).unwrap_err().code,
            "invalid_relation_snapshot"
        );
    }
}

/// Competing override operations fail instead of changing meaning when relation order changes.
#[test]
fn competing_override_is_not_resolved_by_last_writer() {
    let mut description = description(
        "Pixel_Dimmer",
        "Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R",
        "Multiply",
    );
    description.fixture_types[0].dmx_modes[0].relations.push(serde_json::from_value(serde_json::json!({
        "@Master":"Arm_Tilt","@Follower":"Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R","@Type":"Override"
    })).unwrap());
    for reversed in [false, true] {
        if reversed {
            description.fixture_types[0].dmx_modes[0]
                .relations
                .reverse();
        }
        let mode = resolve_mode(
            &description.fixture_types[0],
            "Nested sparse",
            ResolveLimits::default(),
        )
        .unwrap();
        let functions = resolve_functions(&mode).unwrap();
        let plan = plan_relations(
            &functions,
            resolve_relations(&mode, &functions, 100).unwrap(),
        )
        .unwrap();
        let values = vec![0.5; functions.len()];
        let mut active = vec![vec![0]; functions.len()];
        assert_eq!(
            plan.evaluate_normalized(&values, &active).unwrap_err().code,
            "ambiguous_relation_override"
        );
        active[4].clear();
        active[5].clear();
        assert_eq!(
            plan.evaluate_normalized(&values, &active).unwrap().visual,
            values
        );
    }
}

/// Distinct active logical functions on a shared channel must not receive one silently combined value.
#[test]
fn active_follower_functions_are_checked_before_combining_values() {
    let mut description = description(
        "Pixel_Dimmer",
        "Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R",
        "Multiply",
    );
    let source = &mut description.fixture_types[0].dmx_modes[0];
    let logical = source.dmx_channels[4].logical_channels[0].clone();
    source.dmx_channels[3].logical_channels.push(logical);
    source.relations.push(serde_json::from_value(serde_json::json!({
        "@Master":"Arm_Tilt","@Follower":"Pixel_ColorAdd_R.ColorAdd_G.ColorAdd_G","@Type":"Multiply"
    })).unwrap());
    let mode = resolve_mode(
        &description.fixture_types[0],
        "Nested sparse",
        ResolveLimits::default(),
    )
    .unwrap();
    let functions = resolve_functions(&mode).unwrap();
    let plan = plan_relations(
        &functions,
        resolve_relations(&mode, &functions, 100).unwrap(),
    )
    .unwrap();
    let values = vec![0.5; functions.len()];
    let mut active = vec![vec![0]; functions.len()];
    active[4] = vec![0, 1];
    assert_eq!(
        plan.evaluate_normalized(&values, &active).unwrap_err().code,
        "ambiguous_relation_functions"
    );
    active[4] = vec![1];
    let evaluated = plan.evaluate_normalized(&values, &active).unwrap();
    assert_eq!((evaluated.output[4], evaluated.visual[4]), (0.5, 0.25));
    assert_eq!((evaluated.output[5], evaluated.visual[5]), (0.25, 0.25));
    active[4] = vec![2];
    assert_eq!(
        plan.evaluate_normalized(&values, &active).unwrap_err().code,
        "invalid_relation_snapshot"
    );
}
