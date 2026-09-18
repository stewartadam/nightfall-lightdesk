// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Slot fill construction, surface parsing, and semantic normalization.

use super::*;

/// Converts one lexer token into a slot fill and its normalized semantic value.
pub(in crate::parser) fn filled_value_for_slot(
    slot: SlotId,
    token: &LexerToken,
) -> Option<(FilledValue, Option<NormalizedFilledValue>)> {
    if slot == SlotId::ShowfileName
        && matches!(token.kind, LexerTokenKind::Minus | LexerTokenKind::Dot)
    {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if matches!(slot, SlotId::FxIdentifier | SlotId::FxModuleIdentifier)
        && token.kind == LexerTokenKind::Word
    {
        return None;
    }
    if attribute_collection_parse_spec_for_slot(slot).is_some_and(|spec| {
        attribute_lexeme_is_allowed(
            spec.attribute_spec,
            token.text.as_str(),
            token_id_for_text(token.text.as_str()),
            token.kind == LexerTokenKind::QuotedString,
        )
    }) {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::PatchPriority
        && matches!(
            token.text.to_ascii_lowercase().as_str(),
            "prio" | "priority"
        )
    {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::PatchClone && token.text.eq_ignore_ascii_case("/clone") {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::StoreMode && is_store_mode_surface(token.text.as_str()) {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::RecallSelectFlag && is_recall_select_surface(token.text.as_str()) {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::StoreFixtureOffsetKeyword && token.text.eq_ignore_ascii_case("offset") {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::StepFxGroupsKeyword && token.text.eq_ignore_ascii_case("groups") {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::StoreFxModulePayload {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::StepFxSelectionIdentifier
        && token.kind == LexerTokenKind::Word
        && token.text.contains('|')
    {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::SetAttrValue
        && matches!(
            token_id_for_text(token.text.as_str()),
            Some(TokenId::AtSign | TokenId::Tilde | TokenId::DoubleAtSign)
        )
    {
        let value = FilledValue::Token(token_id_for_text(token.text.as_str())?);
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::ChannelOverrideValue
        && token_id_for_text(token.text.as_str()) == Some(TokenId::AtSign)
    {
        let value = FilledValue::Token(TokenId::AtSign);
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::PlacementAxisValue
        && token.kind == LexerTokenKind::Word
        && is_tuple_axis_component(token.text.as_str())
    {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if slot == SlotId::StepFxAttributeShaping
        && token.kind == LexerTokenKind::Word
        && matches!(
            token.text.to_ascii_lowercase().as_str(),
            "linear" | "easein" | "easeout" | "ease" | "snap" | "bezier"
        )
    {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if let Some(token_id) = token_id_for_slot_surface(slot, token.text.as_str()) {
        if slot == SlotId::ClearTarget
            && matches!(
                token_id,
                TokenId::Plus
                    | TokenId::Minus
                    | TokenId::GreaterThan
                    | TokenId::Dot
                    | TokenId::LeftParen
                    | TokenId::RightParen
            )
        {
            let value = FilledValue::Token(token_id);
            return Some((
                value.clone(),
                normalized_value_for_fill(slot, &value, &token.text),
            ));
        }
        if slot == SlotId::FlowAction
            && matches!(
                token_id,
                TokenId::Plus
                    | TokenId::Minus
                    | TokenId::GreaterThan
                    | TokenId::Dot
                    | TokenId::LeftParen
                    | TokenId::RightParen
            )
        {
            let value = FilledValue::Token(token_id);
            return Some((
                value.clone(),
                normalized_value_for_fill(slot, &value, &token.text),
            ));
        }
        if slot_accepts_token(slot, token_id) {
            let value = FilledValue::Token(token_id);
            return Some((
                value.clone(),
                normalized_value_for_fill(slot, &value, &token.text),
            ));
        }
    }

    let placeholder = slot_spec(slot).offers.placeholder?;
    if !placeholder_accepts_token(placeholder, token) {
        return None;
    }

    let value = FilledValue::Lexeme(token.text.clone());
    Some((
        value.clone(),
        normalized_value_for_fill(slot, &value, &token.text),
    ))
}

/// Resolves a surface token using slot-specific attribute canonicalization when needed.
pub(in crate::parser) fn token_id_for_slot_surface(slot: SlotId, text: &str) -> Option<TokenId> {
    if attribute_collection_parse_spec_for_slot(slot).is_some() {
        let normalized = canonicalize_token(
            text,
            AliasCanonicalizationContext {
                attribute_context: true,
                ..AliasCanonicalizationContext::default()
            },
        );
        return token_id_for_text(normalized.as_str());
    }

    token_id_for_text(text)
}

/// Joins the operator and value fills that form an attribute value surface.
pub(in crate::parser) fn set_attr_value_surface(fills: &[&ConsumedSemanticItem]) -> Option<String> {
    (!fills.is_empty()).then(|| {
        fills
            .iter()
            .map(|item| item.surface.as_str())
            .collect::<String>()
    })
}

/// Returns whether text is a valid prefix of a scalar or fanned value range.
pub(in crate::parser) fn value_range_prefix(raw: &str) -> bool {
    let value = raw.trim();
    if value.is_empty() {
        return false;
    }
    if cue_tracking_marker_value(value) {
        return true;
    }
    if value.starts_with('>') {
        return false;
    }

    let segments = value.split('>').collect::<Vec<_>>();
    let mut saw_complete_segment = false;
    for (index, segment) in segments.iter().enumerate() {
        let is_last = index + 1 == segments.len();
        let segment = segment.trim();
        if segment.is_empty() {
            return is_last && value.ends_with('>') && saw_complete_segment;
        }
        if !decimal_value_prefix(segment) {
            return false;
        }
        if !is_last && !is_complete_decimal_value(segment) {
            return false;
        }
        saw_complete_segment = true;
    }

    saw_complete_segment
}

/// Returns whether every segment of a value range is syntactically complete.
pub(in crate::parser) fn is_complete_value_range(raw: &str) -> bool {
    let value = raw.trim();
    if value.is_empty() {
        return false;
    }
    if cue_tracking_marker_value(value) {
        return true;
    }

    value
        .split('>')
        .map(str::trim)
        .all(|segment| !segment.is_empty() && is_complete_decimal_value(segment))
}

/// Returns whether the surface is a complete cue tracking marker value.
pub(in crate::parser) fn cue_tracking_marker_value(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "release" | "r" | "hold" | "h"
    )
}

/// Determines whether an attribute value surface still requires a value token.
pub(in crate::parser) fn set_attr_value_requires_followup(fills: &[&ConsumedSemanticItem]) -> bool {
    if fills
        .first()
        .is_some_and(|fill| token_id_for_text(fill.surface.as_str()) == Some(TokenId::AtSign))
        && fills.get(1).is_some_and(|fill| {
            token_id_for_text(fill.surface.as_str()) == Some(TokenId::Blueprint)
        })
    {
        return fills.len() < 3;
    }
    let Some(surface) = set_attr_value_surface(fills) else {
        return false;
    };
    let surface = surface.trim();
    if surface == "@@" {
        return false;
    }
    let Some(value) = surface
        .strip_prefix('@')
        .or_else(|| surface.strip_prefix('~'))
    else {
        return false;
    };
    if value.is_empty() {
        return true;
    }

    value_range_prefix(value) && !is_complete_value_range(value)
}

/// Determines whether a Step FX source still needs digits or a Blueprint address.
pub(in crate::parser) fn step_fx_value_requires_followup(fills: &[&ConsumedSemanticItem]) -> bool {
    let last = fills
        .last()
        .and_then(|fill| token_id_for_text(fill.surface.as_str()));
    if matches!(
        last,
        Some(TokenId::AtSign | TokenId::Tilde | TokenId::Plus | TokenId::Minus | TokenId::Dot)
    ) {
        return true;
    }
    last == Some(TokenId::Blueprint)
        && fills
            .iter()
            .rev()
            .nth(1)
            .is_some_and(|fill| token_id_for_text(fill.surface.as_str()) == Some(TokenId::AtSign))
}

/// Returns whether a complete attribute value can accept a range continuation.
pub(in crate::parser) fn set_attr_value_can_extend(fills: &[&ConsumedSemanticItem]) -> bool {
    let Some(surface) = set_attr_value_surface(fills) else {
        return false;
    };
    let surface = surface.trim();
    if surface == "@@" {
        return false;
    }
    let Some(value) = surface
        .strip_prefix('@')
        .or_else(|| surface.strip_prefix('~'))
    else {
        return false;
    };
    !value.is_empty() && is_complete_value_range(value)
}

/// Returns whether text is a valid prefix of a scalar or fanned duration range.
pub(in crate::parser) fn duration_range_prefix(raw: &str) -> bool {
    let value = raw.trim();
    if value.is_empty() {
        return false;
    }
    if value.starts_with('>') {
        return false;
    }

    let segments = value.split('>').collect::<Vec<_>>();
    let mut saw_complete_segment = false;
    for (index, segment) in segments.iter().enumerate() {
        let is_last = index + 1 == segments.len();
        let segment = segment.trim();
        if segment.is_empty() {
            return is_last && value.ends_with('>') && saw_complete_segment;
        }
        if !duration_value_prefix(segment) {
            return false;
        }
        if !is_last && !is_complete_duration_value(segment) {
            return false;
        }
        saw_complete_segment = true;
    }

    saw_complete_segment
}

/// Returns whether every segment of a duration range is syntactically complete.
pub(in crate::parser) fn is_complete_duration_range(raw: &str) -> bool {
    let value = raw.trim();
    if value.is_empty() {
        return false;
    }

    value
        .split('>')
        .map(str::trim)
        .all(|segment| !segment.is_empty() && is_complete_duration_value(segment))
}

/// Determines whether a duration range still needs another token to complete.
pub(in crate::parser) fn duration_range_requires_followup(fills: &[&ConsumedSemanticItem]) -> bool {
    let surface = merged_fill_surface(fills);
    duration_range_prefix(surface.as_str()) && !is_complete_duration_range(surface.as_str())
}

/// Returns whether a complete duration range can accept another range segment.
pub(in crate::parser) fn duration_range_can_extend(fills: &[&ConsumedSemanticItem]) -> bool {
    let surface = merged_fill_surface(fills);
    !surface.trim().is_empty() && is_complete_duration_range(surface.as_str())
}

/// Builds the next normalized fill for a multi-token attribute value surface.
pub(in crate::parser) fn filled_value_for_set_attr_value_followup(
    slot: SlotId,
    fills: &[&ConsumedSemanticItem],
    token: &LexerToken,
) -> Option<(FilledValue, Option<NormalizedFilledValue>)> {
    if fills.len() == 1
        && token_id_for_text(fills[0].surface.as_str()) == Some(TokenId::AtSign)
        && token_id_for_text(token.text.as_str()) == Some(TokenId::Blueprint)
    {
        let value = FilledValue::Token(TokenId::Blueprint);
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if fills.len() == 2
        && token_id_for_text(fills[0].surface.as_str()) == Some(TokenId::AtSign)
        && token_id_for_text(fills[1].surface.as_str()) == Some(TokenId::Blueprint)
        && matches!(
            token.kind,
            LexerTokenKind::Number | LexerTokenKind::Word | LexerTokenKind::QuotedString
        )
    {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    let surface = set_attr_value_surface(fills)?;
    let surface = surface.trim();
    if surface == "@@" {
        return None;
    }
    let value_surface = surface
        .strip_prefix('@')
        .or_else(|| surface.strip_prefix('~'))?;
    let token_id = token_id_for_text(token.text.as_str());
    let candidate = format!("{value_surface}{}", token.text);
    if token.kind != LexerTokenKind::Number
        && !matches!(
            token_id,
            Some(TokenId::Plus | TokenId::Minus | TokenId::GreaterThan | TokenId::Dot)
        )
        && !cue_tracking_marker_value(candidate.as_str())
    {
        return None;
    }
    if !value_range_prefix(candidate.as_str()) {
        return None;
    }

    let value = if let Some(
        token_id @ (TokenId::Plus | TokenId::Minus | TokenId::GreaterThan | TokenId::Dot),
    ) = token_id
    {
        FilledValue::Token(token_id)
    } else {
        FilledValue::Lexeme(token.text.clone())
    };
    Some((
        value.clone(),
        normalized_value_for_fill(slot, &value, &token.text),
    ))
}

/// Builds the Blueprint-specific continuation of a Step FX scalar source.
pub(in crate::parser) fn filled_value_for_step_fx_blueprint_followup(
    slot: SlotId,
    fills: &[&ConsumedSemanticItem],
    token: &LexerToken,
) -> Option<(FilledValue, Option<NormalizedFilledValue>)> {
    let last = fills.last()?;
    if token_id_for_text(last.surface.as_str()) == Some(TokenId::AtSign)
        && token_id_for_text(token.text.as_str()) == Some(TokenId::Blueprint)
    {
        let value = FilledValue::Token(TokenId::Blueprint);
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    if token_id_for_text(last.surface.as_str()) == Some(TokenId::Blueprint)
        && fills
            .iter()
            .rev()
            .nth(1)
            .is_some_and(|fill| token_id_for_text(fill.surface.as_str()) == Some(TokenId::AtSign))
        && matches!(
            token.kind,
            LexerTokenKind::Number | LexerTokenKind::Word | LexerTokenKind::QuotedString
        )
    {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }
    None
}

/// Builds the next normalized fill for a multi-token duration range.
pub(in crate::parser) fn filled_value_for_duration_range_followup(
    slot: SlotId,
    fills: &[&ConsumedSemanticItem],
    token: &LexerToken,
) -> Option<(FilledValue, Option<NormalizedFilledValue>)> {
    let surface = merged_fill_surface(fills);
    let token_id = token_id_for_text(token.text.as_str());
    if token.kind != LexerTokenKind::Number
        && token.kind != LexerTokenKind::Word
        && token.kind != LexerTokenKind::Percent
        && !matches!(
            token_id,
            Some(TokenId::Plus | TokenId::Minus | TokenId::Dot | TokenId::GreaterThan)
        )
    {
        return None;
    }

    let candidate = format!("{surface}{}", token.text);
    if !duration_range_prefix(candidate.as_str()) {
        return None;
    }

    let value = if let Some(
        token_id @ (TokenId::Plus | TokenId::Minus | TokenId::Dot | TokenId::GreaterThan),
    ) = token_id
    {
        FilledValue::Token(token_id)
    } else {
        FilledValue::Lexeme(token.text.clone())
    };
    Some((
        value.clone(),
        normalized_value_for_fill(slot, &value, &token.text),
    ))
}

/// Detects an opened Bezier shaping expression that has not reached its closing token.
pub(in crate::parser) fn bezier_expression_in_progress(fills: &[&ConsumedSemanticItem]) -> bool {
    let Some(bezier_index) = fills
        .iter()
        .rposition(|item| item.surface.eq_ignore_ascii_case("bezier"))
    else {
        return false;
    };

    !fills[bezier_index + 1..]
        .iter()
        .any(|item| token_id_for_text(item.surface.as_str()) == Some(TokenId::RightParen))
}

/// Builds a follow-up fill for Step FX width, ramp, or Bezier shaping input.
pub(in crate::parser) fn filled_value_for_step_fx_shaping_followup(
    slot: SlotId,
    fills: &[&ConsumedSemanticItem],
    token: &LexerToken,
) -> Option<(FilledValue, Option<NormalizedFilledValue>)> {
    if !bezier_expression_in_progress(fills) {
        return None;
    }

    if let Some(token_id @ (TokenId::LeftParen | TokenId::RightParen | TokenId::Dot)) =
        token_id_for_text(token.text.as_str())
    {
        let value = FilledValue::Token(token_id);
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }

    if matches!(
        token.kind,
        LexerTokenKind::Number
            | LexerTokenKind::Word
            | LexerTokenKind::Comma
            | LexerTokenKind::Plus
            | LexerTokenKind::Minus
    ) {
        let value = FilledValue::Lexeme(token.text.clone());
        return Some((
            value.clone(),
            normalized_value_for_fill(slot, &value, &token.text),
        ));
    }

    None
}

/// Checks whether a lexer token can satisfy the requested placeholder value kind.
pub(in crate::parser) fn placeholder_accepts_token(
    kind: crate::parser::analysis::ValueKind,
    token: &LexerToken,
) -> bool {
    match kind {
        crate::parser::analysis::ValueKind::ColorPathReference => token
            .text
            .to_ascii_lowercase()
            .strip_prefix("path")
            .is_some_and(|suffix| suffix.chars().all(|ch| ch.is_ascii_digit())),
        crate::parser::analysis::ValueKind::BlueprintAddress => {
            !token.text.starts_with('$')
                && matches!(
                    token.kind,
                    LexerTokenKind::Word | LexerTokenKind::Number | LexerTokenKind::QuotedString
                )
        }
        crate::parser::analysis::ValueKind::Text => matches!(
            token.kind,
            LexerTokenKind::Word | LexerTokenKind::Number | LexerTokenKind::QuotedString
        ),
        crate::parser::analysis::ValueKind::NumericDigit
        | crate::parser::analysis::ValueKind::DmxAddress => token.kind == LexerTokenKind::Number,
        crate::parser::analysis::ValueKind::DurationValue => {
            matches!(token.kind, LexerTokenKind::Number | LexerTokenKind::Word)
                && duration_value_prefix(token.text.as_str())
        }
        crate::parser::analysis::ValueKind::ValueRange => {
            matches!(token.kind, LexerTokenKind::Number | LexerTokenKind::Word)
        }
        crate::parser::analysis::ValueKind::IdentifierExpression => matches!(
            token.kind,
            LexerTokenKind::Word | LexerTokenKind::Number | LexerTokenKind::QuotedString
        ),
    }
}

/// Yields a slot when the token should instead start a legal child clause.
pub(in crate::parser) fn slot_should_yield_to_clause_entry(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    slot: SlotId,
    token: &LexerToken,
) -> bool {
    let token_text = token.text.to_ascii_lowercase();
    let token_id = token_id_for_text(token.text.as_str());

    match (clause.clause, slot) {
        (ClauseId::ProgrammerSelectionIdentifier, SlotId::SelectionIdentifier) => [
            "3d", "fade", "delay", "int", "red", "green", "blue", "white",
        ]
        .iter()
        .any(|keyword| {
            token.kind == LexerTokenKind::Word && keyword.starts_with(token_text.as_str())
        }),
        (ClauseId::FxIdentifier, SlotId::FxIdentifier) => {
            let parent = ClauseInstance {
                clause: ClauseId::Fx,
                instance: clause.instance,
            };
            child_clause_is_available(branch, &parent, ClauseId::FxAction)
                && matches!(
                    token_id,
                    Some(TokenId::Step | TokenId::Start | TokenId::Stop | TokenId::Rate)
                )
        }
        (ClauseId::Clear, SlotId::ClearTarget) => {
            matches!(token_id, Some(TokenId::Attr | TokenId::Attribute))
                && branch.consumed_items.iter().any(|item| {
                    item.clause == *clause
                        && item.slot.slot == SlotId::ClearTarget
                        && matches!(
                            token_id_for_text(item.surface.as_str()),
                            Some(TokenId::Fixture | TokenId::Group | TokenId::Parameter)
                        )
                })
        }
        (
            ClauseId::Store,
            SlotId::StoreCueRef
            | SlotId::StoreObjectIdentifier
            | SlotId::StoreGroupIdentifier
            | SlotId::StoreBlueprintIdentifier,
        ) => {
            let stores_blueprint = branch.consumed_items.iter().any(|item| {
                item.clause == *clause
                    && item.slot.slot == SlotId::StoreObjectType
                    && token_id_for_text(item.surface.as_str()) == Some(TokenId::Blueprint)
            });
            let stores_fx = branch.consumed_items.iter().any(|item| {
                item.clause == *clause
                    && item.slot.slot == SlotId::StoreObjectType
                    && token_id_for_text(item.surface.as_str()) == Some(TokenId::Fx)
            });
            (stores_blueprint
                && ["filter", "attr", "attribute", "type"]
                    .iter()
                    .any(|keyword| keyword.starts_with(token_text.as_str())))
                || (stores_fx
                    && token.kind == LexerTokenKind::Word
                    && ("step".starts_with(token_text.as_str())
                        || branch.consumed_items.iter().any(|item| {
                            item.clause == *clause
                                && item.slot.slot == SlotId::StoreObjectIdentifier
                        })))
        }
        (ClauseId::ProgrammerSetAttributeItem, SlotId::SetAttrValue) => {
            let slot_fills = branch
                .consumed_items
                .iter()
                .filter(|item| item.clause == *clause && item.slot.slot == SlotId::SetAttrValue)
                .collect::<Vec<_>>();
            if slot_fills.is_empty() {
                return false;
            }
            if slot_requires_followup_value(SlotId::SetAttrValue, &slot_fills) {
                return false;
            }

            matches!(
                token_id,
                Some(
                    TokenId::Fade
                        | TokenId::Delay
                        | TokenId::ThreeD
                        | TokenId::AtSign
                        | TokenId::DoubleAtSign
                )
            ) || attribute_collection_parse_spec_for_slot(SlotId::SetAttrAttribute).is_some_and(
                |spec| {
                    attribute_lexeme_is_allowed(
                        spec.attribute_spec,
                        token.text.as_str(),
                        token_id_for_slot_surface(SlotId::SetAttrAttribute, token.text.as_str()),
                        token.kind == LexerTokenKind::QuotedString,
                    )
                },
            )
        }
        _ => false,
    }
}

/// Returns the byte end of a complete decimal prefix, including an optional sign.
pub(in crate::parser) fn complete_decimal_end(raw: &str) -> Option<usize> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }

    let bytes = value.as_bytes();
    let mut index = 0usize;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    let digit_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == digit_start {
        return None;
    }
    if matches!(bytes.get(index), Some(b'.')) {
        let fraction_start = index + 1;
        index += 1;
        while matches!(bytes.get(index), Some(b'0'..=b'9')) {
            index += 1;
        }
        if index == fraction_start {
            return None;
        }
    }
    Some(index)
}

/// Returns whether text can still become a complete decimal value.
pub(in crate::parser) fn decimal_value_prefix(raw: &str) -> bool {
    let value = raw.trim();
    if value.is_empty() {
        return false;
    }

    let bytes = value.as_bytes();
    let mut index = 0usize;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        index += 1;
        if index == bytes.len() {
            return true;
        }
    }
    let digit_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == digit_start {
        return false;
    }
    if matches!(bytes.get(index), Some(b'.')) {
        index += 1;
        while matches!(bytes.get(index), Some(b'0'..=b'9')) {
            index += 1;
        }
    }
    index == bytes.len()
}

/// Returns whether text consists of exactly one complete decimal value.
pub(in crate::parser) fn is_complete_decimal_value(raw: &str) -> bool {
    complete_decimal_end(raw).is_some_and(|end| end == raw.trim().len())
}

/// Returns whether text is a complete numeric component of a placement tuple.
pub(in crate::parser) fn is_tuple_axis_component(raw: &str) -> bool {
    let value = raw.trim();
    if !value.contains(',') {
        return false;
    }

    value.split(',').all(|component| {
        let trimmed = component.trim();
        !trimmed.is_empty() && decimal_value_prefix(trimmed) && is_complete_decimal_value(trimmed)
    })
}

/// Returns whether a complete sleep duration can accept a unit suffix.
pub(in crate::parser) fn sleep_duration_can_extend(raw: &str) -> bool {
    complete_decimal_end(raw).is_some_and(|end| end == raw.trim().len())
}

/// Returns whether a complete integer FPS surface remains valid for completion.
pub(in crate::parser) fn fps_value_can_extend(raw: &str) -> bool {
    let trimmed = raw.trim();
    complete_decimal_end(trimmed).is_some_and(|end| end == trimmed.len() && !trimmed.contains('.'))
}

/// Concatenates cue-reference fills without introducing separator whitespace.
pub(in crate::parser) fn cue_ref_surface(fills: &[&ConsumedSemanticItem]) -> String {
    fills
        .iter()
        .filter(|fill| {
            !matches!(
                fill.normalized_value,
                Some(NormalizedFilledValue::Keyword(TokenId::Cue))
            )
        })
        .map(|fill| fill.surface.as_str())
        .collect::<String>()
}

/// Returns whether text can still become a standard cue reference.
pub(in crate::parser) fn cue_ref_prefix(raw: &str) -> bool {
    cue_ref_state(raw).is_some_and(|state| state.prefix)
}

/// Returns whether text is a complete standard cue or cue-part reference.
pub(in crate::parser) fn is_complete_cue_ref(raw: &str) -> bool {
    cue_ref_state(raw).is_some_and(|state| state.complete)
}

/// Returns whether the provided surface is a store cue mode flag.
pub(in crate::parser) fn is_store_mode_surface(raw: &str) -> bool {
    matches!(
        raw.to_ascii_lowercase().as_str(),
        "/merge" | "/update" | "/remove"
    )
}

/// Returns whether the provided surface is the recall cue select flag.
pub(in crate::parser) fn is_recall_select_surface(raw: &str) -> bool {
    raw.eq_ignore_ascii_case("/select")
}

/// Returns whether a store cue target is complete, including append targets.
pub(in crate::parser) fn is_complete_store_cue_ref(raw: &str) -> bool {
    store_cue_ref_state(raw).is_some_and(|state| state.complete)
}

/// Returns whether text can still become a valid store cue target.
pub(in crate::parser) fn store_cue_ref_prefix(raw: &str) -> bool {
    store_cue_ref_state(raw).is_some_and(|state| state.prefix)
}

/// Intermediate parser state for resolving cue references and cue parts.
struct CueRefState {
    prefix: bool,
    complete: bool,
}

/// Resolves store cue target prefix state while accepting append cue and part markers.
fn store_cue_ref_state(raw: &str) -> Option<CueRefState> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }

    let bytes = value.as_bytes();
    let mut index = 0usize;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == 0 {
        return None;
    }
    if index == bytes.len() {
        return Some(CueRefState {
            prefix: true,
            complete: false,
        });
    }
    if !matches!(bytes.get(index), Some(b'.')) {
        return None;
    }
    index += 1;
    if matches!(bytes.get(index), Some(b'(')) {
        let mut depth = 0u32;
        let mut saw_digit = false;
        for (offset, byte) in bytes[index..].iter().enumerate() {
            match byte {
                b'(' => depth = depth.checked_add(1)?,
                b')' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 && index + offset + 1 != bytes.len() {
                        return None;
                    }
                }
                b'0'..=b'9' => saw_digit = true,
                b'+' | b'-' | b'>' => {}
                _ => return None,
            }
        }
        return Some(CueRefState {
            prefix: true,
            complete: depth == 0 && saw_digit && matches!(bytes.last(), Some(b')')),
        });
    }
    let cue_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == cue_start {
        return (index == bytes.len()).then_some(CueRefState {
            prefix: true,
            complete: true,
        });
    }
    if index == bytes.len() {
        return Some(CueRefState {
            prefix: true,
            complete: true,
        });
    }
    if !matches!(bytes.get(index), Some(b'p' | b'P')) {
        return None;
    }
    index += 1;
    let part_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == part_start {
        return (index == bytes.len()).then_some(CueRefState {
            prefix: true,
            complete: true,
        });
    }
    (index == bytes.len()).then_some(CueRefState {
        prefix: true,
        complete: true,
    })
}

/// Resolves prefix and completion state for standard cue and cue-part references.
fn cue_ref_state(raw: &str) -> Option<CueRefState> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }

    let bytes = value.as_bytes();
    let mut index = 0usize;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == 0 {
        return None;
    }
    if index == bytes.len() {
        return Some(CueRefState {
            prefix: true,
            complete: false,
        });
    }
    if !matches!(bytes.get(index), Some(b'.')) {
        return None;
    }
    index += 1;
    let cue_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == cue_start {
        return Some(CueRefState {
            prefix: true,
            complete: false,
        });
    }
    if index == bytes.len() {
        return Some(CueRefState {
            prefix: true,
            complete: true,
        });
    }
    if !matches!(bytes.get(index), Some(b'p' | b'P')) {
        return None;
    }
    index += 1;
    let part_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == part_start {
        return (index == bytes.len()).then_some(CueRefState {
            prefix: true,
            complete: false,
        });
    }
    (index == bytes.len()).then_some(CueRefState {
        prefix: true,
        complete: true,
    })
}

/// Concatenates adjacent slot fills into the surface consumed by value parsers.
pub(in crate::parser) fn merged_fill_surface(fills: &[&ConsumedSemanticItem]) -> String {
    fills
        .iter()
        .map(|fill| fill.surface.as_str())
        .collect::<String>()
}

/// Projects a raw fill into the semantic value category associated with its slot.
pub(in crate::parser) fn normalized_value_for_fill(
    slot: SlotId,
    value: &FilledValue,
    surface: &SmolStr,
) -> Option<NormalizedFilledValue> {
    match value {
        FilledValue::Token(token) if attribute_collection_parse_spec_for_slot(slot).is_some() => {
            canonical_text(*token).map(|text| NormalizedFilledValue::Attribute(text.into()))
        }
        FilledValue::Lexeme(_) if attribute_collection_parse_spec_for_slot(slot).is_some() => {
            Some(NormalizedFilledValue::Attribute(surface.clone()))
        }
        FilledValue::Token(token) if is_property_slot(slot) => {
            canonical_text(*token).map(|text| NormalizedFilledValue::Property(text.into()))
        }
        FilledValue::Lexeme(_) if slot == SlotId::StoreFixtureOffsetKeyword => {
            Some(NormalizedFilledValue::Property("offset".into()))
        }
        FilledValue::Token(token) => Some(NormalizedFilledValue::Keyword(*token)),
        FilledValue::Placeholder(_, _) | FilledValue::Lexeme(_) if is_identifier_slot(slot) => {
            Some(NormalizedFilledValue::Identifier(surface.clone()))
        }
        FilledValue::Placeholder(_, _) | FilledValue::Lexeme(_) => {
            Some(NormalizedFilledValue::Literal(surface.clone()))
        }
    }
}

/// Returns whether token fills for a slot represent a named property choice.
pub(in crate::parser) fn is_property_slot(slot: SlotId) -> bool {
    matches!(
        slot,
        SlotId::TimingsKeyword
            | SlotId::TimingsDirection
            | SlotId::PlacementAction
            | SlotId::FxAction
            | SlotId::StoreFxAction
            | SlotId::ClipAction
            | SlotId::FlowAction
            | SlotId::TimecodeAction
            | SlotId::TimelineAction
            | SlotId::LogFilterField
            | SlotId::RecallBlueprintKeyword
            | SlotId::StoreObjectType
            | SlotId::StoreMode
            | SlotId::RecallSelectFlag
            | SlotId::StoreFixtureOffsetKeyword
            | SlotId::RmObjectType
            | SlotId::RenameObjectType
            | SlotId::DebugObjectType
            | SlotId::QualifierKeyword
    )
}

/// Returns whether lexeme or placeholder fills for a slot represent an identifier.
pub(in crate::parser) fn is_identifier_slot(slot: SlotId) -> bool {
    matches!(
        slot,
        SlotId::SelectionIdentifier
            | SlotId::FxIdentifier
            | SlotId::FxModuleIdentifier
            | SlotId::StepFxSelectionIdentifier
            | SlotId::PatchSourceUniverse
            | SlotId::PatchSourceAddress
            | SlotId::ClipIdentifier
            | SlotId::ChannelOverrideIdentifier
            | SlotId::ReleaseChannelExpr
            | SlotId::RmObjectIdentifier
            | SlotId::StoreCueRef
            | SlotId::StoreObjectIdentifier
            | SlotId::StoreGroupIdentifier
            | SlotId::StoreBlueprintIdentifier
            | SlotId::StoreFixtureIdentifier
            | SlotId::RenameSource
            | SlotId::RenameTarget
            | SlotId::FlowIdentifier
            | SlotId::TimecodeIdentifier
            | SlotId::TimelineIdentifier
            | SlotId::LogFilterValue
            | SlotId::LogFixtureIdentifier
            | SlotId::RecallCueRef
            | SlotId::RecallBlueprintIdentifier
            | SlotId::DebugObjectIdentifier
    )
}

/// Converts a lexer token's source range into the parser analysis span type.
pub(in crate::parser) fn token_span(token: &LexerToken) -> Span {
    Span {
        start: token.span.start,
        end: token.span.end,
    }
}
