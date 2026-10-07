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
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_delete_fx_aliases() {
    let base_ast = generate_ast("delete fx 1").expect("Failed to parse 'delete fx 1'");

    // Test "delete" command aliases
    let del_ast = generate_ast("del fx 1").expect("Failed to parse 'del fx 1'");
    assert_eq!(
        base_ast, del_ast,
        "'del' should produce identical AST to 'delete'"
    );

    let rm_ast = generate_ast("rm fx 1").expect("Failed to parse 'rm fx 1'");
    assert_eq!(
        base_ast, rm_ast,
        "'rm' should produce identical AST to 'delete'"
    );
}

#[test]
fn test_delete_fx_variations() {
    let base_ast = generate_ast("delete fx 1").expect("Failed to parse 'delete fx 1'");

    // Test different FX IDs produce different ASTs
    let different_id_ast = generate_ast("delete fx 2").expect("Failed to parse 'delete fx 2'");
    assert_ne!(
        base_ast, different_id_ast,
        "Different FX IDs should produce different ASTs"
    );
}

#[test]
fn test_rename_fx_aliases() {
    let base_ast = generate_ast("rename fx 1 2").expect("Failed to parse 'rename fx 1 2'");

    // Test "rename" command aliases
    let mv_ast = generate_ast("mv fx 1 2").expect("Failed to parse 'mv fx 1 2'");
    assert_eq!(
        base_ast, mv_ast,
        "'mv' should produce identical AST to 'rename'"
    );
}

#[test]
fn test_rename_fx_variations() {
    let base_ast = generate_ast("rename fx 1 2").expect("Failed to parse 'rename fx 1 2'");

    // Test different IDs produce different ASTs
    let different_old_id_ast =
        generate_ast("rename fx 2 2").expect("Failed to parse 'rename fx 2 2'");
    assert_ne!(
        base_ast, different_old_id_ast,
        "Different original FX IDs should produce different ASTs"
    );

    let different_new_id_ast =
        generate_ast("rename fx 1 3").expect("Failed to parse 'rename fx 1 3'");
    assert_ne!(
        base_ast, different_new_id_ast,
        "Different new FX IDs should produce different ASTs"
    );
}

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
