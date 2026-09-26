// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use nightfall::prelude::{
    Axis, BlueprintAddress, BlueprintResolution, GridSize, SelectionExpr, SpatialClause,
};
use nightfall_cmd_parse::generate_ast;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fx::ast_conv::FxAstConverter;
use nightfall_fx::events::{StepFxCommand, StepFxCommandValueSource};
use nightfall_fx::prelude::*;

/// Converts command text and returns every stored Step FX payload.
fn converted_step_fx(command: &str) -> Vec<StepFx> {
    let ast = generate_ast(command).expect("command should parse");
    FxAstConverter::convert(&ast)
        .expect("AST should convert")
        .into_iter()
        .map(|payload| {
            let command = payload
                .as_any()
                .downcast_ref::<StepFxCommand>()
                .expect("payload should be a StepFxCommand");
            let StepFxCommand::Store(step_fx) = command else {
                panic!("expected store command")
            };
            step_fx.clone()
        })
        .collect()
}

/// Returns the absolute track from one converted lane.
fn absolute_track(lane: &FxLane) -> &FxTrack {
    lane.absolute.as_ref().expect("absolute track should exist")
}

/// Returns the relative track from one converted lane.
fn relative_track(lane: &FxLane) -> &FxTrack {
    lane.relative.as_ref().expect("relative track should exist")
}

/// Verifies Blueprint targets retain their address and source-local resolution mode.
#[test]
fn blueprint_step_sources_use_stateful_create_command() {
    let ast = generate_ast(
        "store fx 7 step fix 1 5s red steps @ bp 1 @ blueprint \"High Red\" /absolute",
    )
    .expect("Blueprint-backed Step FX targets should parse");
    let commands = FxAstConverter::convert(&ast).expect("Blueprint targets should convert");
    let command = commands[0]
        .as_any()
        .downcast_ref::<StepFxCommand>()
        .expect("command should be a Step FX command");
    let StepFxCommand::Create(step_fx) = command else {
        panic!("command should create a Step FX draft");
    };

    assert!(matches!(
        &step_fx.sequences[0].steps[0].target,
        StepFxCommandValueSource::Blueprint {
            address: BlueprintAddress::Id(1),
            resolution: BlueprintResolution::Reference,
        }
    ));
    assert!(matches!(
        &step_fx.sequences[0].steps[1].target,
        StepFxCommandValueSource::Blueprint {
            address: BlueprintAddress::Label(label),
            resolution: BlueprintResolution::Absolute,
        } if label == "High Red"
    ));
}

/// Verifies long and short RGB aliases produce equivalent syntax.
#[test]
fn rgb_attribute_aliases_are_equivalent() {
    let short = generate_ast(
        "store fx 1 step fix 1 5s int steps 100 0 r steps 100 0 g steps 100 0 b steps 100 0",
    )
    .unwrap();
    let long = generate_ast(
        "store fx 1 step fix 1 5s int steps 100 0 red steps @100 0 g steps 100 0 b steps 100 0",
    )
    .unwrap();
    assert_eq!(short, long);
}

/// Verifies a basic command becomes one beat-native intensity lane.
#[test]
fn basic_step_fx_conversion_uses_canonical_lane_model() {
    let step_fx = converted_step_fx("store fx 1 step fix 1 5s int steps 100 0").remove(0);
    assert_eq!(step_fx.identifiers.id, 1);
    assert_eq!(step_fx.timing.beat_duration, Duration::from_secs(5));
    assert_eq!(step_fx.lanes.len(), 1);
    assert_eq!(step_fx.lanes[0].attribute, Attribute::Intensity);
    assert_eq!(absolute_track(&step_fx.lanes[0]).steps.len(), 2);
    assert_eq!(absolute_track(&step_fx.lanes[0]).authored_pass_beats(), 1.0);
}

/// Verifies ranged storage creates one independent definition per requested ID.
#[test]
fn step_fx_range_conversion_creates_each_id() {
    let effects = converted_step_fx("store fx 1>3 step fix 1 5s int steps 100 0");
    assert_eq!(
        effects
            .iter()
            .map(|fx| fx.identifiers.id)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
}

/// Verifies base-plus-relative command entry projects to separate tracks.
#[test]
fn relative_steps_with_base_create_absolute_and_relative_tracks() {
    let step_fx = converted_step_fx("store fx 1 step fix 1 5s int @ 50 steps ~25 ~-25").remove(0);
    let lane = &step_fx.lanes[0];
    assert_eq!(absolute_track(lane).steps.len(), 1);
    assert_eq!(relative_track(lane).steps.len(), 2);
    assert!(matches!(
        absolute_track(lane).steps[0].target,
        ParameterValue::AbsolutePercent { .. }
    ));
    assert!(
        relative_track(lane)
            .steps
            .iter()
            .all(|step| step.target.is_relative())
    );
}

/// Verifies unsigned attributes reject negative static bases during conversion.
#[test]
fn unsigned_negative_base_value_is_rejected() {
    let ast = generate_ast("store fx 1 step fix 1 5s int @ -50 steps ~25").unwrap();
    assert!(FxAstConverter::convert(&ast).is_err());
}

/// Verifies signed attributes retain negative static bases.
#[test]
fn signed_negative_base_value_is_allowed() {
    let step_fx = converted_step_fx("store fx 1 step fix 1 5s pan @ -50 steps ~25 ~-25").remove(0);
    let lane = &step_fx.lanes[0];
    assert_eq!(lane.attribute, Attribute::Pan);
    assert!(matches!(
        absolute_track(lane).steps[0].target,
        ParameterValue::AbsolutePercent { .. }
    ));
}

/// Verifies one command can create relative and absolute attribute lanes together.
#[test]
fn multi_attribute_relative_and_absolute_conversion() {
    let step_fx =
        converted_step_fx("store fx 5 step fix 311 5s int @ 50 steps ~25 ~-25 red steps @100")
            .remove(0);
    assert_eq!(step_fx.lanes.len(), 2);
    assert!(step_fx.lanes[0].absolute.is_some());
    assert!(step_fx.lanes[0].relative.is_some());
    assert!(step_fx.lanes[1].absolute.is_some());
    assert!(step_fx.lanes[1].relative.is_none());
}

/// Verifies seconds and BPM command input both produce duration-per-beat timing.
#[test]
fn duration_units_convert_to_duration_per_beat() {
    let seconds = converted_step_fx("store fx 1 step fix 1 5s int steps 100 0").remove(0);
    let bpm = converted_step_fx("store fx 1 step fix 1 120bpm int steps 100 0").remove(0);
    assert_eq!(seconds.timing.beat_duration, Duration::from_secs(5));
    assert_eq!(bpm.timing.beat_duration, Duration::from_millis(500));
}

/// Verifies authored width proportions and ramp percentages project correctly.
#[test]
fn width_and_ramp_conversion_uses_beat_native_fields() {
    let step_fx = converted_step_fx(
        "store fx 1 step fix 1 5s int steps 100 width 50 ramp 80 0 width 50 ramp 20",
    )
    .remove(0);
    let steps = &absolute_track(&step_fx.lanes[0]).steps;
    assert_eq!(steps[0].width_beats, 0.5);
    assert_eq!(steps[1].width_beats, 0.5);
    assert!(
        (steps[0].transition.end.as_f32() - 0.8).abs() < 0.001,
        "first ramp ended at {}",
        steps[0].transition.end.as_f32()
    );
    assert!(
        (steps[1].transition.end.as_f32() - 0.2).abs() < 0.001,
        "second ramp ended at {}",
        steps[1].transition.end.as_f32()
    );
    assert_eq!(steps[0].transition.start.as_f32(), 0.0);
    assert_eq!(steps[1].transition.start.as_f32(), 0.0);
}

/// Verifies transformed spatial selection syntax remains in the canonical definition.
#[test]
fn transformed_selection_conversion_is_preserved() {
    let step_fx = converted_step_fx(
        "store fx 1 step fix 1>10 | grid 4x2 | skip 1 | take 4 | mirror y 5s int steps 100 0",
    )
    .remove(0);
    assert!(matches!(
        step_fx.selection.source,
        SelectionExpr::FixtureRange { .. }
    ));
    assert_eq!(
        step_fx.selection.clauses,
        vec![
            SpatialClause::Grid(GridSize::WidthHeight { x: 4, y: 2 }),
            SpatialClause::Skip(1),
            SpatialClause::Take(4),
            SpatialClause::Mirror(Axis::Y),
        ]
    );
}
