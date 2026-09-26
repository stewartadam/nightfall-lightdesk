// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::SelectionExpr;
use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_programmer::ast_conv::ProgrammerAstConverter;
use nightfall_programmer::prelude::{ClearCommand, ClearTarget, UserCommand};

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_clear_selection_aliases() {
    let base_ast = generate_ast("clear selection").expect("Failed to parse 'clear selection'");
    let sel_ast = generate_ast("clear sel").expect("Failed to parse 'clear sel'");
    assert_eq!(
        base_ast, sel_ast,
        "'clear sel' should produce identical AST to 'clear selection'"
    );
}

#[test]
fn test_clear_values_aliases() {
    let base_ast = generate_ast("clear values").expect("Failed to parse 'clear values'");
    let val_ast = generate_ast("clear val").expect("Failed to parse 'clear val'");
    assert_eq!(
        base_ast, val_ast,
        "'clear val' should produce identical AST to 'clear values'"
    );
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

fn clear_targets(command: &UserCommand) -> &[ClearTarget] {
    match command {
        UserCommand::Clear(ClearCommand { targets, .. }) => targets.as_slice(),
        other => panic!("Expected UserCommand::Clear, got {:?}", other),
    }
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

#[test]
fn test_clear_selection_conversion() {
    let ast = generate_ast("clear selection").expect("Failed to parse 'clear selection'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");
    assert_eq!(clear_targets(cmd), &[ClearTarget::Selection]);
}

#[test]
fn test_clear_values_conversion() {
    let ast = generate_ast("clear values").expect("Failed to parse 'clear values'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");
    assert_eq!(clear_targets(cmd), &[ClearTarget::Values]);
}

#[test]
fn test_clear_selection_and_values_conversion() {
    let ast =
        generate_ast("clear selection values").expect("Failed to parse 'clear selection values'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");
    assert_eq!(
        clear_targets(cmd),
        &[ClearTarget::Selection, ClearTarget::Values]
    );
}

#[test]
fn test_clear_values_and_selection_conversion() {
    let ast =
        generate_ast("clear values selection").expect("Failed to parse 'clear values selection'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");
    assert_eq!(
        clear_targets(cmd),
        &[ClearTarget::Values, ClearTarget::Selection]
    );
}

#[test]
fn test_clear_duplicate_targets_deduplicated() {
    let ast = generate_ast("clear selection selection")
        .expect("Failed to parse 'clear selection selection'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");
    assert_eq!(clear_targets(cmd), &[ClearTarget::Selection]);
}

#[test]
fn test_clear_fixture_conversion() {
    let ast = generate_ast("clear fix 1>3").expect("Failed to parse 'clear fix 1>3'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");

    match clear_targets(cmd) {
        [
            ClearTarget::Fixture {
                selection,
                attributes,
            },
        ] => {
            assert!(
                matches!(selection, SelectionExpr::FixtureRange { .. }),
                "expected fixture range selection",
            );
            assert!(attributes.is_empty(), "Expected no attribute filter");
        }
        other => panic!("Expected fixture clear target, got {:?}", other),
    }
}

#[test]
fn test_clear_fixture_attr_conversion() {
    let ast =
        generate_ast("clear f 1 attr red blue").expect("Failed to parse 'clear f 1 attr red blue'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");

    match clear_targets(cmd) {
        [ClearTarget::Fixture { attributes, .. }] => {
            assert_eq!(attributes.len(), 2, "Expected two attributes");
        }
        other => panic!("Expected fixture clear target, got {:?}", other),
    }
}

#[test]
fn test_clear_attr_conversion() {
    let ast = generate_ast("clear attr red").expect("Failed to parse 'clear attr red'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0]
        .as_any()
        .downcast_ref::<UserCommand>()
        .expect("Command is not a UserCommand");

    match clear_targets(cmd) {
        [ClearTarget::Attribute { attributes }] => {
            assert_eq!(attributes.len(), 1, "Expected one attribute");
        }
        other => panic!("Expected attribute clear target, got {:?}", other),
    }
}
