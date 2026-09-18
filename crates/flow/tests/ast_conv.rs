// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::Identifiers;
use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_flow::ast_conv::FlowAstConverter;
use nightfall_flow::{FlowCommand, FlowDefinition};
use uuid::Uuid;

fn escape_json(input: &str) -> String {
    input.replace('"', "\\\"")
}

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_flow_delete_aliases() {
    let base_ast = generate_ast("flow 1 delete").expect("Failed to parse 'flow 1 delete'");

    let del_ast = generate_ast("flow 1 del").expect("Failed to parse 'flow 1 del'");
    assert_eq!(
        base_ast, del_ast,
        "'del' should produce identical AST to 'delete'"
    );

    let rm_ast = generate_ast("flow 1 rm").expect("Failed to parse 'flow 1 rm'");
    assert_eq!(
        base_ast, rm_ast,
        "'rm' should produce identical AST to 'delete'"
    );
}

#[test]
fn test_flow_rename_aliases() {
    let base_ast = generate_ast("flow 1 rename 2").expect("Failed to parse 'flow 1 rename 2'");
    let mv_ast = generate_ast("flow 1 mv 2").expect("Failed to parse 'flow 1 mv 2'");
    assert_eq!(
        base_ast, mv_ast,
        "'mv' should produce identical AST to 'rename'"
    );
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_flow_start_conversion() {
    let ast = generate_ast("flow 1 start").expect("Failed to parse 'flow 1 start'");
    let commands = FlowAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FlowCommand>();
    assert!(cmd.is_some(), "Command is not a FlowCommand");

    match cmd.unwrap() {
        FlowCommand::StartFlow(id) => assert_eq!(*id, 1),
        other => panic!("Expected StartFlow, got {:?}", other),
    }
}

#[test]
fn test_flow_stop_conversion() {
    let ast = generate_ast("flow 1 stop").expect("Failed to parse 'flow 1 stop'");
    let commands = FlowAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FlowCommand>();
    assert!(cmd.is_some(), "Command is not a FlowCommand");

    match cmd.unwrap() {
        FlowCommand::StopFlow(id) => assert_eq!(*id, 1),
        other => panic!("Expected StopFlow, got {:?}", other),
    }
}

#[test]
fn test_flow_go_conversion() {
    let ast = generate_ast("flow 1 go").expect("Failed to parse 'flow 1 go'");
    let commands = FlowAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FlowCommand>();
    assert!(cmd.is_some(), "Command is not a FlowCommand");

    match cmd.unwrap() {
        FlowCommand::GoFlow(id) => assert_eq!(*id, 1),
        other => panic!("Expected GoFlow, got {:?}", other),
    }
}

#[test]
fn test_flow_delete_conversion() {
    let ast = generate_ast("flow 2 delete").expect("Failed to parse 'flow 2 delete'");
    let commands = FlowAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FlowCommand>();
    assert!(cmd.is_some(), "Command is not a FlowCommand");

    match cmd.unwrap() {
        FlowCommand::DeleteFlow(id) => assert_eq!(*id, 2),
        other => panic!("Expected DeleteFlow, got {:?}", other),
    }
}

#[test]
fn test_flow_rename_conversion() {
    let ast = generate_ast("flow 3 rename 9").expect("Failed to parse 'flow 3 rename 9'");
    let commands = FlowAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FlowCommand>();
    assert!(cmd.is_some(), "Command is not a FlowCommand");

    match cmd.unwrap() {
        FlowCommand::RenameFlow { id, new_id } => {
            assert_eq!(*id, 3);
            assert_eq!(*new_id, 9);
        }
        other => panic!("Expected RenameFlow, got {:?}", other),
    }
}

/// Verifies storing a flow without a payload creates the standard empty definition.
#[test]
fn test_flow_store_default_conversion() {
    let ast = generate_ast("store flow 5").expect("Failed to parse 'store flow 5'");
    let commands = FlowAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FlowCommand>();
    assert!(cmd.is_some(), "Command is not a FlowCommand");

    match cmd.unwrap() {
        FlowCommand::StoreFlow(flow) => {
            assert_eq!(flow.identifiers.id, 5);
            assert_eq!(flow.identifiers.label, "Flow 5");
            assert!(flow.nodes.is_empty());
            assert!(flow.edges.is_empty());
        }
        other => panic!("Expected StoreFlow, got {:?}", other),
    }
}

/// Verifies flow store ranges create one empty definition for each selected ID.
#[test]
fn test_flow_store_range_conversion() {
    let ast = generate_ast("store flow 3>5").expect("Failed to parse flow store range");
    let commands = FlowAstConverter::convert(&ast).expect("Failed to convert AST");

    let ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<FlowCommand>()
                .expect("Command is not a FlowCommand");
            let FlowCommand::StoreFlow(flow) = command else {
                panic!("Expected StoreFlow command, got {command:?}");
            };
            flow.identifiers.id
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![3, 4, 5]);
}

/// Verifies storing a flow from serialized data preserves its definition.
#[test]
fn test_flow_store_payload_conversion() {
    let identifiers = Identifiers {
        id: 7,
        uid: Uuid::from_u128(7),
        label: "Test Flow".to_string(),
    };
    let flow = FlowDefinition::new(identifiers);
    let json = serde_json::to_string(&flow).expect("Failed to serialize flow");
    let escaped = escape_json(&json);
    let cmd = format!("store flow 7 \"{}\"", escaped);

    let ast = generate_ast(&cmd).expect("Failed to parse flow store payload");
    let commands = FlowAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FlowCommand>();
    assert!(cmd.is_some(), "Command is not a FlowCommand");

    match cmd.unwrap() {
        FlowCommand::StoreFlow(flow) => {
            assert_eq!(flow.identifiers.id, 7);
            assert_eq!(flow.identifiers.label, "Test Flow");
        }
        other => panic!("Expected StoreFlow, got {:?}", other),
    }
}
