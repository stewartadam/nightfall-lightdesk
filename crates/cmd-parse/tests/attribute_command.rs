// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::{ast, generate_ast, split_command_statements};

#[test]
fn test_active_selection_attribute_rejects_reserved_command_heads() {
    for input in ["fx @ 2", "fps @ 2", "store @ 50", "f @ 10", "fix @ 10"] {
        assert!(
            generate_ast(input).is_err(),
            "reserved command head parsed as attribute for input: {input}"
        );
    }
}

#[test]
fn test_explicit_selection_attribute_rejects_reserved_command_heads() {
    assert!(
        generate_ast("fix 1 store @ 50").is_err(),
        "reserved command head parsed as attribute in explicit selection context"
    );
}

#[test]
fn test_explicit_selection_attribute_keeps_non_reserved_attribute_names() {
    assert!(generate_ast("fix 1 pan @ 50").is_ok());
}

/// Verifies active and inline selections share the same Blueprint attribute-action AST.
#[test]
fn blueprint_attribute_actions_are_shared_across_selection_forms() {
    let active = generate_ast("color @ blueprint \"foo\"").expect("active command should parse");
    let inline = generate_ast("fix 311 color @ bp \"foo\"").expect("inline command should parse");
    let ast::CommandAst::ActiveSelectionAttribute(active) = active else {
        panic!("expected active-selection attribute command");
    };
    let ast::CommandAst::Attribute(inline) = inline else {
        panic!("expected inline-selection attribute command");
    };
    assert_eq!(active.actions, inline.actions);
}

/// Verifies Blueprint IDs, labels, complete recall, and absolute resolution parse strictly.
#[test]
fn parses_blueprint_value_sources() {
    for input in [
        "red @ blueprint 5",
        "color @ bp sunset",
        "color @ blueprint \"Warm White\" /absolute",
        "fix 311 @ blueprint 5",
    ] {
        assert!(generate_ast(input).is_ok(), "failed to parse `{input}`");
    }
}

/// Verifies incomplete, shorthand, and misplaced Blueprint modifiers fail strict parsing.
#[test]
fn rejects_incomplete_or_unsupported_blueprint_value_sources() {
    for input in [
        "red @ blueprint",
        "red @ blueprint $sunset",
        "red @ blueprint /absolute 5",
        "red @ blueprint 5 /absolute /absolute",
    ] {
        assert!(
            generate_ast(input).is_err(),
            "unexpectedly parsed `{input}`"
        );
    }
}

/// Verifies semicolons segment commands without owning attribute-assignment parsing.
#[test]
fn semicolon_only_segments_blueprint_commands() {
    let statements = split_command_statements("fix 311;red @ bp 5");
    assert_eq!(statements.len(), 2);
    assert!(generate_ast("fix 311").is_ok());
    assert!(generate_ast("red @ bp 5").is_ok());
}

/// Verifies recall accepts numeric and label addresses with source-local absolute resolution.
#[test]
fn parses_blueprint_recall_addresses_and_resolution() {
    for input in [
        "recall blueprint 5",
        "recall bp sunset",
        "recall blueprint \"Warm White\" /absolute",
    ] {
        assert!(generate_ast(input).is_ok(), "failed to parse `{input}`");
    }
}
