// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programmer-family helpers used by the structural parser.

use crate::lexicon::tokens::token_id_for_text;
use crate::parser::analysis::{
    ClauseExpectation, ClauseInstance, ExpectedToken, NormalizedFilledValue, ParseBranchState,
    TokenId,
};
use crate::parser::structural::{
    StructuralClauseParser, signed_numeric_expected_tokens, slot_requires_followup_value,
};
use crate::parser::structural_expectation::{filtered_slot_expectation, slot_expectation};
use crate::slots::contracts::SlotId;

fn push_expected_token(tokens: &mut Vec<ExpectedToken>, token: ExpectedToken) {
    if !tokens.contains(&token) {
        tokens.push(token);
    }
}

fn placement_action_expected_tokens(used_actions: &[TokenId]) -> Vec<ExpectedToken> {
    let mut expected_tokens = Vec::new();
    for token in [TokenId::Pos, TokenId::Rot] {
        if !used_actions.contains(&token) {
            push_expected_token(&mut expected_tokens, ExpectedToken::Token(token));
        }
    }
    expected_tokens
}

fn placement_axis_expected_tokens(used_axes: &[TokenId]) -> Vec<ExpectedToken> {
    let mut expected_tokens = Vec::new();
    for token in [TokenId::X, TokenId::Y, TokenId::Z] {
        if !used_axes.contains(&token) {
            push_expected_token(&mut expected_tokens, ExpectedToken::Token(token));
        }
    }
    push_expected_token(
        &mut expected_tokens,
        ExpectedToken::Placeholder(crate::parser::analysis::ValueKind::NumericDigit),
    );
    expected_tokens
}

pub(super) fn programmer_placement_frontier(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    parser: &StructuralClauseParser,
) -> (Vec<ClauseExpectation>, bool) {
    let Some(action_slot) = parser
        .slots
        .iter()
        .copied()
        .find(|slot| slot.slot == SlotId::PlacementAction)
    else {
        return (Vec::new(), false);
    };
    let Some(axis_slot) = parser
        .slots
        .iter()
        .copied()
        .find(|slot| slot.slot == SlotId::PlacementAxisValue)
    else {
        return (Vec::new(), false);
    };

    let clause_items = branch
        .consumed_items
        .iter()
        .filter(|item| item.clause == *clause)
        .collect::<Vec<_>>();
    let action_items = clause_items
        .iter()
        .copied()
        .filter(|item| item.slot.slot == SlotId::PlacementAction)
        .collect::<Vec<_>>();

    if action_items.is_empty() {
        return (
            vec![filtered_slot_expectation(
                parser,
                clause.clone(),
                action_slot,
                placement_action_expected_tokens(&[]),
            )],
            true,
        );
    }

    let Some(last_action_index) = clause_items
        .iter()
        .rposition(|item| item.slot.slot == SlotId::PlacementAction)
    else {
        return (Vec::new(), false);
    };
    let current_action_items = clause_items[last_action_index + 1..]
        .iter()
        .copied()
        .filter(|item| item.slot.slot == SlotId::PlacementAxisValue)
        .collect::<Vec<_>>();

    if current_action_items.is_empty() {
        return (
            vec![slot_expectation(parser, clause.clone(), axis_slot)],
            true,
        );
    }

    if slot_requires_followup_value(SlotId::PlacementAxisValue, &current_action_items) {
        return (
            vec![filtered_slot_expectation(
                parser,
                clause.clone(),
                axis_slot,
                signed_numeric_expected_tokens(),
            )],
            true,
        );
    }

    let mut frontier = Vec::new();
    let last_axis_index = current_action_items.iter().rposition(|item| {
        matches!(
            token_id_for_text(item.surface.as_str()),
            Some(TokenId::X | TokenId::Y | TokenId::Z)
        )
    });
    let current_component = last_axis_index
        .map(|index| &current_action_items[index + 1..])
        .unwrap_or(current_action_items.as_slice());
    if !current_component.is_empty()
        && !current_component
            .iter()
            .any(|item| token_id_for_text(item.surface.as_str()) == Some(TokenId::Dot))
    {
        frontier.push(filtered_slot_expectation(
            parser,
            clause.clone(),
            axis_slot,
            vec![ExpectedToken::Token(TokenId::Dot)],
        ));
    }
    let used_action_tokens = action_items
        .iter()
        .filter_map(|item| match item.normalized_value.as_ref() {
            Some(NormalizedFilledValue::Keyword(token)) => Some(*token),
            _ => token_id_for_text(item.surface.as_str()),
        })
        .collect::<Vec<_>>();
    let remaining_actions = placement_action_expected_tokens(&used_action_tokens);
    if !remaining_actions.is_empty() {
        frontier.push(filtered_slot_expectation(
            parser,
            clause.clone(),
            action_slot,
            remaining_actions,
        ));
    }

    let used_axis_tokens = current_action_items
        .iter()
        .filter_map(|item| match item.normalized_value.as_ref() {
            Some(NormalizedFilledValue::Keyword(token)) => Some(*token),
            _ => token_id_for_text(item.surface.as_str()),
        })
        .filter(|token| matches!(token, TokenId::X | TokenId::Y | TokenId::Z))
        .collect::<Vec<_>>();
    let remaining_axes = placement_axis_expected_tokens(&used_axis_tokens);
    if !remaining_axes.is_empty() {
        frontier.push(filtered_slot_expectation(
            parser,
            clause.clone(),
            axis_slot,
            remaining_axes,
        ));
    }

    (frontier, false)
}
