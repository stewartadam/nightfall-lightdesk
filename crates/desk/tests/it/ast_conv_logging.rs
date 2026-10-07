// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_desk::ast_conv::DeskAstConverter;
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

// No aliases for log commands currently

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_log_level_basic_conversion() {
    let ast = generate_ast("log level info").expect("Failed to parse 'log level info'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::SetLogLevel(level) => {
            assert_eq!(level, "info", "Expected log level 'info', got '{}'", level);
        }
        other => panic!("Expected SetLogLevel command, got {:?}", other),
    }
}

#[test]
fn test_log_level_with_target_conversion() {
    let ast = generate_ast("log level nightfall=trace")
        .expect("Failed to parse 'log level nightfall=trace'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::SetLogLevel(level) => {
            assert_eq!(
                level, "nightfall=trace",
                "Expected log level 'nightfall=trace', got '{}'",
                level
            );
        }
        other => panic!("Expected SetLogLevel command, got {:?}", other),
    }
}

#[test]
fn test_log_level_with_span_field_conversion() {
    let ast = generate_ast("log level nightfall[{composited_layers}]=trace")
        .expect("Failed to parse with span field");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::SetLogLevel(level) => {
            assert!(
                level.contains("nightfall"),
                "Expected level to contain 'nightfall'"
            );
            assert!(
                level.contains("composited_layers"),
                "Expected level to contain 'composited_layers'"
            );
            assert!(level.contains("trace"), "Expected level to contain 'trace'");
        }
        other => panic!("Expected SetLogLevel command, got {:?}", other),
    }
}

#[test]
fn test_log_level_clear_conversion() {
    let ast = generate_ast("log level clear").expect("Failed to parse 'log level clear'");
    let cmds = DeskAstConverter::convert(&ast).expect("Conversion failed");
    assert_eq!(cmds.len(), 1);

    let cmd = &cmds[0];
    if let Some(desk_cmd) = cmd.as_any().downcast_ref::<DeskCommand>() {
        match desk_cmd {
            DeskCommand::SetLogLevel(level) => {
                assert_eq!(
                    level, "clear",
                    "Expected log level 'clear', got '{}'",
                    level
                );
            }
            other => panic!("Expected SetLogLevel command, got {:?}", other),
        }
    } else {
        panic!("Expected DeskCommand");
    }
}

#[test]
fn test_log_filter_set_field_only_conversion() {
    let ast = generate_ast("log filter myfield").expect("Failed to parse 'log filter myfield'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::SetTracingFilter { field, value } => {
            assert_eq!(
                field, "myfield",
                "Expected field 'myfield', got '{}'",
                field
            );
            assert!(value.is_none(), "Expected no value, got {:?}", value);
        }
        other => panic!("Expected SetTracingFilter command, got {:?}", other),
    }
}

#[test]
fn test_log_filter_set_field_value_conversion() {
    let ast = generate_ast("log filter myfield myvalue")
        .expect("Failed to parse 'log filter myfield myvalue'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::SetTracingFilter { field, value } => {
            assert_eq!(
                field, "myfield",
                "Expected field 'myfield', got '{}'",
                field
            );
            assert_eq!(
                value.as_ref().unwrap(),
                "myvalue",
                "Expected value 'myvalue', got {:?}",
                value
            );
        }
        other => panic!("Expected SetTracingFilter command, got {:?}", other),
    }
}

#[test]
fn test_log_filter_clear_conversion() {
    let ast = generate_ast("log filter clear").expect("Failed to parse 'log filter clear'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::ClearTracingFilter => {
            // Success - correct command variant
        }
        other => panic!("Expected ClearTracingFilter command, got {:?}", other),
    }
}

#[test]
#[ignore] // Parser doesn't currently support fixture-specific logging
fn test_log_fixture_conversion() {
    let ast = generate_ast("log fixture 1 int").expect("Failed to parse 'log fixture 1 int'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    // TODO: Add property validation once this is supported
}
