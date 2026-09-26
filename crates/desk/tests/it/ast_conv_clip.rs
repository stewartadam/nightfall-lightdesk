// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::IdExpr;
use nightfall_clips::*;
use nightfall_cmd_parse::generate_ast;
use nightfall_desk::ast_conv::DeskAstConverter;
use nightfall_engine::prelude::*;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_clip_start_aliases() {
    let base_ast = generate_ast("clip 1 start").expect("Failed to parse 'clip 1 start'");

    // Test "start" action aliases
    let on_ast = generate_ast("clip 1 on").expect("Failed to parse 'clip 1 on'");
    assert_eq!(
        base_ast, on_ast,
        "'on' should produce identical AST to 'start'"
    );

    // Test "clip" object type aliases with "start"
    let exec_start_ast = generate_ast("exec 1 start").expect("Failed to parse 'exec 1 start'");
    assert_eq!(
        base_ast, exec_start_ast,
        "'exec' should produce identical AST to 'clip'"
    );

    let exec_on_ast = generate_ast("exec 1 on").expect("Failed to parse 'exec 1 on'");
    assert_eq!(
        base_ast, exec_on_ast,
        "'exec 1 on' should produce identical AST to 'clip 1 start'"
    );

    let e_start_ast = generate_ast("e 1 start").expect("Failed to parse 'e 1 start'");
    assert_eq!(
        base_ast, e_start_ast,
        "'e' should produce identical AST to 'clip'"
    );

    let e_on_ast = generate_ast("e 1 on").expect("Failed to parse 'e 1 on'");
    assert_eq!(
        base_ast, e_on_ast,
        "'e 1 on' should produce identical AST to 'clip 1 start'"
    );
}

#[test]
fn test_clip_stop_aliases() {
    let base_ast = generate_ast("clip 1 stop").expect("Failed to parse 'clip 1 stop'");

    // Test "stop" action aliases
    let off_ast = generate_ast("clip 1 off").expect("Failed to parse 'clip 1 off'");
    assert_eq!(
        base_ast, off_ast,
        "'off' should produce identical AST to 'stop'"
    );

    // Test "clip" object type aliases with "stop"
    let exec_stop_ast = generate_ast("exec 1 stop").expect("Failed to parse 'exec 1 stop'");
    assert_eq!(
        base_ast, exec_stop_ast,
        "'exec' should produce identical AST to 'clip'"
    );

    let exec_off_ast = generate_ast("exec 1 off").expect("Failed to parse 'exec 1 off'");
    assert_eq!(
        base_ast, exec_off_ast,
        "'exec 1 off' should produce identical AST to 'clip 1 stop'"
    );

    let e_stop_ast = generate_ast("e 1 stop").expect("Failed to parse 'e 1 stop'");
    assert_eq!(
        base_ast, e_stop_ast,
        "'e' should produce identical AST to 'clip'"
    );

    let e_off_ast = generate_ast("e 1 off").expect("Failed to parse 'e 1 off'");
    assert_eq!(
        base_ast, e_off_ast,
        "'e 1 off' should produce identical AST to 'clip 1 stop'"
    );
}

#[test]
fn test_clip_go_aliases() {
    let base_ast = generate_ast("clip 1 go").expect("Failed to parse 'clip 1 go'");

    // Test "clip" object type aliases with "go"
    let exec_go_ast = generate_ast("exec 1 go").expect("Failed to parse 'exec 1 go'");
    assert_eq!(
        base_ast, exec_go_ast,
        "'exec' should produce identical AST to 'clip'"
    );

    let e_go_ast = generate_ast("e 1 go").expect("Failed to parse 'e 1 go'");
    assert_eq!(
        base_ast, e_go_ast,
        "'e' should produce identical AST to 'clip'"
    );
}

#[test]
fn test_clip_range_aliases() {
    let ast = generate_ast("clip 1>5 on").expect("Failed to parse 'clip 1>5 on'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");
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
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

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
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

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
        DeskAstConverter::convert(&ast).is_err(),
        "oversized clip range should fail command conversion"
    );
}

#[test]
fn test_clip_start_conversion() {
    let ast = generate_ast("clip 1 start").expect("Failed to parse 'clip 1 start'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

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

#[test]
fn test_clip_stop_conversion() {
    let ast = generate_ast("clip 1 stop").expect("Failed to parse 'clip 1 stop'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

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

#[test]
fn test_clip_go_conversion() {
    let ast = generate_ast("clip 1 go").expect("Failed to parse 'clip 1 go'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

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
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

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

/// Verifies clip rate commands convert to attached playback rate commands.
#[test]
fn test_clip_rate_conversion() {
    let ast = generate_ast("exec 1 rate 2.5").expect("Failed to parse 'exec 1 rate 2.5'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ClipCommand>();
    assert!(cmd.is_some(), "Command is not an ClipCommand");

    match cmd.unwrap() {
        ClipCommand::SetRate { clip_id, rate } => {
            assert_eq!(
                *clip_id,
                IdExpr::Single(1),
                "Expected clip ID 1, got {}",
                clip_id
            );
            assert_eq!(*rate, 2.5);
        }
        other => panic!("Expected SetRate command, got {:?}", other),
    }
}

/// Verifies clip target set commands convert to ID-addressed source assignment commands.
#[test]
fn test_set_clip_fx_target_conversion() {
    let ast =
        generate_ast("set exec 1 target=fx 2").expect("Failed to parse 'set exec 1 target=fx 2'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

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
