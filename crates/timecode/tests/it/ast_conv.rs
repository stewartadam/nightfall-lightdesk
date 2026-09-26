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
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_timecode_start_aliases() {
    let base_ast = generate_ast("timecode 1 start").expect("Failed to parse 'timecode 1 start'");

    // Test "timecode" object type aliases
    let tc_ast = generate_ast("tc 1 start").expect("Failed to parse 'tc 1 start'");
    assert_eq!(
        base_ast, tc_ast,
        "'tc' should produce identical AST to 'timecode'"
    );
}

#[test]
fn test_timecode_pause_aliases() {
    let base_ast = generate_ast("timecode 1 pause").expect("Failed to parse 'timecode 1 pause'");

    // Test "timecode" object type aliases
    let tc_ast = generate_ast("tc 1 pause").expect("Failed to parse 'tc 1 pause'");
    assert_eq!(
        base_ast, tc_ast,
        "'tc' should produce identical AST to 'timecode'"
    );
}

#[test]
fn test_timecode_stop_aliases() {
    let base_ast = generate_ast("timecode 1 stop").expect("Failed to parse 'timecode 1 stop'");

    // Test "timecode" object type aliases
    let tc_ast = generate_ast("tc 1 stop").expect("Failed to parse 'tc 1 stop'");
    assert_eq!(
        base_ast, tc_ast,
        "'tc' should produce identical AST to 'timecode'"
    );
}

#[test]
fn test_delete_timecode_aliases() {
    let base_ast = generate_ast("delete timecode 1").expect("Failed to parse 'delete timecode 1'");

    // Test "delete" command aliases
    let del_ast = generate_ast("del timecode 1").expect("Failed to parse 'del timecode 1'");
    assert_eq!(
        base_ast, del_ast,
        "'del' should produce identical AST to 'delete'"
    );

    let rm_ast = generate_ast("rm timecode 1").expect("Failed to parse 'rm timecode 1'");
    assert_eq!(
        base_ast, rm_ast,
        "'rm' should produce identical AST to 'delete'"
    );

    // Test "timecode" object type aliases
    let delete_tc_ast = generate_ast("delete tc 1").expect("Failed to parse 'delete tc 1'");
    assert_eq!(
        base_ast, delete_tc_ast,
        "'tc' should produce identical AST to 'timecode'"
    );

    let del_tc_ast = generate_ast("del tc 1").expect("Failed to parse 'del tc 1'");
    assert_eq!(
        base_ast, del_tc_ast,
        "'del tc' should produce identical AST to 'delete timecode'"
    );

    let rm_tc_ast = generate_ast("rm tc 1").expect("Failed to parse 'rm tc 1'");
    assert_eq!(
        base_ast, rm_tc_ast,
        "'rm tc' should produce identical AST to 'delete timecode'"
    );
}

#[test]
fn test_rename_timecode_aliases() {
    let base_ast =
        generate_ast("rename timecode 1 2").expect("Failed to parse 'rename timecode 1 2'");

    // Test "rename" command aliases
    let mv_ast = generate_ast("mv timecode 1 2").expect("Failed to parse 'mv timecode 1 2'");
    assert_eq!(
        base_ast, mv_ast,
        "'mv' should produce identical AST to 'rename'"
    );

    // Test "timecode" object type aliases
    let rename_tc_ast = generate_ast("rename tc 1 2").expect("Failed to parse 'rename tc 1 2'");
    assert_eq!(
        base_ast, rename_tc_ast,
        "'tc' should produce identical AST to 'timecode'"
    );

    let mv_tc_ast = generate_ast("mv tc 1 2").expect("Failed to parse 'mv tc 1 2'");
    assert_eq!(
        base_ast, mv_tc_ast,
        "'mv tc' should produce identical AST to 'rename timecode'"
    );
}

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
