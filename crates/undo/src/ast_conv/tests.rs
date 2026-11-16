// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;

use super::UndoAstConverter;
use crate::prelude::*;

/// Verifies undo commands need the tagged `data` form and reject unknown fields.
#[test]
fn test_undo_command_deserialization() {
    // Test that UndoCommand can be deserialized from JSON with tag/content format
    // Also test the format the UI sends (with just "type" for backward compatibility)
    let json_undo_full = r#"{"type":"Undo","data":{}}"#;
    let cmd: UndoCommand =
        serde_json::from_str(json_undo_full).expect("Failed to deserialize Undo");
    assert!(matches!(cmd, UndoCommand::Undo {}));

    let json_redo_full = r#"{"type":"Redo","data":{}}"#;
    let cmd: UndoCommand =
        serde_json::from_str(json_redo_full).expect("Failed to deserialize Redo");
    assert!(matches!(cmd, UndoCommand::Redo {}));

    let json_clear_full = r#"{"type":"ClearHistory","data":{}}"#;
    let cmd: UndoCommand =
        serde_json::from_str(json_clear_full).expect("Failed to deserialize ClearHistory");
    assert!(matches!(cmd, UndoCommand::ClearHistory {}));

    // Test UI format (without "data" field) - this will fail with tag+content
    // The UI needs to send {"type":"Undo","data":{}} format
    let json_undo_ui = r#"{"type":"Undo"}"#;
    let result = serde_json::from_str::<UndoCommand>(json_undo_ui);
    assert!(
        result.is_err(),
        "UI format without 'data' field should fail with tag+content serde attribute"
    );

    let json_undo_extra_top_level = r#"{"type":"Undo","data":{},"extra":true}"#;
    let result = serde_json::from_str::<UndoCommand>(json_undo_extra_top_level);
    assert!(
        result.is_err(),
        "Unknown top-level fields should be rejected"
    );

    let json_undo_extra_data = r#"{"type":"Undo","data":{"extra":true}}"#;
    let result = serde_json::from_str::<UndoCommand>(json_undo_extra_data);
    assert!(
        result.is_err(),
        "Unknown fields inside command payload should be rejected"
    );
}

/// Verifies `undo` becomes the undo command.
#[test]
fn test_undo_command_parsing() {
    // Test parsing "undo" command
    let result = UndoAstConverter::convert(&generate_ast("undo").expect("undo should parse"));
    assert!(result.is_ok(), "Failed to parse 'undo': {:?}", result.err());

    let commands = result.unwrap();
    assert_eq!(
        commands.len(),
        1,
        "Expected 1 command, got {}",
        commands.len()
    );

    // Verify it's an UndoCommand::Undo
    let cmd = &commands[0];
    let undo_cmd = cmd.as_any().downcast_ref::<UndoCommand>();
    assert!(undo_cmd.is_some(), "Command is not an UndoCommand");
    assert!(
        matches!(undo_cmd.unwrap(), UndoCommand::Undo {}),
        "Expected UndoCommand::Undo"
    );
}

/// Verifies `redo` becomes the redo command.
#[test]
fn test_redo_command_parsing() {
    // Test parsing "redo" command
    let result = UndoAstConverter::convert(&generate_ast("redo").expect("redo should parse"));
    assert!(result.is_ok(), "Failed to parse 'redo': {:?}", result.err());

    let commands = result.unwrap();
    assert_eq!(
        commands.len(),
        1,
        "Expected 1 command, got {}",
        commands.len()
    );

    // Verify it's an UndoCommand::Redo
    let cmd = &commands[0];
    let undo_cmd = cmd.as_any().downcast_ref::<UndoCommand>();
    assert!(undo_cmd.is_some(), "Command is not an UndoCommand");
    assert!(
        matches!(undo_cmd.unwrap(), UndoCommand::Redo {}),
        "Expected UndoCommand::Redo"
    );
}
