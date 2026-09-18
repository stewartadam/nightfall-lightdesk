// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::{Axis, GridSize, GroupRefExpr, SelectionExpr, SpatialClause};
use nightfall_cmd_parse::generate_ast;
use nightfall_engine::prelude::*;
use nightfall_programmer::ast_conv::ProgrammerAstConverter;
use nightfall_programmer::prelude::*;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_fixture_selection_aliases() {
    let base_ast = generate_ast("fix 1").expect("Failed to parse 'fix 1'");

    // Test "fixture" keyword - produces identical AST to "fix"
    let fixture_ast = generate_ast("fixture 1").expect("Failed to parse 'fixture 1'");
    assert_eq!(
        base_ast, fixture_ast,
        "'fixture' should produce identical AST to 'fix'"
    );

    // Test "f" alias - produces identical AST to "fix"
    let f_ast = generate_ast("f 1").expect("Failed to parse 'f 1'");
    assert_eq!(base_ast, f_ast, "'f' should produce identical AST to 'fix'");
}

#[test]
fn test_range_selection_aliases() {
    // Base command with ">" operator
    let base_ast = generate_ast("fix 1>10").expect("Failed to parse 'fix 1>10'");

    // Test "thru" range operator - produces identical AST to ">"
    let thru_ast = generate_ast("fix 1 thru 10").expect("Failed to parse 'fix 1 thru 10'");
    assert_eq!(
        base_ast, thru_ast,
        "'thru' should produce identical AST to '>'"
    );

    // Test "t" range operator - produces identical AST to ">"
    let t_ast = generate_ast("fix 1 t 10").expect("Failed to parse 'fix 1 t 10'");
    assert_eq!(base_ast, t_ast, "'t' should produce identical AST to '>'");
}

#[test]
fn test_signed_range_endpoint_is_invalid_selection_syntax() {
    assert!(generate_ast("fix 2 > +1").is_err());
}

#[test]
fn test_element_reference_without_index_is_invalid_selection_syntax() {
    assert!(generate_ast("fix 1.").is_err());
    assert!(generate_ast("fix 1>3.").is_err());
}

#[test]
fn test_fixture_map_is_distinct_from_linear_range() {
    let map_ast = generate_ast("fix 1>3 .1").expect("Failed to parse 'fix 1>3 .1'");
    let range_ast = generate_ast("fix 1>3.1").expect("Failed to parse 'fix 1>3.1'");

    assert_ne!(
        map_ast, range_ast,
        "Fixture map syntax should produce a distinct AST from linear ranges"
    );
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_basic_fixture_selection_conversion() {
    let ast = generate_ast("fix 1").expect("Failed to parse 'fix 1'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => match &selection.source {
            SelectionExpr::Fixture(fixture_ref) => {
                assert_eq!(fixture_ref.fixture_id, 1, "Expected fixture ID 1");
                assert!(
                    fixture_ref.element_index.is_none(),
                    "Expected no element reference"
                );
                assert!(selection.clauses.is_empty(), "Expected no spatial clauses");
            }
            other => panic!("Expected SelectionExpr::Fixture, got {:?}", other),
        },
        other => panic!("Expected SetProgrammerSpatialSelection, got {:?}", other),
    }
}

#[test]
fn test_range_selection_conversion() {
    let ast = generate_ast("fix 1>10").expect("Failed to parse 'fix 1>10'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => match &selection.source {
            SelectionExpr::FixtureRange { start, end } => {
                assert_eq!(start.fixture_id, 1, "Expected start fixture ID 1");
                assert_eq!(end.fixture_id, 10, "Expected end fixture ID 10");
                assert!(selection.clauses.is_empty(), "Expected no spatial clauses");
            }
            other => panic!("Expected SelectionExpr::FixtureRange, got {:?}", other),
        },
        other => panic!("Expected SetProgrammerSpatialSelection, got {:?}", other),
    }
}

#[test]
fn test_fixture_map_selection_conversion() {
    let ast = generate_ast("fix 1>3 .1").expect("Failed to parse 'fix 1>3 .1'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => match &selection.source {
            SelectionExpr::FixtureMap { fixtures, elements } => {
                assert_eq!(fixtures.start, 1, "Expected fixture range start 1");
                assert_eq!(fixtures.end, 3, "Expected fixture range end 3");
                assert_eq!(
                    *elements,
                    nightfall::prelude::ElementSelectorExpr::Single(1),
                    "Expected element selector 1"
                );
                assert!(selection.clauses.is_empty(), "Expected no spatial clauses");
            }
            other => panic!("Expected SelectionExpr::FixtureMap, got {:?}", other),
        },
        other => panic!("Expected SetProgrammerSpatialSelection, got {:?}", other),
    }
}

#[test]
fn test_element_reference_selection_conversion() {
    let ast = generate_ast("fix 1.2").expect("Failed to parse 'fix 1.2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => match &selection.source {
            SelectionExpr::Fixture(fixture_ref) => {
                assert_eq!(fixture_ref.fixture_id, 1, "Expected fixture ID 1");
                assert_eq!(
                    fixture_ref.element_index,
                    Some(2),
                    "Expected element index 2"
                );
                assert!(selection.clauses.is_empty(), "Expected no spatial clauses");
            }
            other => panic!("Expected SelectionExpr::Fixture, got {:?}", other),
        },
        other => panic!("Expected SetProgrammerSpatialSelection, got {:?}", other),
    }
}

#[test]
fn test_fixture_element_range_conversion() {
    let ast = generate_ast("fix 5.(1>3)").expect("Failed to parse 'fix 5.(1>3)'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => match &selection.source {
            SelectionExpr::FixtureMap { fixtures, elements } => {
                assert_eq!(fixtures.start, 5, "Expected fixture range start 5");
                assert_eq!(fixtures.end, 5, "Expected fixture range end 5");
                assert_eq!(
                    *elements,
                    nightfall::prelude::ElementSelectorExpr::Range { start: 1, end: 3 },
                    "Expected element range 1>3"
                );
                assert!(selection.clauses.is_empty(), "Expected no spatial clauses");
            }
            other => panic!("Expected SelectionExpr::FixtureMap, got {:?}", other),
        },
        other => panic!("Expected SetProgrammerSpatialSelection, got {:?}", other),
    }
}

#[test]
fn test_range_with_element_reference_is_linear() {
    let ast = generate_ast("fix 1>3.1").expect("Failed to parse 'fix 1>3.1'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => match &selection.source {
            SelectionExpr::FixtureRange { start, end } => {
                assert_eq!(start.fixture_id, 1, "Expected start fixture ID 1");
                assert_eq!(start.element_index, None, "Expected no start element");
                assert_eq!(end.fixture_id, 3, "Expected end fixture ID 3");
                assert_eq!(end.element_index, Some(1), "Expected end element 1");
                assert!(selection.clauses.is_empty(), "Expected no spatial clauses");
            }
            other => panic!("Expected SelectionExpr::FixtureRange, got {:?}", other),
        },
        other => panic!("Expected SetProgrammerSpatialSelection, got {:?}", other),
    }
}

/// Verifies spatial selection AST conversion preserves skip, take, and ordering clauses.
#[test]
fn test_spatial_selection_command_conversion() {
    let ast = generate_ast("group 1>4|skip 1|take 2|wings 2")
        .expect("Failed to parse 'group 1>4|skip 1|take 2|wings 2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => {
            assert_eq!(
                selection.source,
                SelectionExpr::Group(GroupRefExpr::RangeById { start: 1, end: 4 })
            );
            assert_eq!(
                selection.clauses,
                vec![
                    SpatialClause::Skip(1),
                    SpatialClause::Take(2),
                    SpatialClause::Wings {
                        axis: Axis::X,
                        amount: 2,
                    },
                ]
            );
        }
        other => panic!("Expected SetProgrammerSpatialSelection, got {:?}", other),
    }
}

/// Verifies parenthesized spatial selections are accepted and converted from CLI input.
#[test]
fn test_parenthesized_spatial_selection_command_conversion() {
    let ast = generate_ast("(fix 601.20>601.115 | Grid 4) | Take 2")
        .expect("Failed to parse parenthesized spatial selection command");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => {
            let SelectionExpr::Spatial(inner) = &selection.source else {
                panic!("Expected nested spatial selection source");
            };
            match &inner.source {
                SelectionExpr::FixtureRange { start, end } => {
                    assert_eq!(start.fixture_id, 601);
                    assert_eq!(start.element_index, Some(20));
                    assert_eq!(end.fixture_id, 601);
                    assert_eq!(end.element_index, Some(115));
                }
                other => panic!("Expected inner fixture range, got {:?}", other),
            }
            assert_eq!(inner.clauses, vec![SpatialClause::Grid(GridSize::Width(4))]);
            assert_eq!(selection.clauses, vec![SpatialClause::Take(2)]);
        }
        other => panic!("Expected SetProgrammerSpatialSelection, got {:?}", other),
    }
}
