// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Slot consumption and multi-token spatial selection acceptance.

use super::*;

/// Validates and applies one token to a slot, then refreshes the resulting parse branch.
pub(in crate::parser) fn consume_slot<'i>(
    branch: &ParseBranchState<'i>,
    slot: SlotRef,
    token: &LexerToken,
) -> Option<ParseBranchState<'i>> {
    let slot_id = slot.slot;
    let clause = slot
        .clause
        .clone()
        .or_else(|| branch.clause_stack.last().map(|frame| frame.clause.clone()))?;
    let slot_fills = branch
        .consumed_items
        .iter()
        .filter(|item| item.clause == clause && item.slot.slot == slot_id)
        .collect::<Vec<_>>();
    let existing_fills = slot_fills.len();
    if slot_id == SlotId::ShowfileName
        && slot_fills
            .last()
            .is_some_and(|fill| fill.source_span.end != token.span.start)
    {
        return None;
    }
    let token_id = token_id_for_text(token.text.as_str());
    if slot_id == SlotId::FpsValue
        && existing_fills > 0
        && !(existing_fills == 1
            && token.kind == LexerTokenKind::Number
            && slot_fills.first().is_some_and(|fill| {
                matches!(fill.surface.as_str(), "+" | "-")
                    && fill.source_span.end == token.span.start
            }))
    {
        return None;
    }
    if slot_id == SlotId::ReleaseChannelExpr
        && existing_fills == 1
        && slot_fills
            .first()
            .is_some_and(|fill| token_id_for_text(fill.surface.as_str()) == Some(TokenId::Channel))
        && token.kind != LexerTokenKind::Number
    {
        return None;
    }
    if slot_id == SlotId::RenameSource
        && slot_fills.last().is_some_and(|item| {
            token.span.start > item.source_span.end && token.kind != LexerTokenKind::Whitespace
        })
    {
        return None;
    }
    let rm_cue_ref =
        slot_id == SlotId::RmObjectIdentifier && rm_object_identifier_uses_cue_ref(branch, &clause);
    let store_cue_ref =
        slot_id == SlotId::StoreCueRef && store_cue_ref_uses_cue_ref(branch, &clause);
    let recall_cue_ref = slot_id == SlotId::RecallCueRef;
    let rename_cue_ref = rename_identifier_uses_cue_ref(branch, &clause, slot_id);
    let cue_ref_slot = rm_cue_ref || store_cue_ref || recall_cue_ref || rename_cue_ref;
    let selection_slot = matches!(
        slot_id,
        SlotId::SelectionSource
            | SlotId::SelectionIdentifier
            | SlotId::StepFxSelectionIdentifier
            | SlotId::StepFxSelectionTransform
    );
    if selection_slot
        && !crate::selection_language::prefix::analyze_selection_prefix(&selection_slot_surface(
            branch,
            slot_id,
            Some(token),
        ))
        .valid
    {
        return None;
    }
    if existing_fills == 0
        && matches!(
            slot_id,
            SlotId::PatchSourceUniverse | SlotId::PatchSourceAddress
        )
        && !token_id.is_some_and(|token_id| slot_accepts_token(slot_id, token_id))
    {
        return None;
    }
    if !selection_slot && slot_should_yield_to_clause_entry(branch, &clause, slot_id, token) {
        return None;
    }
    if !slot_is_available_in_branch(branch, &clause, slot_id) {
        return None;
    }
    if !selection_slot && existing_fills == 0 && !slot_accepts_initial_fill(slot_id, token) {
        return None;
    }
    if slot_id == SlotId::PatchTargetEndpoint
        && existing_fills > 0
        && matches!(
            token.text.to_ascii_lowercase().as_str(),
            "prio" | "priority" | "/clone"
        )
    {
        return None;
    }
    if slot_id == SlotId::PatchSourceEndpoint && existing_fills > 0 {
        let universe_fills = branch
            .consumed_items
            .iter()
            .filter(|item| item.clause == clause && item.slot.slot == SlotId::PatchSourceUniverse)
            .collect::<Vec<_>>();
        if universe_fills.last().is_some_and(|item| {
            token_id_for_text(item.surface.as_str()) == Some(TokenId::Colon)
                && token.kind == LexerTokenKind::Number
        }) {
            return None;
        }

        let address_fills = branch
            .consumed_items
            .iter()
            .filter(|item| item.clause == clause && item.slot.slot == SlotId::PatchSourceAddress)
            .collect::<Vec<_>>();
        if address_fills.last().is_some_and(|item| {
            token_id_for_text(item.surface.as_str()) == Some(TokenId::Dot)
                && token.kind == LexerTokenKind::Number
        }) {
            return None;
        }
    }
    if clause.clause == ClauseId::Rm
        && slot_id == SlotId::PatchTargetEndpoint
        && existing_fills == 0
        && token_id != Some(TokenId::AtSign)
    {
        return None;
    }
    if existing_fills == 0
        && matches!(slot_id, SlotId::ClipAction | SlotId::FlowAction)
        && !token_id.is_some_and(|token_id| slot_accepts_token(slot_id, token_id))
    {
        return None;
    }
    if (rm_cue_ref || store_cue_ref || rename_cue_ref)
        && existing_fills == 0
        && token.kind != LexerTokenKind::Number
    {
        return None;
    }
    if slot_id == SlotId::StoreMode
        && (existing_fills > 0 || !is_store_mode_surface(token.text.as_str()))
    {
        return None;
    }
    if slot_id == SlotId::RecallSelectFlag
        && (existing_fills > 0 || !is_recall_select_surface(token.text.as_str()))
    {
        return None;
    }
    if matches!(
        slot_id,
        SlotId::StoreObjectIdentifier
            | SlotId::StoreGroupIdentifier
            | SlotId::StoreFixtureIdentifier
    ) && existing_fills == 0
        && token_id.is_some_and(|token_id| {
            matches!(
                token_id,
                TokenId::Plus
                    | TokenId::Minus
                    | TokenId::GreaterThan
                    | TokenId::Dot
                    | TokenId::LeftParen
                    | TokenId::RightParen
            )
        })
    {
        return None;
    }
    if slot_id == SlotId::StoreObjectIdentifier
        && existing_fills > 0
        && token.kind == LexerTokenKind::QuotedString
        && store_object_type_token(branch, &clause) == Some(TokenId::Flow)
    {
        return None;
    }
    if slot_id == SlotId::StoreObjectPayload && token.kind != LexerTokenKind::QuotedString {
        return None;
    }
    if slot_id == SlotId::StoreFxModulePayload
        && existing_fills == 0
        && token_id == Some(TokenId::Step)
    {
        return None;
    }
    if slot_id == SlotId::LogLevel && existing_fills == 0 && token_id != Some(TokenId::Level) {
        return None;
    }
    if slot_id == SlotId::LogFilterField && existing_fills == 0 && token_id != Some(TokenId::Filter)
    {
        return None;
    }
    if slot_id == SlotId::LogFilterValue
        && (existing_fills >= 2
            || slot_fills.first().is_some_and(|item| {
                token_id_for_text(item.surface.as_str()) == Some(TokenId::Clear)
            }))
    {
        return None;
    }
    if cue_ref_slot && existing_fills > 0 {
        let surface = cue_ref_surface(&slot_fills);
        let candidate = format!("{surface}{}", token.text);
        let accepts_cue_ref_token =
            cue_ref_prefix(candidate.as_str()) && candidate.len() > surface.len();
        if !accepts_cue_ref_token {
            return None;
        }
    }
    if slot_id == SlotId::ChannelOverrideValue
        && ((existing_fills == 0 && token_id != Some(TokenId::AtSign))
            || (existing_fills > 0 && !slot_requires_followup_value(slot_id, &slot_fills)))
    {
        return None;
    }
    if existing_fills > 0
        && matches!(slot_id, SlotId::ClipAction | SlotId::FlowAction)
        && !slot_requires_followup_value(slot_id, &slot_fills)
        && !slot_keeps_expression_continuation_live(slot_id, &slot_fills)
    {
        return None;
    }
    if slot_id == SlotId::StoreFixtureIdentifier
        && existing_fills > 0
        && !slot_requires_followup_value(slot_id, &slot_fills)
        && !matches!(
            token_id,
            Some(
                TokenId::Plus
                    | TokenId::Minus
                    | TokenId::GreaterThan
                    | TokenId::Dot
                    | TokenId::LeftParen
                    | TokenId::RightParen
            )
        )
    {
        return None;
    }
    if slot_id == SlotId::QualifierAttributeList
        && existing_fills == 0
        && !branch
            .consumed_items
            .iter()
            .any(|item| item.clause == clause && item.slot.slot == SlotId::QualifierKeyword)
    {
        return None;
    }
    if slot_id == SlotId::TimingsGlobalDuration
        && existing_fills > 0
        && timing_override_duration_should_receive_followup(branch, &clause, token_id)
    {
        return None;
    }
    let (value, normalized_value) = if selection_slot {
        let value = FilledValue::Lexeme(token.text.clone());
        (
            value.clone(),
            normalized_value_for_fill(slot_id, &value, &token.text),
        )
    } else if slot_id == SlotId::LogLevel && existing_fills > 0 {
        let value = FilledValue::Lexeme(token.text.clone());
        (
            value.clone(),
            normalized_value_for_fill(slot.slot, &value, &token.text),
        )
    } else if cue_ref_slot && existing_fills > 0 {
        if token_id == Some(TokenId::Dot) {
            let value = FilledValue::Token(TokenId::Dot);
            (
                value.clone(),
                normalized_value_for_fill(slot.slot, &value, &token.text),
            )
        } else {
            filled_value_for_slot(slot.slot, token).unwrap_or_else(|| {
                let value = FilledValue::Lexeme(token.text.clone());
                (
                    value.clone(),
                    normalized_value_for_fill(slot.slot, &value, &token.text),
                )
            })
        }
    } else if matches!(slot_id, SlotId::FxAction | SlotId::ClipAction) && existing_fills > 0 {
        filled_value_for_fx_rate_followup(
            slot.slot,
            &slot_fills,
            token,
            decimal_value_prefix,
            is_complete_decimal_value,
        )
        .or_else(|| filled_value_for_slot(slot.slot, token))?
    } else if slot_id == SlotId::SetAttrValue && existing_fills > 0 {
        filled_value_for_set_attr_value_followup(slot.slot, &slot_fills, token)?
    } else if matches!(
        slot_id,
        SlotId::StepFxAttributeBaseline | SlotId::StepFxStepValues
    ) && existing_fills > 0
        && step_fx_value_requires_followup(&slot_fills)
    {
        filled_value_for_step_fx_blueprint_followup(slot.slot, &slot_fills, token)
            .or_else(|| filled_value_for_slot(slot.slot, token))?
    } else if slot_id == SlotId::TimingsGlobalDuration
        && existing_fills > 0
        && timings_global_duration_can_start_next_pair(branch, &clause)
    {
        filled_value_for_slot(slot.slot, token)?
    } else if matches!(
        slot_id,
        SlotId::TimingsGlobalDuration | SlotId::TimingsOverrideDuration
    ) && existing_fills > 0
    {
        filled_value_for_duration_range_followup(slot.slot, &slot_fills, token)?
    } else if matches!(slot_id, SlotId::StepFxDuration | SlotId::SleepDuration)
        && existing_fills > 0
    {
        if token_id == Some(TokenId::GreaterThan) {
            return None;
        }
        filled_value_for_duration_range_followup(slot.slot, &slot_fills, token)?
    } else if slot_id == SlotId::StepFxAttributeShaping && existing_fills > 0 {
        filled_value_for_step_fx_shaping_followup(slot.slot, &slot_fills, token)
            .or_else(|| filled_value_for_slot(slot.slot, token))?
    } else if slot_id == SlotId::StepFxSelectionIdentifier && existing_fills > 0 {
        let value = FilledValue::Lexeme(token.text.clone());
        (
            value.clone(),
            normalized_value_for_fill(slot.slot, &value, &token.text),
        )
    } else {
        filled_value_for_slot(slot.slot, token)?
    };

    let mut next = branch.clone();
    if truncate_branch_to_clause(&mut next, &clause).is_none() {
        let parent_clause = clause_parent(clause.clause)?;
        truncate_branch_to_clause_id(&mut next, parent_clause)?;
        next.clause_stack.push(ClauseFrame {
            clause: clause.clone(),
            phase: ClausePhase::Entered,
            commit_state: ClauseCommitState::Committed,
        });
    }
    next.consumed_items.push(ConsumedSemanticItem {
        slot,
        clause: clause.clone(),
        surface: token.text.clone(),
        normalized_value: normalized_value.clone(),
        source_span: token_span(token),
        source_token_start: token.span.start,
        source_token_end: token.span.end,
    });
    if let Some(value) = normalized_value {
        record_clause_usage(&mut next, &clause, value);
    }
    if slot_id == SlotId::StepFxDuration && !is_complete_duration_value(token.text.as_str()) {
        if let Some(frame) = next
            .clause_stack
            .iter_mut()
            .rfind(|frame| frame.clause == clause)
        {
            frame.phase = ClausePhase::Filling;
            frame.commit_state = ClauseCommitState::Speculative;
        }
    }
    if slot_id == SlotId::StoreFxAction && token_id == Some(TokenId::Step) {
        truncate_branch_to_clause_id(&mut next, ClauseId::Store)?;
        next.clause_stack.push(ClauseFrame {
            clause: ClauseInstance {
                clause: ClauseId::StepFx,
                instance: 0,
            },
            phase: ClausePhase::Entered,
            commit_state: ClauseCommitState::Committed,
        });
    }
    refresh_branch(&mut next);

    let _ = value;
    Some(next)
}

/// Reconstructs a selection slot's consumed text while preserving lexical adjacency.
pub(in crate::parser) fn selection_slot_surface(
    branch: &ParseBranchState<'_>,
    slot: SlotId,
    next: Option<&LexerToken>,
) -> String {
    let programmer = matches!(slot, SlotId::SelectionSource | SlotId::SelectionIdentifier);
    let mut pieces = branch
        .consumed_items
        .iter()
        .filter(|item| {
            if programmer {
                matches!(
                    item.slot.slot,
                    SlotId::SelectionSource | SlotId::SelectionType | SlotId::SelectionIdentifier
                )
            } else {
                matches!(
                    item.slot.slot,
                    SlotId::StepFxSelectionHead
                        | SlotId::StepFxSelectionIdentifier
                        | SlotId::StepFxSelectionTransform
                )
            }
        })
        .map(|item| {
            (
                item.source_span.start,
                item.source_span.end,
                item.surface.as_str(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(token) = next {
        pieces.push((token.span.start, token.span.end, token.text.as_str()));
    }
    pieces.sort_by_key(|piece| piece.0);
    let mut result = String::new();
    let mut previous_end = None;
    for (start, end, text) in pieces {
        if previous_end.is_some_and(|previous| previous < start) {
            result.push(' ');
        }
        result.push_str(text);
        previous_end = Some(end);
    }
    result
}
