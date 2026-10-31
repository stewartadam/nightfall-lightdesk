// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::ColorPathId;
use nightfall_cmd_parse::generate_ast;
use nightfall_cues::CueCommand;
use nightfall_cues::ast_conv::CueAstConverter;
use nightfall_engine::prelude::*;

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_delete_cue_conversion() {
    let ast = generate_ast("delete cue 1.5").expect("Failed to parse 'delete cue 1.5'");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::DeleteCue {
            sequence_id,
            cue_id,
        } => {
            assert_eq!(
                *sequence_id, 1,
                "Expected sequence ID 1, got {}",
                sequence_id
            );
            assert_eq!(*cue_id, 5, "Expected cue ID 5, got {}", cue_id);
        }
        other => panic!("Expected DeleteCue command, got {:?}", other),
    }
}

#[test]
fn test_rename_cue_conversion() {
    let ast = generate_ast("rename cue 1.5 2.10").expect("Failed to parse 'rename cue 1.5 2.10'");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::RenameCue {
            sequence_id,
            cue_id,
            new_sequence_id,
            new_cue_id,
        } => {
            assert_eq!(
                *sequence_id, 1,
                "Expected original sequence ID 1, got {}",
                sequence_id
            );
            assert_eq!(*cue_id, 5, "Expected original cue ID 5, got {}", cue_id);
            assert_eq!(
                *new_sequence_id, 2,
                "Expected new sequence ID 2, got {}",
                new_sequence_id
            );
            assert_eq!(
                *new_cue_id, 10,
                "Expected new cue ID 10, got {}",
                new_cue_id
            );
        }
        other => panic!("Expected RenameCue command, got {:?}", other),
    }
}

/// Verifies block cue commands convert to cue block operations.
#[test]
fn test_block_cue_conversion() {
    let ast = generate_ast("block cue 1.5").expect("Failed to parse 'block cue 1.5'");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::BlockCue {
            sequence_id,
            cue_id,
            part_id,
            overwrite,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, 5);
            assert_eq!(*part_id, None);
            assert!(!overwrite);
        }
        other => panic!("Expected BlockCue command, got {:?}", other),
    }
}

/// Verifies block cue overwrite commands preserve the overwrite flag.
#[test]
fn test_block_cue_overwrite_conversion() {
    let ast =
        generate_ast("block cue 1.5 /overwrite").expect("Failed to parse overwrite block cue");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::BlockCue {
            sequence_id,
            cue_id,
            part_id,
            overwrite,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, 5);
            assert_eq!(*part_id, None);
            assert!(overwrite);
        }
        other => panic!("Expected BlockCue command, got {:?}", other),
    }
}

/// Verifies unblock cue part commands convert to cue unblock operations.
#[test]
fn test_unblock_cue_part_conversion() {
    let ast = generate_ast("unblock cue 1.5p2").expect("Failed to parse 'unblock cue 1.5p2'");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::UnblockCue {
            sequence_id,
            cue_id,
            part_id,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, 5);
            assert_eq!(*part_id, Some(2));
        }
        other => panic!("Expected UnblockCue command, got {:?}", other),
    }
}

/// Verifies cue path syntax converts to cue assignment commands.
#[test]
fn test_set_cue_path_conversion() {
    let ast = generate_ast("cue 1.5 path 101").expect("Failed to parse cue path");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::SetCueColorPath {
            sequence_id,
            cue_id,
            color_path_id,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, 5);
            assert_eq!(*color_path_id, Some(ColorPathId(101)));
        }
        other => panic!("Expected SetCueColorPath command, got {:?}", other),
    }
}

/// Verifies cue path clear syntax converts to a cue clearing command.
#[test]
fn test_clear_cue_path_conversion() {
    let ast = generate_ast("cue 1.5 path none").expect("Failed to parse cue path clear");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::SetCueColorPath {
            sequence_id,
            cue_id,
            color_path_id,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, 5);
            assert_eq!(*color_path_id, None);
        }
        other => panic!("Expected SetCueColorPath command, got {:?}", other),
    }
}

/// Verifies store path syntax converts to a custom color path store command.
#[test]
fn test_store_path_conversion() {
    let ast = generate_ast("store path 101").expect("Failed to parse store path");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::StoreColorPath(color_path) => {
            assert_eq!(color_path.identifiers.id, 101);
            assert_eq!(color_path.identifiers.label, "Color Path 101");
            assert_eq!(
                color_path.interpolation_space,
                nightfall::prelude::ColorInterpolationSpace::Hsv
            );
        }
        other => panic!("Expected StoreColorPath command, got {:?}", other),
    }
}

/// Verifies color-path store ranges create one default path for each ID.
#[test]
fn test_store_path_range_conversion() {
    let ast = generate_ast("store path 101>103").expect("Failed to parse store path range");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    let ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<CueCommand>()
                .expect("Command is not a CueCommand");
            let CueCommand::StoreColorPath(color_path) = command else {
                panic!("Expected StoreColorPath command, got {command:?}");
            };
            color_path.identifiers.id
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![101, 102, 103]);
}

/// Verifies store color-path alias syntax converts to a store command.
#[test]
fn test_store_color_path_alias_conversion() {
    let ast = generate_ast("store color-path 101").expect("Failed to parse store color-path");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::StoreColorPath(color_path) => {
            assert_eq!(color_path.identifiers.id, 101);
            assert_eq!(color_path.identifiers.label, "Color Path 101");
            assert_eq!(
                color_path.interpolation_space,
                nightfall::prelude::ColorInterpolationSpace::Hsv
            );
        }
        other => panic!("Expected StoreColorPath command, got {:?}", other),
    }
}

/// Verifies store path label syntax creates a labeled color path.
#[test]
fn test_store_path_label_conversion() {
    let ast = generate_ast("store path 101 label \"No Green\"")
        .expect("Failed to parse store path label");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::StoreColorPath(color_path) => {
            assert_eq!(color_path.identifiers.id, 101);
            assert_eq!(color_path.identifiers.label, "No Green");
            assert_eq!(
                color_path.interpolation_space,
                nightfall::prelude::ColorInterpolationSpace::Hsv
            );
        }
        other => panic!("Expected StoreColorPath command, got {:?}", other),
    }
}

/// Verifies generic copy syntax converts to a color path duplicate command.
#[test]
fn test_duplicate_color_path_conversion() {
    let ast = generate_ast("cp path 101 202").expect("Failed to parse copy path");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::DuplicateColorPath { id, new_id } => {
            assert_eq!(*id, 101);
            assert_eq!(*new_id, 202);
        }
        other => panic!("Expected DuplicateColorPath command, got {:?}", other),
    }
}

/// Verifies generic mv path syntax converts to a color path rename command.
#[test]
fn test_move_color_path_conversion() {
    let ast = generate_ast("mv path 101 202").expect("Failed to parse path move");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::RenameColorPath { id, new_id } => {
            assert_eq!(*id, 101);
            assert_eq!(*new_id, 202);
        }
        other => panic!("Expected RenameColorPath command, got {:?}", other),
    }
}

/// Verifies compact mv path syntax converts to a color path rename command.
#[test]
fn test_move_compact_color_path_conversion() {
    let ast = generate_ast("mv path101 path202").expect("Failed to parse compact path move");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::RenameColorPath { id, new_id } => {
            assert_eq!(*id, 101);
            assert_eq!(*new_id, 202);
        }
        other => panic!("Expected RenameColorPath command, got {:?}", other),
    }
}

/// Verifies delete path syntax converts to a color path delete command.
#[test]
fn test_delete_color_path_conversion() {
    let ast = generate_ast("delete path 101").expect("Failed to parse delete path");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::DeleteColorPath(id) => assert_eq!(*id, 101),
        other => panic!("Expected DeleteColorPath command, got {:?}", other),
    }
}

/// Verifies deleting a color path range expands into one delete command per ID.
#[test]
fn test_delete_color_path_range_conversion() {
    let ast = generate_ast("rm path 101>103").expect("Failed to parse delete path range");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    let ids = commands
        .iter()
        .map(|command| {
            let cmd = command.as_any().downcast_ref::<CueCommand>();
            assert!(cmd.is_some(), "Command is not a CueCommand");
            match cmd.unwrap() {
                CueCommand::DeleteColorPath(id) => *id,
                other => panic!("Expected DeleteColorPath command, got {:?}", other),
            }
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![101, 102, 103]);
}

#[test]
fn test_delete_sequence_conversion() {
    let ast = generate_ast("delete sequence 1").expect("Failed to parse 'delete sequence 1'");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::DeleteSequence(seq_id) => {
            assert_eq!(*seq_id, 1, "Expected sequence ID 1, got {}", seq_id);
        }
        other => panic!("Expected DeleteSequence command, got {:?}", other),
    }
}

#[test]
fn test_rename_sequence_conversion() {
    let ast = generate_ast("rename sequence 1 2").expect("Failed to parse 'rename sequence 1 2'");
    let commands = CueAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<CueCommand>();
    assert!(cmd.is_some(), "Command is not a CueCommand");

    match cmd.unwrap() {
        CueCommand::RenameSequence { id, new_id } => {
            assert_eq!(*id, 1, "Expected original sequence ID 1, got {}", id);
            assert_eq!(*new_id, 2, "Expected new sequence ID 2, got {}", new_id);
        }
        other => panic!("Expected RenameSequence command, got {:?}", other),
    }
}
