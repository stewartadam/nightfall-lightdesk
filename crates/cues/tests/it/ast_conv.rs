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
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_delete_cue_aliases() {
    let base_ast = generate_ast("delete cue 1.5").expect("Failed to parse 'delete cue 1.5'");

    // Test "delete" command aliases
    let del_ast = generate_ast("del cue 1.5").expect("Failed to parse 'del cue 1.5'");
    assert_eq!(
        base_ast, del_ast,
        "'del' should produce identical AST to 'delete'"
    );

    let rm_ast = generate_ast("rm cue 1.5").expect("Failed to parse 'rm cue 1.5'");
    assert_eq!(
        base_ast, rm_ast,
        "'rm' should produce identical AST to 'delete'"
    );

    // Test "cue" object type aliases
    let delete_c_ast = generate_ast("delete c 1.5").expect("Failed to parse 'delete c 1.5'");
    assert_eq!(
        base_ast, delete_c_ast,
        "'c' should produce identical AST to 'cue'"
    );

    let del_c_ast = generate_ast("del c 1.5").expect("Failed to parse 'del c 1.5'");
    assert_eq!(
        base_ast, del_c_ast,
        "'del c' should produce identical AST to 'delete cue'"
    );

    let rm_c_ast = generate_ast("rm c 1.5").expect("Failed to parse 'rm c 1.5'");
    assert_eq!(
        base_ast, rm_c_ast,
        "'rm c' should produce identical AST to 'delete cue'"
    );
}

#[test]
fn test_rename_cue_aliases() {
    let base_ast =
        generate_ast("rename cue 1.5 2.10").expect("Failed to parse 'rename cue 1.5 2.10'");

    // Test "rename" command aliases
    let mv_ast = generate_ast("mv cue 1.5 2.10").expect("Failed to parse 'mv cue 1.5 2.10'");
    assert_eq!(
        base_ast, mv_ast,
        "'mv' should produce identical AST to 'rename'"
    );

    // Test "cue" object type aliases
    let rename_c_ast =
        generate_ast("rename c 1.5 2.10").expect("Failed to parse 'rename c 1.5 2.10'");
    assert_eq!(
        base_ast, rename_c_ast,
        "'c' should produce identical AST to 'cue'"
    );

    let mv_c_ast = generate_ast("mv c 1.5 2.10").expect("Failed to parse 'mv c 1.5 2.10'");
    assert_eq!(
        base_ast, mv_c_ast,
        "'mv c' should produce identical AST to 'rename cue'"
    );
}

#[test]
fn test_delete_sequence_aliases() {
    let base_ast = generate_ast("delete sequence 1").expect("Failed to parse 'delete sequence 1'");

    // Test "delete" command aliases
    let del_ast = generate_ast("del sequence 1").expect("Failed to parse 'del sequence 1'");
    assert_eq!(
        base_ast, del_ast,
        "'del' should produce identical AST to 'delete'"
    );

    let rm_ast = generate_ast("rm sequence 1").expect("Failed to parse 'rm sequence 1'");
    assert_eq!(
        base_ast, rm_ast,
        "'rm' should produce identical AST to 'delete'"
    );

    // Test "sequence" object type aliases
    let delete_seq_ast = generate_ast("delete seq 1").expect("Failed to parse 'delete seq 1'");
    assert_eq!(
        base_ast, delete_seq_ast,
        "'seq' should produce identical AST to 'sequence'"
    );

    let del_seq_ast = generate_ast("del seq 1").expect("Failed to parse 'del seq 1'");
    assert_eq!(
        base_ast, del_seq_ast,
        "'del seq' should produce identical AST to 'delete sequence'"
    );

    let rm_seq_ast = generate_ast("rm seq 1").expect("Failed to parse 'rm seq 1'");
    assert_eq!(
        base_ast, rm_seq_ast,
        "'rm seq' should produce identical AST to 'delete sequence'"
    );

    let delete_s_ast = generate_ast("delete s 1").expect("Failed to parse 'delete s 1'");
    assert_eq!(
        base_ast, delete_s_ast,
        "'s' should produce identical AST to 'sequence'"
    );

    let del_s_ast = generate_ast("del s 1").expect("Failed to parse 'del s 1'");
    assert_eq!(
        base_ast, del_s_ast,
        "'del s' should produce identical AST to 'delete sequence'"
    );

    let rm_s_ast = generate_ast("rm s 1").expect("Failed to parse 'rm s 1'");
    assert_eq!(
        base_ast, rm_s_ast,
        "'rm s' should produce identical AST to 'delete sequence'"
    );
}

#[test]
fn test_rename_sequence_aliases() {
    let base_ast =
        generate_ast("rename sequence 1 2").expect("Failed to parse 'rename sequence 1 2'");

    // Test "rename" command aliases
    let mv_ast = generate_ast("mv sequence 1 2").expect("Failed to parse 'mv sequence 1 2'");
    assert_eq!(
        base_ast, mv_ast,
        "'mv' should produce identical AST to 'rename'"
    );

    // Test "sequence" object type aliases
    let rename_seq_ast = generate_ast("rename seq 1 2").expect("Failed to parse 'rename seq 1 2'");
    assert_eq!(
        base_ast, rename_seq_ast,
        "'seq' should produce identical AST to 'sequence'"
    );

    let mv_seq_ast = generate_ast("mv seq 1 2").expect("Failed to parse 'mv seq 1 2'");
    assert_eq!(
        base_ast, mv_seq_ast,
        "'mv seq' should produce identical AST to 'rename sequence'"
    );

    let rename_s_ast = generate_ast("rename s 1 2").expect("Failed to parse 'rename s 1 2'");
    assert_eq!(
        base_ast, rename_s_ast,
        "'s' should produce identical AST to 'sequence'"
    );

    let mv_s_ast = generate_ast("mv s 1 2").expect("Failed to parse 'mv s 1 2'");
    assert_eq!(
        base_ast, mv_s_ast,
        "'mv s' should produce identical AST to 'rename sequence'"
    );
}

#[test]
fn test_delete_blueprint_aliases() {
    let base_ast =
        generate_ast("delete blueprint 1").expect("Failed to parse 'delete blueprint 1'");

    // Test "delete" command aliases
    let del_ast = generate_ast("del blueprint 1").expect("Failed to parse 'del blueprint 1'");
    assert_eq!(
        base_ast, del_ast,
        "'del' should produce identical AST to 'delete'"
    );

    let rm_ast = generate_ast("rm blueprint 1").expect("Failed to parse 'rm blueprint 1'");
    assert_eq!(
        base_ast, rm_ast,
        "'rm' should produce identical AST to 'delete'"
    );

    // Test "blueprint" object type aliases
    let delete_bp_ast = generate_ast("delete bp 1").expect("Failed to parse 'delete bp 1'");
    assert_eq!(
        base_ast, delete_bp_ast,
        "'bp' should produce identical AST to 'blueprint'"
    );

    let del_bp_ast = generate_ast("del bp 1").expect("Failed to parse 'del bp 1'");
    assert_eq!(
        base_ast, del_bp_ast,
        "'del bp' should produce identical AST to 'delete blueprint'"
    );

    let rm_bp_ast = generate_ast("rm bp 1").expect("Failed to parse 'rm bp 1'");
    assert_eq!(
        base_ast, rm_bp_ast,
        "'rm bp' should produce identical AST to 'delete blueprint'"
    );
}

#[test]
fn test_rename_blueprint_aliases() {
    let base_ast =
        generate_ast("rename blueprint 1 2").expect("Failed to parse 'rename blueprint 1 2'");

    // Test "rename" command aliases
    let mv_ast = generate_ast("mv blueprint 1 2").expect("Failed to parse 'mv blueprint 1 2'");
    assert_eq!(
        base_ast, mv_ast,
        "'mv' should produce identical AST to 'rename'"
    );

    // Test "blueprint" object type aliases
    let rename_bp_ast = generate_ast("rename bp 1 2").expect("Failed to parse 'rename bp 1 2'");
    assert_eq!(
        base_ast, rename_bp_ast,
        "'bp' should produce identical AST to 'blueprint'"
    );

    let mv_bp_ast = generate_ast("mv bp 1 2").expect("Failed to parse 'mv bp 1 2'");
    assert_eq!(
        base_ast, mv_bp_ast,
        "'mv bp' should produce identical AST to 'rename blueprint'"
    );
}

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

/// Verifies legacy record syntax does not parse for color paths.
#[test]
fn test_record_path_does_not_parse() {
    assert!(
        generate_ast("record path 101").is_err(),
        "record path should not parse"
    );
}

/// Verifies object-local duplicate syntax does not parse for color paths.
#[test]
fn test_path_duplicate_does_not_parse() {
    assert!(
        generate_ast("path 101 duplicate 202").is_err(),
        "path duplicate should not parse"
    );
}

/// Verifies object-local label syntax does not parse for color paths.
#[test]
fn test_path_label_does_not_parse() {
    assert!(
        generate_ast("path 101 label \"No Green\"").is_err(),
        "path label should not parse"
    );
}

/// Verifies list path syntax does not parse for color paths.
#[test]
fn test_list_path_does_not_parse() {
    assert!(
        generate_ast("list path").is_err(),
        "list path should not parse"
    );
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
