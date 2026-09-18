// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Frontier generation for structural parser branches.

use crate::lexicon::tokens::token_id_for_text;
use crate::parser::analysis::{
    ClauseExpectation, ClauseInstance, ContinuationKind, ContinuationTarget, ExpectedToken,
    GrammarRuleId, ParseBranchState, SlotRef, TokenId, ValueKind,
};
use crate::parser::frontier::is_complete_duration_value;
use crate::parser::structural::{
    StructuralClauseChild, StructuralClauseParser, child_clause_is_available, cue_ref_prefix,
    cue_ref_surface, duration_range_can_extend, expected_tokens_for_clause_entry,
    expected_tokens_for_slot, is_complete_cue_ref, is_complete_store_cue_ref, merged_fill_surface,
    push_expected_token, rename_identifier_uses_cue_ref, rm_object_identifier_uses_cue_ref,
    root_rule_for_clause, set_attr_value_can_extend, signed_numeric_expected_tokens,
    slot_is_available_in_branch, slot_state, store_cue_ref_prefix, structural_clause_parser,
};
use crate::parser::structural_expectation::{
    clause_expectation, filtered_slot_expectation, slot_expectation, slot_value_expectation,
};
use crate::parser::structural_fx::{fx_rate_value_surface, step_fx_shaping_expected_tokens};
use crate::parser::structural_programmer::programmer_placement_frontier;
use crate::slots::contracts::{ClauseCardinality, ClauseId, SlotCardinality, SlotId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimingPairEvent {
    Direction,
    Duration,
    Override,
}

pub(super) fn branch_frontier_state_for_branch(
    branch: &ParseBranchState<'_>,
) -> (Vec<ClauseExpectation>, bool) {
    let mut frontier = Vec::new();
    let mut has_blocking_expectations = false;

    for frame in branch.clause_stack.iter().rev() {
        let parser = structural_clause_parser(frame.clause.clause);
        let (immediate, blocks_ancestors) =
            immediate_frontier_for_clause(branch, &frame.clause, &parser);
        for expectation in immediate {
            if !frontier.contains(&expectation) {
                frontier.push(expectation);
            }
        }
        if blocks_ancestors {
            has_blocking_expectations = true;
            break;
        }
    }

    (frontier, has_blocking_expectations)
}

/// Compute the next legal expectations for the active structural clause.
fn immediate_frontier_for_clause(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    parser: &StructuralClauseParser,
) -> (Vec<ClauseExpectation>, bool) {
    if clause.clause == ClauseId::ProgrammerPlacement3d {
        return programmer_placement_frontier(branch, clause, parser);
    }
    if clause.clause == ClauseId::Store
        && child_clause_is_available(branch, clause, ClauseId::StoreFixture)
        && !branch.clause_tree.nodes.iter().any(|node| {
            node.parent.is_some_and(|parent_id| {
                branch.clause_tree.nodes[parent_id.0 as usize].clause == *clause
            }) && node.clause.clause == ClauseId::StoreFixture
        })
    {
        return (
            vec![clause_expectation(parser, ClauseId::StoreFixture)],
            true,
        );
    }
    if clause.clause == ClauseId::StoreFixture
        && !branch.clause_tree.nodes.iter().any(|node| {
            node.parent.is_some_and(|parent_id| {
                branch.clause_tree.nodes[parent_id.0 as usize].clause == *clause
            })
        })
        && branch
            .consumed_items
            .iter()
            .any(|item| item.clause == *clause && item.slot.slot == SlotId::StoreFixtureIdentifier)
    {
        let identifier = parser
            .slots
            .iter()
            .find(|slot| slot.slot == SlotId::StoreFixtureIdentifier)
            .expect("Store fixture definitions expose their required identifier");
        return (
            vec![
                slot_expectation(parser, clause.clone(), *identifier),
                clause_expectation(parser, ClauseId::StoreFixtureOffset),
                clause_expectation(parser, ClauseId::StoreFixturePayload),
            ],
            true,
        );
    }
    if clause.clause == ClauseId::StepFx
        && branch
            .consumed_items
            .iter()
            .any(|item| item.clause == *clause && item.slot.slot == SlotId::StoreFxAction)
        && !branch.clause_tree.nodes.iter().any(|node| {
            node.parent.is_some_and(|parent_id| {
                branch.clause_tree.nodes[parent_id.0 as usize].clause == *clause
            }) && node.clause.clause == ClauseId::StepFxSelection
        })
    {
        return (
            vec![clause_expectation(parser, ClauseId::StepFxSelection)],
            true,
        );
    }
    if clause.clause == ClauseId::StepFxStepDefinition {
        let has_attribute = branch
            .consumed_items
            .iter()
            .any(|item| item.clause == *clause && item.slot.slot == SlotId::StepFxStepAttribute);
        let has_steps = branch
            .consumed_items
            .iter()
            .any(|item| item.clause == *clause && item.slot.slot == SlotId::StepFxStepValues);
        let has_baseline = branch.consumed_items.iter().any(|item| {
            item.clause == *clause && item.slot.slot == SlotId::StepFxAttributeBaseline
        });
        if has_attribute && !has_steps && !has_baseline {
            let step_values = parser
                .slots
                .iter()
                .find(|slot| slot.slot == SlotId::StepFxStepValues)
                .expect("Step FX definitions expose their required step values");
            let baseline = parser
                .slots
                .iter()
                .find(|slot| slot.slot == SlotId::StepFxAttributeBaseline)
                .expect("Step FX definitions expose their optional initial value");
            let shaping = parser
                .slots
                .iter()
                .find(|slot| slot.slot == SlotId::StepFxAttributeShaping)
                .expect("Step FX definitions expose optional shaping controls");
            return (
                vec![
                    filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *baseline,
                        vec![ExpectedToken::Token(TokenId::AtSign)],
                    ),
                    filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *shaping,
                        step_fx_shaping_expected_tokens(),
                    ),
                    filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *step_values,
                        vec![ExpectedToken::Token(TokenId::Steps)],
                    ),
                ],
                true,
            );
        }
    }

    let mut frontier = Vec::new();

    for slot in parser.slots {
        if !slot_is_available_in_branch(branch, clause, slot.slot) {
            continue;
        }
        let slot_fills = branch
            .consumed_items
            .iter()
            .filter(|item| item.clause == *clause && item.slot.slot == slot.slot)
            .collect::<Vec<_>>();
        let merged_surface = merged_fill_surface(&slot_fills);
        if matches!(
            slot.slot,
            SlotId::StepFxAttributeBaseline | SlotId::StepFxStepValues
        ) && slot_fills.iter().rev().nth(1).is_some_and(|item| {
            token_id_for_text(item.surface.as_str()) == Some(TokenId::Blueprint)
        }) && slot_fills
            .iter()
            .rev()
            .nth(2)
            .is_some_and(|item| token_id_for_text(item.surface.as_str()) == Some(TokenId::AtSign))
        {
            frontier.push(filtered_slot_expectation(
                parser,
                clause.clone(),
                *slot,
                vec![ExpectedToken::Token(TokenId::Absolute)],
            ));
        }
        if slot.slot == SlotId::FpsValue
            && !slot_fills.is_empty()
            && !matches!(merged_surface.as_str(), "+" | "-")
        {
            continue;
        }
        if crate::parser::parse_specs::duration_parse_spec_for_slot(slot.slot).is_some()
            && branch
                .consumed_items
                .last()
                .is_some_and(|item| item.clause == *clause && item.slot.slot == slot.slot)
            && merged_surface
                .rsplit('>')
                .next()
                .is_some_and(crate::parser::structural::sleep_duration_can_extend)
        {
            let units = crate::parser::parse_specs::duration_unit_texts()
                .iter()
                .map(|unit| ExpectedToken::Literal((*unit).into()))
                .collect();
            frontier.push(filtered_slot_expectation(
                parser,
                clause.clone(),
                *slot,
                units,
            ));
        }
        if slot.slot == SlotId::SleepDuration
            && !slot_fills.is_empty()
            && is_complete_duration_value(merged_surface.as_str())
        {
            if merged_surface.parse::<i64>().is_ok() {
                frontier.push(filtered_slot_expectation(
                    parser,
                    clause.clone(),
                    *slot,
                    vec![ExpectedToken::Token(TokenId::Dot)],
                ));
            }
            continue;
        }
        if matches!(
            slot.slot,
            SlotId::SelectionSource
                | SlotId::SelectionIdentifier
                | SlotId::StepFxSelectionIdentifier
                | SlotId::StepFxSelectionTransform
        ) {
            let surface =
                crate::parser::structural::selection_slot_surface(branch, slot.slot, None);
            let selection = crate::selection_language::prefix::analyze_selection_prefix(&surface);
            if !selection.expected.is_empty() {
                frontier.push(filtered_slot_expectation(
                    parser,
                    clause.clone(),
                    *slot,
                    selection.expected,
                ));
            }
            if !selection.complete {
                return (frontier, true);
            }
            continue;
        }
        if slot.slot == SlotId::StepFxDuration
            && !slot_fills.is_empty()
            && branch.clause_stack.iter().any(|frame| {
                frame.clause == *clause
                    && frame.phase == crate::parser::analysis::ClausePhase::Filling
            })
            && (!is_complete_duration_value(merged_surface.as_str())
                || merged_surface.parse::<f64>().is_ok())
        {
            frontier.push(slot_value_expectation(parser, clause.clone(), *slot));
            return (frontier, true);
        }
        if slot.slot == SlotId::RmObjectIdentifier
            && rm_object_identifier_uses_cue_ref(branch, clause)
        {
            let surface = merged_fill_surface(&slot_fills);
            if cue_ref_prefix(surface.as_str()) && !is_complete_cue_ref(surface.as_str()) {
                if slot_fills.last().is_some_and(|item| {
                    token_id_for_text(item.surface.as_str()) == Some(TokenId::Dot)
                }) {
                    frontier.push(slot_value_expectation(parser, clause.clone(), *slot));
                } else {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        vec![ExpectedToken::Token(TokenId::Dot)],
                    ));
                }
                return (frontier, true);
            }
            frontier.push(filtered_slot_expectation(
                parser,
                clause.clone(),
                *slot,
                vec![ExpectedToken::Placeholder(ValueKind::NumericDigit)],
            ));
            return (frontier, false);
        }
        if slot.slot == SlotId::RmObjectIdentifier
            && branch.consumed_items.iter().any(|item| {
                item.slot.slot == SlotId::RmObjectType
                    && token_id_for_text(item.surface.as_str()) == Some(TokenId::Sequence)
            })
        {
            frontier.push(filtered_slot_expectation(
                parser,
                clause.clone(),
                *slot,
                vec![ExpectedToken::Placeholder(ValueKind::NumericDigit)],
            ));
            return (frontier, false);
        }
        if matches!(slot.slot, SlotId::StoreCueRef | SlotId::RecallCueRef)
            || rename_identifier_uses_cue_ref(branch, clause, slot.slot)
        {
            let surface = cue_ref_surface(&slot_fills);
            let complete = if slot.slot == SlotId::StoreCueRef {
                is_complete_store_cue_ref(surface.as_str())
            } else {
                is_complete_cue_ref(surface.as_str())
            };
            let prefix = if slot.slot == SlotId::StoreCueRef {
                store_cue_ref_prefix(surface.as_str())
            } else {
                cue_ref_prefix(surface.as_str())
            };
            if prefix && !complete {
                if surface.ends_with('.') || surface.ends_with('p') || surface.ends_with('P') {
                    frontier.push(slot_value_expectation(parser, clause.clone(), *slot));
                } else {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        vec![ExpectedToken::Token(TokenId::Dot)],
                    ));
                }
                return (frontier, true);
            }
            if matches!(slot.slot, SlotId::StoreCueRef)
                || rename_identifier_uses_cue_ref(branch, clause, slot.slot)
            {
                let mut expected_tokens = vec![ExpectedToken::Placeholder(ValueKind::NumericDigit)];
                if !surface.is_empty() {
                    expected_tokens.insert(0, ExpectedToken::Token(TokenId::Dot));
                }
                frontier.push(filtered_slot_expectation(
                    parser,
                    clause.clone(),
                    *slot,
                    expected_tokens,
                ));
                if slot.slot == SlotId::RenameSource
                    || (slot.slot == SlotId::StoreCueRef && !surface.is_empty())
                {
                    continue;
                }
                return (frontier, false);
            }
        }
        match slot_state(slot.slot, slot.cardinality, &slot_fills) {
            crate::parser::structural::SlotState::RequiredPending => {
                if slot.slot == SlotId::StepFxStepValues {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        vec![ExpectedToken::Token(TokenId::Steps)],
                    ));
                } else if slot.slot == SlotId::StepFxSelectionIdentifier {
                    let has_selection_head = branch.consumed_items.iter().any(|item| {
                        item.clause == *clause && item.slot.slot == SlotId::StepFxSelectionHead
                    });
                    let expected_tokens = if has_selection_head {
                        vec![ExpectedToken::Placeholder(ValueKind::NumericDigit)]
                    } else {
                        vec![
                            ExpectedToken::Token(TokenId::Fixture),
                            ExpectedToken::Token(TokenId::Group),
                        ]
                    };
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        expected_tokens,
                    ));
                } else {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        crate::parser::structural::initial_expected_tokens_for_slot(SlotRef {
                            slot: slot.slot,
                            clause: Some(clause.clone()),
                        }),
                    ));
                }
                if slot.slot == SlotId::StepFxAttributeShaping {
                    frontier.pop();
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        step_fx_shaping_expected_tokens(),
                    ));
                }
                append_parallel_required_slot_expectations(
                    &mut frontier,
                    parser,
                    clause.clone(),
                    slot.slot,
                );
                if should_offer_child_clauses_alongside_required_slot(slot.slot) {
                    append_available_child_clause_expectations(
                        &mut frontier,
                        branch,
                        clause,
                        parser,
                    );
                }
                return (frontier, true);
            }
            crate::parser::structural::SlotState::OptionalPending => {
                if slot.slot == SlotId::StepFxAttributeBaseline {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        vec![ExpectedToken::Token(TokenId::AtSign)],
                    ));
                } else if slot.slot == SlotId::StepFxGroupsKeyword {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        vec![ExpectedToken::Literal("groups".into())],
                    ));
                } else {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        crate::parser::structural::initial_expected_tokens_for_slot(SlotRef {
                            slot: slot.slot,
                            clause: Some(clause.clone()),
                        }),
                    ));
                }
            }
            crate::parser::structural::SlotState::ValuePending => {
                if clause.clause == ClauseId::Rm
                    && slot.slot == SlotId::PatchTargetEndpoint
                    && slot_fills.len() == 1
                    && slot_fills.first().is_some_and(|item| {
                        token_id_for_text(item.surface.as_str()) == Some(TokenId::AtSign)
                    })
                {
                    frontier.push(slot_expectation(parser, clause.clone(), *slot));
                    continue;
                } else if matches!(
                    slot.slot,
                    SlotId::StepFxAttributeBaseline | SlotId::StepFxStepValues
                ) {
                    let mut expected_tokens = signed_numeric_expected_tokens();
                    if slot_fills.last().is_some_and(|item| {
                        token_id_for_text(item.surface.as_str()) == Some(TokenId::AtSign)
                    }) {
                        push_expected_token(
                            &mut expected_tokens,
                            ExpectedToken::Token(TokenId::Blueprint),
                        );
                    } else if slot_fills.last().is_some_and(|item| {
                        token_id_for_text(item.surface.as_str()) == Some(TokenId::Blueprint)
                    }) {
                        expected_tokens =
                            vec![ExpectedToken::Placeholder(ValueKind::BlueprintAddress)];
                    }
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        expected_tokens,
                    ));
                } else if matches!(
                    slot.slot,
                    SlotId::SetAttrValue | SlotId::StepFxAttributeShaping
                ) {
                    let mut expected = signed_numeric_expected_tokens();
                    if slot.slot == SlotId::SetAttrValue {
                        if slot_fills.last().is_some_and(|fill| {
                            token_id_for_text(&fill.surface) == Some(TokenId::Blueprint)
                        }) {
                            expected =
                                vec![ExpectedToken::Placeholder(ValueKind::BlueprintAddress)];
                        } else if slot_fills.last().is_some_and(|fill| {
                            token_id_for_text(&fill.surface) == Some(TokenId::AtSign)
                        }) {
                            expected.push(ExpectedToken::Token(TokenId::Blueprint));
                        }
                    }
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        expected,
                    ));
                } else {
                    frontier.push(slot_value_expectation(parser, clause.clone(), *slot));
                }
                return (frontier, true);
            }
            crate::parser::structural::SlotState::RepeatableComplete => {
                if slot.slot == SlotId::TimingsGlobalDuration {
                    let expected = if slot_fills.is_empty()
                        || crate::parser::structural::timings_global_duration_can_start_next_pair(
                            branch, clause,
                        ) {
                        crate::parser::structural::initial_expected_tokens_for_slot(SlotRef {
                            slot: slot.slot,
                            clause: Some(clause.clone()),
                        })
                    } else if matches!(
                        last_programmer_timing_pair_event(branch, clause),
                        Some(TimingPairEvent::Duration)
                    ) && duration_range_can_extend(&slot_fills)
                    {
                        vec![ExpectedToken::Token(TokenId::GreaterThan)]
                    } else {
                        Vec::new()
                    };
                    if !expected.is_empty() {
                        frontier.push(filtered_slot_expectation(
                            parser,
                            clause.clone(),
                            *slot,
                            expected,
                        ));
                    }
                } else if slot.slot == SlotId::ChannelOverrideIdentifier {
                    let value_started = branch.consumed_items.iter().any(|item| {
                        item.clause == *clause && item.slot.slot == SlotId::ChannelOverrideValue
                    });
                    if !value_started {
                        frontier.push(channel_identifier_continuation_expectation(
                            parser,
                            clause.clone(),
                        ));
                    }
                } else if slot.slot == SlotId::StepFxStepValues {
                    let expected_tokens = if slot_fills.is_empty() {
                        vec![ExpectedToken::Token(TokenId::Steps)]
                    } else {
                        signed_numeric_expected_tokens()
                    };
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        expected_tokens,
                    ));
                } else if slot.slot == SlotId::StepFxAttributeShaping {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        step_fx_shaping_expected_tokens(),
                    ));
                } else if slot.slot == SlotId::StoreBlueprintIdentifier {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        vec![ExpectedToken::Placeholder(ValueKind::NumericDigit)],
                    ));
                } else if slot.slot == SlotId::PatchTargetEndpoint
                    && slot_fills.last().is_some_and(|item| {
                        token_id_for_text(item.surface.as_str()) == Some(TokenId::Disabled)
                    })
                {
                } else {
                    frontier.push(slot_expectation(parser, clause.clone(), *slot));
                }
            }
            crate::parser::structural::SlotState::Complete => {
                if slot.slot == SlotId::PatchTargetEndpoint
                    && slot_fills.last().is_some_and(|item| {
                        token_id_for_text(item.surface.as_str()) == Some(TokenId::Disabled)
                    })
                {
                } else if slot.slot == SlotId::StepFxSelectionIdentifier && !slot_fills.is_empty() {
                    frontier.push(step_selection_identifier_continuation_expectation(
                        clause.clone(),
                    ));
                } else if (slot.slot == SlotId::SetAttrValue
                    && set_attr_value_can_extend(&slot_fills))
                    || (matches!(
                        slot.slot,
                        SlotId::TimingsGlobalDuration | SlotId::TimingsOverrideDuration
                    ) && duration_range_can_extend(&slot_fills))
                {
                    frontier.push(filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        vec![ExpectedToken::Token(TokenId::GreaterThan)],
                    ));
                } else if slot_keeps_expression_continuation_live(slot.slot, &slot_fills) {
                    frontier.push(slot_expectation(parser, clause.clone(), *slot));
                }
            }
        }
    }

    append_programmer_timing_pair_expectations(&mut frontier, branch, clause, parser);

    for child in &parser.children {
        if clause.clause == ClauseId::Programmer
            && child.parser.clause == ClauseId::ProgrammerSelection
            && is_active_selection_programmer_branch(branch)
        {
            continue;
        }
        let child_count = branch
            .clause_tree
            .nodes
            .iter()
            .filter(|node| {
                node.parent.is_some_and(|parent_id| {
                    branch.clause_tree.nodes[parent_id.0 as usize].clause == *clause
                }) && node.clause.clause == child.parser.clause
            })
            .count();
        if !child_clause_is_available(branch, clause, child.parser.clause) {
            continue;
        }
        if child_clause_requires_initial_entry(clause.clause, child.parser.clause, child_count) {
            frontier.push(
                initial_child_expectation(branch, child, child_count)
                    .unwrap_or_else(|| clause_expectation(parser, child.parser.clause)),
            );
            return (frontier, true);
        }
        match child.cardinality {
            ClauseCardinality::Required if child_count == 0 => {
                frontier.push(clause_expectation(parser, child.parser.clause));
                return (frontier, true);
            }
            ClauseCardinality::Optional if child_count == 0 => {
                append_child_clause_frontier_projection(
                    &mut frontier,
                    branch,
                    parser,
                    child,
                    child_count,
                );
            }
            ClauseCardinality::Repeated => {
                append_child_clause_frontier_projection(
                    &mut frontier,
                    branch,
                    parser,
                    child,
                    child_count,
                );
            }
            _ => {}
        }
    }

    (frontier, false)
}

/// Appends same-clause timing continuations for `fade in 1 out 2` style syntax.
fn append_programmer_timing_pair_expectations(
    frontier: &mut Vec<ClauseExpectation>,
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    parser: &StructuralClauseParser,
) {
    if clause.clause != ClauseId::ProgrammerTimings {
        return;
    }

    match last_programmer_timing_pair_event(branch, clause) {
        Some(TimingPairEvent::Direction) => {
            if let Some(slot) = parser
                .slots
                .iter()
                .find(|slot| slot.slot == SlotId::TimingsGlobalDuration)
            {
                push_unique_frontier(
                    frontier,
                    slot_value_expectation(parser, clause.clone(), *slot),
                );
            }
        }
        Some(TimingPairEvent::Duration | TimingPairEvent::Override)
            if programmer_timing_clause_has_direction(branch, clause) =>
        {
            if let Some(slot) = parser
                .slots
                .iter()
                .find(|slot| slot.slot == SlotId::TimingsDirection)
            {
                push_unique_frontier(
                    frontier,
                    filtered_slot_expectation(
                        parser,
                        clause.clone(),
                        *slot,
                        vec![
                            ExpectedToken::Token(TokenId::In),
                            ExpectedToken::Token(TokenId::Out),
                        ],
                    ),
                );
            }
        }
        _ => {}
    }
}

/// Pushes a frontier expectation only when it is not already present.
fn push_unique_frontier(frontier: &mut Vec<ClauseExpectation>, expectation: ClauseExpectation) {
    if !frontier.contains(&expectation) {
        frontier.push(expectation);
    }
}

/// Returns whether a programmer timing clause has at least one explicit direction.
fn programmer_timing_clause_has_direction(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> bool {
    branch
        .consumed_items
        .iter()
        .any(|item| item.clause == *clause && item.slot.slot == SlotId::TimingsDirection)
}

/// Returns the last same-clause timing event that can influence pair continuation.
fn last_programmer_timing_pair_event(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> Option<TimingPairEvent> {
    let mut events = branch
        .consumed_items
        .iter()
        .filter_map(|item| {
            if item.clause == *clause {
                match item.slot.slot {
                    SlotId::TimingsDirection => {
                        Some((item.source_span.start, TimingPairEvent::Direction))
                    }
                    SlotId::TimingsGlobalDuration => {
                        Some((item.source_span.start, TimingPairEvent::Duration))
                    }
                    _ => None,
                }
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    if let Some(parent_index) = branch
        .clause_tree
        .nodes
        .iter()
        .position(|node| node.clause == *clause)
    {
        events.extend(branch.clause_tree.nodes.iter().filter_map(|node| {
            let belongs_to_clause = node.parent.is_some_and(|parent_id| {
                parent_id.0 as usize == parent_index
                    && node.clause.clause == ClauseId::ProgrammerTimingOverride
            });
            belongs_to_clause.then_some((
                node.span.map(|span| span.start).unwrap_or(usize::MAX),
                TimingPairEvent::Override,
            ))
        }));
    }

    events
        .into_iter()
        .max_by_key(|(start, _)| *start)
        .map(|(_, event)| event)
}

fn is_active_selection_programmer_branch(branch: &ParseBranchState<'_>) -> bool {
    let has_active_selection_attribute_fills = branch.consumed_items.iter().any(|item| {
        matches!(
            item.slot.slot,
            SlotId::SetAttrAttribute | SlotId::SetAttrValue
        )
    });
    has_active_selection_attribute_fills
        && !branch.consumed_items.iter().any(|item| {
            item.clause.clause == ClauseId::Programmer && item.slot.slot == SlotId::CommandHead
        })
}

fn append_parallel_required_slot_expectations(
    frontier: &mut Vec<ClauseExpectation>,
    parser: &StructuralClauseParser,
    clause: ClauseInstance,
    pending_slot: SlotId,
) {
    if !should_offer_parallel_required_slots(parser.clause, pending_slot) {
        return;
    }

    for sibling in parser.slots {
        if sibling.slot == pending_slot || !matches!(sibling.cardinality, SlotCardinality::Required)
        {
            continue;
        }
        if parser.clause == ClauseId::ChannelOverride
            && sibling.slot == SlotId::ChannelOverrideValue
        {
            frontier.push(channel_root_value_expectation(parser, clause.clone()));
            continue;
        }
        frontier.push(slot_expectation(parser, clause.clone(), *sibling));
    }
}

fn should_offer_parallel_required_slots(clause: ClauseId, pending_slot: SlotId) -> bool {
    clause == ClauseId::ChannelOverride && pending_slot == SlotId::ChannelOverrideIdentifier
}

fn channel_root_value_expectation(
    parser: &StructuralClauseParser,
    clause: ClauseInstance,
) -> ClauseExpectation {
    ClauseExpectation {
        replace_active_token: false,
        target: ContinuationTarget::Slot(SlotRef {
            slot: SlotId::ChannelOverrideValue,
            clause: Some(clause),
        }),
        continuation_kind: crate::parser::structural::continuation_kind_for_slot(
            SlotId::ChannelOverrideValue,
        ),
        expected_tokens: vec![ExpectedToken::Placeholder(ValueKind::NumericDigit)],
        rule: root_rule_for_clause(parser.clause),
    }
}

fn append_child_clause_frontier_projection(
    frontier: &mut Vec<ClauseExpectation>,
    branch: &ParseBranchState<'_>,
    parser: &StructuralClauseParser,
    child: &StructuralClauseChild,
    _child_count: usize,
) {
    let clause_entry = clause_expectation(parser, child.parser.clause);
    if !frontier.contains(&clause_entry) {
        frontier.push(clause_entry);
    }
    if !child_clause_should_project_initial_slot(child.parser.clause) {
        return;
    }
    let Some(slot) = child.parser.slots.first().copied() else {
        return;
    };
    let child_clause = ClauseInstance {
        clause: child.parser.clause,
        instance: crate::parser::structural::next_child_clause_instance(
            branch,
            crate::slots::contracts::clause_parent(child.parser.clause)
                .expect("child clause parent"),
            child.parser.clause,
        ),
    };
    let slot_entry = filtered_slot_expectation(
        &child.parser,
        child_clause.clone(),
        slot,
        crate::parser::structural::initial_expected_tokens_for_slot(SlotRef {
            slot: slot.slot,
            clause: Some(child_clause),
        }),
    );
    if !frontier.contains(&slot_entry) {
        frontier.push(slot_entry);
    }
}

fn channel_identifier_continuation_expectation(
    parser: &StructuralClauseParser,
    clause: ClauseInstance,
) -> ClauseExpectation {
    ClauseExpectation {
        replace_active_token: false,
        target: ContinuationTarget::Slot(SlotRef {
            slot: SlotId::ChannelOverrideIdentifier,
            clause: Some(clause),
        }),
        continuation_kind: crate::parser::structural::continuation_kind_for_slot(
            SlotId::ChannelOverrideIdentifier,
        ),
        expected_tokens: vec![
            ExpectedToken::Token(TokenId::LeftParen),
            ExpectedToken::Token(TokenId::RightParen),
            ExpectedToken::Token(TokenId::Dot),
            ExpectedToken::Token(TokenId::Plus),
            ExpectedToken::Token(TokenId::Minus),
            ExpectedToken::Token(TokenId::GreaterThan),
            ExpectedToken::Placeholder(ValueKind::DmxAddress),
        ],
        rule: root_rule_for_clause(parser.clause),
    }
}

fn programmer_selection_identifier_entry_expectation(clause: ClauseInstance) -> ClauseExpectation {
    ClauseExpectation {
        replace_active_token: false,
        target: ContinuationTarget::Slot(SlotRef {
            slot: SlotId::SelectionIdentifier,
            clause: Some(clause),
        }),
        continuation_kind: ContinuationKind::IdentifierExpr,
        expected_tokens: vec![
            ExpectedToken::Token(TokenId::LeftParen),
            ExpectedToken::Placeholder(ValueKind::IdentifierExpression),
            ExpectedToken::Placeholder(ValueKind::NumericDigit),
        ],
        rule: GrammarRuleId::IdentifierExpression,
    }
}

fn step_selection_identifier_continuation_expectation(clause: ClauseInstance) -> ClauseExpectation {
    ClauseExpectation {
        replace_active_token: false,
        target: ContinuationTarget::Slot(SlotRef {
            slot: SlotId::StepFxSelectionIdentifier,
            clause: Some(clause),
        }),
        continuation_kind: ContinuationKind::IdentifierExpr,
        expected_tokens: vec![
            ExpectedToken::Token(TokenId::Plus),
            ExpectedToken::Token(TokenId::Minus),
            ExpectedToken::Token(TokenId::GreaterThan),
            ExpectedToken::Token(TokenId::Dot),
            ExpectedToken::Token(TokenId::LeftParen),
            ExpectedToken::Token(TokenId::RightParen),
            ExpectedToken::Placeholder(ValueKind::IdentifierExpression),
        ],
        rule: GrammarRuleId::IdentifierExpression,
    }
}

fn should_offer_child_clauses_alongside_required_slot(slot: SlotId) -> bool {
    matches!(slot, SlotId::ClearTarget)
}

fn append_available_child_clause_expectations(
    frontier: &mut Vec<ClauseExpectation>,
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    parser: &StructuralClauseParser,
) {
    for child in &parser.children {
        let child_count = branch
            .clause_tree
            .nodes
            .iter()
            .filter(|node| {
                node.parent.is_some_and(|parent_id| {
                    branch.clause_tree.nodes[parent_id.0 as usize].clause == *clause
                }) && node.clause.clause == child.parser.clause
            })
            .count();
        if child_count != 0 || !child_clause_is_available(branch, clause, child.parser.clause) {
            continue;
        }
        if matches!(
            child.cardinality,
            ClauseCardinality::Optional | ClauseCardinality::Required
        ) {
            frontier.push(clause_expectation(parser, child.parser.clause));
        }
    }
}

pub(super) fn slot_keeps_expression_continuation_live(
    slot: SlotId,
    fills: &[&crate::parser::analysis::ConsumedSemanticItem],
) -> bool {
    match slot {
        SlotId::SelectionIdentifier | SlotId::StepFxSelectionIdentifier | SlotId::ClearTarget => {
            !fills.is_empty()
        }
        SlotId::FxIdentifier => !fills.is_empty(),
        SlotId::FlowAction => {
            crate::parser::structural::flow_action_uses_identifier_expression(fills)
                && fills.len() > 1
        }
        SlotId::FxAction | SlotId::ClipAction => {
            fx_rate_value_surface(fills).is_some_and(|surface| {
                crate::parser::structural::is_complete_decimal_value(surface.as_str())
                    && !surface.contains('.')
            })
        }
        SlotId::SleepDuration => {
            let surface = merged_fill_surface(fills);
            crate::parser::frontier::is_complete_duration_value(surface.as_str())
                && crate::parser::structural::sleep_duration_can_extend(surface.as_str())
        }
        SlotId::FpsValue => {
            let surface = merged_fill_surface(fills);
            crate::parser::structural::is_complete_decimal_value(surface.as_str())
                && crate::parser::structural::fps_value_can_extend(surface.as_str())
        }
        _ => false,
    }
}

fn child_clause_requires_initial_entry(
    parent_clause: ClauseId,
    child_clause: ClauseId,
    child_count: usize,
) -> bool {
    child_count == 0
        && matches!(
            (parent_clause, child_clause),
            (
                ClauseId::ProgrammerSelection,
                ClauseId::ProgrammerSelectionIdentifier
            ) | (ClauseId::StepFx, ClauseId::StepFxStepDefinition)
        )
}

fn initial_child_expectation(
    branch: &ParseBranchState<'_>,
    child: &StructuralClauseChild,
    _child_count: usize,
) -> Option<ClauseExpectation> {
    let child_clause = ClauseInstance {
        clause: child.parser.clause,
        instance: crate::parser::structural::next_child_clause_instance(
            branch,
            crate::slots::contracts::clause_parent(child.parser.clause)
                .expect("child clause parent"),
            child.parser.clause,
        ),
    };
    if child.parser.clause == ClauseId::StepFxDuration {
        return Some(ClauseExpectation {
            replace_active_token: false,
            target: ContinuationTarget::Slot(SlotRef {
                slot: SlotId::StepFxDuration,
                clause: Some(child_clause),
            }),
            continuation_kind: crate::parser::structural::continuation_kind_for_slot(
                SlotId::StepFxDuration,
            ),
            expected_tokens: vec![ExpectedToken::Placeholder(ValueKind::DurationValue)],
            rule: GrammarRuleId::DurationValue,
        });
    }
    if child.parser.clause == ClauseId::StepFxStepDefinition {
        let slot_ref = SlotRef {
            slot: SlotId::StepFxStepAttribute,
            clause: Some(child_clause),
        };
        return Some(ClauseExpectation {
            replace_active_token: false,
            target: ContinuationTarget::Slot(slot_ref.clone()),
            continuation_kind: crate::parser::structural::continuation_kind_for_slot(slot_ref.slot),
            expected_tokens: expected_tokens_for_slot(slot_ref),
            rule: GrammarRuleId::FxAttributeSteps,
        });
    }

    if child.parser.clause == ClauseId::ProgrammerSelectionIdentifier {
        return Some(ClauseExpectation {
            replace_active_token: false,
            target: ContinuationTarget::Clause(child.parser.clause),
            continuation_kind: ContinuationKind::ClauseEntry,
            expected_tokens: programmer_selection_identifier_entry_expectation(child_clause)
                .expected_tokens,
            rule: GrammarRuleId::IdentifierExpression,
        });
    }

    Some(ClauseExpectation {
        replace_active_token: false,
        target: ContinuationTarget::Clause(child.parser.clause),
        continuation_kind: ContinuationKind::ClauseEntry,
        expected_tokens: expected_tokens_for_clause_entry(child.parser.clause),
        rule: root_rule_for_clause(child.parser.clause),
    })
}

fn child_clause_should_project_initial_slot(clause: ClauseId) -> bool {
    matches!(
        clause,
        ClauseId::ProgrammerSetAttributeItem
            | ClauseId::ProgrammerTimings
            | ClauseId::FxIdentifier
            | ClauseId::FxAction
            | ClauseId::RecallCue
            | ClauseId::RecallBlueprint
            | ClauseId::ClipAction
            | ClauseId::FlowAction
            | ClauseId::TimecodeAction
            | ClauseId::TimelineAction
    )
}
