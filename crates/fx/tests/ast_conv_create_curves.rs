// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_fx::ast_conv::FxAstConverter;
use nightfall_fx::events::StepFxCommand;
use nightfall_fx::prelude::*;

/// Converts one named command curve and returns its canonical Bézier controls.
fn converted_named_bezier(name: &str) -> Bezier {
    let command = format!("store fx 1 step fix 1 5s int steps 100 {name}");
    let ast = generate_ast(&command).expect("named curve command should parse");
    let commands = FxAstConverter::convert(&ast).expect("named curve command should convert");
    let command = commands[0]
        .as_any()
        .downcast_ref::<StepFxCommand>()
        .expect("converted command should be Step FX");
    let StepFxCommand::Store(step_fx) = command else {
        panic!("converted command should store Step FX");
    };
    let curve = &step_fx.lanes[0].absolute.as_ref().unwrap().steps[0].curve;
    let CurveType::Bezier(bezier) = curve else {
        panic!("named ease should produce a Bézier curve");
    };
    bezier.clone()
}

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

// No curve aliases currently

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_step_with_linear_curve_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 5s int steps 100 linear")
        .expect("Failed to parse 'store fx 1 step fix 1 5s int steps 100 linear'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");
            assert_eq!(step_fx.lanes.len(), 1, "Expected 1 attribute sequence");
            assert_eq!(
                step_fx.lanes[0].absolute.as_ref().unwrap().steps.len(),
                1,
                "Expected 1 step"
            );

            // Validate curve type is Linear
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[0].curve {
                CurveType::Linear(_) => {
                    // Success - correct curve type
                }
                other => panic!("Expected Linear curve, got {:?}", other),
            }
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

#[test]
fn test_step_with_ease_curve_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 5s int steps 100 ease")
        .expect("Failed to parse 'store fx 1 step fix 1 5s int steps 100 ease'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");

            // Validate curve type is Bezier with EASE preset control points
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[0].curve {
                CurveType::Bezier(bezier) => {
                    // EASE preset: cp1=(0.42, 0.0), cp2=(0.58, 1.0)
                    assert!((bezier.cp1.x - 0.42).abs() < 0.01, "Expected cp1.x ≈ 0.42");
                    assert!((bezier.cp1.y - 0.0).abs() < 0.01, "Expected cp1.y ≈ 0.0");
                    assert!((bezier.cp2.x - 0.58).abs() < 0.01, "Expected cp2.x ≈ 0.58");
                    assert!((bezier.cp2.y - 1.0).abs() < 0.01, "Expected cp2.y ≈ 1.0");
                }
                other => panic!("Expected Bezier curve, got {:?}", other),
            }
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

/// Verifies command aliases retain their distinct named Bézier presets.
#[test]
fn named_ease_curves_preserve_distinct_presets() {
    assert_eq!(converted_named_bezier("ease"), Bezier::EASE);
    assert_eq!(converted_named_bezier("easein"), Bezier::EASE_IN);
    assert_eq!(converted_named_bezier("easeout"), Bezier::EASE_OUT);
}

#[test]
fn test_step_with_snap_curve_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 5s int steps 100 snap")
        .expect("Failed to parse 'store fx 1 step fix 1 5s int steps 100 snap'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");

            // Validate curve type is Snap
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[0].curve {
                CurveType::Snap(_) => {
                    // Success - correct curve type
                }
                other => panic!("Expected Snap curve, got {:?}", other),
            }
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

#[test]
fn test_step_with_bezier_curve_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 5s int steps 100 bezier(0.42,0,0.58,1)")
        .expect("Failed to parse 'store fx 1 step fix 1 5s int steps 100 bezier(0.42,0,0.58,1)'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");

            // Validate curve type is Bezier with custom control points
            // Note: Parser converts percentage values (42 -> 0.0042, etc.)
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[0].curve {
                CurveType::Bezier(bezier) => {
                    assert!(
                        (bezier.cp1.x - 0.0042).abs() < 0.0001,
                        "Expected cp1.x ≈ 0.0042, got {}",
                        bezier.cp1.x
                    );
                    assert!(
                        (bezier.cp1.y - 0.0).abs() < 0.0001,
                        "Expected cp1.y ≈ 0.0, got {}",
                        bezier.cp1.y
                    );
                    assert!(
                        (bezier.cp2.x - 0.0058).abs() < 0.0001,
                        "Expected cp2.x ≈ 0.0058, got {}",
                        bezier.cp2.x
                    );
                    assert!(
                        (bezier.cp2.y - 0.01).abs() < 0.0001,
                        "Expected cp2.y ≈ 0.01, got {}",
                        bezier.cp2.y
                    );
                }
                other => panic!("Expected Bezier curve, got {:?}", other),
            }
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

#[test]
fn test_bezier_with_different_control_points_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 5s int steps 100 bezier(0,0,1,1)")
        .expect("Failed to parse 'store fx 1 step fix 1 5s int steps 100 bezier(0,0,1,1)'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            // Validate different control points
            // Note: Parser converts percentage values (0 -> 0.0, 100 -> 0.01)
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[0].curve {
                CurveType::Bezier(bezier) => {
                    assert!((bezier.cp1.x - 0.0).abs() < 0.0001, "Expected cp1.x = 0.0");
                    assert!((bezier.cp1.y - 0.0).abs() < 0.0001, "Expected cp1.y = 0.0");
                    assert!(
                        (bezier.cp2.x - 0.01).abs() < 0.0001,
                        "Expected cp2.x ≈ 0.01 (100 / 100)"
                    );
                    assert!(
                        (bezier.cp2.y - 0.01).abs() < 0.0001,
                        "Expected cp2.y ≈ 0.01 (100 / 100)"
                    );
                }
                other => panic!("Expected Bezier curve, got {:?}", other),
            }
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

#[test]
fn test_multiple_steps_with_different_curves_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 5s int steps 100 linear 50 ease 0 snap")
        .expect("Failed to parse multiple steps with different curves");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");
            assert_eq!(
                step_fx.lanes[0].absolute.as_ref().unwrap().steps.len(),
                3,
                "Expected 3 steps"
            );

            // Validate first step has Linear curve
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[0].curve {
                CurveType::Linear(_) => {}
                other => panic!("Expected Linear curve for step 0, got {:?}", other),
            }

            // Validate second step has Bezier curve (ease)
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[1].curve {
                CurveType::Bezier(_) => {}
                other => panic!("Expected Bezier curve for step 1, got {:?}", other),
            }

            // Validate third step has Snap curve
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[2].curve {
                CurveType::Snap(_) => {}
                other => panic!("Expected Snap curve for step 2, got {:?}", other),
            }
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}
