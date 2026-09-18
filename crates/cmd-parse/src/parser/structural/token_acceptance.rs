// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Initial token acceptance for structural parser slots.

use super::*;

/// Finds the first schema slot that can consume a token without skipping a required slot.
pub(in crate::parser) fn first_consumable_slot(
    parser: &StructuralClauseParser,
    token: &LexerToken,
) -> Option<ClauseSlotSpec> {
    for slot in parser.slots.iter().copied() {
        if filled_value_for_slot(slot.slot, token).is_some()
            && slot_accepts_initial_fill(slot.slot, token)
        {
            return Some(slot);
        }
        if matches!(slot.cardinality, SlotCardinality::Required) {
            return None;
        }
    }
    None
}

/// Checks whether a slot schema explicitly offers a canonical token.
pub(in crate::parser) fn slot_accepts_token(
    slot: crate::slots::contracts::SlotId,
    token: TokenId,
) -> bool {
    slot_spec(slot).offers.tokens.contains(&token)
}

/// Applies contextual syntax rules to the first token proposed for a slot.
pub(in crate::parser) fn slot_accepts_initial_fill(slot: SlotId, token: &LexerToken) -> bool {
    let token_id = token_id_for_text(token.text.as_str());
    if matches!(slot, SlotId::SleepDuration | SlotId::FpsValue) && token_id == Some(TokenId::Dot) {
        return false;
    }
    if slot == SlotId::ReleaseChannelExpr {
        return matches!(
            token_id,
            Some(TokenId::Channel | TokenId::Fixture | TokenId::Group | TokenId::Parameter)
        );
    }
    if matches!(
        slot,
        SlotId::StoreObjectIdentifier
            | SlotId::StoreGroupIdentifier
            | SlotId::StoreFixtureIdentifier
    ) && matches!(
        token_id,
        Some(
            TokenId::Plus
                | TokenId::Minus
                | TokenId::GreaterThan
                | TokenId::Dot
                | TokenId::LeftParen
                | TokenId::RightParen
        )
    ) {
        return false;
    }
    let selection_or_object_token_id = token_id_for_text(
        canonicalize_token(
            token.text.as_str(),
            AliasCanonicalizationContext {
                selection_or_object_context: true,
                ..AliasCanonicalizationContext::default()
            },
        )
        .as_str(),
    );
    if slot == SlotId::LogLevel {
        return token_id == Some(TokenId::Level);
    }
    if slot == SlotId::LogFilterField {
        return token_id == Some(TokenId::Filter);
    }
    if slot == SlotId::RecallCueRef {
        return selection_or_object_token_id == Some(TokenId::Cue);
    }
    if slot == SlotId::RecallBlueprintKeyword {
        return selection_or_object_token_id == Some(TokenId::Blueprint);
    }
    if slot == SlotId::StepFxGroupsKeyword {
        return token.text.eq_ignore_ascii_case("groups");
    }
    if slot == SlotId::PatchTargetEndpoint {
        return token_id == Some(TokenId::AtSign);
    }
    if slot == SlotId::SetAttrValue {
        return matches!(
            token_id_for_text(token.text.as_str()),
            Some(TokenId::AtSign | TokenId::Tilde | TokenId::DoubleAtSign)
        );
    }
    if matches!(
        slot,
        SlotId::BlueprintResolution | SlotId::RecallBlueprintResolution
    ) {
        return token_id == Some(TokenId::Absolute);
    }
    if matches!(
        slot,
        SlotId::TimingsGlobalDuration | SlotId::TimingsOverrideDuration | SlotId::StepFxDuration
    ) {
        return !matches!(
            token_id_for_text(token.text.as_str()),
            Some(TokenId::Dot | TokenId::GreaterThan)
        );
    }
    if let Some(spec) = attribute_collection_parse_spec_for_slot(slot) {
        return attribute_lexeme_is_allowed(
            spec.attribute_spec,
            token.text.as_str(),
            token_id_for_slot_surface(slot, token.text.as_str()),
            token.kind == LexerTokenKind::QuotedString,
        );
    }
    if slot == SlotId::StepFxAttributeBaseline {
        return token_id_for_text(token.text.as_str()) == Some(TokenId::AtSign);
    }
    if slot == SlotId::StepFxStepValues {
        return token_id_for_text(token.text.as_str()) == Some(TokenId::Steps);
    }
    if slot == SlotId::StepFxAttributeShaping {
        return matches!(
            token_id_for_text(token.text.as_str()),
            Some(TokenId::Width | TokenId::Ramp)
        ) || matches!(
            token.text.to_ascii_lowercase().as_str(),
            "linear" | "easein" | "easeout" | "ease" | "snap" | "bezier"
        );
    }
    if matches!(slot, SlotId::StoreFixtureMake | SlotId::StoreFixtureModel) {
        return token.kind == LexerTokenKind::QuotedString;
    }
    if slot == SlotId::StoreFixtureMode {
        return matches!(token.kind, LexerTokenKind::Word | LexerTokenKind::Number);
    }
    if slot == SlotId::PatchPriority {
        return matches!(
            token.text.to_ascii_lowercase().as_str(),
            "prio" | "priority"
        );
    }
    if slot == SlotId::PatchClone {
        return token.text.eq_ignore_ascii_case("/clone");
    }
    if matches!(slot, SlotId::ClipAction | SlotId::FlowAction) {
        return token_id_for_text(token.text.as_str())
            .is_some_and(|token_id| slot_accepts_token(slot, token_id));
    }
    true
}
