// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::IdExpr;
use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;

use super::ClipAstConverter;
use crate::*;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

/// Verifies a clip range expands to every clip in it.
#[test]
fn test_clip_range_aliases() {
    let ast = generate_ast("clip 1>5 on").expect("Failed to parse 'clip 1>5 on'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");
    assert_eq!(commands.len(), 1);

    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");
    match cmd.unwrap() {
        ClipCommand::StartClip(id_expr) => {
            assert_eq!(
                id_expr.expand(),
                vec![1, 2, 3, 4, 5],
                "Expected clip IDs 1-5"
            );
        }
        other => panic!("Expected StartClip command, got {:?}", other),
    }
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

/// Verifies storing a clip creates the standard empty clip definition.
#[test]
fn test_store_clip_conversion() {
    let ast = generate_ast("store clip 7").expect("Failed to parse 'store clip 7'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

    let command = commands[0]
        .as_any()
        .downcast_ref::<ClipCommand>()
        .expect("Command is not an ClipCommand");
    let ClipCommand::StoreClip(clip) = command else {
        panic!("Expected StoreClip command, got {command:?}");
    };
    assert_eq!(clip.identifiers.id, 7);
    assert_eq!(clip.identifiers.label, "Clip 7");
    assert!(clip.source.is_none());
    assert!(clip.options.auto_release);
}

/// Verifies clip store ranges expand into one creation command per ID.
#[test]
fn test_store_clip_range_conversion() {
    let ast = generate_ast("store exec 1>5").expect("Failed to parse clip store range");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

    let ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<ClipCommand>()
                .expect("Command is not an ClipCommand");
            let ClipCommand::StoreClip(clip) = command else {
                panic!("Expected StoreClip command, got {command:?}");
            };
            clip.identifiers.id
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![1, 2, 3, 4, 5]);
}

/// Verifies oversized store ranges fail conversion without materializing the range.
#[test]
fn test_store_clip_rejects_oversized_range() {
    let ast = generate_ast("store clip 0>4294967295")
        .expect("oversized clip range should remain syntactically valid");

    assert!(
        ClipAstConverter::convert(&ast).is_err(),
        "oversized clip range should fail command conversion"
    );
}

/// Verifies `clip N on` starts the clip.
#[test]
fn test_clip_start_conversion() {
    let ast = generate_ast("clip 1 start").expect("Failed to parse 'clip 1 start'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::StartClip(id_expr) => {
            assert_eq!(
                *id_expr,
                IdExpr::Single(1),
                "Expected clip ID 1, got {}",
                id_expr
            );
        }
        other => panic!("Expected StartClip command, got {:?}", other),
    }
}

/// Verifies `clip N off` stops the clip.
#[test]
fn test_clip_stop_conversion() {
    let ast = generate_ast("clip 1 stop").expect("Failed to parse 'clip 1 stop'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::StopClip(id_expr) => {
            assert_eq!(
                *id_expr,
                IdExpr::Single(1),
                "Expected clip ID 1, got {}",
                id_expr
            );
        }
        other => panic!("Expected StopClip command, got {:?}", other),
    }
}

/// Verifies `clip N go` advances the clip.
#[test]
fn test_clip_go_conversion() {
    let ast = generate_ast("clip 1 go").expect("Failed to parse 'clip 1 go'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::GoClip(id_expr) => {
            assert_eq!(
                *id_expr,
                IdExpr::Single(1),
                "Expected clip ID 1, got {}",
                id_expr
            );
        }
        other => panic!("Expected GoClip command, got {:?}", other),
    }
}

/// Verifies clip back commands convert to `BackClip`.
#[test]
fn test_clip_back_conversion() {
    let ast = generate_ast("clip 1 back").expect("Failed to parse 'clip 1 back'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::BackClip(id_expr) => {
            assert_eq!(
                *id_expr,
                IdExpr::Single(1),
                "Expected clip ID 1, got {}",
                id_expr
            );
        }
        other => panic!("Expected BackClip command, got {:?}", other),
    }
}

/// Verifies clip speed commands convert to attached playback speed commands.
#[test]
fn test_clip_speed_conversion() {
    let ast = generate_ast("exec 1 speed 2.5").expect("Failed to parse 'exec 1 speed 2.5'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::SetSpeed { clip_id, speed } => {
            assert_eq!(
                *clip_id,
                IdExpr::Single(1),
                "Expected clip ID 1, got {}",
                clip_id
            );
            assert_eq!(*speed, 2.5);
        }
        other => panic!("Expected SetSpeed command, got {:?}", other),
    }
}

/// Verifies clip target set commands convert to ID-addressed source assignment commands.
#[test]
fn test_set_clip_fx_target_conversion() {
    let ast =
        generate_ast("set exec 1 target=fx 2").expect("Failed to parse 'set exec 1 target=fx 2'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::AssignSourceById { clip_id, source } => {
            assert_eq!(*clip_id, 1);
            assert!(
                matches!(source, ClipSourceRef::Fx(2)),
                "Expected FX target 2, got {source:?}",
            );
        }
        other => panic!("Expected AssignSourceById command, got {:?}", other),
    }
}

// ============================================================================
// AST -> Command Conversion Tests - Clips
// ============================================================================

/// Verifies `delete clip N` deletes that clip.
#[test]
fn test_delete_clip_conversion() {
    let ast = generate_ast("delete clip 1").expect("Failed to parse 'delete clip 1'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

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

/// Verifies `rename clip A B` renumbers the clip.
#[test]
fn test_rename_clip_conversion() {
    let ast = generate_ast("rename clip 1 2").expect("Failed to parse 'rename clip 1 2'");
    let commands = ClipAstConverter::convert(&ast).expect("Failed to convert AST");

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
