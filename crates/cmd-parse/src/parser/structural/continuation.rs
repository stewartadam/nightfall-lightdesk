// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Continuation classification and follow-up state for structural slots.

use super::*;

/// Maps a slot to the completion category used when projecting its frontier.
pub(in crate::parser) fn continuation_kind_for_slot(
    slot: crate::slots::contracts::SlotId,
) -> crate::parser::analysis::ContinuationKind {
    match slot {
        crate::slots::contracts::SlotId::CommandHead => ContinuationKind::CommandHead,
        crate::slots::contracts::SlotId::SetAttrAttribute
        | crate::slots::contracts::SlotId::StepFxStepAttribute
        | crate::slots::contracts::SlotId::TimingsOverrideAttribute
        | crate::slots::contracts::SlotId::QualifierAttributeList => {
            ContinuationKind::AttributeName
        }
        crate::slots::contracts::SlotId::TimingsKeyword
        | crate::slots::contracts::SlotId::BlueprintResolution
        | crate::slots::contracts::SlotId::RecallBlueprintResolution
        | crate::slots::contracts::SlotId::TimingsDirection
        | crate::slots::contracts::SlotId::PlacementAction
        | crate::slots::contracts::SlotId::FxAction
        | crate::slots::contracts::SlotId::StoreFxAction
        | crate::slots::contracts::SlotId::ClipAction
        | crate::slots::contracts::SlotId::FlowAction
        | crate::slots::contracts::SlotId::TimecodeAction
        | crate::slots::contracts::SlotId::TimelineAction
        | crate::slots::contracts::SlotId::LogFilterField
        | crate::slots::contracts::SlotId::RecallBlueprintKeyword
        | crate::slots::contracts::SlotId::StoreObjectType
        | crate::slots::contracts::SlotId::StoreMode
        | crate::slots::contracts::SlotId::StoreFixtureOffsetKeyword
        | crate::slots::contracts::SlotId::RmObjectType
        | crate::slots::contracts::SlotId::RenameObjectType
        | crate::slots::contracts::SlotId::DebugObjectType => ContinuationKind::PropertyName,
        crate::slots::contracts::SlotId::SelectionIdentifier
        | crate::slots::contracts::SlotId::FxIdentifier
        | crate::slots::contracts::SlotId::ClipIdentifier
        | crate::slots::contracts::SlotId::FlowIdentifier
        | crate::slots::contracts::SlotId::TimecodeIdentifier
        | crate::slots::contracts::SlotId::TimelineIdentifier
        | crate::slots::contracts::SlotId::ReleaseChannelExpr
        | crate::slots::contracts::SlotId::RecallCueRef
        | crate::slots::contracts::SlotId::RecallBlueprintIdentifier
        | crate::slots::contracts::SlotId::RenameSource
        | crate::slots::contracts::SlotId::RenameTarget
        | crate::slots::contracts::SlotId::StoreCueRef
        | crate::slots::contracts::SlotId::StoreObjectIdentifier
        | crate::slots::contracts::SlotId::StoreObjectPayload
        | crate::slots::contracts::SlotId::StoreGroupIdentifier
        | crate::slots::contracts::SlotId::StoreBlueprintIdentifier
        | crate::slots::contracts::SlotId::StoreFixtureIdentifier
        | crate::slots::contracts::SlotId::DebugObjectIdentifier
        | crate::slots::contracts::SlotId::RmObjectIdentifier => ContinuationKind::IdentifierExpr,
        _ => ContinuationKind::SlotValue,
    }
}

/// Adds one expected token while preserving first-seen order and uniqueness.
pub(in crate::parser) fn push_expected_token(
    tokens: &mut Vec<ExpectedToken>,
    token: ExpectedToken,
) {
    if !tokens.contains(&token) {
        tokens.push(token);
    }
}

/// Parser states tracked for a structural slot while consuming input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::parser) enum SlotState {
    RequiredPending,
    OptionalPending,
    ValuePending,
    Complete,
    RepeatableComplete,
}

/// Derives a slot's parser state from its cardinality, existing fills, and follow-up needs.
pub(in crate::parser) fn slot_state(
    slot: SlotId,
    cardinality: SlotCardinality,
    fills: &[&ConsumedSemanticItem],
) -> SlotState {
    if slot_requires_followup_value(slot, fills) {
        return SlotState::ValuePending;
    }

    if fills.is_empty() {
        return match cardinality {
            SlotCardinality::Required => SlotState::RequiredPending,
            SlotCardinality::Optional => SlotState::OptionalPending,
            SlotCardinality::Repeated => SlotState::RepeatableComplete,
        };
    }

    if slot == SlotId::StepFxDuration
        && !is_complete_duration_value(merged_fill_surface(fills).as_str())
    {
        return SlotState::ValuePending;
    }

    if keeps_identifier_continuation(slot) {
        return SlotState::RepeatableComplete;
    }

    match cardinality {
        SlotCardinality::Repeated => SlotState::RepeatableComplete,
        SlotCardinality::Required | SlotCardinality::Optional => SlotState::Complete,
    }
}

/// Returns whether a completed identifier slot remains open for expression tokens.
pub(in crate::parser) fn keeps_identifier_continuation(slot: SlotId) -> bool {
    matches!(
        slot,
        SlotId::PropertyObjectIdentifier
            | SlotId::PropertyTargetIdentifier
            | SlotId::PathIdentifier
            | SlotId::FxModuleIdentifier
            | SlotId::ClipIdentifier
            | SlotId::FlowIdentifier
            | SlotId::TimecodeIdentifier
            | SlotId::TimelineIdentifier
            | SlotId::ChannelOverrideIdentifier
            | SlotId::ReleaseChannelExpr
            | SlotId::PatchSourceEndpoint
            | SlotId::PatchTargetEndpoint
            | SlotId::StoreCueRef
            | SlotId::RecallCueRef
            | SlotId::StoreObjectIdentifier
            | SlotId::StoreGroupIdentifier
            | SlotId::StoreBlueprintIdentifier
            | SlotId::RmObjectIdentifier
    )
}

/// Detects endpoint surfaces that end in an operator or incomplete fixture prefix.
pub(in crate::parser) fn patch_endpoint_requires_followup(
    slot: SlotId,
    fills: &[&ConsumedSemanticItem],
) -> bool {
    if fills.is_empty() {
        return false;
    }

    let token_ids = fills
        .iter()
        .map(|item| token_id_for_text(item.surface.as_str()))
        .collect::<Vec<_>>();
    let mut start_index = 0usize;
    if slot == SlotId::PatchTargetEndpoint && token_ids.first() == Some(&Some(TokenId::AtSign)) {
        if token_ids.len() == 1 {
            return true;
        }
        start_index = 1;
    }

    let endpoint_ids = &token_ids[start_index..];
    let Some(last_id) = endpoint_ids.last().copied() else {
        return true;
    };
    let Some(last_id) = last_id else {
        return false;
    };
    if matches!(
        last_id,
        TokenId::Colon
            | TokenId::Dot
            | TokenId::Plus
            | TokenId::Minus
            | TokenId::GreaterThan
            | TokenId::LeftParen
    ) {
        return true;
    }

    endpoint_ids.first() == Some(&Some(TokenId::Fixture)) && endpoint_ids.len() == 1
}

/// Returns whether the selected flow action consumes a following identifier expression.
pub(in crate::parser) fn flow_action_uses_identifier_expression(
    fills: &[&ConsumedSemanticItem],
) -> bool {
    fills.first().is_some_and(|item| {
        matches!(
            item.normalized_value.as_ref(),
            Some(NormalizedFilledValue::Property(property)) if property == "rename"
        )
    })
}

/// Determines whether a filled slot requires another token before it can complete.
pub(in crate::parser) fn slot_requires_followup_value(
    slot: SlotId,
    fills: &[&ConsumedSemanticItem],
) -> bool {
    if matches!(slot, SlotId::CompactPathSource | SlotId::CompactPathTarget) {
        return fills
            .last()
            .is_some_and(|item| item.surface.eq_ignore_ascii_case("path"));
    }
    if matches!(
        slot,
        SlotId::LogFilterField | SlotId::LogFilterValue | SlotId::PathValue
    ) {
        return false;
    }
    if slot == SlotId::ReleaseChannelExpr {
        return fills.last().is_some_and(|item| {
            matches!(
                token_id_for_text(item.surface.as_str()),
                Some(
                    TokenId::Channel
                        | TokenId::Fixture
                        | TokenId::Group
                        | TokenId::Parameter
                        | TokenId::Plus
                        | TokenId::Minus
                        | TokenId::GreaterThan
                        | TokenId::LeftParen
                )
            )
        });
    }
    if matches!(
        slot,
        SlotId::PatchSourceEndpoint | SlotId::PatchTargetEndpoint
    ) {
        return patch_endpoint_requires_followup(slot, fills);
    }
    if slot == SlotId::PlacementAxisValue {
        return fills.last().is_some_and(|item| {
            matches!(
                token_id_for_text(item.surface.as_str()),
                Some(
                    TokenId::X
                        | TokenId::Y
                        | TokenId::Z
                        | TokenId::Plus
                        | TokenId::Minus
                        | TokenId::Dot
                        | TokenId::LeftParen
                )
            )
        });
    }
    if slot == SlotId::SetAttrValue {
        return set_attr_value_requires_followup(fills);
    }
    if matches!(
        slot,
        SlotId::TimingsGlobalDuration | SlotId::TimingsOverrideDuration
    ) {
        return duration_range_requires_followup(fills);
    }
    if slot == SlotId::ChannelOverrideIdentifier {
        return fills.last().is_some_and(|item| {
            matches!(
                token_id_for_text(item.surface.as_str()),
                Some(
                    TokenId::LeftParen
                        | TokenId::Dot
                        | TokenId::Plus
                        | TokenId::Minus
                        | TokenId::GreaterThan
                )
            )
        });
    }
    if slot == SlotId::StoreFixtureIdentifier {
        return fills.last().is_some_and(|item| {
            matches!(
                token_id_for_text(item.surface.as_str()),
                Some(
                    TokenId::LeftParen
                        | TokenId::Dot
                        | TokenId::Plus
                        | TokenId::Minus
                        | TokenId::GreaterThan
                )
            )
        });
    }
    if matches!(
        slot,
        SlotId::SelectionIdentifier | SlotId::StepFxSelectionIdentifier | SlotId::ClearTarget
    ) {
        return fills.last().is_some_and(|item| {
            matches!(
                token_id_for_text(item.surface.as_str()),
                Some(
                    TokenId::Fixture
                        | TokenId::Group
                        | TokenId::Parameter
                        | TokenId::Attr
                        | TokenId::Attribute
                        | TokenId::LeftParen
                        | TokenId::Dot
                        | TokenId::Plus
                        | TokenId::Minus
                        | TokenId::GreaterThan
                )
            )
        });
    }
    if slot == SlotId::ChannelOverrideValue {
        return fills
            .last()
            .is_some_and(|item| token_id_for_text(item.surface.as_str()) == Some(TokenId::AtSign));
    }
    if slot == SlotId::StepFxAttributeBaseline {
        return step_fx_value_requires_followup(fills);
    }
    if slot == SlotId::StepFxStepValues {
        return step_fx_value_requires_followup(fills)
            || fills.last().is_some_and(|item| {
                token_id_for_text(item.surface.as_str()) == Some(TokenId::Steps)
            });
    }
    if slot == SlotId::StepFxAttributeShaping {
        return fills.last().is_some_and(|item| {
            matches!(
                token_id_for_text(item.surface.as_str()),
                Some(TokenId::Width | TokenId::Ramp)
            )
        }) || bezier_expression_in_progress(fills);
    }
    if slot == SlotId::ClipAction {
        return fx_rate_requires_followup(fills, decimal_value_prefix, is_complete_decimal_value)
            || fills.last().is_some_and(|item| {
                token_id_for_text(item.surface.as_str()) == Some(TokenId::Goto)
            });
    }
    if slot == SlotId::FxAction {
        return fx_rate_requires_followup(fills, decimal_value_prefix, is_complete_decimal_value);
    }
    if slot == SlotId::FlowAction {
        return fills.last().is_some_and(|item| {
            matches!(
                token_id_for_text(item.surface.as_str()),
                Some(TokenId::Rename)
            )
        }) || fills.last().is_some_and(|item| {
            flow_action_uses_identifier_expression(fills)
                && matches!(
                    token_id_for_text(item.surface.as_str()),
                    Some(
                        TokenId::Plus
                            | TokenId::Minus
                            | TokenId::GreaterThan
                            | TokenId::Dot
                            | TokenId::LeftParen
                    )
                )
        });
    }
    if slot == SlotId::PatchPriority {
        return fills.last().is_some_and(|item| {
            matches!(
                item.surface.to_ascii_lowercase().as_str(),
                "prio" | "priority"
            )
        });
    }
    if slot == SlotId::RecallCueRef {
        let surface = cue_ref_surface(fills);
        return fills.last().is_some_and(|item| {
            matches!(
                item.normalized_value,
                Some(NormalizedFilledValue::Keyword(TokenId::Cue))
            )
        }) || (cue_ref_prefix(surface.as_str()) && !is_complete_cue_ref(surface.as_str()));
    }
    if slot == SlotId::StoreCueRef {
        let surface = cue_ref_surface(fills);
        return store_cue_ref_prefix(surface.as_str())
            && !is_complete_store_cue_ref(surface.as_str());
    }
    if slot == SlotId::SleepDuration {
        let surface = merged_fill_surface(fills);
        return matches!(surface.as_str(), "+" | "-" | "." | "+." | "-.")
            || (duration_value_prefix(surface.as_str())
                && !is_complete_duration_value(surface.as_str()));
    }
    if slot == SlotId::FpsValue {
        let surface = merged_fill_surface(fills);
        return decimal_value_prefix(surface.as_str())
            && !is_complete_decimal_value(surface.as_str());
    }
    let spec = slot_spec(slot);
    if spec.offers.tokens.is_empty() || spec.offers.placeholder.is_none() {
        return false;
    }

    let Some(last) = fills.last() else {
        return false;
    };

    matches!(
        &last.normalized_value,
        Some(NormalizedFilledValue::Keyword(token)) if spec.offers.tokens.contains(token)
    )
}
