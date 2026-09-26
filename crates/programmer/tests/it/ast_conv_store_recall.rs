// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::*;
use nightfall_cmd_parse::generate_ast;
use nightfall_dmx::prelude::{Attribute, AttributeCategory};
use nightfall_engine::prelude::*;
use nightfall_programmer::ast_conv::ProgrammerAstConverter;
use nightfall_programmer::prelude::*;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_store_cue_aliases() {
    let base_ast = generate_ast("store cue 1.5").expect("Failed to parse 'store cue 1.5'");

    // Test "c" alias produces identical AST to "cue"
    let c_ast = generate_ast("store c 1.5").expect("Failed to parse 'store c 1.5'");
    assert_eq!(base_ast, c_ast, "'c' should produce identical AST to 'cue'");
}

#[test]
fn test_store_group_aliases() {
    let base_ast = generate_ast("store group 5").expect("Failed to parse 'store group 5'");

    // Test "grp" alias produces identical AST to "group"
    let grp_ast = generate_ast("store grp 5").expect("Failed to parse 'store grp 5'");
    assert_eq!(
        base_ast, grp_ast,
        "'grp' should produce identical AST to 'group'"
    );

    // Test "g" alias produces identical AST to "group"
    let g_ast = generate_ast("store g 5").expect("Failed to parse 'store g 5'");
    assert_eq!(
        base_ast, g_ast,
        "'g' should produce identical AST to 'group'"
    );
}

#[test]
fn test_store_blueprint_aliases() {
    let base_ast = generate_ast("store blueprint 1").expect("Failed to parse 'store blueprint 1'");

    // Test "bp" alias produces identical AST to "blueprint"
    let bp_ast = generate_ast("store bp 1").expect("Failed to parse 'store bp 1'");
    assert_eq!(
        base_ast, bp_ast,
        "'bp' should produce identical AST to 'blueprint'"
    );
}

#[test]
fn test_recall_cue_aliases() {
    let base_ast = generate_ast("recall cue 1.5").expect("Failed to parse 'recall cue 1.5'");

    // Test "c" alias produces identical AST to "cue"
    let c_ast = generate_ast("recall c 1.5").expect("Failed to parse 'recall c 1.5'");
    assert_eq!(base_ast, c_ast, "'c' should produce identical AST to 'cue'");
}

#[test]
fn test_recall_blueprint_aliases() {
    let base_ast =
        generate_ast("recall blueprint 1").expect("Failed to parse 'recall blueprint 1'");

    // Test "bp" alias produces identical AST to "blueprint"
    let bp_ast = generate_ast("recall bp 1").expect("Failed to parse 'recall bp 1'");
    assert_eq!(
        base_ast, bp_ast,
        "'bp' should produce identical AST to 'blueprint'"
    );
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_store_cue_conversion() {
    let ast = generate_ast("store cue 1.5").expect("Failed to parse 'store cue 1.5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreCue {
            sequence_id,
            cue_id,
            part_id,
            mode,
            label,
        } => {
            assert_eq!(
                *sequence_id, 1,
                "Expected sequence ID 1, got {}",
                sequence_id
            );
            assert_eq!(*cue_id, StoreCueId::Exact(5));
            assert_eq!(*part_id, StoreCuePartId::Exact(0));
            assert_eq!(*mode, StoreMode::Replace);
            assert_eq!(*label, None, "Expected no label");
        }
        other => panic!("Expected StoreCue command, got {:?}", other),
    }
}

/// Verifies a nested cue range expands into ordered stores within one sequence.
#[test]
fn test_store_cue_range_conversion() {
    let ast = generate_ast("store cue 11.(1>5)").expect("Failed to parse cue store range");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cue_ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<ProgrammerCommand>()
                .expect("Command is not a ProgrammerCommand");
            let ProgrammerCommand::StoreCue {
                sequence_id,
                cue_id: StoreCueId::Exact(cue_id),
                part_id: StoreCuePartId::Exact(0),
                mode: StoreMode::Replace,
                label: None,
            } = command
            else {
                panic!("Expected exact StoreCue command, got {command:?}");
            };
            assert_eq!(*sequence_id, 11);
            *cue_id
        })
        .collect::<Vec<_>>();

    assert_eq!(cue_ids, vec![1, 2, 3, 4, 5]);
}

#[test]
fn test_store_setup_cue_conversion() {
    let ast = generate_ast("store cue 1.0").expect("Failed to parse 'store cue 1.0'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreCue {
            sequence_id,
            cue_id,
            part_id,
            mode,
            label,
        } => {
            assert_eq!(
                *sequence_id, 1,
                "Expected sequence ID 1, got {}",
                sequence_id
            );
            assert_eq!(*cue_id, StoreCueId::Exact(0));
            assert_eq!(*part_id, StoreCuePartId::Exact(0));
            assert_eq!(*mode, StoreMode::Replace);
            assert_eq!(*label, None, "Expected no label");
        }
        other => panic!("Expected StoreCue command, got {:?}", other),
    }
}

#[test]
fn test_store_cue_different_id_conversion() {
    let ast = generate_ast("store cue 2.10").expect("Failed to parse 'store cue 2.10'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreCue {
            sequence_id,
            cue_id,
            part_id,
            mode,
            label,
        } => {
            assert_eq!(
                *sequence_id, 2,
                "Expected sequence ID 2, got {}",
                sequence_id
            );
            assert_eq!(*cue_id, StoreCueId::Exact(10));
            assert_eq!(*part_id, StoreCuePartId::Exact(0));
            assert_eq!(*mode, StoreMode::Replace);
            assert_eq!(*label, None, "Expected no label");
        }
        other => panic!("Expected StoreCue command, got {:?}", other),
    }
}

#[test]
fn test_store_cue_part_conversion() {
    let ast = generate_ast("store cue 1.5p2").expect("Failed to parse 'store cue 1.5p2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreCue {
            sequence_id,
            cue_id,
            part_id,
            mode,
            label,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, StoreCueId::Exact(5));
            assert_eq!(*part_id, StoreCuePartId::Exact(2));
            assert_eq!(*mode, StoreMode::Replace);
            assert_eq!(*label, None, "Expected no label");
        }
        other => panic!("Expected StoreCue command, got {:?}", other),
    }
}

/// Verifies p0 store syntax targets the parent cue rather than a real cue part.
#[test]
fn test_store_cue_part_zero_conversion_targets_parent_cue() {
    let ast = generate_ast("store cue 1.5p0").expect("Failed to parse 'store cue 1.5p0'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<ProgrammerCommand>()
        .expect("Command is not a ProgrammerCommand");
    match cmd {
        ProgrammerCommand::StoreCue {
            sequence_id,
            cue_id,
            part_id,
            mode,
            label,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, StoreCueId::Exact(5));
            assert_eq!(*part_id, StoreCuePartId::Exact(0));
            assert_eq!(*mode, StoreMode::Replace);
            assert_eq!(*label, None);
        }
        other => panic!("Expected StoreCue command, got {:?}", other),
    }
}

/// Verifies append cue syntax converts to a next-cue store target.
#[test]
fn test_store_cue_append_conversion() {
    let ast = generate_ast("store cue 1.").expect("Failed to parse 'store cue 1.'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0]
        .as_any()
        .downcast_ref::<ProgrammerCommand>()
        .expect("Command is not a ProgrammerCommand");
    match cmd {
        ProgrammerCommand::StoreCue {
            sequence_id,
            cue_id,
            part_id,
            mode,
            label,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, StoreCueId::Next);
            assert_eq!(*part_id, StoreCuePartId::Exact(0));
            assert_eq!(*mode, StoreMode::Replace);
            assert_eq!(*label, None);
        }
        other => panic!("Expected StoreCue command, got {:?}", other),
    }
}

/// Verifies append cue-part syntax converts to a next-part store target.
#[test]
fn test_store_cue_part_append_conversion() {
    let ast = generate_ast("store cue 1.5p").expect("Failed to parse 'store cue 1.5p'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0]
        .as_any()
        .downcast_ref::<ProgrammerCommand>()
        .expect("Command is not a ProgrammerCommand");
    match cmd {
        ProgrammerCommand::StoreCue {
            sequence_id,
            cue_id,
            part_id,
            mode,
            label,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, StoreCueId::Exact(5));
            assert_eq!(*part_id, StoreCuePartId::Next);
            assert_eq!(*mode, StoreMode::Replace);
            assert_eq!(*label, None);
        }
        other => panic!("Expected StoreCue command, got {:?}", other),
    }
}

/// Verifies cue store mode flags convert to programmer store modes.
#[test]
fn test_store_cue_mode_flag_conversion() {
    for (input, expected_mode) in [
        ("store cue 1.5 /merge", StoreMode::Merge),
        ("store cue 1.5 /update", StoreMode::Update),
        ("store cue 1.5 /remove", StoreMode::Remove),
    ] {
        let ast = generate_ast(input).expect("Failed to parse store cue mode");
        let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");
        let cmd = commands[0]
            .as_any()
            .downcast_ref::<ProgrammerCommand>()
            .expect("Command is not a ProgrammerCommand");
        match cmd {
            ProgrammerCommand::StoreCue { mode, .. } => assert_eq!(*mode, expected_mode),
            other => panic!("Expected StoreCue command, got {:?}", other),
        }
    }
}

#[test]
fn test_store_group_conversion() {
    let ast = generate_ast("store group 5").expect("Failed to parse 'store group 5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreGroup { group_id, label } => {
            assert_eq!(*group_id, 5, "Expected group ID 5, got {}", group_id);
            assert_eq!(*label, None, "Expected no label");
        }
        other => panic!("Expected StoreGroup command, got {:?}", other),
    }
}

#[test]
fn test_store_group_different_id_conversion() {
    let ast = generate_ast("store group 10").expect("Failed to parse 'store group 10'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreGroup { group_id, label } => {
            assert_eq!(*group_id, 10, "Expected group ID 10, got {}", group_id);
            assert_eq!(*label, None, "Expected no label");
        }
        other => panic!("Expected StoreGroup command, got {:?}", other),
    }
}

/// Verifies group store ranges create one group command per selected ID.
#[test]
fn test_store_group_range_conversion() {
    let ast = generate_ast("store group 5>7").expect("Failed to parse group store range");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<ProgrammerCommand>()
                .expect("Command is not a ProgrammerCommand");
            let ProgrammerCommand::StoreGroup { group_id, .. } = command else {
                panic!("Expected StoreGroup command, got {command:?}");
            };
            *group_id
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![5, 6, 7]);
}

/// Verifies the selection-independent Blueprint store command converts directly.
#[test]
fn test_store_blueprint_default_conversion() {
    let ast = generate_ast("store blueprint 1").expect("Failed to parse 'store blueprint 1'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreBlueprint {
            blueprint_id,
            filter,
        } => {
            assert_eq!(
                *blueprint_id, 1,
                "Expected blueprint ID 1, got {}",
                blueprint_id
            );
            assert!(filter.is_empty(), "Expected empty filter");
        }
        other => panic!("Expected StoreBlueprint command, got {:?}", other),
    }
}

/// Verifies blueprint store ranges create one selection-independent definition per ID.
#[test]
fn test_store_blueprint_range_conversion() {
    let ast = generate_ast("store blueprint 2>4").expect("Failed to parse blueprint store range");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<ProgrammerCommand>()
                .expect("Command is not a ProgrammerCommand");
            let ProgrammerCommand::StoreBlueprint { blueprint_id, .. } = command else {
                panic!("Expected StoreBlueprint command, got {command:?}");
            };
            *blueprint_id
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![2, 3, 4]);
}

#[test]
fn test_store_blueprint_different_id_conversion() {
    let ast = generate_ast("store blueprint 2").expect("Failed to parse 'store blueprint 2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreBlueprint { blueprint_id, .. } => {
            assert_eq!(
                *blueprint_id, 2,
                "Expected blueprint ID 2, got {}",
                blueprint_id
            );
        }
        other => panic!("Expected StoreBlueprint command, got {:?}", other),
    }
}

#[test]
fn programmer_command_store_cue_formats_to_cli() {
    let command = ProgrammerCommand::StoreCue {
        sequence_id: 7,
        cue_id: StoreCueId::Exact(42),
        part_id: StoreCuePartId::Exact(0),
        mode: StoreMode::Replace,
        label: Some("Intro".to_string()),
    };
    assert_eq!(command.to_cli_command().as_deref(), Some("store cue 7.42"),);
}

#[test]
fn programmer_command_store_cue_part_formats_to_cli() {
    let command = ProgrammerCommand::StoreCue {
        sequence_id: 7,
        cue_id: StoreCueId::Exact(42),
        part_id: StoreCuePartId::Exact(3),
        mode: StoreMode::Replace,
        label: Some("Look".to_string()),
    };
    assert_eq!(
        command.to_cli_command().as_deref(),
        Some("store cue 7.42p3"),
    );
}

/// Verifies p0 typed store commands render as parent cue stores.
#[test]
fn programmer_command_store_cue_part_zero_formats_to_parent_cue_cli() {
    let command = ProgrammerCommand::StoreCue {
        sequence_id: 7,
        cue_id: StoreCueId::Exact(42),
        part_id: StoreCuePartId::Exact(0),
        mode: StoreMode::Replace,
        label: Some("Look".to_string()),
    };
    assert_eq!(command.to_cli_command().as_deref(), Some("store cue 7.42"),);
}

/// Verifies remove store mode is rendered back to parser-compatible CLI text.
#[test]
fn programmer_command_store_cue_remove_formats_to_cli() {
    let command = ProgrammerCommand::StoreCue {
        sequence_id: 7,
        cue_id: StoreCueId::Exact(42),
        part_id: StoreCuePartId::Exact(0),
        mode: StoreMode::Remove,
        label: Some("Intro".to_string()),
    };
    assert_eq!(
        command.to_cli_command().as_deref(),
        Some("store cue 7.42 /remove"),
    );
}

#[test]
fn programmer_command_recall_cue_part_formats_to_cli() {
    let command = ProgrammerCommand::RecallCue {
        sequence_id: 7,
        cue_id: 42,
        part_id: 3,
        select: false,
    };
    assert_eq!(
        command.to_cli_command().as_deref(),
        Some("recall cue 7.42p3"),
    );
}

/// Verifies p0 typed recall commands render as parent cue recalls.
#[test]
fn programmer_command_recall_cue_part_zero_formats_to_parent_cue_cli() {
    let command = ProgrammerCommand::RecallCue {
        sequence_id: 7,
        cue_id: 42,
        part_id: 0,
        select: false,
    };
    assert_eq!(command.to_cli_command().as_deref(), Some("recall cue 7.42"),);
}

/// Verifies flagged recall commands render back to parser-compatible CLI text.
#[test]
fn programmer_command_recall_cue_select_formats_to_cli() {
    let command = ProgrammerCommand::RecallCue {
        sequence_id: 7,
        cue_id: 42,
        part_id: 0,
        select: true,
    };
    assert_eq!(
        command.to_cli_command().as_deref(),
        Some("recall cue 7.42 /select"),
    );
}

#[test]
fn programmer_command_release_attr_formats_to_cli() {
    let command = ProgrammerCommand::ReleaseProgrammerValues {
        selection: None,
        attributes: vec![Attribute::Red, Attribute::Blue],
        allow_selection_flatten: false,
        selection_flatten_approval: None,
    };
    assert_eq!(
        command.to_cli_command().as_deref(),
        Some("release attr red blue"),
    );
}

#[test]
fn test_store_blueprint_with_filter_conversion() {
    let ast = generate_ast("store blueprint 1 filter int red")
        .expect("Failed to parse 'store blueprint 1 filter int red'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::StoreBlueprint { filter, .. } => {
            assert_eq!(
                filter,
                &vec![
                    BlueprintSelector::Attribute(Attribute::Intensity),
                    BlueprintSelector::Attribute(Attribute::Red),
                ]
            );
        }
        other => panic!("Expected StoreBlueprint command, got {:?}", other),
    }
}

/// Unquoted category names remain dynamic filters while quoted names remain custom attributes.
#[test]
fn store_blueprint_filter_distinguishes_category_and_attribute() {
    let ast = generate_ast("store blueprint 1 filter color \"color\"")
        .expect("Blueprint category filter should parse");
    let commands = ProgrammerAstConverter::convert(&ast).expect("AST should convert");
    let command = commands[0]
        .as_any()
        .downcast_ref::<ProgrammerCommand>()
        .expect("command should be a ProgrammerCommand");
    let ProgrammerCommand::StoreBlueprint { filter, .. } = command else {
        panic!("expected Blueprint store command")
    };
    assert_eq!(
        filter,
        &vec![
            BlueprintSelector::Category(AttributeCategory::Color),
            BlueprintSelector::Attribute(Attribute::Custom {
                label: "color".to_owned(),
            }),
        ]
    );
}

#[test]
fn test_recall_cue_conversion() {
    let ast = generate_ast("recall cue 1.5").expect("Failed to parse 'recall cue 1.5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::RecallCue {
            sequence_id,
            cue_id,
            part_id,
            select,
        } => {
            assert_eq!(
                *sequence_id, 1,
                "Expected sequence ID 1, got {}",
                sequence_id
            );
            assert_eq!(*cue_id, 5, "Expected cue ID 5, got {}", cue_id);
            assert_eq!(*part_id, 0);
            assert!(!select);
        }
        other => panic!("Expected RecallCue command, got {:?}", other),
    }
}

/// Verifies recall cue select flag conversion enables active-selection recall.
#[test]
fn test_recall_cue_select_flag_conversion() {
    let ast =
        generate_ast("recall cue 1.5 /select").expect("Failed to parse 'recall cue 1.5 /select'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::RecallCue {
            sequence_id,
            cue_id,
            part_id,
            select,
        } => {
            assert_eq!(*sequence_id, 1);
            assert_eq!(*cue_id, 5);
            assert_eq!(*part_id, 0);
            assert!(select);
        }
        other => panic!("Expected RecallCue command, got {:?}", other),
    }
}

#[test]
fn test_recall_cue_different_id_conversion() {
    let ast = generate_ast("recall cue 3.10").expect("Failed to parse 'recall cue 3.10'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::RecallCue {
            sequence_id,
            cue_id,
            part_id,
            select,
        } => {
            assert_eq!(
                *sequence_id, 3,
                "Expected sequence ID 3, got {}",
                sequence_id
            );
            assert_eq!(*cue_id, 10, "Expected cue ID 10, got {}", cue_id);
            assert_eq!(*part_id, 0);
            assert!(!select);
        }
        other => panic!("Expected RecallCue command, got {:?}", other),
    }
}

#[test]
fn test_recall_cue_part_conversion() {
    let ast = generate_ast("recall cue 3.10p4").expect("Failed to parse 'recall cue 3.10p4'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::RecallCue {
            sequence_id,
            cue_id,
            part_id,
            select,
        } => {
            assert_eq!(*sequence_id, 3);
            assert_eq!(*cue_id, 10);
            assert_eq!(*part_id, 4);
            assert!(!select);
        }
        other => panic!("Expected RecallCue command, got {:?}", other),
    }
}

/// Verifies p0 recall syntax targets the parent cue rather than a real cue part.
#[test]
fn test_recall_cue_part_zero_conversion_targets_parent_cue() {
    let ast = generate_ast("recall cue 3.10p0").expect("Failed to parse 'recall cue 3.10p0'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::RecallCue {
            sequence_id,
            cue_id,
            part_id,
            select,
        } => {
            assert_eq!(*sequence_id, 3);
            assert_eq!(*cue_id, 10);
            assert_eq!(*part_id, 0);
            assert!(!select);
        }
        other => panic!("Expected RecallCue command, got {:?}", other),
    }
}

#[test]
fn test_recall_blueprint_conversion() {
    let ast = generate_ast("recall blueprint 1").expect("Failed to parse 'recall blueprint 1'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    let ProgrammerCommand::ApplyAttributeOperations { operations, .. } = cmd.unwrap() else {
        panic!("Expected Blueprint attribute operations")
    };
    assert!(matches!(
        operations.as_slice(),
        [ProgrammerAttributeOperation {
            target: BlueprintSelector::All,
            source: ProgrammerAttributeSource::Blueprint {
                address: BlueprintAddress::Id(1),
                resolution: BlueprintResolution::Reference,
            },
        }]
    ));
}

#[test]
fn test_recall_blueprint_different_id_conversion() {
    let ast = generate_ast("recall blueprint 5").expect("Failed to parse 'recall blueprint 5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    let ProgrammerCommand::ApplyAttributeOperations { operations, .. } = cmd.unwrap() else {
        panic!("Expected Blueprint attribute operations")
    };
    assert!(matches!(
        operations.as_slice(),
        [ProgrammerAttributeOperation {
            target: BlueprintSelector::All,
            source: ProgrammerAttributeSource::Blueprint {
                address: BlueprintAddress::Id(5),
                resolution: BlueprintResolution::Reference,
            },
        }]
    ));
}

#[test]
fn test_clear_conversion() {
    let ast = generate_ast("clear").expect("Failed to parse 'clear'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");
    assert_eq!(cmd, &UserCommand::Clear(ClearCommand::default()));
}
