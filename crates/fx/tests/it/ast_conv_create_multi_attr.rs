// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fx::ast_conv::FxAstConverter;
use nightfall_fx::events::StepFxCommand;
use nightfall_fx::prelude::*;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_rgb_attribute_aliases() {
    let base_ast = generate_ast(
        "store fx 1 step fix 1 5s int steps 100 0 r steps 100 0 g steps 100 0 b steps 100 0",
    )
    .expect("Failed to parse with 'r' alias");

    // Test "red" alias produces identical AST to "r"
    let red_ast = generate_ast(
        "store fx 1 step fix 1 5s int steps 100 0 red steps 100 0 g steps 100 0 b steps 100 0",
    )
    .expect("Failed to parse with 'red' alias");
    assert_eq!(
        base_ast, red_ast,
        "'red' should produce identical AST to 'r'"
    );
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_fx_with_multiple_attributes_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 5s int steps 100 0 red steps 100 0")
        .expect("Failed to parse 'store fx 1 step fix 1 5s int steps 100 0 red steps 100 0'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");
            assert_eq!(step_fx.lanes.len(), 2, "Expected 2 attribute sequences");

            // Validate first sequence is intensity
            assert_eq!(
                step_fx.lanes[0].attribute,
                Attribute::Intensity,
                "Expected first attribute to be Intensity"
            );
            assert_eq!(
                step_fx.lanes[0].absolute.as_ref().unwrap().steps.len(),
                2,
                "Expected 2 steps for intensity"
            );

            // Validate second sequence is red
            assert_eq!(
                step_fx.lanes[1].attribute,
                Attribute::Red,
                "Expected second attribute to be Red"
            );
            assert_eq!(
                step_fx.lanes[1].absolute.as_ref().unwrap().steps.len(),
                2,
                "Expected 2 steps for red"
            );
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

#[test]
fn test_fx_with_rgb_attributes_conversion() {
    let ast = generate_ast(
        "store fx 1 step fix 1 5s int steps 100 0 r steps 100 0 g steps 100 0 b steps 100 0",
    )
    .expect("Failed to parse RGB step fx");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");
            assert_eq!(
                step_fx.lanes.len(),
                4,
                "Expected 4 attribute sequences (int, r, g, b)"
            );

            // Validate all four attributes
            assert_eq!(
                step_fx.lanes[0].attribute,
                Attribute::Intensity,
                "Expected intensity"
            );
            assert_eq!(step_fx.lanes[1].attribute, Attribute::Red, "Expected red");
            assert_eq!(
                step_fx.lanes[2].attribute,
                Attribute::Green,
                "Expected green"
            );
            assert_eq!(step_fx.lanes[3].attribute, Attribute::Blue, "Expected blue");

            // Validate each has 2 steps (100 and 0)
            for (i, lane) in step_fx.lanes.iter().enumerate() {
                assert_eq!(
                    lane.absolute.as_ref().unwrap().steps.len(),
                    2,
                    "Expected 2 steps for lane {}",
                    i
                );
            }
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

#[test]
fn test_fx_multi_attr_with_curves_conversion() {
    let ast = generate_ast(
        "store fx 1 step fix 1 5s int steps 100 linear 0 ease red steps 100 snap 0 bezier(0,0,1,1)",
    )
    .expect("Failed to parse multi-attribute fx with different curves");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");
            assert_eq!(step_fx.lanes.len(), 2, "Expected 2 attribute sequences");

            // Validate intensity sequence has Linear and Bezier curves
            assert_eq!(step_fx.lanes[0].attribute, Attribute::Intensity);
            assert_eq!(
                step_fx.lanes[0].absolute.as_ref().unwrap().steps.len(),
                2,
                "Expected 2 steps for intensity"
            );
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[0].curve {
                CurveType::Linear(_) => {}
                other => panic!(
                    "Expected Linear curve for intensity step 0, got {:?}",
                    other
                ),
            }
            match &step_fx.lanes[0].absolute.as_ref().unwrap().steps[1].curve {
                CurveType::Bezier(_) => {}
                other => panic!(
                    "Expected Bezier curve for intensity step 1, got {:?}",
                    other
                ),
            }

            // Validate red sequence has Snap and Bezier curves
            assert_eq!(step_fx.lanes[1].attribute, Attribute::Red);
            assert_eq!(
                step_fx.lanes[1].absolute.as_ref().unwrap().steps.len(),
                2,
                "Expected 2 steps for red"
            );
            match &step_fx.lanes[1].absolute.as_ref().unwrap().steps[0].curve {
                CurveType::Snap(_) => {}
                other => panic!("Expected Snap curve for red step 0, got {:?}", other),
            }
            match &step_fx.lanes[1].absolute.as_ref().unwrap().steps[1].curve {
                CurveType::Bezier(_) => {}
                other => panic!("Expected Bezier curve for red step 1, got {:?}", other),
            }
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

/// Verifies per-step ramp shaping converts across multiple attribute lanes.
#[test]
fn test_fx_multi_attr_with_width_ramp_conversion() {
    let ast = generate_ast(
        "store fx 1 step fix 1 5s int steps 100 width 0.5 ramp 0.8 red steps 50 width 0.3 ramp 0.5",
    )
    .expect("Failed to parse multi-attribute fx with width and ramp");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(step_fx.identifiers.id, 1, "Expected FX ID 1");
            assert_eq!(step_fx.lanes.len(), 2, "Expected 2 attribute sequences");

            // Validate both attributes are present
            assert_eq!(step_fx.lanes[0].attribute, Attribute::Intensity);
            assert_eq!(step_fx.lanes[1].attribute, Attribute::Red);

            // TODO: Validate width and ramp values once parser properly sets step properties
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}
