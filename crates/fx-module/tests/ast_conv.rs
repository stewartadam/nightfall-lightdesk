// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::AstConvert;
use nightfall_fx_module::ast_conv::FxModuleAstConverter;
use nightfall_fx_module::prelude::{FxModuleCommand, FxModuleControlAction};

#[test]
fn store_fx_module_conversion_builds_store_request() {
    let ast = generate_ast("store fx 1 sparkle selection fix 1 config foo=bar")
        .expect("parse store fx module");
    let commands = FxModuleAstConverter::convert(&ast).expect("convert store fx module");

    assert_eq!(commands.len(), 1);
    let command = commands[0]
        .as_any()
        .downcast_ref::<FxModuleCommand>()
        .expect("fx module command");

    let FxModuleCommand::StoreFxModule(request) = command else {
        panic!("expected store fx module command");
    };

    assert_eq!(request.identifiers.id, 1);
    assert_eq!(request.identifiers.label, "sparkle");
    assert_eq!(request.module_name, "sparkle");
    assert!(request.selection.is_some(), "selection should be populated");
    assert_eq!(request.config.get("foo").map(String::as_str), Some("bar"));
    assert!(!request.merge);
}

/// Verifies FX module store ranges clone the request for every selected ID.
#[test]
fn store_fx_module_range_conversion_builds_store_requests() {
    let ast =
        generate_ast("store fx 1>3 sparkle config foo=bar").expect("parse ranged store fx module");
    let commands = FxModuleAstConverter::convert(&ast).expect("convert ranged store fx module");

    let ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<FxModuleCommand>()
                .expect("fx module command");
            let FxModuleCommand::StoreFxModule(request) = command else {
                panic!("expected store fx module command");
            };
            assert_eq!(request.config.get("foo").map(String::as_str), Some("bar"));
            request.identifiers.id
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![1, 2, 3]);
}

/// Verifies hyphenated fx module names survive command conversion.
#[test]
fn store_fx_module_conversion_accepts_hyphenated_module_name() {
    let ast = generate_ast("store fx 6 hook-riser config duration_ms=1200 /merge")
        .expect("parse hyphenated store fx module");
    let commands = FxModuleAstConverter::convert(&ast).expect("convert hyphenated store fx module");

    let command = commands[0]
        .as_any()
        .downcast_ref::<FxModuleCommand>()
        .expect("fx module command");

    let FxModuleCommand::StoreFxModule(request) = command else {
        panic!("expected store fx module command");
    };

    assert_eq!(request.identifiers.id, 6);
    assert_eq!(request.identifiers.label, "hook-riser");
    assert_eq!(request.module_name, "hook-riser");
    assert_eq!(
        request.config.get("duration_ms").map(String::as_str),
        Some("1200")
    );
    assert!(request.merge);
}

/// Verifies fx module conversion preserves spatial selection transform clauses.
#[test]
fn store_fx_module_conversion_preserves_spatial_selection() {
    let ast = generate_ast("store fx 1 sparkle selection fix 1>8 | grid 4x2 | blocks 2")
        .expect("parse spatial store fx module");
    let commands = FxModuleAstConverter::convert(&ast).expect("convert spatial store fx module");

    let command = commands[0]
        .as_any()
        .downcast_ref::<FxModuleCommand>()
        .expect("fx module command");

    let FxModuleCommand::StoreFxModule(request) = command else {
        panic!("expected store fx module command");
    };
    let selection = request.selection.as_ref().expect("selection should exist");

    assert_eq!(selection.clauses.len(), 2);
}

#[test]
fn store_fx_module_merge_conversion_sets_merge_mode() {
    let ast = generate_ast("store fx 1 sparkle x=y /merge").expect("parse merge store");
    let commands = FxModuleAstConverter::convert(&ast).expect("convert merge store");

    let command = commands[0]
        .as_any()
        .downcast_ref::<FxModuleCommand>()
        .expect("fx module command");

    let FxModuleCommand::StoreFxModule(request) = command else {
        panic!("expected store fx module command");
    };

    assert!(
        request.selection.is_none(),
        "merge update should not force selection"
    );
    assert_eq!(request.config.get("x").map(String::as_str), Some("y"));
    assert!(request.merge);
}

#[test]
fn store_fx_module_config_clause_allows_trailing_merge_flag() {
    let ast = generate_ast("store fx 1 sparkle config foo=bar /merge").expect("parse config merge");
    let commands = FxModuleAstConverter::convert(&ast).expect("convert config merge");

    let command = commands[0]
        .as_any()
        .downcast_ref::<FxModuleCommand>()
        .expect("fx module command");

    let FxModuleCommand::StoreFxModule(request) = command else {
        panic!("expected store fx module command");
    };

    assert_eq!(request.config.get("foo").map(String::as_str), Some("bar"));
    assert!(request.merge);
}

/// Verifies signed config values convert into a single key-value pair.
#[test]
fn store_fx_module_conversion_preserves_signed_config_values() {
    let ast = generate_ast(
        "store fx 400 example-pattern selection fix 311>390 | grid 6x4 config m=2 light_ms=-100 r=100",
    )
    .expect("parse signed config");
    let commands = FxModuleAstConverter::convert(&ast).expect("convert signed config");

    let command = commands[0]
        .as_any()
        .downcast_ref::<FxModuleCommand>()
        .expect("fx module command");

    let FxModuleCommand::StoreFxModule(request) = command else {
        panic!("expected store fx module command");
    };

    assert_eq!(request.config.get("m").map(String::as_str), Some("2"));
    assert_eq!(
        request.config.get("light_ms").map(String::as_str),
        Some("-100")
    );
    assert_eq!(request.config.get("r").map(String::as_str), Some("100"));
}

#[test]
fn fx_module_start_conversion_builds_control_command() {
    let ast = generate_ast("fx module 1 start").expect("parse fx module start");
    let commands = FxModuleAstConverter::convert(&ast).expect("convert fx module start");

    let command = commands[0]
        .as_any()
        .downcast_ref::<FxModuleCommand>()
        .expect("fx module command");

    assert!(matches!(
        command,
        FxModuleCommand::ControlFxModule(FxModuleControlAction::Start(1))
    ));
}
