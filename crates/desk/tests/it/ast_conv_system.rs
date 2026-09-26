// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use nightfall::command_types::DmxChannelExpr;
use nightfall_cmd_parse::generate_ast;
use nightfall_desk::ast_conv::DeskAstConverter;
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::undo::ClearDmxChannels;
use nightfall_programmer::ast_conv::ProgrammerAstConverter;
use nightfall_programmer::prelude::{ReleaseCommand, ReleaseTarget, UserCommand};

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

// No aliases for system commands currently

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_save_conversion() {
    let ast = generate_ast("save").expect("Failed to parse 'save'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::SaveShowfile(options) => {
            // Success - correct command variant
            assert!(options.active_panel_layout.is_none());
        }
        other => panic!("Expected SaveShowfile command, got {:?}", other),
    }
}

/// Verifies named save commands convert to a named showfile payload.
#[test]
fn test_named_save_conversion() {
    let ast = generate_ast("save demo").expect("Failed to parse 'save demo'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::SaveNamedShowfile { name, options } => {
            assert_eq!(name, "demo");
            assert!(options.active_panel_layout.is_none());
        }
        other => panic!("Expected SaveNamedShowfile command, got {:?}", other),
    }
}

#[test]
fn test_load_conversion() {
    let ast = generate_ast("load").expect("Failed to parse 'load'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::LoadShowfile => {
            // Success - correct command variant
        }
        other => panic!("Expected LoadShowfile command, got {:?}", other),
    }
}

/// Verifies named load commands convert to a named showfile payload.
#[test]
fn test_named_load_conversion() {
    let ast = generate_ast("load demo").expect("Failed to parse 'load demo'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::LoadNamedShowfile(name) => {
            assert_eq!(name, "demo");
        }
        other => panic!("Expected LoadNamedShowfile command, got {:?}", other),
    }
}

/// Verifies explicit draft load paths convert to a draft showfile load.
#[test]
fn test_draft_load_path_conversion() {
    let ast = generate_ast("load draft/default").expect("Failed to parse draft load");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::LoadDraftShowfile(name) => {
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
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::LoadShowfileRevision(selection) => {
            assert_eq!(selection.showfile_name, "default");
            assert_eq!(selection.revision_name, "default-20260707-151450");
        }
        other => panic!("Expected LoadShowfileRevision command, got {:?}", other),
    }
}

/// Verifies new-show commands convert to the fresh-showfile desk command.
#[test]
fn test_new_show_conversion() {
    let ast = generate_ast("new show").expect("Failed to parse 'new show'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::NewShowfile => {
            // Success - correct command variant
        }
        other => panic!("Expected NewShowfile command, got {:?}", other),
    }
}

#[test]
fn test_quit_conversion() {
    let ast = generate_ast("quit").expect("Failed to parse 'quit'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::Quit => {
            // Success - correct command variant
        }
        other => panic!("Expected Quit command, got {:?}", other),
    }
}

#[test]
fn test_sleep_seconds_conversion() {
    let ast = generate_ast("sleep 5").expect("Failed to parse 'sleep 5'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::Sleep(duration) => {
            assert_eq!(
                *duration,
                Duration::from_secs(5),
                "Expected 5 seconds, got {:?}",
                duration
            );
        }
        other => panic!("Expected Sleep command, got {:?}", other),
    }
}

#[test]
fn test_sleep_milliseconds_conversion() {
    let ast = generate_ast("sleep 1500ms").expect("Failed to parse 'sleep 1500ms'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::Sleep(duration) => {
            assert_eq!(
                *duration,
                Duration::from_millis(1500),
                "Expected 1500ms (1.5s), got {:?}",
                duration
            );
        }
        other => panic!("Expected Sleep command, got {:?}", other),
    }
}

#[test]
fn test_sleep_bpm_conversion() {
    let ast = generate_ast("sleep 60bpm").expect("Failed to parse 'sleep 60bpm'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::Sleep(duration) => {
            assert_eq!(
                *duration,
                Duration::from_secs(1),
                "Expected 1 second (60bpm), got {:?}",
                duration
            );
        }
        other => panic!("Expected Sleep command, got {:?}", other),
    }
}

#[test]
fn test_sleep_hz_conversion() {
    let ast = generate_ast("sleep 2hz").expect("Failed to parse 'sleep 2hz'");
    let commands = DeskAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<DeskCommand>();
    assert!(cmd.is_some(), "Command is not a DeskCommand");

    match cmd.unwrap() {
        DeskCommand::Sleep(duration) => {
            assert_eq!(
                *duration,
                Duration::from_millis(500),
                "Expected 500ms (2hz), got {:?}",
                duration
            );
        }
        other => panic!("Expected Sleep command, got {:?}", other),
    }
}

#[test]
fn test_release_all_conversion() {
    let ast = generate_ast("release").expect("Failed to parse 'release'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);

    let cmd0 = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("First command should be UserCommand");
    match cmd0 {
        UserCommand::Release(ReleaseCommand { target: None, .. }) => {}
        other => panic!(
            "Expected release user command with no target, got {:?}",
            other
        ),
    }
}

#[test]
fn test_release_fixture_conversion() {
    let ast = generate_ast("release fix 1").expect("Failed to parse 'release fix 1'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);

    let cmd0 = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("First command should be UserCommand");
    match cmd0 {
        UserCommand::Release(ReleaseCommand {
            target:
                Some(ReleaseTarget::Fixture {
                    selection,
                    attributes,
                }),
            ..
        }) => {
            assert!(
                matches!(
                    selection,
                    nightfall::command_types::SelectionExpr::Fixture(_)
                ),
                "Expected fixture selection"
            );
            assert!(attributes.is_empty(), "Expected no attribute filter");
        }
        other => panic!("Expected fixture release user command, got {:?}", other),
    }
}

#[test]
fn test_release_range_conversion() {
    let ast = generate_ast("release fix 1>10").expect("Failed to parse 'release fix 1>10'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);

    let cmd0 = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("First command should be UserCommand");
    match cmd0 {
        UserCommand::Release(ReleaseCommand {
            target:
                Some(ReleaseTarget::Fixture {
                    selection,
                    attributes,
                }),
            ..
        }) => {
            assert!(
                matches!(
                    selection,
                    nightfall::command_types::SelectionExpr::FixtureRange { .. }
                ),
                "Expected fixture range selection"
            );
            assert!(attributes.is_empty(), "Expected no attribute filter");
        }
        other => panic!(
            "Expected fixture range release user command, got {:?}",
            other
        ),
    }
}

#[test]
fn test_release_attr_conversion() {
    let ast =
        generate_ast("release attr red blue").expect("Failed to parse 'release attr red blue'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command should be UserCommand");

    match cmd {
        UserCommand::Release(ReleaseCommand {
            target: Some(ReleaseTarget::Attribute { attributes }),
            ..
        }) => {
            assert_eq!(attributes.len(), 2, "Expected two attributes");
        }
        other => panic!("Expected attribute release user command, got {:?}", other),
    }
}

#[test]
fn test_release_fixture_attr_conversion() {
    let ast =
        generate_ast("release f 1>3 attr red").expect("Failed to parse 'release f 1>3 attr red'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command should be UserCommand");

    match cmd {
        UserCommand::Release(ReleaseCommand {
            target:
                Some(ReleaseTarget::Fixture {
                    selection,
                    attributes,
                }),
            ..
        }) => {
            assert!(
                matches!(
                    selection,
                    nightfall::command_types::SelectionExpr::FixtureRange { .. }
                ),
                "Expected explicit fixture range selection"
            );
            assert_eq!(attributes.len(), 1, "Expected one attribute");
        }
        other => panic!(
            "Expected fixture+attribute release user command, got {:?}",
            other
        ),
    }
}

#[test]
fn test_release_channel_conversion() {
    let ast = generate_ast("release channel 5.").expect("Failed to parse 'release channel 5.'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<ClearDmxChannels>()
        .expect("Expected ClearDmxChannels command");

    assert_eq!(
        cmd.0.channels,
        DmxChannelExpr::Range {
            start: nightfall::command_types::DmxChannelRef {
                universe: 5,
                address: 1,
            },
            end: nightfall::command_types::DmxChannelRef {
                universe: 5,
                address: 512,
            },
        }
    );
}

/// Verifies stale input release syntax converts to the desk cleanup command.
#[test]
fn test_release_stale_inputs_conversion() {
    let ast = generate_ast("release stale-inputs").expect("Failed to parse 'release stale-inputs'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<DeskCommand>()
        .expect("Expected DeskCommand");

    assert!(matches!(cmd, DeskCommand::ReleaseStaleInputs));
}
