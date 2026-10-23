// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tempo-family helpers used by the structural parser.
//!
//! The `tempo` command owns a single action slot whose first fill selects the operation: a
//! number starts an unsigned decimal BPM, `nudge` expects a signed decimal number of beats,
//! `bar` expects an integer beat count, and the remaining keywords take no operand. These
//! helpers decide which follow-up tokens the slot may still consume and what to suggest next.

use crate::lexicon::tokens::token_id_for_text;
use crate::parser::analysis::{
    ConsumedSemanticItem, ExpectedToken, FilledValue, NormalizedFilledValue, TokenId, ValueKind,
};
use crate::parser::lexer::{LexerToken, LexerTokenKind};
use crate::parser::structural::{
    decimal_value_prefix, is_complete_decimal_value, normalized_value_for_fill,
    signed_numeric_expected_tokens,
};
use crate::slots::contracts::SlotId;

/// Operand grammar selected by the first fill of a tempo action slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TempoOperand {
    /// Unsigned decimal BPM whose first digits are the leading fill itself.
    Bpm,
    /// Signed decimal beat offset following the `nudge` keyword.
    Nudge,
    /// Integer beats-per-bar count following the `bar` keyword.
    Bar,
    /// Keyword operation that accepts no operand.
    Standalone,
}

/// Classifies the operand grammar of a tempo action from its leading fill.
fn tempo_operand(fills: &[&ConsumedSemanticItem]) -> Option<TempoOperand> {
    let first = fills.first()?;
    if first.surface.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(TempoOperand::Bpm);
    }
    Some(match token_id_for_text(first.surface.as_str())? {
        TokenId::Nudge => TempoOperand::Nudge,
        TokenId::Bar => TempoOperand::Bar,
        _ => TempoOperand::Standalone,
    })
}

/// Returns the numeric operand text consumed so far, including the BPM's leading digits.
fn tempo_value_surface(operand: TempoOperand, fills: &[&ConsumedSemanticItem]) -> String {
    let skip = usize::from(operand != TempoOperand::Bpm);
    fills
        .iter()
        .skip(skip)
        .map(|item| item.surface.as_str())
        .collect()
}

/// Builds the slot fill recorded for one accepted tempo follow-up token.
fn tempo_fill(slot: SlotId, token: &LexerToken) -> (FilledValue, Option<NormalizedFilledValue>) {
    let value = match token_id_for_text(token.text.as_str()) {
        Some(token_id @ (TokenId::Plus | TokenId::Minus | TokenId::Dot)) => {
            FilledValue::Token(token_id)
        }
        _ => FilledValue::Lexeme(token.text.clone()),
    };
    let normalized = normalized_value_for_fill(slot, &value, &token.text);
    (value, normalized)
}

/// Accepts the next token of a tempo operand, rejecting anything the operand grammar forbids.
///
/// The first operand token after `nudge` or `bar` may follow whitespace; every later token must
/// touch the previous fill so that `128 .5` or `- 0.1` never parse as one value.
pub(super) fn filled_value_for_tempo_followup(
    slot: SlotId,
    fills: &[&ConsumedSemanticItem],
    token: &LexerToken,
) -> Option<(FilledValue, Option<NormalizedFilledValue>)> {
    let operand = tempo_operand(fills)?;
    let surface = tempo_value_surface(operand, fills);
    let adjacent = fills
        .last()
        .is_some_and(|fill| fill.source_span.end == token.span.start);
    let is_number = token.kind == LexerTokenKind::Number;
    let is_sign = matches!(token.kind, LexerTokenKind::Plus | LexerTokenKind::Minus);
    let is_dot = token.kind == LexerTokenKind::Dot;
    let accepts = match operand {
        TempoOperand::Standalone => false,
        TempoOperand::Bar => surface.is_empty() && is_number,
        TempoOperand::Nudge if surface.is_empty() => is_number || is_sign,
        TempoOperand::Bpm | TempoOperand::Nudge => {
            adjacent
                && if surface.ends_with(['+', '-', '.']) {
                    is_number
                } else {
                    is_dot && is_complete_decimal_value(surface.as_str()) && !surface.contains('.')
                }
        }
    };
    accepts.then(|| tempo_fill(slot, token))
}

/// Returns whether a tempo action still needs operand tokens before it can complete.
pub(super) fn tempo_action_requires_followup(fills: &[&ConsumedSemanticItem]) -> bool {
    let Some(operand) = tempo_operand(fills) else {
        return false;
    };
    let surface = tempo_value_surface(operand, fills);
    match operand {
        TempoOperand::Standalone => false,
        TempoOperand::Bar => surface.is_empty(),
        TempoOperand::Bpm | TempoOperand::Nudge => {
            surface.is_empty()
                || (decimal_value_prefix(surface.as_str())
                    && !is_complete_decimal_value(surface.as_str()))
        }
    }
}

/// Returns whether a complete tempo value may still grow a fractional part.
pub(super) fn tempo_action_can_extend(fills: &[&ConsumedSemanticItem]) -> bool {
    let Some(operand @ (TempoOperand::Bpm | TempoOperand::Nudge)) = tempo_operand(fills) else {
        return false;
    };
    let surface = tempo_value_surface(operand, fills);
    is_complete_decimal_value(surface.as_str()) && !surface.contains('.')
}

/// Returns the suggestions for an incomplete tempo operand.
pub(super) fn tempo_followup_expected_tokens(
    fills: &[&ConsumedSemanticItem],
) -> Vec<ExpectedToken> {
    match tempo_operand(fills) {
        Some(TempoOperand::Nudge) if tempo_value_surface(TempoOperand::Nudge, fills).is_empty() => {
            signed_numeric_expected_tokens()
        }
        _ => vec![ExpectedToken::Placeholder(ValueKind::NumericDigit)],
    }
}
