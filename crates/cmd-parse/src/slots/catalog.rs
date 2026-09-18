// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Slot catalog (semantic source of truth).

use super::contracts::{SlotId, SlotOffers, SlotPolicy, SlotSpec, SuppressRule};
use crate::parser::analysis::{TokenId, ValueKind};
use crate::parser::parse_shapes::{
    InstanceCommandParseShapeId, ObjectCommandParseShapeId, ParseShapeSlotSpec,
    object_command_parse_shape_slots, playback_command_parse_shape_slots,
};
use crate::parser::parse_specs::{
    attribute_collection_parse_spec_for_slot, duration_parse_spec_for_slot,
};

const NONE_TOKENS: &[TokenId] = &[];
const NONE_SUPPRESS: &[SuppressRule] = &[];
const TIMING_KEYWORD_SUPPRESS: &[SuppressRule] = &[SuppressRule::ExcludeFilledTokensInSlot {
    slot: SlotId::TimingsKeyword,
}];

/// Returns the slot specification for a slot ID, including its offered tokens and suppression policy.
pub fn slot_spec(slot_id: SlotId) -> SlotSpec {
    match slot_id {
        SlotId::CompactPathSource | SlotId::CompactPathTarget => slot(
            slot_id,
            &[],
            Some(ValueKind::ColorPathReference),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::SelectionSource => slot(
            slot_id,
            &[TokenId::LeftParen, TokenId::LeftBrace, TokenId::Quote],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::PropertyObjectType => slot(
            slot_id,
            &[
                TokenId::Fx,
                TokenId::Flow,
                TokenId::Fixture,
                TokenId::Parameter,
                TokenId::Group,
                TokenId::Clip,
                TokenId::Cue,
                TokenId::Sequence,
                TokenId::Timecode,
                TokenId::Timeline,
                TokenId::Blueprint,
                TokenId::Path,
            ],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::PropertyObjectIdentifier | SlotId::PropertyTargetIdentifier => slot(
            slot_id,
            &[TokenId::Plus, TokenId::Minus, TokenId::GreaterThan],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::PropertyKeyword => slot(slot_id, &[TokenId::Target], None, NONE_SUPPRESS, false),
        SlotId::PropertyEquals => slot(slot_id, &[TokenId::Equals], None, NONE_SUPPRESS, false),
        SlotId::PropertyTargetType => slot(
            slot_id,
            &[
                TokenId::Sequence,
                TokenId::Fx,
                TokenId::StepFx,
                TokenId::FxModule,
                TokenId::Flow,
            ],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::ShowfileName => slot(slot_id, &[], Some(ValueKind::Text), NONE_SUPPRESS, false),
        SlotId::NewShowfileType => slot(slot_id, &[TokenId::Showfile], None, NONE_SUPPRESS, false),
        SlotId::CueOverwrite => slot(slot_id, &[TokenId::Overwrite], None, NONE_SUPPRESS, false),
        SlotId::ReleaseStaleKeyword => slot(slot_id, &[TokenId::Stale], None, NONE_SUPPRESS, false),
        SlotId::ReleaseStaleSeparator => {
            slot(slot_id, &[TokenId::Minus], None, NONE_SUPPRESS, false)
        }
        SlotId::ReleaseInputsKeyword => {
            slot(slot_id, &[TokenId::Inputs], None, NONE_SUPPRESS, false)
        }
        SlotId::PathIdentifier => slot(
            slot_id,
            &[TokenId::Plus, TokenId::Minus, TokenId::GreaterThan],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::PathKeyword => slot(slot_id, &[TokenId::Path], None, NONE_SUPPRESS, false),
        SlotId::PathValue => slot(
            slot_id,
            &[TokenId::Clear, TokenId::Stop],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::LabelKeyword => slot(slot_id, &[TokenId::Label], None, NONE_SUPPRESS, false),
        SlotId::LabelText => slot(slot_id, &[], Some(ValueKind::Text), NONE_SUPPRESS, false),
        SlotId::CommandHead => slot(slot_id, command_heads(), None, NONE_SUPPRESS, false),
        SlotId::SelectionType => slot(
            slot_id,
            &[TokenId::Fixture, TokenId::Group, TokenId::Parameter],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::SelectionIdentifier => slot(
            slot_id,
            &[
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::Dot,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::SetAttrAttribute => attribute_collection_slot(slot_id),
        SlotId::SetAttrValue => slot(
            slot_id,
            &[TokenId::AtSign, TokenId::Tilde, TokenId::DoubleAtSign],
            Some(ValueKind::ValueRange),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::BlueprintResolution => {
            slot(slot_id, &[TokenId::Absolute], None, NONE_SUPPRESS, true)
        }
        SlotId::TimingsKeyword => slot(
            slot_id,
            &[TokenId::Fade, TokenId::Delay],
            None,
            TIMING_KEYWORD_SUPPRESS,
            false,
        ),
        SlotId::TimingsDirection => slot(slot_id, &[TokenId::In, TokenId::Out], None, &[], false),
        SlotId::TimingsGlobalDuration => duration_slot(slot_id),
        SlotId::TimingsOverrideAttribute => attribute_collection_slot(slot_id),
        SlotId::TimingsOverrideDuration => duration_slot(slot_id),
        SlotId::PlacementAction => slot(
            slot_id,
            &[TokenId::Pos, TokenId::Rot],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::PlacementAxisValue => slot(
            slot_id,
            &[
                TokenId::X,
                TokenId::Y,
                TokenId::Z,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::Dot,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::FxIdentifier => slot(
            slot_id,
            &[TokenId::Plus, TokenId::Minus, TokenId::GreaterThan],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::FxModuleKeyword => slot(slot_id, &[TokenId::Module], None, NONE_SUPPRESS, false),
        SlotId::FxModuleIdentifier => slot(
            slot_id,
            &[TokenId::Plus, TokenId::Minus, TokenId::GreaterThan],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::FxModuleAction => slot(
            slot_id,
            &[TokenId::Start, TokenId::Stop],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::FxAction => slot(
            slot_id,
            &[TokenId::Start, TokenId::Stop, TokenId::Rate],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreFxAction => slot(slot_id, &[TokenId::Step], None, NONE_SUPPRESS, false),
        SlotId::StepFxSelectionHead => slot(
            slot_id,
            &[TokenId::Fixture, TokenId::Group],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StepFxSelectionIdentifier => slot(
            slot_id,
            &[
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::Dot,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StepFxSelectionTransform => slot(
            slot_id,
            NONE_TOKENS,
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StepFxDuration => duration_slot(slot_id),
        SlotId::StepFxGroupsKeyword => slot(slot_id, NONE_TOKENS, None, NONE_SUPPRESS, false),
        SlotId::StepFxGroupsValue => slot(
            slot_id,
            NONE_TOKENS,
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreFxModulePayload => slot(
            slot_id,
            NONE_TOKENS,
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StepFxStepAttribute => attribute_collection_slot(slot_id),
        SlotId::StepFxAttributeBaseline => slot(
            slot_id,
            &[
                TokenId::AtSign,
                TokenId::Absolute,
                TokenId::Blueprint,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::Dot,
            ],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::StepFxStepValues => slot(
            slot_id,
            &[
                TokenId::Steps,
                TokenId::AtSign,
                TokenId::Absolute,
                TokenId::Blueprint,
                TokenId::Tilde,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::Dot,
            ],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StepFxAttributeShaping => slot(
            slot_id,
            &[
                TokenId::Width,
                TokenId::Ramp,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::Dot,
            ],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::PatchSourceEndpoint => slot(
            slot_id,
            &[
                TokenId::Fixture,
                TokenId::Console,
                TokenId::Sacn,
                TokenId::Artnet,
                TokenId::Udmx,
                TokenId::Disabled,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::PatchSourceUniverse => slot(
            slot_id,
            &[TokenId::Colon],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::PatchSourceAddress => slot(
            slot_id,
            &[TokenId::Dot],
            Some(ValueKind::DmxAddress),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::PatchTargetEndpoint => slot(
            slot_id,
            &[
                TokenId::AtSign,
                TokenId::Console,
                TokenId::Sacn,
                TokenId::Artnet,
                TokenId::Udmx,
                TokenId::Disabled,
                TokenId::Colon,
                TokenId::Dot,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::PatchPriority => slot(
            slot_id,
            NONE_TOKENS,
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::PatchClone => slot(slot_id, NONE_TOKENS, None, NONE_SUPPRESS, false),
        SlotId::ClipIdentifier | SlotId::ClipAction => playback_shape_slot(slot_id),
        SlotId::ClearTarget => slot(
            slot_id,
            &[
                TokenId::Fixture,
                TokenId::Selected,
                TokenId::Values,
                TokenId::Attr,
            ],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::QualifierKeyword => slot(
            slot_id,
            &[TokenId::Attribute, TokenId::Attr, TokenId::Filter],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::QualifierAttributeList => attribute_collection_slot(slot_id),
        SlotId::ChannelOverrideIdentifier => slot(
            slot_id,
            &[
                TokenId::LeftParen,
                TokenId::RightParen,
                TokenId::Dot,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
            ],
            Some(ValueKind::DmxAddress),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::ChannelOverrideValue => slot(
            slot_id,
            &[TokenId::AtSign],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::ReleaseChannelExpr => slot(
            slot_id,
            &[
                TokenId::Channel,
                TokenId::Fixture,
                TokenId::Group,
                TokenId::Parameter,
                TokenId::LeftParen,
                TokenId::RightParen,
                TokenId::Dot,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
            ],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::RmObjectType | SlotId::RmObjectIdentifier => object_shape_slot(slot_id),
        SlotId::StoreObjectType => slot(
            slot_id,
            &[
                TokenId::Blueprint,
                TokenId::Cue,
                TokenId::Clip,
                TokenId::Fixture,
                TokenId::Flow,
                TokenId::Fx,
                TokenId::Group,
                TokenId::Path,
                TokenId::Timecode,
                TokenId::Timeline,
            ],
            None,
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreObjectIdentifier => slot(
            slot_id,
            &[
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreObjectPayload => slot(
            slot_id,
            NONE_TOKENS,
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::StoreCueRef => slot(
            slot_id,
            &[
                TokenId::Dot,
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreMode => slot(slot_id, NONE_TOKENS, None, NONE_SUPPRESS, true),
        SlotId::StoreGroupIdentifier => slot(
            slot_id,
            &[
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::Dot,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreBlueprintIdentifier => slot(
            slot_id,
            &[
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::Dot,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreFixtureIdentifier => slot(
            slot_id,
            &[
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::Dot,
                TokenId::LeftParen,
                TokenId::RightParen,
            ],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreFixtureMake | SlotId::StoreFixtureModel | SlotId::StoreFixtureMode => slot(
            slot_id,
            NONE_TOKENS,
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::StoreFixtureOffsetKeyword => slot(slot_id, NONE_TOKENS, None, NONE_SUPPRESS, false),
        SlotId::StoreFixtureOffsetAttribute => attribute_collection_slot(slot_id),
        SlotId::StoreFixtureOffsetValue => slot(
            slot_id,
            &[TokenId::Plus, TokenId::Minus, TokenId::Dot],
            Some(ValueKind::ValueRange),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::RenameObjectType | SlotId::RenameSource | SlotId::RenameTarget => {
            object_shape_slot(slot_id)
        }
        SlotId::FlowIdentifier | SlotId::FlowAction => playback_shape_slot(slot_id),
        SlotId::TimecodeIdentifier | SlotId::TimecodeAction => playback_shape_slot(slot_id),
        SlotId::TimelineIdentifier | SlotId::TimelineAction => playback_shape_slot(slot_id),
        SlotId::LogLevel => slot(
            slot_id,
            &[TokenId::Level],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::LogFilterField => slot(
            slot_id,
            &[TokenId::Filter, TokenId::Clear],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::LogFilterValue => slot(
            slot_id,
            &[TokenId::Clear],
            Some(ValueKind::IdentifierExpression),
            NONE_SUPPRESS,
            true,
        ),
        SlotId::LogFixtureIdentifier => slot(
            slot_id,
            &[TokenId::Fixture],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::LogFixtureAttribute => attribute_collection_slot(slot_id),
        SlotId::RecallCueRef => slot(
            slot_id,
            &[TokenId::Cue, TokenId::Dot],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::RecallSelectFlag => slot(slot_id, NONE_TOKENS, None, NONE_SUPPRESS, true),
        SlotId::RecallBlueprintKeyword => {
            slot(slot_id, &[TokenId::Blueprint], None, NONE_SUPPRESS, false)
        }
        SlotId::RecallBlueprintIdentifier => slot(
            slot_id,
            NONE_TOKENS,
            Some(ValueKind::BlueprintAddress),
            NONE_SUPPRESS,
            false,
        ),
        SlotId::RecallBlueprintResolution => {
            slot(slot_id, &[TokenId::Absolute], None, NONE_SUPPRESS, true)
        }
        SlotId::DebugObjectType | SlotId::DebugObjectIdentifier => object_shape_slot(slot_id),
        SlotId::SleepDuration => duration_slot(slot_id),
        SlotId::FpsValue => slot(
            slot_id,
            &[TokenId::Plus, TokenId::Minus, TokenId::Dot],
            Some(ValueKind::NumericDigit),
            NONE_SUPPRESS,
            false,
        ),
    }
}

fn attribute_collection_slot(slot_id: SlotId) -> SlotSpec {
    let spec = attribute_collection_parse_spec_for_slot(slot_id)
        .unwrap_or_else(|| panic!("missing attribute collection parse spec for {slot_id:?}"));
    slot(
        slot_id,
        spec.attribute_spec.offered_tokens,
        None,
        spec.suppress,
        spec.can_skip,
    )
}

fn duration_slot(slot_id: SlotId) -> SlotSpec {
    let spec = duration_parse_spec_for_slot(slot_id)
        .unwrap_or_else(|| panic!("missing duration parse spec for {slot_id:?}"));
    slot(
        slot_id,
        spec.offered_tokens,
        Some(spec.placeholder),
        NONE_SUPPRESS,
        spec.can_skip,
    )
}

fn playback_shape_slot(slot_id: SlotId) -> SlotSpec {
    let shape_slot = playback_shape_slot_spec(slot_id)
        .unwrap_or_else(|| panic!("missing playback parse shape slot for {slot_id:?}"));
    slot(
        slot_id,
        shape_slot.tokens,
        shape_slot.placeholder,
        NONE_SUPPRESS,
        false,
    )
}

fn playback_shape_slot_spec(slot_id: SlotId) -> Option<&'static ParseShapeSlotSpec> {
    let shape_id = match slot_id {
        SlotId::ClipIdentifier | SlotId::ClipAction => InstanceCommandParseShapeId::Clip,
        SlotId::FlowIdentifier | SlotId::FlowAction => InstanceCommandParseShapeId::Flow,
        SlotId::TimecodeIdentifier | SlotId::TimecodeAction => {
            InstanceCommandParseShapeId::Timecode
        }
        SlotId::TimelineIdentifier | SlotId::TimelineAction => {
            InstanceCommandParseShapeId::Timeline
        }
        _ => return None,
    };
    playback_command_parse_shape_slots(shape_id)
        .iter()
        .find(|shape_slot| shape_slot.slot == slot_id)
}

fn object_shape_slot(slot_id: SlotId) -> SlotSpec {
    let shape_slot = object_shape_slot_spec(slot_id)
        .unwrap_or_else(|| panic!("missing object parse shape slot for {slot_id:?}"));
    slot(
        slot_id,
        shape_slot.tokens,
        shape_slot.placeholder,
        NONE_SUPPRESS,
        false,
    )
}

fn object_shape_slot_spec(slot_id: SlotId) -> Option<&'static ParseShapeSlotSpec> {
    let shape_id = match slot_id {
        SlotId::RmObjectType | SlotId::RmObjectIdentifier => ObjectCommandParseShapeId::Rm,
        SlotId::RenameObjectType | SlotId::RenameSource | SlotId::RenameTarget => {
            ObjectCommandParseShapeId::Rename
        }
        SlotId::DebugObjectType | SlotId::DebugObjectIdentifier => ObjectCommandParseShapeId::Debug,
        _ => return None,
    };
    object_command_parse_shape_slots(shape_id)
        .iter()
        .find(|shape_slot| shape_slot.slot == slot_id)
}

/// Builds a slot specification from its token offers, placeholder, and suppression policy.
fn slot(
    id: SlotId,
    tokens: &'static [TokenId],
    placeholder: Option<ValueKind>,
    suppress: &'static [SuppressRule],
    can_skip: bool,
) -> SlotSpec {
    SlotSpec {
        id,
        offers: SlotOffers {
            tokens,
            placeholder,
        },
        policy: SlotPolicy { suppress, can_skip },
    }
}

/// Returns the token IDs that are valid top-level command heads.
fn command_heads() -> &'static [TokenId] {
    &[
        TokenId::Fixture,
        TokenId::Group,
        TokenId::Parameter,
        TokenId::Fx,
        TokenId::Patch,
        TokenId::Channel,
        TokenId::Flow,
        TokenId::Clip,
        TokenId::Timecode,
        TokenId::Timeline,
        TokenId::Store,
        TokenId::Recall,
        TokenId::Rm,
        TokenId::Rename,
        TokenId::Clear,
        TokenId::Release,
        TokenId::Debug,
        TokenId::Log,
        TokenId::Sleep,
        TokenId::Fps,
    ]
}
