// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! FX-family helpers used by the structural parser.

use crate::lexicon::tokens::token_id_for_text;
use crate::parser::analysis::{
    ClauseCommitState, ClauseFrame, ClauseInstance, ClausePhase, CommandPrefixContext,
    ConsumedSemanticItem, ExpectedToken, FilledValue, NormalizedFilledValue, ParseBranchState,
    TokenId,
};
use crate::parser::frontier::is_complete_duration_value;
use crate::parser::lexer::{LexerToken, LexerTokenKind};
use crate::parser::structural::{normalized_value_for_fill, refresh_branch};
use crate::slots::contracts::{ClauseId, SlotId};

pub(super) fn step_fx_shaping_expected_tokens() -> Vec<ExpectedToken> {
    vec![
        ExpectedToken::Token(TokenId::Width),
        ExpectedToken::Token(TokenId::Ramp),
        ExpectedToken::Literal("linear".into()),
        ExpectedToken::Literal("easein".into()),
        ExpectedToken::Literal("easeout".into()),
        ExpectedToken::Literal("ease".into()),
        ExpectedToken::Literal("snap".into()),
        ExpectedToken::Literal("bezier".into()),
    ]
}

pub(super) fn fx_rate_value_surface(fills: &[&ConsumedSemanticItem]) -> Option<String> {
    fills
        .first()
        .is_some_and(|item| token_id_for_text(item.surface.as_str()) == Some(TokenId::Rate))
        .then(|| {
            fills
                .iter()
                .skip(1)
                .map(|item| item.surface.as_str())
                .collect::<String>()
        })
}

pub(super) fn filled_value_for_fx_rate_followup(
    slot: SlotId,
    fills: &[&ConsumedSemanticItem],
    token: &LexerToken,
    decimal_value_prefix: fn(&str) -> bool,
    is_complete_decimal_value: fn(&str) -> bool,
) -> Option<(FilledValue, Option<NormalizedFilledValue>)> {
    let value_surface = fx_rate_value_surface(fills)?;
    let token_id = token_id_for_text(token.text.as_str());
    if value_surface.is_empty() {
        if token.kind == LexerTokenKind::Number {
            let value = FilledValue::Lexeme(token.text.clone());
            return Some((
                value.clone(),
                normalized_value_for_fill(slot, &value, &token.text),
            ));
        }
        if let Some(token_id @ (TokenId::Plus | TokenId::Minus)) = token_id {
            let value = FilledValue::Token(token_id);
            return Some((
                value.clone(),
                normalized_value_for_fill(slot, &value, &token.text),
            ));
        }
        return None;
    }

    if decimal_value_prefix(value_surface.as_str())
        && !is_complete_decimal_value(value_surface.as_str())
    {
        if token.kind == LexerTokenKind::Number {
            let value = FilledValue::Lexeme(token.text.clone());
            return Some((
                value.clone(),
                normalized_value_for_fill(slot, &value, &token.text),
            ));
        }
        return None;
    }

    if is_complete_decimal_value(value_surface.as_str())
        && !value_surface.contains('.')
        && token_id == Some(TokenId::Dot)
    {
        let value = FilledValue::Token(TokenId::Dot);
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }

    None
}

pub(super) fn fx_rate_requires_followup(
    fills: &[&ConsumedSemanticItem],
    decimal_value_prefix: fn(&str) -> bool,
    is_complete_decimal_value: fn(&str) -> bool,
) -> bool {
    let Some(value_surface) = fx_rate_value_surface(fills) else {
        return false;
    };
    value_surface.is_empty()
        || (decimal_value_prefix(value_surface.as_str())
            && !is_complete_decimal_value(value_surface.as_str()))
}

pub(super) fn promote_ready_step_fx_definition(
    context: &CommandPrefixContext,
    branch: &mut ParseBranchState<'_>,
) {
    if !context.has_trailing_whitespace
        || branch
            .clause_stack
            .last()
            .is_none_or(|frame| frame.clause.clause != ClauseId::StepFxDuration)
        || branch
            .clause_stack
            .iter()
            .any(|frame| frame.clause.clause == ClauseId::StepFxStepDefinition)
    {
        return;
    }

    let duration_complete = branch
        .consumed_items
        .iter()
        .rev()
        .find(|item| item.slot.slot == SlotId::StepFxDuration)
        .is_some_and(|item| is_complete_duration_value(item.surface.as_str()));
    if !duration_complete {
        return;
    }

    branch.clause_stack.push(ClauseFrame {
        clause: ClauseInstance {
            clause: ClauseId::StepFxStepDefinition,
            instance: 0,
        },
        phase: ClausePhase::Entered,
        commit_state: ClauseCommitState::Committed,
    });
    refresh_branch(branch);
}
