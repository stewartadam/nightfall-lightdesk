// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_fx::ast_conv::FxAstConverter;
use nightfall_fx::events::StepFxCommand;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

// No aliases for step FX creation currently

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_end_to_end_create_step_fx_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 5s int steps 100")
        .expect("Failed to parse base command");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(
                step_fx.identifiers.id, 1,
                "Expected FX ID 1, got {}",
                step_fx.identifiers.id
            );
            assert_eq!(
                step_fx.timing.beat_duration,
                Duration::from_secs(5),
                "Expected duration 5s, got {:?}",
                step_fx.timing.beat_duration
            );
            assert_eq!(step_fx.lanes.len(), 1, "Expected 1 attribute lane");
            assert_eq!(
                step_fx.lanes[0].absolute.as_ref().unwrap().steps.len(),
                1,
                "Expected 1 step"
            );
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

#[test]
fn test_different_fx_id_end_to_end_conversion() {
    let ast = generate_ast("store fx 2 step fix 1 5s int steps 100")
        .expect("Failed to parse different FX ID");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(
                step_fx.identifiers.id, 2,
                "Expected FX ID 2, got {}",
                step_fx.identifiers.id
            );
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}

#[test]
fn test_different_duration_end_to_end_conversion() {
    let ast = generate_ast("store fx 1 step fix 1 10s int steps 100")
        .expect("Failed to parse different duration");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Store(step_fx) => {
            assert_eq!(
                step_fx.timing.beat_duration,
                Duration::from_secs(10),
                "Expected duration 10s, got {:?}",
                step_fx.timing.beat_duration
            );
        }
        other => panic!("Expected Create command, got {:?}", other),
    }
}
