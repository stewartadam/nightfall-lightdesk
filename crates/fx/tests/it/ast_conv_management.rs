// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_fx::FxCommand;
use nightfall_fx::ast_conv::FxAstConverter;

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_delete_fx_conversion() {
    let ast = generate_ast("delete fx 1").expect("Failed to parse 'delete fx 1'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FxCommand>();
    assert!(cmd.is_some(), "Command is not an FxCommand");

    match cmd.unwrap() {
        FxCommand::DeleteFx(fx_id) => {
            assert_eq!(*fx_id, 1, "Expected FX ID 1, got {}", fx_id);
        }
        other => panic!("Expected DeleteFx command, got {:?}", other),
    }
}

#[test]
fn test_rename_fx_conversion() {
    let ast = generate_ast("rename fx 1 2").expect("Failed to parse 'rename fx 1 2'");
    let commands = FxAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FxCommand>();
    assert!(cmd.is_some(), "Command is not an FxCommand");

    match cmd.unwrap() {
        FxCommand::RenameFx { id, new_id } => {
            assert_eq!(*id, 1, "Expected original FX ID 1, got {}", id);
            assert_eq!(*new_id, 2, "Expected new FX ID 2, got {}", new_id);
        }
        other => panic!("Expected RenameFx command, got {:?}", other),
    }
}
