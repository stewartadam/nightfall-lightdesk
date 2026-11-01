// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_clips::ClipCommand;
use nightfall_cmd_parse::generate_ast;
use nightfall_desk::ast_conv::DeskAstConverter;
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;

// ============================================================================
// AST -> Command Conversion Tests - Groups
// ============================================================================

#[test]
fn test_delete_group_conversion() {
    let ast = generate_ast("delete group 1").expect("Failed to parse 'delete group 1'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<GroupCommand>();
    assert!(cmd.is_some(), "Command is not a GroupCommand");

    match cmd.unwrap() {
        GroupCommand::DeleteGroup(group_id) => {
            assert_eq!(*group_id, 1, "Expected group ID 1, got {}", group_id);
        }
        other => panic!("Expected DeleteGroup command, got {:?}", other),
    }
}

#[test]
fn test_rename_group_conversion() {
    let ast = generate_ast("rename group 1 2").expect("Failed to parse 'rename group 1 2'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<GroupCommand>();
    assert!(cmd.is_some(), "Command is not a GroupCommand");

    match cmd.unwrap() {
        GroupCommand::RenameGroup { id, new_id } => {
            assert_eq!(*id, 1, "Expected original group ID 1, got {}", id);
            assert_eq!(*new_id, 2, "Expected new group ID 2, got {}", new_id);
        }
        other => panic!("Expected RenameGroup command, got {:?}", other),
    }
}

// ============================================================================
// AST -> Command Conversion Tests - Clips
// ============================================================================

#[test]
fn test_delete_clip_conversion() {
    let ast = generate_ast("delete clip 1").expect("Failed to parse 'delete clip 1'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::DeleteClip(clip_id) => {
            assert_eq!(*clip_id, 1, "Expected clip ID 1, got {}", clip_id);
        }
        other => panic!("Expected DeleteClip command, got {:?}", other),
    }
}

#[test]
fn test_rename_clip_conversion() {
    let ast = generate_ast("rename clip 1 2").expect("Failed to parse 'rename clip 1 2'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::RenameClip { id, new_id } => {
            assert_eq!(*id, 1, "Expected original clip ID 1, got {}", id);
            assert_eq!(*new_id, 2, "Expected new clip ID 2, got {}", new_id);
        }
        other => panic!("Expected RenameClip command, got {:?}", other),
    }
}
