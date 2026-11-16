// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::command_types::DmxChannelExpr;
use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_programming::ast_conv::ProgrammerAstConverter;
use nightfall_programming::prelude::{ReleaseCommand, ReleaseTarget, UserCommand};

/// Verifies a bare `release` releases everything.
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

/// Verifies `release fix N` releases that fixture's parameters.
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

/// Verifies a fixture range release selects every fixture in it.
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

/// Verifies `release attr ...` releases those attributes on every fixture.
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

/// Verifies a fixture and attribute release limits the release to both.
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

/// Channel release enters the user command planner so it reaches the real release path.
#[test]
fn test_release_channel_conversion() {
    let ast = generate_ast("release channel 5.").expect("Failed to parse 'release channel 5.'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Expected release user command");
    let UserCommand::Release(release) = cmd else {
        panic!("Expected release command, got {cmd:?}");
    };
    let Some(ReleaseTarget::Channels { channels }) = &release.target else {
        panic!("Expected channel release target, got {:?}", release.target);
    };

    assert_eq!(
        channels,
        &DmxChannelExpr::Range {
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
