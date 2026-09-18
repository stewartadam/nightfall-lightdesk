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

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_fx_start_aliases() {
    let base_ast = generate_ast("fx 1 start").expect("Failed to parse 'fx 1 start'");

    // Test "on" alias produces identical AST
    let on_ast = generate_ast("fx 1 on").expect("Failed to parse 'fx 1 on'");
    assert_eq!(
        base_ast, on_ast,
        "'on' should produce identical AST to 'start'"
    );
}

#[test]
fn test_fx_stop_aliases() {
    let base_ast = generate_ast("fx 1 stop").expect("Failed to parse 'fx 1 stop'");

    // Test "off" alias produces identical AST
    let off_ast = generate_ast("fx 1 off").expect("Failed to parse 'fx 1 off'");
    assert_eq!(
        base_ast, off_ast,
        "'off' should produce identical AST to 'stop'"
    );
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_fx_start_conversion() {
    let ast = generate_ast("fx 1 start").expect("Failed to parse 'fx 1 start'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Start(fx_id) => {
            assert_eq!(*fx_id, 1, "Expected FX ID 1, got {}", fx_id);
        }
        other => panic!("Expected Start command, got {:?}", other),
    }
}

#[test]
fn test_fx_stop_conversion() {
    let ast = generate_ast("fx 1 stop").expect("Failed to parse 'fx 1 stop'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::Stop(fx_id) => {
            assert_eq!(*fx_id, 1, "Expected FX ID 1, got {}", fx_id);
        }
        other => panic!("Expected Stop command, got {:?}", other),
    }
}

#[test]
fn test_fx_set_rate_conversion() {
    let ast = generate_ast("fx 1 rate 2.5").expect("Failed to parse 'fx 1 rate 2.5'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::SetRate { fx_id, rate } => {
            assert_eq!(*fx_id, 1, "Expected FX ID 1, got {}", fx_id);
            assert!(
                (*rate - 2.5).abs() < 1e-6,
                "Expected rate 2.5, got {}",
                rate
            );
        }
        other => panic!("Expected SetRate command, got {:?}", other),
    }
}

#[test]
fn test_fx_set_rate_different_values_conversion() {
    let ast = generate_ast("fx 1 rate 0.5").expect("Failed to parse 'fx 1 rate 0.5'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<StepFxCommand>();
    assert!(cmd.is_some(), "Command is not a StepFxCommand");

    match cmd.unwrap() {
        StepFxCommand::SetRate { fx_id, rate } => {
            assert_eq!(*fx_id, 1, "Expected FX ID 1, got {}", fx_id);
            assert!(
                (*rate - 0.5).abs() < 1e-6,
                "Expected rate 0.5, got {}",
                rate
            );
        }
        other => panic!("Expected SetRate command, got {:?}", other),
    }
}
