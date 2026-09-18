// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Structural parser facade and coordinator tests.

use super::{
    ClauseCardinality, execute_branches_from_tokens, expected_tokens_for_clause_entry,
    seed_branch_from_head, semantic_hook_spec, structural_clause_parser_for_head,
};
use crate::parser::analysis::{
    ClauseParseTree, ExpectedToken, NormalizedFilledValue, PathStatus, TokenId, ValueKind,
};
use crate::parser::lexer::lex_command;
use crate::slots::contracts::{ClauseHookId, ClauseId};

#[test]
fn programmer_root_parser_tracks_children_and_hook_family() {
    let parser =
        structural_clause_parser_for_head(TokenId::Fixture).expect("fixture head should map");

    assert_eq!(parser.clause, ClauseId::Programmer);
    assert_eq!(parser.hook, Some(ClauseHookId::Programmer));
    assert!(parser.children.iter().any(|child| {
        child.parser.clause == ClauseId::ProgrammerSelection
            && child.cardinality == ClauseCardinality::Required
    }));
    assert!(parser.children.iter().any(|child| {
        child.parser.clause == ClauseId::ProgrammerTimings
            && child.cardinality == ClauseCardinality::Repeated
    }));
}

#[test]
fn programmer_root_parser_exposes_semantic_hook_spec() {
    let parser =
        structural_clause_parser_for_head(TokenId::Fixture).expect("fixture head should map");

    assert_eq!(
        semantic_hook_spec(&parser).map(|spec| spec.hook_id),
        Some(ClauseHookId::Programmer)
    );
}

/// Verifies timing direction and duration slots remain live for paired timing clauses.
#[test]
fn programmer_timing_parser_repeats_direction_and_duration_slots() {
    let parser = super::structural_clause_parser(ClauseId::ProgrammerTimings);
    let direction = parser
        .slots
        .iter()
        .find(|slot| slot.slot == crate::slots::contracts::SlotId::TimingsDirection)
        .expect("timing direction slot should exist");
    let duration = parser
        .slots
        .iter()
        .find(|slot| slot.slot == crate::slots::contracts::SlotId::TimingsGlobalDuration)
        .expect("timing duration slot should exist");

    assert_eq!(
        direction.cardinality,
        crate::slots::contracts::SlotCardinality::Repeated
    );
    assert_eq!(
        duration.cardinality,
        crate::slots::contracts::SlotCardinality::Repeated
    );
}

#[test]
fn seed_branch_from_head_commits_root_clause_and_projects_children() {
    let branch = seed_branch_from_head(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 1,
            active_token_start: 0,
            active_token_end: 3,
            active_token_text: Some("fix".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        TokenId::Fixture,
        3,
        ClauseParseTree::default(),
    )
    .expect("fixture head should seed a branch");

    assert_eq!(branch.clause_stack.len(), 2);
    assert_eq!(branch.clause_stack[0].clause.clause, ClauseId::Programmer);
    assert_eq!(
        branch.clause_stack[1].clause.clause,
        ClauseId::ProgrammerSelection
    );
    assert_eq!(branch.consumed_items.len(), 2);
    assert_eq!(
        branch.consumed_items[0].slot.slot,
        crate::slots::contracts::SlotId::CommandHead
    );
    assert_eq!(
        branch.consumed_items[1].slot.slot,
        crate::slots::contracts::SlotId::SelectionType
    );
    assert!(branch.frontier.iter().any(|expectation| {
        matches!(
            expectation.target,
            crate::parser::analysis::ContinuationTarget::Clause(
                ClauseId::ProgrammerSelectionIdentifier
            )
        ) && expectation
            .expected_tokens
            .contains(&ExpectedToken::Placeholder(ValueKind::IdentifierExpression))
    }));
    assert!(branch.frontier.iter().any(|expectation| {
        matches!(
            expectation.target,
            crate::parser::analysis::ContinuationTarget::Clause(
                ClauseId::ProgrammerSelectionIdentifier
            )
        ) && expectation
            .expected_tokens
            .contains(&ExpectedToken::Token(TokenId::LeftParen))
    }));
}

#[test]
fn seed_branch_from_patch_head_requires_source_before_target() {
    let branch = seed_branch_from_head(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 1,
            active_token_start: 0,
            active_token_end: 5,
            active_token_text: Some("patch".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        TokenId::Patch,
        5,
        ClauseParseTree::default(),
    )
    .expect("patch head should seed a branch");

    assert!(branch.frontier.iter().any(|expectation| {
        matches!(
            expectation.target,
            crate::parser::analysis::ContinuationTarget::Clause(ClauseId::PatchSource)
        )
    }));
    assert!(!branch.frontier.iter().any(|expectation| {
        matches!(
            expectation.target,
            crate::parser::analysis::ContinuationTarget::Clause(ClauseId::PatchTarget)
        )
    }));
}

#[test]
fn clause_entry_tokens_recurse_through_structural_children() {
    let expected = expected_tokens_for_clause_entry(ClauseId::ProgrammerAttributeActions);

    assert!(expected.contains(&ExpectedToken::Token(TokenId::Red)));
    assert!(expected.contains(&ExpectedToken::Token(TokenId::Blue)));

    let timing_override = expected_tokens_for_clause_entry(ClauseId::ProgrammerTimingOverride);
    assert!(timing_override.contains(&ExpectedToken::Token(TokenId::Intensity)));
    assert!(timing_override.contains(&ExpectedToken::Token(TokenId::Red)));
}

#[test]
fn execute_branches_from_tokens_advances_programmer_selection_into_optional_clauses() {
    let tokens = lex_command("fix 311");
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 2,
            active_token_start: 4,
            active_token_end: 7,
            active_token_text: Some("311".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        7,
    );

    assert!(!branches.is_empty());
    let branch = branches
        .iter()
        .find(|branch| {
            branch
                .committed_clause_path()
                .iter()
                .map(|clause| clause.clause)
                .collect::<Vec<_>>()
                == vec![
                    ClauseId::Programmer,
                    ClauseId::ProgrammerSelection,
                    ClauseId::ProgrammerSelectionIdentifier,
                ]
        })
        .expect("expected a branch that completed the programmer selection identifier");
    assert_eq!(branch.consumed_items.len(), 3);
    assert_eq!(
        branch.consumed_items[0].slot.slot,
        crate::slots::contracts::SlotId::CommandHead
    );
    assert!(branch.frontier.iter().any(|expectation| {
        matches!(
            expectation.target,
            crate::parser::analysis::ContinuationTarget::Clause(ClauseId::ProgrammerTimings)
        )
    }));
    assert!(branch.frontier.iter().any(|expectation| {
        matches!(
            expectation.target,
            crate::parser::analysis::ContinuationTarget::Clause(
                ClauseId::ProgrammerAttributeActions
            )
        )
    }));
    assert!(
        branch
            .clause_tree
            .nodes
            .iter()
            .any(|node| node.clause.clause == ClauseId::ProgrammerSelectionIdentifier)
    );
}

#[test]
fn execute_branches_from_tokens_builds_programmer_timing_override_path() {
    let tokens = lex_command("fix 311 fade 1 red 10");
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 6,
            active_token_start: 19,
            active_token_end: 21,
            active_token_text: Some("10".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        21,
    );

    assert!(!branches.is_empty());
    let branch = branches
        .iter()
        .find(|branch| {
            branch.consumed_items.iter().any(|item| {
                item.slot.slot == crate::slots::contracts::SlotId::TimingsOverrideAttribute
            })
        })
        .expect("expected a structural branch that reaches a timing override");
    assert!(
        branch
            .consumed_items
            .iter()
            .any(|item| item.slot.slot == crate::slots::contracts::SlotId::TimingsKeyword)
    );
    assert!(branch.consumed_items.iter().any(
            |item| item.slot.slot == crate::slots::contracts::SlotId::TimingsOverrideAttribute
        ));
    assert!(branch.frontier.iter().any(|expectation| {
        matches!(
            expectation.target,
            crate::parser::analysis::ContinuationTarget::Clause(ClauseId::ProgrammerTimingOverride)
        )
    }));
    assert!(
        branch
            .clause_tree
            .nodes
            .iter()
            .any(|node| node.clause.clause == ClauseId::ProgrammerTimings)
    );
}

/// Verifies one timing keyword can consume separate directed duration pairs.
#[test]
fn execute_branches_from_tokens_builds_paired_timing_direction_path() {
    let input = "fix 1 @ 50 fade in 2s out 100ms";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 9,
            active_token_start: 26,
            active_token_end: 31,
            active_token_text: Some("100ms".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch
                .consumed_items
                .iter()
                .filter(|item| item.slot.slot == crate::slots::contracts::SlotId::TimingsDirection)
                .count()
                == 2
                && branch
                    .consumed_items
                    .iter()
                    .filter(|item| {
                        item.slot.slot == crate::slots::contracts::SlotId::TimingsGlobalDuration
                    })
                    .count()
                    == 2
        })
        .expect("expected a structural branch with paired timing directions");

    assert_eq!(branch.cursor.furthest_pos, input.len());
}

#[test]
fn execute_branches_from_tokens_builds_active_selection_attribute_path() {
    let input = "red @ 100 fade 1";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 5,
            active_token_start: 13,
            active_token_end: 14,
            active_token_text: Some("1".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch
                .consumed_items
                .iter()
                .any(|item| item.slot.slot == crate::slots::contracts::SlotId::SetAttrAttribute)
                && branch
                    .consumed_items
                    .iter()
                    .any(|item| item.slot.slot == crate::slots::contracts::SlotId::TimingsKeyword)
        })
        .expect("expected an active-selection structural branch");

    assert!(
        branch
            .clause_tree
            .nodes
            .iter()
            .any(|node| node.clause.clause == ClauseId::ProgrammerAttributeActions)
    );
    assert!(
        !branch
            .consumed_items
            .iter()
            .any(|item| { item.slot.slot == crate::slots::contracts::SlotId::CommandHead })
    );
    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::SetAttrValue && item.surface == "100"
    }));
    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::TimingsKeyword && item.surface == "fade"
    }));
}

#[test]
fn execute_branches_from_tokens_reopens_remaining_3d_actions_after_completed_axis_pair() {
    let input = "fix 311 3d pos x 1";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 6,
            active_token_start: 17,
            active_token_end: 18,
            active_token_text: Some("1".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch
                .committed_clause_path()
                .iter()
                .map(|clause| clause.clause)
                .collect::<Vec<_>>()
                == vec![ClauseId::Programmer, ClauseId::ProgrammerPlacement3d]
        })
        .expect("expected a placement branch");

    let action_expectation = branch
        .frontier
        .iter()
        .find(|expectation| {
            matches!(
                expectation.target,
                crate::parser::analysis::ContinuationTarget::Slot(
                    crate::parser::analysis::SlotRef {
                        slot: crate::slots::contracts::SlotId::PlacementAction,
                        ..
                    }
                )
            )
        })
        .expect("expected remaining placement action frontier");
    assert!(
        action_expectation
            .expected_tokens
            .contains(&ExpectedToken::Token(TokenId::Rot))
    );
    assert!(
        !action_expectation
            .expected_tokens
            .contains(&ExpectedToken::Token(TokenId::Pos))
    );
}

#[test]
fn execute_branches_from_tokens_completes_3d_position_then_rotation_chain() {
    let input = "fix 311 3d pos x 1 rot z 180";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 9,
            active_token_start: 25,
            active_token_end: 28,
            active_token_text: Some("180".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch
                .consumed_items
                .iter()
                .filter(|item| item.slot.slot == crate::slots::contracts::SlotId::PlacementAction)
                .count()
                == 2
        })
        .expect("expected a branch that consumed both placement actions");
    assert_eq!(branch.status, PathStatus::Completed);
    let actions = branch
        .consumed_items
        .iter()
        .filter(|item| item.slot.slot == crate::slots::contracts::SlotId::PlacementAction)
        .map(|item| item.surface.as_str())
        .collect::<Vec<_>>();
    assert_eq!(actions, vec!["pos", "rot"]);
    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::PlacementAxisValue
            && item.surface == "180"
    }));
}

#[test]
fn execute_branches_from_tokens_keeps_store_cue_part_marker_live() {
    let prefix = "store cue 1.5";
    let prefix_tokens = lex_command(prefix);
    let prefix_branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 4,
            cursor: prefix.len(),
            segment_end: prefix.len(),
            active_token_start: 12,
            active_token_end: 13,
            active_token_text: Some("5".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &prefix_tokens,
        prefix.len(),
    );
    assert!(
        prefix_branches.iter().any(|branch| {
            branch.frontier.iter().any(|expectation| {
                matches!(
                    &expectation.target,
                    crate::parser::analysis::ContinuationTarget::Slot(slot)
                        if slot.slot == crate::slots::contracts::SlotId::StoreCueRef
                )
            })
        }),
        "{:?}",
        prefix_branches
            .iter()
            .map(|branch| &branch.frontier)
            .collect::<Vec<_>>()
    );

    let input = "store cue 1.5p";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 5,
            cursor: input.len(),
            segment_end: input.len(),
            active_token_start: 12,
            active_token_end: 14,
            active_token_text: Some("5p".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch.consumed_items.iter().any(|item| {
                item.slot.slot == crate::slots::contracts::SlotId::StoreCueRef
                    && item.surface == "5p"
            })
        })
        .expect("expected compact part marker branch");
    assert!(branch.frontier.iter().any(|expectation| {
        expectation
            .expected_tokens
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    }));
}

/// Verifies the store command builds the complete structural Step FX clause tree.
#[test]
fn execute_branches_from_tokens_builds_fx_step_structure() {
    let input = "store fx 1 step fixture 311 5s int steps 100 ";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: tokens.len(),
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: input.len(),
            active_token_end: input.len(),
            active_token_text: None,
            has_trailing_whitespace: true,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    assert!(!branches.is_empty());
    let branch = branches
        .iter()
        .find(|branch| {
            branch
                .consumed_items
                .iter()
                .any(|item| item.slot.slot == crate::slots::contracts::SlotId::StepFxStepValues)
        })
        .expect("expected a structural branch that reaches step-fx step values");
    assert!(
        branch
            .consumed_items
            .iter()
            .any(|item| item.slot.slot == crate::slots::contracts::SlotId::StoreFxAction)
    );
    assert!(
        branch
            .consumed_items
            .iter()
            .any(|item| item.slot.slot == crate::slots::contracts::SlotId::StepFxSelectionHead)
    );
    assert!(
        branch
            .consumed_items
            .iter()
            .any(|item| item.slot.slot == crate::slots::contracts::SlotId::StepFxStepValues)
    );
    assert!(
        branches
            .iter()
            .any(|branch| branch.frontier.iter().any(|expectation| {
                matches!(
                    expectation.target,
                    crate::parser::analysis::ContinuationTarget::Slot(
                        crate::parser::analysis::SlotRef {
                            slot: crate::slots::contracts::SlotId::StepFxAttributeShaping,
                            ..
                        }
                    )
                )
            }))
    );
}

/// Verifies repeated Step FX values remain assigned to the value slot.
#[test]
fn execute_branches_from_tokens_keeps_repeated_fx_step_values_in_value_slot() {
    let input = "store fx 1 step fixture 311 5s int steps 100 0";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: tokens.len(),
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: input.len() - 1,
            active_token_end: input.len(),
            active_token_text: Some("0".into()),
            has_trailing_whitespace: false,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch.status == crate::parser::analysis::PathStatus::Completed
                && branch
                    .consumed_items
                    .iter()
                    .any(|item| item.slot.slot == crate::slots::contracts::SlotId::StepFxStepValues)
        })
        .expect("expected a completed branch for a valid step fx definition");
    let step_values = branch
        .consumed_items
        .iter()
        .filter(|item| item.slot.slot == crate::slots::contracts::SlotId::StepFxStepValues)
        .map(|item| item.surface.as_str())
        .collect::<Vec<_>>();

    assert_eq!(step_values, vec!["steps", "100", "0"]);
    assert!(!branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::StepFxAttributeShaping
            && item.surface == "0"
    }));
}

#[test]
fn execute_branches_from_tokens_preserves_fx_rate_value() {
    let tokens = lex_command("fx 1 rate 50");
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 4,
            segment_end: 12,
            cursor: 12,
            active_token_start: 10,
            active_token_end: 12,
            active_token_text: Some("50".into()),
            has_trailing_whitespace: false,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        12,
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch.status == PathStatus::Completed
                && branch
                    .consumed_items
                    .iter()
                    .filter(|item| item.slot.slot == crate::slots::contracts::SlotId::FxAction)
                    .count()
                    == 2
        })
        .expect("expected a completed structural branch that preserves the fx rate payload");

    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::FxAction
            && item.normalized_value == Some(NormalizedFilledValue::Literal("50".into()))
    }));
}

/// Verifies clip rate actions keep their decimal payload inside the action slot.
#[test]
fn execute_branches_from_tokens_preserves_clip_rate_value() {
    let input = "clip 1 rate 2.5";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: tokens
                .iter()
                .filter(|token| token.kind != crate::parser::lexer::LexerTokenKind::Whitespace)
                .count(),
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: input.len() - 3,
            active_token_end: input.len(),
            active_token_text: Some("2.5".into()),
            has_trailing_whitespace: false,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch.status == PathStatus::Completed
                && branch.consumed_items.iter().any(|item| {
                    item.slot.slot == crate::slots::contracts::SlotId::ClipAction
                        && item.surface == "rate"
                })
        })
        .expect("expected a completed structural branch that preserves clip rate payload");

    let rate_surface = branch
        .consumed_items
        .iter()
        .filter(|item| item.slot.slot == crate::slots::contracts::SlotId::ClipAction)
        .map(|item| item.surface.as_str())
        .collect::<String>();
    assert_eq!(rate_surface, "rate2.5");
}

#[test]
fn execute_branches_from_tokens_keeps_patch_universe_value_in_universe_slot() {
    let tokens = lex_command("patch sacn:1 ");
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 4,
            segment_end: 13,
            cursor: 13,
            active_token_start: 13,
            active_token_end: 13,
            active_token_text: None,
            has_trailing_whitespace: true,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        13,
    );

    assert!(!branches.is_empty());
    assert!(branches.iter().all(|branch| {
        branch.consumed_items.iter().any(|item| {
            item.slot.slot == crate::slots::contracts::SlotId::PatchSourceUniverse
                && item.normalized_value == Some(NormalizedFilledValue::Identifier("1".into()))
        })
    }));
    assert!(branches.iter().all(|branch| {
        !branch
            .consumed_items
            .iter()
            .any(|item| item.slot.slot == crate::slots::contracts::SlotId::PatchSourceAddress)
    }));
    assert!(branches.iter().any(|branch| {
        branch.frontier.iter().any(|expectation| {
            matches!(
                expectation.target,
                crate::parser::analysis::ContinuationTarget::Clause(ClauseId::PatchTarget)
            )
        })
    }));
}

#[test]
fn execute_branches_from_tokens_preserves_rm_patch_payloads() {
    let input = "rm patch artnet:3.78 @ fix 311 prio 2 /clone";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 15,
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: 39,
            active_token_end: 45,
            active_token_text: Some("/clone".into()),
            has_trailing_whitespace: false,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch.status == PathStatus::Completed
                && branch.consumed_items.iter().any(|item| {
                    item.slot.slot == crate::slots::contracts::SlotId::PatchSourceEndpoint
                })
                && branch.consumed_items.iter().any(|item| {
                    item.slot.slot == crate::slots::contracts::SlotId::PatchTargetEndpoint
                })
                && branch
                    .consumed_items
                    .iter()
                    .any(|item| item.slot.slot == crate::slots::contracts::SlotId::PatchPriority)
                && branch
                    .consumed_items
                    .iter()
                    .any(|item| item.slot.slot == crate::slots::contracts::SlotId::PatchClone)
        })
        .expect("expected a completed rm patch branch with preserved payload slots");

    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::PatchSourceAddress
            && item.normalized_value == Some(NormalizedFilledValue::Identifier("78".into()))
    }));
}

#[test]
fn execute_branches_from_tokens_preserves_patch_fixture_target_and_modifiers() {
    let input = "patch artnet:3.78 @ fix 311 prio 2 /clone";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 14,
            active_token_start: 36,
            active_token_end: 42,
            active_token_text: Some("/clone".into()),
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch
                .consumed_items
                .iter()
                .any(|item| item.slot.slot == crate::slots::contracts::SlotId::PatchClone)
        })
        .expect("expected a structural patch branch that preserves modifiers");

    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::PatchSourceEndpoint
            && item.surface.eq_ignore_ascii_case("artnet")
    }));
    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::PatchSourceUniverse
            && item.surface == "3"
    }));
    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::PatchSourceAddress
            && item.surface == "78"
    }));
    let target_items = branch
        .consumed_items
        .iter()
        .filter(|item| item.slot.slot == crate::slots::contracts::SlotId::PatchTargetEndpoint)
        .map(|item| item.surface.as_str())
        .collect::<Vec<_>>();
    assert_eq!(target_items, vec!["@", "fix", "311"]);
    let priority_items = branch
        .consumed_items
        .iter()
        .filter(|item| item.slot.slot == crate::slots::contracts::SlotId::PatchPriority)
        .map(|item| item.surface.as_str())
        .collect::<Vec<_>>();
    assert_eq!(priority_items, vec!["prio", "2"]);
    assert!(branch.consumed_items.iter().any(|item| {
        item.slot.slot == crate::slots::contracts::SlotId::PatchClone
            && item.surface.eq_ignore_ascii_case("/clone")
    }));
}

#[test]
fn execute_branches_from_tokens_keeps_instance_identifiers_live_with_action_projection() {
    let cases = [
        (
            "clip 1 ",
            ClauseId::Clip,
            ClauseId::ClipIdentifier,
            crate::slots::contracts::SlotId::ClipIdentifier,
            ClauseId::ClipAction,
        ),
        (
            "flow 1 ",
            ClauseId::Flow,
            ClauseId::FlowIdentifier,
            crate::slots::contracts::SlotId::FlowIdentifier,
            ClauseId::FlowAction,
        ),
        (
            "timecode 1 ",
            ClauseId::Timecode,
            ClauseId::TimecodeIdentifier,
            crate::slots::contracts::SlotId::TimecodeIdentifier,
            ClauseId::TimecodeAction,
        ),
        (
            "timeline 1 ",
            ClauseId::Timeline,
            ClauseId::TimelineIdentifier,
            crate::slots::contracts::SlotId::TimelineIdentifier,
            ClauseId::TimelineAction,
        ),
    ];

    for (input, root_clause, identifier_clause, identifier_slot, action_clause) in cases {
        let tokens = lex_command(input);
        let branches = execute_branches_from_tokens(
            &crate::parser::analysis::CommandPrefixContext {
                token_count: 2,
                segment_end: input.len(),
                cursor: input.len(),
                active_token_start: input.len(),
                active_token_end: input.len(),
                active_token_text: None,
                has_trailing_whitespace: true,
                ..crate::parser::analysis::CommandPrefixContext::default()
            },
            &tokens,
            input.len(),
        );

        assert!(
            !branches.is_empty(),
            "expected structural branches for {input}"
        );
        let branch = branches
            .iter()
            .find(|branch| {
                branch
                    .committed_clause_path()
                    .iter()
                    .map(|clause| clause.clause)
                    .collect::<Vec<_>>()
                    == vec![root_clause, identifier_clause]
            })
            .unwrap_or_else(|| panic!("expected identifier branch for {input}"));
        assert!(branch.frontier.iter().any(|expectation| {
            matches!(
                expectation.target,
                crate::parser::analysis::ContinuationTarget::Slot(
                    crate::parser::analysis::SlotRef { slot, .. }
                ) if slot == identifier_slot
            )
        }));
        assert!(branch.frontier.iter().any(|expectation| {
            matches!(
                expectation.target,
                crate::parser::analysis::ContinuationTarget::Clause(clause)
                    if clause == action_clause
            )
        }));
    }
}

#[test]
fn execute_branches_from_tokens_keeps_flow_rename_targets_live() {
    let input = "flow 3 mv 7";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 4,
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: input.len() - 1,
            active_token_end: input.len(),
            active_token_text: Some("7".into()),
            has_trailing_whitespace: false,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    let branch = branches
        .iter()
        .find(|branch| {
            branch.consumed_items.iter().any(|item| {
                item.slot.slot == crate::slots::contracts::SlotId::FlowAction && item.surface == "7"
            })
        })
        .expect("expected flow rename branch");

    assert!(branch.frontier.iter().any(|expectation| {
        matches!(
            expectation.target,
            crate::parser::analysis::ContinuationTarget::Slot(
                crate::parser::analysis::SlotRef { slot, .. }
            ) if slot == crate::slots::contracts::SlotId::FlowAction
        )
    }));
}

#[test]
fn execute_branches_from_tokens_keeps_channel_identifier_live_with_value_projection() {
    let input = "channel 1 ";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 2,
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: input.len(),
            active_token_end: input.len(),
            active_token_text: None,
            has_trailing_whitespace: true,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    assert!(!branches.is_empty());
    assert!(branches.iter().any(|branch| {
        branch.frontier.iter().any(|expectation| {
            matches!(
                expectation.target,
                crate::parser::analysis::ContinuationTarget::Slot(
                    crate::parser::analysis::SlotRef {
                        slot: crate::slots::contracts::SlotId::ChannelOverrideIdentifier,
                        ..
                    }
                )
            )
        })
    }));
    assert!(branches.iter().any(|branch| {
        branch.frontier.iter().any(|expectation| {
            matches!(
                expectation.target,
                crate::parser::analysis::ContinuationTarget::Slot(
                    crate::parser::analysis::SlotRef {
                        slot: crate::slots::contracts::SlotId::ChannelOverrideValue,
                        ..
                    }
                )
            )
        })
    }));
}

#[test]
fn execute_branches_from_tokens_completes_simple_channel_override() {
    let input = "channel 1.100 @ 255";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 6,
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: 16,
            active_token_end: input.len(),
            active_token_text: Some("255".into()),
            has_trailing_whitespace: false,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    assert!(branches.iter().any(|branch| {
        branch.status == crate::parser::analysis::PathStatus::Completed
            && branch.consumed_items.iter().any(|item| {
                item.slot.slot == crate::slots::contracts::SlotId::ChannelOverrideValue
                    && item.surface == "255"
            })
    }));
}

#[test]
fn execute_branches_from_tokens_completes_grouped_channel_override() {
    let input = "channel (1.1>1.5)+(2.1>2.5) @ 100";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: tokens
                .iter()
                .filter(|token| token.kind != crate::parser::lexer::LexerTokenKind::Whitespace)
                .count(),
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: input.len() - 3,
            active_token_end: input.len(),
            active_token_text: Some("100".into()),
            has_trailing_whitespace: false,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    assert!(branches.iter().any(|branch| {
        branch.status == crate::parser::analysis::PathStatus::Completed
            && branch.consumed_items.iter().any(|item| {
                item.slot.slot == crate::slots::contracts::SlotId::ChannelOverrideValue
                    && item.surface == "100"
            })
    }));
}

/// Verifies a Blueprint attribute filter completes without a selection-related type clause.
#[test]
fn execute_branches_from_tokens_completes_store_blueprint_tail() {
    let input = "store blueprint 9 filter red blue";
    let tokens = lex_command(input);
    let branches = execute_branches_from_tokens(
        &crate::parser::analysis::CommandPrefixContext {
            token_count: 6,
            segment_end: input.len(),
            cursor: input.len(),
            active_token_start: 29,
            active_token_end: 33,
            active_token_text: Some("blue".into()),
            has_trailing_whitespace: false,
            ..crate::parser::analysis::CommandPrefixContext::default()
        },
        &tokens,
        input.len(),
    );

    assert!(branches.iter().any(|branch| {
        branch.status == crate::parser::analysis::PathStatus::Completed
            && branch
                .consumed_items
                .iter()
                .map(|item| item.source_span.end)
                .max()
                .is_some_and(|end| end >= input.len())
    }));
}
