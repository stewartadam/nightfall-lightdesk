// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::ast;
use nightfall_cmd_parse::generate_ast;

/// Asserts an identifier expression is exactly one fixture reference.
fn assert_single_fixture_id(id: &ast::IdentifierExpressionAst, expected: u32) {
    let ast::TermAst::Single(ast::SingleIdAst {
        target: ast::TargetAst::FixtureRef { fixture_id },
    }) = &id.head
    else {
        panic!("expected single fixture ID");
    };
    assert_eq!(*fixture_id, expected);
    assert!(id.tail.is_empty(), "expected no additional fixture terms");
}

/// Asserts an identifier expression is exactly one fixture element reference.
fn assert_single_fixture_element(
    id: &ast::IdentifierExpressionAst,
    expected_fixture: u32,
    expected_element: u32,
) {
    let ast::TermAst::Single(ast::SingleIdAst {
        target:
            ast::TargetAst::ElementRef {
                fixture_id,
                element_index: Some(element_index),
            },
    }) = &id.head
    else {
        panic!("expected single fixture element ID");
    };
    assert_eq!(*fixture_id, expected_fixture);
    assert_eq!(*element_index, expected_element);
    assert!(id.tail.is_empty(), "expected no additional fixture terms");
}

/// Verifies cue path assignment parses to a cue-scoped AST command.
#[test]
fn cue_path_assignment_parses() {
    let command = generate_ast("cue 1.5 path 101").expect("parse cue path command");

    let ast::CommandAst::General(ast::GeneralCommandAst::SetCueColorPath(color_path)) = command
    else {
        panic!("expected cue color path command");
    };
    assert_eq!(color_path.cue_ref.sequence_id, 1);
    assert_eq!(color_path.cue_ref.cue_id, 5);
    assert_eq!(color_path.color_path_id, Some(101));
}

/// Verifies cue path assignment accepts cue aliases and clearing sentinels.
#[test]
fn cue_path_clear_parses() {
    let command = generate_ast("c 1.5 path clear").expect("parse cue path clear");

    let ast::CommandAst::General(ast::GeneralCommandAst::SetCueColorPath(color_path)) = command
    else {
        panic!("expected cue color path command");
    };
    assert_eq!(color_path.cue_ref.sequence_id, 1);
    assert_eq!(color_path.cue_ref.cue_id, 5);
    assert_eq!(color_path.color_path_id, None);
}

/// Verifies fixture path assignment parses to a fixture-scoped AST command.
#[test]
fn fixture_path_assignment_parses() {
    let command = generate_ast("fixture 301 path 101").expect("parse fixture path command");

    let ast::CommandAst::General(ast::GeneralCommandAst::SetFixtureColorPath(color_path)) = command
    else {
        panic!("expected fixture color path command");
    };
    assert_single_fixture_id(&color_path.id, 301);
    assert_eq!(color_path.color_path_id, Some(101));
}

/// Verifies fixture path assignment can target one fixture element.
#[test]
fn fixture_element_path_assignment_parses() {
    let command = generate_ast("fixture 301.2 path 101").expect("parse fixture element path");

    let ast::CommandAst::General(ast::GeneralCommandAst::SetFixtureColorPath(color_path)) = command
    else {
        panic!("expected fixture color path command");
    };
    assert_single_fixture_element(&color_path.id, 301, 2);
    assert_eq!(color_path.color_path_id, Some(101));
}

/// Verifies fixture path assignment accepts fixture aliases and clearing sentinels.
#[test]
fn fixture_path_clear_parses() {
    let command = generate_ast("fix 301 path clear").expect("parse fixture path clear");

    let ast::CommandAst::General(ast::GeneralCommandAst::SetFixtureColorPath(color_path)) = command
    else {
        panic!("expected fixture color path command");
    };
    assert_single_fixture_id(&color_path.id, 301);
    assert_eq!(color_path.color_path_id, None);
}

/// Verifies storing a path parses to a color-path store AST.
#[test]
fn store_path_parses() {
    let command = generate_ast("store path 101").expect("parse store path command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreColorPath(color_path)) = command
    else {
        panic!("expected store color path command");
    };
    assert!(
        color_path.id.tail.is_empty(),
        "expected a single color path ID"
    );
    assert_eq!(color_path.label, None);
}

/// Verifies storing a path accepts the hyphenated object spelling.
#[test]
fn store_color_path_alias_parses() {
    let command = generate_ast("store color-path 101").expect("parse store color-path command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreColorPath(color_path)) = command
    else {
        panic!("expected store color path command");
    };
    assert!(
        color_path.id.tail.is_empty(),
        "expected a single color path ID"
    );
    assert_eq!(color_path.label, None);
}

/// Verifies storing a path can include an initial label.
#[test]
fn store_path_label_parses() {
    let command =
        generate_ast("store path 101 label \"No Green\"").expect("parse store path label command");

    let ast::CommandAst::General(ast::GeneralCommandAst::StoreColorPath(color_path)) = command
    else {
        panic!("expected store color path command");
    };
    assert!(
        color_path.id.tail.is_empty(),
        "expected a single color path ID"
    );
    assert_eq!(color_path.label.map(|label| label.0), Some("\"No Green\""));
}

/// Verifies duplicating a color path parses through generic copy syntax.
#[test]
fn duplicate_color_path_parses() {
    let command = generate_ast("cp path 101 202").expect("parse path copy command");

    let ast::CommandAst::General(ast::GeneralCommandAst::DuplicateColorPath(color_path)) = command
    else {
        panic!("expected duplicate color path command");
    };
    assert!(
        color_path.id.tail.is_empty(),
        "expected a single source color path ID"
    );
    assert!(
        color_path.new_id.tail.is_empty(),
        "expected a single target color path ID"
    );
}

/// Verifies generic move syntax parses for color path IDs.
#[test]
fn move_color_path_parses() {
    let command = generate_ast("mv path 101 202").expect("parse path move command");

    let ast::CommandAst::General(ast::GeneralCommandAst::Rename(rename)) = command else {
        panic!("expected rename color path command");
    };
    assert_eq!(rename.object_type, ast::ObjectTypeAst::ColorPath);
}

/// Verifies compact color path references parse for generic move syntax.
#[test]
fn move_compact_color_path_parses() {
    let command = generate_ast("mv path101 path202").expect("parse compact path move command");

    let ast::CommandAst::General(ast::GeneralCommandAst::Rename(rename)) = command else {
        panic!("expected rename color path command");
    };
    assert_eq!(rename.object_type, ast::ObjectTypeAst::ColorPath);
    assert!(matches!(
        rename.from.head,
        ast::SimpleTermAst::Single(ast::SimpleIdAst { id: 101 })
    ));
    assert!(matches!(
        rename.to.head,
        ast::SimpleTermAst::Single(ast::SimpleIdAst { id: 202 })
    ));
}

/// Verifies legacy record syntax is not accepted for color paths.
#[test]
fn record_path_does_not_parse() {
    assert!(
        generate_ast("record path 101").is_err(),
        "record path should not parse"
    );
}

/// Verifies object-local duplicate syntax is not accepted for color paths.
#[test]
fn path_duplicate_does_not_parse() {
    assert!(
        generate_ast("path 101 duplicate 202").is_err(),
        "path duplicate should not parse"
    );
}

/// Verifies object-local label syntax is not accepted for color paths.
#[test]
fn path_label_does_not_parse() {
    assert!(
        generate_ast("path 101 label \"No Green\"").is_err(),
        "path label should not parse"
    );
}

/// Verifies color path list commands are not accepted.
#[test]
fn list_color_paths_does_not_parse() {
    assert!(
        generate_ast("list path").is_err(),
        "list path should not parse"
    );
    assert!(
        generate_ast("list paths").is_err(),
        "list paths should not parse"
    );
}

/// Verifies two-token color path assignment syntax is not accepted.
#[test]
fn color_path_assignment_does_not_parse() {
    assert!(
        generate_ast("cue 1.5 color path 101").is_err(),
        "cue color path should not parse"
    );
    assert!(
        generate_ast("fixture 301 color path 101").is_err(),
        "fixture color path should not parse"
    );
}

/// Verifies deleting a color path parses through the generic object delete command.
#[test]
fn delete_color_path_parses() {
    let command = generate_ast("delete path 101").expect("parse delete path command");

    let ast::CommandAst::General(ast::GeneralCommandAst::Delete(delete)) = command else {
        panic!("expected delete color path command");
    };
    assert_eq!(delete.object_type, ast::ObjectTypeAst::ColorPath);
}

/// Verifies generic delete syntax accepts color path ranges.
#[test]
fn delete_color_path_range_parses() {
    let command = generate_ast("rm path 101>103").expect("parse delete path range command");

    let ast::CommandAst::General(ast::GeneralCommandAst::Delete(delete)) = command else {
        panic!("expected delete color path command");
    };
    assert_eq!(delete.object_type, ast::ObjectTypeAst::ColorPath);
    assert!(matches!(
        delete.id.head,
        ast::SimpleTermAst::Range(ast::SimpleRangeAst {
            start: ast::SimpleIdAst { id: 101 },
            end: ast::SimpleIdAst { id: 103 },
        })
    ));
}
