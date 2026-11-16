// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use nightfall_cmd_parse::generate_ast;

use super::EngineAstConverter;
use crate::prelude::*;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

// No aliases for log commands currently

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

/// Verifies `log level info` sets that level.
#[test]
fn test_log_level_basic_conversion() {
    let ast = generate_ast("log level info").expect("Failed to parse 'log level info'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<LogCommand>();
    assert!(cmd.is_some(), "Command is not a LogCommand");

    match cmd.unwrap() {
        LogCommand::SetLogLevel(level) => {
            assert_eq!(level, "info", "Expected log level 'info', got '{}'", level);
        }
        other => panic!("Expected SetLogLevel command, got {:?}", other),
    }
}

/// Verifies a per-target level such as `nightfall=trace` passes through unchanged.
#[test]
fn test_log_level_with_target_conversion() {
    let ast = generate_ast("log level nightfall=trace")
        .expect("Failed to parse 'log level nightfall=trace'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<LogCommand>();
    assert!(cmd.is_some(), "Command is not a LogCommand");

    match cmd.unwrap() {
        LogCommand::SetLogLevel(level) => {
            assert_eq!(
                level, "nightfall=trace",
                "Expected log level 'nightfall=trace', got '{}'",
                level
            );
        }
        other => panic!("Expected SetLogLevel command, got {:?}", other),
    }
}

/// Verifies a level with a span field filter passes through unchanged.
#[test]
fn test_log_level_with_span_field_conversion() {
    let ast = generate_ast("log level nightfall[{composited_layers}]=trace")
        .expect("Failed to parse with span field");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<LogCommand>();
    assert!(cmd.is_some(), "Command is not a LogCommand");

    match cmd.unwrap() {
        LogCommand::SetLogLevel(level) => {
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

/// Verifies `log level clear` is passed on for the handler to map to the default filter.
#[test]
fn test_log_level_clear_conversion() {
    let ast = generate_ast("log level clear").expect("Failed to parse 'log level clear'");
    let cmds = EngineAstConverter::convert(&ast).expect("Conversion failed");
    assert_eq!(cmds.len(), 1);

    let cmd = &cmds[0];
    if let Some(log_cmd) = cmd.as_any().downcast_ref::<LogCommand>() {
        match log_cmd {
            LogCommand::SetLogLevel(level) => {
                assert_eq!(
                    level, "clear",
                    "Expected log level 'clear', got '{}'",
                    level
                );
            }
            other => panic!("Expected SetLogLevel command, got {:?}", other),
        }
    } else {
        panic!("Expected LogCommand");
    }
}

/// Verifies `log filter set` with only a field name matches any value of that field.
#[test]
fn test_log_filter_set_field_only_conversion() {
    let ast = generate_ast("log filter myfield").expect("Failed to parse 'log filter myfield'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<LogCommand>();
    assert!(cmd.is_some(), "Command is not a LogCommand");

    match cmd.unwrap() {
        LogCommand::SetTracingFilter { field, value } => {
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

/// Verifies `log filter set` with a value matches only that value of the field.
#[test]
fn test_log_filter_set_field_value_conversion() {
    let ast = generate_ast("log filter myfield myvalue")
        .expect("Failed to parse 'log filter myfield myvalue'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<LogCommand>();
    assert!(cmd.is_some(), "Command is not a LogCommand");

    match cmd.unwrap() {
        LogCommand::SetTracingFilter { field, value } => {
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

/// Verifies `log filter clear` removes every field matcher.
#[test]
fn test_log_filter_clear_conversion() {
    let ast = generate_ast("log filter clear").expect("Failed to parse 'log filter clear'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<LogCommand>();
    assert!(cmd.is_some(), "Command is not a LogCommand");

    match cmd.unwrap() {
        LogCommand::ClearTracingFilter => {
            // Success - correct command variant
        }
        other => panic!("Expected ClearTracingFilter command, got {:?}", other),
    }
}

/// Verifies `quit` becomes the engine quit command.
#[test]
fn test_quit_conversion() {
    let ast = generate_ast("quit").expect("Failed to parse 'quit'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<EngineCommand>();
    assert!(cmd.is_some(), "Command is not an EngineCommand");

    match cmd.unwrap() {
        EngineCommand::Quit => {
            // Success - correct command variant
        }
        other => panic!("Expected Quit command, got {:?}", other),
    }
}

/// Verifies a bare sleep duration is read as seconds.
#[test]
fn test_sleep_seconds_conversion() {
    let ast = generate_ast("sleep 5").expect("Failed to parse 'sleep 5'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<EngineCommand>();
    assert!(cmd.is_some(), "Command is not an EngineCommand");

    match cmd.unwrap() {
        EngineCommand::Sleep(duration) => {
            assert_eq!(
                *duration,
                Duration::from_secs(5),
                "Expected 5 seconds, got {:?}",
                duration
            );
        }
        other => panic!("Expected Sleep command, got {:?}", other),
    }
}

/// Verifies a sleep duration in milliseconds.
#[test]
fn test_sleep_milliseconds_conversion() {
    let ast = generate_ast("sleep 1500ms").expect("Failed to parse 'sleep 1500ms'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<EngineCommand>();
    assert!(cmd.is_some(), "Command is not an EngineCommand");

    match cmd.unwrap() {
        EngineCommand::Sleep(duration) => {
            assert_eq!(
                *duration,
                Duration::from_millis(1500),
                "Expected 1500ms (1.5s), got {:?}",
                duration
            );
        }
        other => panic!("Expected Sleep command, got {:?}", other),
    }
}

/// Verifies a sleep in beats per minute waits one beat.
#[test]
fn test_sleep_bpm_conversion() {
    let ast = generate_ast("sleep 60bpm").expect("Failed to parse 'sleep 60bpm'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<EngineCommand>();
    assert!(cmd.is_some(), "Command is not an EngineCommand");

    match cmd.unwrap() {
        EngineCommand::Sleep(duration) => {
            assert_eq!(
                *duration,
                Duration::from_secs(1),
                "Expected 1 second (60bpm), got {:?}",
                duration
            );
        }
        other => panic!("Expected Sleep command, got {:?}", other),
    }
}

/// Verifies a sleep in hertz waits one period.
#[test]
fn test_sleep_hz_conversion() {
    let ast = generate_ast("sleep 2hz").expect("Failed to parse 'sleep 2hz'");
    let commands = EngineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<EngineCommand>();
    assert!(cmd.is_some(), "Command is not an EngineCommand");

    match cmd.unwrap() {
        EngineCommand::Sleep(duration) => {
            assert_eq!(
                *duration,
                Duration::from_millis(500),
                "Expected 500ms (2hz), got {:?}",
                duration
            );
        }
        other => panic!("Expected Sleep command, got {:?}", other),
    }
}
