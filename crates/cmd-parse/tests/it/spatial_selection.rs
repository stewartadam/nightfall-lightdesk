// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::*;
use nightfall_cmd_parse::{ast, generate_ast, parse_spatial_selection_text};
use nightfall_dmx::prelude::Attribute;

fn parse_spatial(input: &str) -> SpatialSelection {
    parse_spatial_selection_text(input).expect("failed to parse spatial selection")
}

#[test]
fn parses_spatial_selection_with_clause_sequence() {
    let selection = parse_spatial(
        "fix 1>8 | Grid 4x2 | Mirror Y | Take 6 | Skip 1 | Blocks 2 | Shift 1 | Group Y=2 | Wings 2 | Shuffle 17 | Invert Wing Attrs Pan,Tilt",
    );

    assert!(matches!(
        selection.source,
        SelectionExpr::FixtureRange { .. }
    ));
    assert_eq!(
        selection.clauses,
        vec![
            SpatialClause::Grid(GridSize::WidthHeight { x: 4, y: 2 }),
            SpatialClause::Mirror(Axis::Y),
            SpatialClause::Take(6),
            SpatialClause::Skip(1),
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 2
            },
            SpatialClause::Shift {
                axis: Axis::X,
                amount: 1
            },
            SpatialClause::Group {
                axis: Axis::Y,
                amount: 2
            },
            SpatialClause::Wings {
                axis: Axis::X,
                amount: 2
            },
            SpatialClause::Shuffle {
                axis: Axis::X,
                seed: 17
            },
            SpatialClause::Invert {
                mode: InvertMode::Wing,
                attrs: Some(vec![Attribute::Pan, Attribute::Tilt]),
            },
        ]
    );
}

/// Verifies that spatial selection unions preserve branch-local clause pipelines.
#[test]
fn parses_union_of_spatial_selection_pipelines() {
    let input = "fix 601.(20>115) | Blocks 4 | Take 12 | Grid 4x3 + fix 601.(20>115) | Blocks 4 | Skip 12 | Take 12 | Grid 4x3";
    let selection = parse_spatial(input);

    assert!(matches!(selection.source, SelectionExpr::FixtureMap { .. }));
    assert_eq!(
        selection.clauses,
        vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 4
            },
            SpatialClause::Take(12),
            SpatialClause::Grid(GridSize::WidthHeight { x: 4, y: 3 }),
        ]
    );
    assert_eq!(selection.union.len(), 1);
    assert!(matches!(
        selection.union[0].source,
        SelectionExpr::FixtureMap { .. }
    ));
    assert_eq!(
        selection.union[0].clauses,
        vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 4
            },
            SpatialClause::Skip(12),
            SpatialClause::Take(12),
            SpatialClause::Grid(GridSize::WidthHeight { x: 4, y: 3 }),
        ]
    );
    assert!(matches!(
        generate_ast(input),
        Ok(ast::CommandAst::Selection(ast::SelectionCommandAst { source, .. }))
            if source == input
    ));
}

/// Verifies compact source additions are not mistaken for spatial union separators.
#[test]
fn parses_spatial_union_with_compact_source_additions() {
    let input = "fix 1+3 | Grid 2 + fix 5+6 | Grid 2";
    let selection = parse_spatial(input);

    assert!(matches!(selection.source, SelectionExpr::Add { .. }));
    assert_eq!(
        selection.clauses,
        vec![SpatialClause::Grid(GridSize::Width(2))]
    );
    assert_eq!(selection.union.len(), 1);
    assert!(matches!(
        selection.union[0].source,
        SelectionExpr::Add { .. }
    ));
    assert_eq!(
        selection.union[0].clauses,
        vec![SpatialClause::Grid(GridSize::Width(2))]
    );
    assert!(matches!(
        generate_ast(input),
        Ok(ast::CommandAst::Selection(ast::SelectionCommandAst { source, .. }))
            if source == input
    ));
}

/// Verifies groups can be additive sources without requiring fixture heads.
#[test]
fn parses_additive_group_sources() {
    for input in ["Group 1 + Group 2", "Group 1 + Fix 311>315"] {
        let selection = parse_spatial(input);
        assert!(matches!(selection.source, SelectionExpr::Add { .. }));
        assert!(selection.clauses.is_empty());
        assert!(selection.union.is_empty());
        assert!(matches!(
            generate_ast(input),
            Ok(ast::CommandAst::Selection(ast::SelectionCommandAst { source, .. }))
                if source == input
        ));
    }
}

/// Verifies spatial clauses after additive sources apply to the full additive source.
#[test]
fn parses_additive_sources_before_spatial_clauses() {
    let input = "Group 1+3 | Mirror";
    let selection = parse_spatial(input);
    assert!(matches!(selection.source, SelectionExpr::Group(_)));
    assert_eq!(selection.clauses, vec![SpatialClause::Mirror(Axis::X)]);
    assert!(selection.union.is_empty());

    let input = "Group 1+3 + fix 311>315 | Mirror";
    let selection = parse_spatial(input);
    assert!(matches!(selection.source, SelectionExpr::Add { .. }));
    assert_eq!(selection.clauses, vec![SpatialClause::Mirror(Axis::X)]);
    assert!(selection.union.is_empty());
}

/// Verifies parenthesized spatial branches can be added to untransformed sources.
#[test]
fn parses_parenthesized_spatial_branch_in_additive_source() {
    let input = "Group 1+3 + (fix 311>315 | Mirror)";
    let selection = parse_spatial(input);
    let SelectionExpr::Add { rhs, .. } = selection.source else {
        panic!("expected additive selection source");
    };
    assert!(matches!(*rhs, SelectionExpr::Spatial(_)));
    assert!(selection.clauses.is_empty());
    assert!(selection.union.is_empty());
}

/// Verifies parenthesized base selections group syntax without creating explicit sets.
#[test]
fn parses_parenthesized_base_selection_branches_as_grouping() {
    let input = "(fix 1>3) + (fix 4+6) + (group 2)";
    let selection = parse_spatial(input);
    let SelectionExpr::Add { lhs, rhs } = &selection.source else {
        panic!("expected additive selection source");
    };
    let SelectionExpr::Add {
        lhs: first,
        rhs: second,
    } = lhs.as_ref()
    else {
        panic!("expected nested additive selection source");
    };

    assert!(matches!(first.as_ref(), SelectionExpr::FixtureRange { .. }));
    assert!(matches!(second.as_ref(), SelectionExpr::Add { .. }));
    assert!(matches!(rhs.as_ref(), SelectionExpr::Group(_)));
    assert!(selection.clauses.is_empty());
    assert!(selection.union.is_empty());

    let command = "(fix 1>3) + (fix 4+6) + (group 2) red @ 100 fade 1>3";
    assert!(matches!(
        generate_ast(command),
        Ok(ast::CommandAst::Attribute(ast::AttributeCommandAst { .. }))
    ));
}

/// Verifies braced base selections compose as explicit selection sets.
#[test]
fn parses_braced_base_selection_branches_as_explicit_sets() {
    let input = "{fix 1>3} + {fix 4+6} + {group 2}";
    let selection = parse_spatial(input);
    let SelectionExpr::Add { lhs, rhs } = &selection.source else {
        panic!("expected additive selection source");
    };
    let SelectionExpr::Add {
        lhs: first,
        rhs: second,
    } = lhs.as_ref()
    else {
        panic!("expected nested additive selection source");
    };

    assert!(
        matches!(first.as_ref(), SelectionExpr::Span(inner) if matches!(inner.as_ref(), SelectionExpr::FixtureRange { .. }))
    );
    assert!(
        matches!(second.as_ref(), SelectionExpr::Span(inner) if matches!(inner.as_ref(), SelectionExpr::Add { .. }))
    );
    assert!(
        matches!(rhs.as_ref(), SelectionExpr::Span(inner) if matches!(inner.as_ref(), SelectionExpr::Group(_)))
    );
    assert!(selection.clauses.is_empty());
    assert!(selection.union.is_empty());

    let command = "{fix 1>3} + {fix 4+6} + {group 2} red @ 100 fade 1>3";
    assert!(matches!(
        generate_ast(command),
        Ok(ast::CommandAst::Attribute(ast::AttributeCommandAst { .. }))
    ));
}

/// Verifies live selection-transform command examples parse as attribute commands.
#[test]
fn parses_selection_transform_attribute_command_examples() {
    let commands = [
        "group 1>3 red @ 100 fade 1>3",
        "group 1>3 | split red @ 100 fade 1>3",
        "group 1>3 | split | expand 1 red @ 100 fade 1>3",
        "group 1>3 | split | expand 1 | merge red @ 100 fade 1>3",
        "(fix 1>3) + (fix 4+6) + (group 2) red @ 100 fade 1>3",
        "{fix 1>3} + {fix 4+6} + {group 2} | merge red @ 100 fade 1>3",
        "(group 1 | mirror) + fix 5 red @ 100 fade 1>3",
        "{group 1 | mirror} + fix 5 red @ 100 fade 1>3",
        "fix 1>10 | blocks 2 red @ 100 fade 1>5",
        "fix 1>10 | blocks 2 | split red @ 100 fade 1>5",
    ];

    for command in commands {
        assert!(
            matches!(
                generate_ast(command),
                Ok(ast::CommandAst::Attribute(ast::AttributeCommandAst { .. }))
            ),
            "expected selection-transform attribute command to parse: {command}"
        );
    }
}

/// Verifies additive parenthesized spatial selections accept outer clauses and attributes.
#[test]
fn parses_parenthesized_spatial_addition_with_outer_grid_and_attribute() {
    let input = "(Group 3 | Mirror) + (Group 5 | Mirror) | Grid 20";
    let selection = parse_spatial(input);
    assert!(matches!(selection.source, SelectionExpr::Add { .. }));
    assert_eq!(
        selection.clauses,
        vec![SpatialClause::Grid(GridSize::Width(20))]
    );
    assert!(selection.union.is_empty());

    let command = "(Group 3 | Mirror) + (Group 5 | Mirror) | Grid 20 int @ 0";
    assert!(matches!(
        generate_ast(command),
        Ok(ast::CommandAst::Attribute(ast::AttributeCommandAst { .. }))
    ));
}

/// Verifies quoted group labels are valid selection sources.
#[test]
fn parses_quoted_group_label_selection() {
    let input = "\"No Fixtures\"";
    let selection = parse_spatial(input);
    assert!(matches!(
        selection.source,
        SelectionExpr::Group(GroupRefExpr::ByLabel(ref label)) if label == "No Fixtures"
    ));
    assert!(selection.clauses.is_empty());
    assert!(selection.union.is_empty());
    assert!(matches!(
        generate_ast(input),
        Ok(ast::CommandAst::Selection(ast::SelectionCommandAst { source, .. }))
            if source == input
    ));
}

/// Verifies parenthesized spatial pipelines remain composable source selections.
#[test]
fn parses_parenthesized_spatial_selection_source() {
    let selection = parse_spatial("(fix 301>320 | Group 4) | Group 2 | Take 1");

    let SelectionExpr::Spatial(inner) = &selection.source else {
        panic!("expected nested spatial selection source");
    };
    assert!(matches!(inner.source, SelectionExpr::FixtureRange { .. }));
    assert_eq!(
        inner.clauses,
        vec![SpatialClause::Group {
            axis: Axis::X,
            amount: 4
        }]
    );
    assert_eq!(
        selection.clauses,
        vec![
            SpatialClause::Group {
                axis: Axis::X,
                amount: 2
            },
            SpatialClause::Take(1),
        ]
    );
}

/// Verifies CLI command parsing accepts nested spatial selections that start with parentheses.
#[test]
fn parses_parenthesized_spatial_selection_as_cli_command() {
    let input = "(fix 601.20>601.115 | Grid 4) | Take 2";
    let ast = generate_ast(input).expect("failed to parse parenthesized spatial selection command");

    assert!(matches!(
        ast,
        ast::CommandAst::Selection(ast::SelectionCommandAst { source, .. })
            if source == input
    ));
}

/// Verifies parenthesized spatial pipelines can be added as source branches.
#[test]
fn parses_union_of_parenthesized_spatial_selection_sources() {
    let selection = parse_spatial("(fix 301>320 | Group 4) + (fix 401>420 | Group 4)");

    let SelectionExpr::Add { lhs, rhs } = selection.source else {
        panic!("expected additive spatial source branches");
    };
    assert!(matches!(*lhs, SelectionExpr::Spatial(_)));
    assert!(matches!(*rhs, SelectionExpr::Spatial(_)));
    assert!(selection.union.is_empty());
}

/// Verifies that take and skip clauses round-trip through the standalone selection parser.
#[test]
fn parses_take_and_skip_subset_clauses_as_standalone_command() {
    let ast = generate_ast("fixture 1>20 | skip 5 | take 10")
        .expect("failed to parse selection subset command");

    assert!(matches!(
        ast,
        ast::CommandAst::Selection(ast::SelectionCommandAst { source, .. })
            if source == "fixture 1>20 | skip 5 | take 10"
    ));
}

#[test]
fn expands_multi_axis_assignments_into_ordered_clauses() {
    let selection = parse_spatial("group 1 | Group X=4 Y=2 | Shift X=1 Z=-1");

    assert_eq!(
        selection.clauses,
        vec![
            SpatialClause::Group {
                axis: Axis::X,
                amount: 4
            },
            SpatialClause::Group {
                axis: Axis::Y,
                amount: 2
            },
            SpatialClause::Shift {
                axis: Axis::X,
                amount: 1
            },
            SpatialClause::Shift {
                axis: Axis::Z,
                amount: -1
            },
        ]
    );
}

#[test]
fn formats_spatial_selection_back_to_cli_text() {
    let selection = SpatialSelection {
        source: SelectionExpr::Group(GroupRefExpr::ById(5)),
        clauses: vec![
            SpatialClause::Grid(GridSize::Width(4)),
            SpatialClause::Skip(1),
            SpatialClause::Take(2),
            SpatialClause::Mirror(Axis::X),
            SpatialClause::Invert {
                mode: InvertMode::Block,
                attrs: Some(vec![
                    Attribute::Pan,
                    Attribute::Custom {
                        label: "Pan Fine".to_string(),
                    },
                ]),
            },
        ],
        union: Vec::new(),
    };

    assert_eq!(
        selection.to_string(),
        "Group 5 | Grid 4 | Skip 1 | Take 2 | Mirror | Invert Block Attrs Pan,\"Pan Fine\""
    );
}

#[test]
fn formats_mapped_spatial_selection_back_to_parseable_cli_text() {
    let input = "fix 323.(20>1) + fix 322.(20>1) + fix 311.(1>20) | Blocks 4 | Mirror | Grid 30";
    let selection = parse_spatial(input);
    let formatted = selection.to_string();

    assert_eq!(
        formatted,
        "Fixture 323.(20>1) + Fixture 322.(20>1) + Fixture 311.(1>20) | Blocks 4 | Mirror | Grid 30"
    );
    parse_spatial_selection_text(&formatted).expect("formatted spatial selection should parse");
}

#[test]
fn formats_cli_spatial_fixture_range_with_trailing_grid_clause() {
    let input = "fix 311>312 | blocks 2 | grid 20";
    let selection = parse_spatial(input);

    assert_eq!(
        selection.to_string(),
        "Fixture 311>312 | Blocks 2 | Grid 20"
    );
}

#[test]
fn rejects_invert_without_mode() {
    assert!(parse_spatial_selection_text("fix 1>8 | Invert Attrs Pan,Tilt").is_err());
}

#[test]
fn parses_spatial_selection_as_standalone_command() {
    let ast = generate_ast("Group 1>4|Wings 2").expect("failed to parse spatial selection command");

    assert!(matches!(ast, ast::CommandAst::Selection(_)));
}
