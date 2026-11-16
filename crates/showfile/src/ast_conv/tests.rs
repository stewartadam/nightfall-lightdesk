// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;

use super::ShowfileAstConverter;
use crate::command::ShowfileCommand;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

// No aliases for system commands currently

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

/// Verifies a bare `save` saves the current show.
#[test]
fn test_save_conversion() {
    let ast = generate_ast("save").expect("Failed to parse 'save'");
    let commands = ShowfileAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ShowfileCommand>();
    assert!(cmd.is_some(), "Command is not a ShowfileCommand");

    match cmd.unwrap() {
        ShowfileCommand::SaveShowfile => {}
        other => panic!("Expected SaveShowfile command, got {:?}", other),
    }
}

/// Verifies named save commands convert to a named showfile payload.
#[test]
fn test_named_save_conversion() {
    let ast = generate_ast("save demo").expect("Failed to parse 'save demo'");
    let commands = ShowfileAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ShowfileCommand>();
    assert!(cmd.is_some(), "Command is not a ShowfileCommand");

    match cmd.unwrap() {
        ShowfileCommand::SaveNamedShowfile(name) => {
            assert_eq!(name, "demo");
        }
        other => panic!("Expected SaveNamedShowfile command, got {:?}", other),
    }
}

/// Verifies a bare `load` loads the current show.
#[test]
fn test_load_conversion() {
    let ast = generate_ast("load").expect("Failed to parse 'load'");
    let commands = ShowfileAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ShowfileCommand>();
    assert!(cmd.is_some(), "Command is not a ShowfileCommand");

    match cmd.unwrap() {
        ShowfileCommand::LoadShowfile => {
            // Success - correct command variant
        }
        other => panic!("Expected LoadShowfile command, got {:?}", other),
    }
}

/// Verifies named load commands convert to a named showfile payload.
#[test]
fn test_named_load_conversion() {
    let ast = generate_ast("load demo").expect("Failed to parse 'load demo'");
    let commands = ShowfileAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ShowfileCommand>();
    assert!(cmd.is_some(), "Command is not a ShowfileCommand");

    match cmd.unwrap() {
        ShowfileCommand::LoadNamedShowfile(name) => {
            assert_eq!(name, "demo");
        }
        other => panic!("Expected LoadNamedShowfile command, got {:?}", other),
    }
}

/// Verifies explicit draft load paths convert to a draft showfile load.
#[test]
fn test_draft_load_path_conversion() {
    let ast = generate_ast("load draft/default").expect("Failed to parse draft load");
    let commands = ShowfileAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ShowfileCommand>();
    assert!(cmd.is_some(), "Command is not a ShowfileCommand");

    match cmd.unwrap() {
        ShowfileCommand::LoadDraftShowfile(name) => {
            assert_eq!(name, "default");
        }
        other => panic!("Expected LoadDraftShowfile command, got {:?}", other),
    }
}

/// Verifies explicit backup load paths convert to a showfile revision load.
#[test]
fn test_backup_load_path_conversion() {
    let ast =
        generate_ast("load backups/default-20260707-151450").expect("Failed to parse backup load");
    let commands = ShowfileAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ShowfileCommand>();
    assert!(cmd.is_some(), "Command is not a ShowfileCommand");

    match cmd.unwrap() {
        ShowfileCommand::LoadShowfileRevision(selection) => {
            assert_eq!(selection.showfile_name, "default");
            assert_eq!(selection.revision_name, "default-20260707-151450");
        }
        other => panic!("Expected LoadShowfileRevision command, got {:?}", other),
    }
}

/// Verifies new-show commands convert to the fresh-showfile command.
#[test]
fn test_new_show_conversion() {
    let ast = generate_ast("new show").expect("Failed to parse 'new show'");
    let commands = ShowfileAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ShowfileCommand>();
    assert!(cmd.is_some(), "Command is not a ShowfileCommand");

    match cmd.unwrap() {
        ShowfileCommand::NewShowfile => {
            // Success - correct command variant
        }
        other => panic!("Expected NewShowfile command, got {:?}", other),
    }
}
