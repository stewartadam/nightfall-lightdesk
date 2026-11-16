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
