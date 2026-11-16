// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command line conversion of group and Blueprint delete and rename commands.

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_programming::ast_conv::ProgrammerAstConverter;
use nightfall_programming::prelude::*;

/// Converts one command line into the single payload the programming converter produces.
fn convert_one(command: &str) -> DynEnginePayload {
    let ast = generate_ast(command).unwrap_or_else(|_| panic!("failed to parse '{command}'"));
    let mut commands = ProgrammerAstConverter::convert(&ast).expect("failed to convert AST");
    assert_eq!(
        commands.len(),
        1,
        "'{command}' should convert to one command"
    );
    commands.remove(0)
}

/// `delete group N` becomes a group delete for that number.
#[test]
fn delete_group_converts_to_group_command() {
    let command = convert_one("delete group 1");
    assert!(matches!(
        command.as_any().downcast_ref::<GroupCommand>(),
        Some(GroupCommand::DeleteGroup(1))
    ));
}

/// `rename group N M` becomes a group rename from N to M.
#[test]
fn rename_group_converts_to_group_command() {
    let command = convert_one("rename group 1 2");
    assert!(matches!(
        command.as_any().downcast_ref::<GroupCommand>(),
        Some(GroupCommand::RenameGroup { id: 1, new_id: 2 })
    ));
}

/// `delete blueprint N` becomes a Blueprint delete for that number.
#[test]
fn delete_blueprint_converts_to_blueprint_command() {
    let command = convert_one("delete blueprint 3");
    assert!(matches!(
        command.as_any().downcast_ref::<BlueprintCommand>(),
        Some(BlueprintCommand::DeleteBlueprint(3))
    ));
}

/// `rename blueprint N M` becomes a Blueprint rename from N to M.
#[test]
fn rename_blueprint_converts_to_blueprint_command() {
    let command = convert_one("rename blueprint 3 4");
    assert!(matches!(
        command.as_any().downcast_ref::<BlueprintCommand>(),
        Some(BlueprintCommand::RenameBlueprint { id: 3, new_id: 4 })
    ));
}

/// Deleting an object type owned by another domain is left to that domain's converter.
#[test]
fn delete_of_other_object_types_is_not_applicable() {
    let ast = generate_ast("delete clip 1").expect("failed to parse 'delete clip 1'");
    assert!(matches!(
        ProgrammerAstConverter::convert(&ast),
        Err(DispatchError::NotApplicable)
    ));
}
