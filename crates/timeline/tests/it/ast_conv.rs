// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_timeline::TimelineCommand;
use nightfall_timeline::ast_conv::TimelineAstConverter;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_timeline_start_aliases() {
    let base_ast = generate_ast("timeline 1 start").expect("Failed to parse 'timeline 1 start'");

    // Test "timeline" object type aliases
    let tl_ast = generate_ast("tl 1 start").expect("Failed to parse 'tl 1 start'");
    assert_eq!(
        base_ast, tl_ast,
        "'tl' should produce identical AST to 'timeline'"
    );
}

#[test]
fn test_timeline_stop_aliases() {
    let base_ast = generate_ast("timeline 1 stop").expect("Failed to parse 'timeline 1 stop'");

    // Test "timeline" object type aliases
    let tl_ast = generate_ast("tl 1 stop").expect("Failed to parse 'tl 1 stop'");
    assert_eq!(
        base_ast, tl_ast,
        "'tl' should produce identical AST to 'timeline'"
    );
}

#[test]
fn test_delete_timeline_aliases() {
    let base_ast = generate_ast("delete timeline 1").expect("Failed to parse 'delete timeline 1'");

    // Test "delete" command aliases
    let del_ast = generate_ast("del timeline 1").expect("Failed to parse 'del timeline 1'");
    assert_eq!(
        base_ast, del_ast,
        "'del' should produce identical AST to 'delete'"
    );

    let rm_ast = generate_ast("rm timeline 1").expect("Failed to parse 'rm timeline 1'");
    assert_eq!(
        base_ast, rm_ast,
        "'rm' should produce identical AST to 'delete'"
    );

    // Test "timeline" object type aliases
    let delete_tl_ast = generate_ast("delete tl 1").expect("Failed to parse 'delete tl 1'");
    assert_eq!(
        base_ast, delete_tl_ast,
        "'tl' should produce identical AST to 'timeline'"
    );

    let del_tl_ast = generate_ast("del tl 1").expect("Failed to parse 'del tl 1'");
    assert_eq!(
        base_ast, del_tl_ast,
        "'del tl' should produce identical AST to 'delete timeline'"
    );

    let rm_tl_ast = generate_ast("rm tl 1").expect("Failed to parse 'rm tl 1'");
    assert_eq!(
        base_ast, rm_tl_ast,
        "'rm tl' should produce identical AST to 'delete timeline'"
    );
}

#[test]
fn test_rename_timeline_aliases() {
    let base_ast =
        generate_ast("rename timeline 1 2").expect("Failed to parse 'rename timeline 1 2'");

    // Test "rename" command aliases
    let mv_ast = generate_ast("mv timeline 1 2").expect("Failed to parse 'mv timeline 1 2'");
    assert_eq!(
        base_ast, mv_ast,
        "'mv' should produce identical AST to 'rename'"
    );

    // Test "timeline" object type aliases
    let rename_tl_ast = generate_ast("rename tl 1 2").expect("Failed to parse 'rename tl 1 2'");
    assert_eq!(
        base_ast, rename_tl_ast,
        "'tl' should produce identical AST to 'timeline'"
    );

    let mv_tl_ast = generate_ast("mv tl 1 2").expect("Failed to parse 'mv tl 1 2'");
    assert_eq!(
        base_ast, mv_tl_ast,
        "'mv tl' should produce identical AST to 'rename timeline'"
    );
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

/// Verifies storing a timeline creates and links its default timecode pair.
#[test]
fn test_store_timeline_conversion() {
    let ast = generate_ast("store timeline 7").expect("Failed to parse 'store timeline 7'");
    let commands = TimelineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let timeline_command = commands[0]
        .as_any()
        .downcast_ref::<TimelineCommand>()
        .expect("Command is not a TimelineCommand");
    let TimelineCommand::CreateTimeline { timeline, timecode } = timeline_command else {
        panic!("Expected CreateTimeline command, got {timeline_command:?}");
    };
    assert_eq!(timeline.identifiers.id, 7);
    assert_eq!(timeline.identifiers.label, "Timeline 7");
    assert_eq!(timecode.identifiers.id, 7);
    assert_eq!(timeline.timecode_uid, timecode.identifiers.uid);
}

/// Verifies timeline store ranges create linked timecode/timeline pairs in ID order.
#[test]
fn test_store_timeline_range_conversion() {
    let ast = generate_ast("store timeline 7>8").expect("Failed to parse timeline store range");
    let commands = TimelineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 2);
    for (index, expected_id) in [7, 8].into_iter().enumerate() {
        let timeline_command = commands[index]
            .as_any()
            .downcast_ref::<TimelineCommand>()
            .expect("Range command is not a TimelineCommand");
        let TimelineCommand::CreateTimeline { timeline, timecode } = timeline_command else {
            panic!("Expected CreateTimeline command, got {timeline_command:?}");
        };
        assert_eq!(timecode.identifiers.id, expected_id);
        assert_eq!(timeline.identifiers.id, expected_id);
        assert_eq!(timeline.timecode_uid, timecode.identifiers.uid);
    }
}

#[test]
fn test_timeline_start_conversion() {
    let ast = generate_ast("timeline 1 start").expect("Failed to parse 'timeline 1 start'");
    let commands = TimelineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimelineCommand>();
    assert!(cmd.is_some(), "Command is not a TimelineCommand");

    match cmd.unwrap() {
        TimelineCommand::StartTimeline(timeline_id) => {
            assert_eq!(
                *timeline_id, 1,
                "Expected timeline ID 1, got {}",
                timeline_id
            );
        }
        other => panic!("Expected StartTimeline command, got {:?}", other),
    }
}

#[test]
fn test_timeline_stop_conversion() {
    let ast = generate_ast("timeline 1 stop").expect("Failed to parse 'timeline 1 stop'");
    let commands = TimelineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimelineCommand>();
    assert!(cmd.is_some(), "Command is not a TimelineCommand");

    match cmd.unwrap() {
        TimelineCommand::StopTimeline(timeline_id) => {
            assert_eq!(
                *timeline_id, 1,
                "Expected timeline ID 1, got {}",
                timeline_id
            );
        }
        other => panic!("Expected StopTimeline command, got {:?}", other),
    }
}

#[test]
fn test_delete_timeline_conversion() {
    let ast = generate_ast("delete timeline 1").expect("Failed to parse 'delete timeline 1'");
    let commands = TimelineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimelineCommand>();
    assert!(cmd.is_some(), "Command is not a TimelineCommand");

    match cmd.unwrap() {
        TimelineCommand::DeleteTimeline(timeline_id) => {
            assert_eq!(
                *timeline_id, 1,
                "Expected timeline ID 1, got {}",
                timeline_id
            );
        }
        other => panic!("Expected DeleteTimeline command, got {:?}", other),
    }
}

#[test]
fn test_rename_timeline_conversion() {
    let ast = generate_ast("rename timeline 1 2").expect("Failed to parse 'rename timeline 1 2'");
    let commands = TimelineAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<TimelineCommand>();
    assert!(cmd.is_some(), "Command is not a TimelineCommand");

    match cmd.unwrap() {
        TimelineCommand::RenameTimeline { id, new_id } => {
            assert_eq!(*id, 1, "Expected original timeline ID 1, got {}", id);
            assert_eq!(*new_id, 2, "Expected new timeline ID 2, got {}", new_id);
        }
        other => panic!("Expected RenameTimeline command, got {:?}", other),
    }
}
