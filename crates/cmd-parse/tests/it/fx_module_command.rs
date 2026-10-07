// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::{ast, generate_ast};

#[test]
fn fx_module_start_aliases_share_ast() {
    let start_ast = generate_ast("fx module 1 start").expect("parse fx module start");
    let on_ast = generate_ast("fx module 1 on").expect("parse fx module on");

    assert_eq!(start_ast, on_ast);
}

#[test]
fn store_fx_module_command_parses_selection_and_config_clause() {
    let ast = generate_ast("store fx 1 foo selection fix 1 config foo=bar")
        .expect("parse store fx module command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) = ast else {
        panic!("expected store fx module AST");
    };

    assert_eq!(store_ast.module_name.0, "foo");
    assert_eq!(store_ast.parts.len(), 2);
    assert!(matches!(
        store_ast.parts[0],
        ast::FxModuleStorePartAst::Selection(_)
    ));
    assert!(matches!(
        store_ast.parts[1],
        ast::FxModuleStorePartAst::ConfigClause(_)
    ));
}

/// Verifies signed config values survive lexer splitting around the minus sign.
#[test]
fn store_fx_module_command_parses_signed_config_values() {
    let ast = generate_ast(
        "store fx 400 example-pattern selection fix 311>390 | grid 6x4 config m=2 light_ms=-100 r=100",
    )
    .expect("parse signed fx module config command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) = ast else {
        panic!("expected store fx module AST");
    };
    let ast::FxModuleStorePartAst::ConfigClause(config) = &store_ast.parts[1] else {
        panic!("expected fx module config clause");
    };

    let entries = config
        .entries
        .iter()
        .map(|entry| entry.0)
        .collect::<Vec<_>>();
    assert_eq!(entries, ["m=2", "light_ms=-100", "r=100"]);
}

/// Verifies signed shorthand config entries also remain a single key-value entry.
#[test]
fn store_fx_module_command_parses_signed_shorthand_config_values() {
    let ast = generate_ast("store fx 1 foo light_ms=-100 /merge")
        .expect("parse signed shorthand fx module config command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) = ast else {
        panic!("expected store fx module AST");
    };
    let ast::FxModuleStorePartAst::ConfigEntry(entry) = &store_ast.parts[0] else {
        panic!("expected fx module config entry");
    };

    assert_eq!(entry.0, "light_ms=-100");
}

/// Verifies module names may include contiguous hyphen separators.
#[test]
fn store_fx_module_command_parses_hyphenated_module_name() {
    let ast = generate_ast("store fx 6 hook-riser config duration_ms=1200")
        .expect("parse hyphenated fx module command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) = ast else {
        panic!("expected store fx module AST");
    };

    assert_eq!(store_ast.module_name.0, "hook-riser");
    assert_eq!(store_ast.parts.len(), 1);
    assert!(matches!(
        store_ast.parts[0],
        ast::FxModuleStorePartAst::ConfigClause(_)
    ));
}

/// Verifies module names that prefix `step` are not mistaken for Step FX creation.
#[test]
fn store_fx_module_command_accepts_step_prefix_names() {
    for module_name in ["s", "st", "ste"] {
        let command = format!("store fx 1 {module_name}");
        let ast = generate_ast(command.as_str()).expect("parse step-prefix module name");
        let ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) = ast else {
            panic!("expected store FX module AST for {module_name}");
        };
        assert_eq!(store_ast.module_name.0, module_name);
    }
}

/// Verifies fx module store commands preserve full spatial selection text.
#[test]
fn store_fx_module_command_parses_spatial_selection_clause() {
    let ast = generate_ast("store fx 1 foo selection fix 1>8 | grid 4x2 | blocks 2 config foo=bar")
        .expect("parse spatial fx module command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) = ast else {
        panic!("expected store fx module AST");
    };

    let ast::FxModuleStorePartAst::Selection(selection) = &store_ast.parts[0] else {
        panic!("expected fx module selection part");
    };

    assert_eq!(selection.selection.source, "fix 1>8 | grid 4x2 | blocks 2");
    assert_eq!(
        selection.selection.selection.selection_type,
        ast::SelectionTypeAst::Fixture
    );
}

#[test]
fn store_fx_module_merge_command_parses_raw_config_entries() {
    let ast = generate_ast("store fx 1 foo x=y /merge").expect("parse fx module merge command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) = ast else {
        panic!("expected store fx module AST");
    };

    assert_eq!(store_ast.module_name.0, "foo");
    assert_eq!(store_ast.parts.len(), 2);
    assert!(matches!(
        store_ast.parts[0],
        ast::FxModuleStorePartAst::ConfigEntry(_)
    ));
    assert!(matches!(
        store_ast.parts[1],
        ast::FxModuleStorePartAst::Merge(_)
    ));
}

#[test]
fn store_fx_module_config_clause_stops_before_merge_flag() {
    let ast = generate_ast("store fx 1 foo config foo=bar /merge")
        .expect("parse fx module config merge command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) = ast else {
        panic!("expected store fx module AST");
    };

    assert_eq!(store_ast.module_name.0, "foo");
    assert_eq!(store_ast.parts.len(), 2);
    assert!(matches!(
        store_ast.parts[0],
        ast::FxModuleStorePartAst::ConfigClause(_)
    ));
    assert!(matches!(
        store_ast.parts[1],
        ast::FxModuleStorePartAst::Merge(_)
    ));
}
