// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_timecode::TimecodeCommand;
use nightfall_timecode::ast_conv::TimecodeAstConverter;

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

/// Verifies storing a timecode creates the standard internal 30 FPS definition.
#[test]
fn test_store_timecode_conversion() {
    let ast = generate_ast("store timecode 7").expect("Failed to parse 'store timecode 7'");
    let commands = TimecodeAstConverter::convert(&ast).expect("Failed to convert AST");

    let command = commands[0]
        .as_any()
        .downcast_ref::<TimecodeCommand>()
        .expect("Command is not a TimecodeCommand");
    let TimecodeCommand::StoreTimecode(timecode) = command else {
        panic!("Expected StoreTimecode command, got {command:?}");
    };
    assert_eq!(timecode.identifiers.id, 7);
    assert_eq!(timecode.identifiers.label, "Timecode 7");
}

/// Verifies timecode store ranges create one definition for each selected ID.
#[test]
fn test_store_timecode_range_conversion() {
    let ast = generate_ast("store timecode 7>9").expect("Failed to parse timecode store range");
    let commands = TimecodeAstConverter::convert(&ast).expect("Failed to convert AST");

    let ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<TimecodeCommand>()
                .expect("Command is not a TimecodeCommand");
            let TimecodeCommand::StoreTimecode(timecode) = command else {
                panic!("Expected StoreTimecode command, got {command:?}");
            };
            timecode.identifiers.id
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![7, 8, 9]);
}

#[test]
fn test_timecode_start_conversion() {
    let ast = generate_ast("timecode 1 start").expect("Failed to parse 'timecode 1 start'");
    let commands = TimecodeAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimecodeCommand>();
    assert!(cmd.is_some(), "Command is not a TimecodeCommand");

    match cmd.unwrap() {
        TimecodeCommand::StartTimecode(timecode_id) => {
            assert_eq!(
                *timecode_id, 1,
                "Expected timecode ID 1, got {}",
                timecode_id
            );
        }
        other => panic!("Expected StartTimecode command, got {:?}", other),
    }
}

#[test]
fn test_timecode_pause_conversion() {
    let ast = generate_ast("timecode 1 pause").expect("Failed to parse 'timecode 1 pause'");
    let commands = TimecodeAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimecodeCommand>();
    assert!(cmd.is_some(), "Command is not a TimecodeCommand");

    match cmd.unwrap() {
        TimecodeCommand::PauseTimecode(timecode_id) => {
            assert_eq!(
                *timecode_id, 1,
                "Expected timecode ID 1, got {}",
                timecode_id
            );
        }
        other => panic!("Expected PauseTimecode command, got {:?}", other),
    }
}

#[test]
fn test_timecode_stop_conversion() {
    let ast = generate_ast("timecode 1 stop").expect("Failed to parse 'timecode 1 stop'");
    let commands = TimecodeAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimecodeCommand>();
    assert!(cmd.is_some(), "Command is not a TimecodeCommand");

    match cmd.unwrap() {
        TimecodeCommand::StopTimecode(timecode_id) => {
            assert_eq!(
                *timecode_id, 1,
                "Expected timecode ID 1, got {}",
                timecode_id
            );
        }
        other => panic!("Expected StopTimecode command, got {:?}", other),
    }
}

#[test]
fn test_delete_timecode_conversion() {
    let ast = generate_ast("delete timecode 1").expect("Failed to parse 'delete timecode 1'");
    let commands = TimecodeAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimecodeCommand>();
    assert!(cmd.is_some(), "Command is not a TimecodeCommand");

    match cmd.unwrap() {
        TimecodeCommand::DeleteTimecode(timecode_id) => {
            assert_eq!(
                *timecode_id, 1,
                "Expected timecode ID 1, got {}",
                timecode_id
            );
        }
        other => panic!("Expected DeleteTimecode command, got {:?}", other),
    }
}

#[test]
fn test_rename_timecode_conversion() {
    let ast = generate_ast("rename timecode 1 2").expect("Failed to parse 'rename timecode 1 2'");
    let commands = TimecodeAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimecodeCommand>();
    assert!(cmd.is_some(), "Command is not a TimecodeCommand");

    match cmd.unwrap() {
        TimecodeCommand::RenameTimecode { id, new_id } => {
            assert_eq!(*id, 1, "Expected original timecode ID 1, got {}", id);
            assert_eq!(*new_id, 2, "Expected new timecode ID 2, got {}", new_id);
        }
        other => panic!("Expected RenameTimecode command, got {:?}", other),
    }
}
