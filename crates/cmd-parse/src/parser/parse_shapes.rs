// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reusable parse shapes shared across parser layers.

use crate::parser::analysis::{TokenId, ValueKind};
use crate::slots::contracts::SlotId;

const SIMPLE_SET_EXPR_TOKENS: &[TokenId] = &[
    TokenId::Plus,
    TokenId::Minus,
    TokenId::GreaterThan,
    TokenId::LeftParen,
    TokenId::RightParen,
];

const CLIP_ACTION_TOKENS: &[TokenId] = &[
    TokenId::Start,
    TokenId::Stop,
    TokenId::Go,
    TokenId::Back,
    TokenId::Goto,
    TokenId::Rate,
];
const FLOW_ACTION_TOKENS: &[TokenId] = &[
    TokenId::Start,
    TokenId::Stop,
    TokenId::Go,
    TokenId::Rm,
    TokenId::Rename,
];
const TIMECODE_ACTION_TOKENS: &[TokenId] = &[TokenId::Start, TokenId::Pause, TokenId::Stop];
const TIMELINE_ACTION_TOKENS: &[TokenId] = &[TokenId::Start, TokenId::Stop];

const SHARED_OBJECT_TYPE_TOKENS: &[TokenId] = &[
    TokenId::Blueprint,
    TokenId::Cue,
    TokenId::Clip,
    TokenId::Fixture,
    TokenId::Fx,
    TokenId::Group,
    TokenId::Parameter,
    TokenId::Path,
    TokenId::Patch,
    TokenId::Sequence,
    TokenId::Timecode,
    TokenId::Timeline,
];

/// Slot requirement used by parse-shape tests to describe expected command surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseShapeSlotSpec {
    pub slot: SlotId,
    pub tokens: &'static [TokenId],
    pub placeholder: Option<ValueKind>,
}

/// Named playback parse shapes covered by parser surface tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceCommandParseShapeId {
    Clip,
    Flow,
    Timecode,
    Timeline,
}

/// Expected slot layout for one instance command parse shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstanceCommandParseShape {
    pub slots: &'static [ParseShapeSlotSpec],
}

const CLIP_PLAYBACK_SHAPE_SLOTS: &[ParseShapeSlotSpec] = &[
    ParseShapeSlotSpec {
        slot: SlotId::ClipIdentifier,
        tokens: SIMPLE_SET_EXPR_TOKENS,
        placeholder: Some(ValueKind::NumericDigit),
    },
    ParseShapeSlotSpec {
        slot: SlotId::ClipAction,
        tokens: CLIP_ACTION_TOKENS,
        placeholder: Some(ValueKind::NumericDigit),
    },
];
const CLIP_PLAYBACK_SHAPE_SLOT_IDS: &[SlotId] = &[SlotId::ClipIdentifier, SlotId::ClipAction];

const FLOW_PLAYBACK_SHAPE_SLOTS: &[ParseShapeSlotSpec] = &[
    ParseShapeSlotSpec {
        slot: SlotId::FlowIdentifier,
        tokens: SIMPLE_SET_EXPR_TOKENS,
        placeholder: Some(ValueKind::NumericDigit),
    },
    ParseShapeSlotSpec {
        slot: SlotId::FlowAction,
        tokens: FLOW_ACTION_TOKENS,
        placeholder: Some(ValueKind::IdentifierExpression),
    },
];
const FLOW_PLAYBACK_SHAPE_SLOT_IDS: &[SlotId] = &[SlotId::FlowIdentifier, SlotId::FlowAction];

const TIMECODE_PLAYBACK_SHAPE_SLOTS: &[ParseShapeSlotSpec] = &[
    ParseShapeSlotSpec {
        slot: SlotId::TimecodeIdentifier,
        tokens: SIMPLE_SET_EXPR_TOKENS,
        placeholder: Some(ValueKind::NumericDigit),
    },
    ParseShapeSlotSpec {
        slot: SlotId::TimecodeAction,
        tokens: TIMECODE_ACTION_TOKENS,
        placeholder: None,
    },
];
const TIMECODE_PLAYBACK_SHAPE_SLOT_IDS: &[SlotId] =
    &[SlotId::TimecodeIdentifier, SlotId::TimecodeAction];

const TIMELINE_PLAYBACK_SHAPE_SLOTS: &[ParseShapeSlotSpec] = &[
    ParseShapeSlotSpec {
        slot: SlotId::TimelineIdentifier,
        tokens: SIMPLE_SET_EXPR_TOKENS,
        placeholder: Some(ValueKind::NumericDigit),
    },
    ParseShapeSlotSpec {
        slot: SlotId::TimelineAction,
        tokens: TIMELINE_ACTION_TOKENS,
        placeholder: None,
    },
];
const TIMELINE_PLAYBACK_SHAPE_SLOT_IDS: &[SlotId] =
    &[SlotId::TimelineIdentifier, SlotId::TimelineAction];

const CLIP_PLAYBACK_SHAPE: InstanceCommandParseShape = InstanceCommandParseShape {
    slots: CLIP_PLAYBACK_SHAPE_SLOTS,
};

const FLOW_PLAYBACK_SHAPE: InstanceCommandParseShape = InstanceCommandParseShape {
    slots: FLOW_PLAYBACK_SHAPE_SLOTS,
};

const TIMECODE_PLAYBACK_SHAPE: InstanceCommandParseShape = InstanceCommandParseShape {
    slots: TIMECODE_PLAYBACK_SHAPE_SLOTS,
};

const TIMELINE_PLAYBACK_SHAPE: InstanceCommandParseShape = InstanceCommandParseShape {
    slots: TIMELINE_PLAYBACK_SHAPE_SLOTS,
};

/// Named object-management parse shapes covered by parser surface tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectCommandParseShapeId {
    Rm,
    Rename,
    Debug,
}

/// Expected slot layout for one object-management command parse shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectCommandParseShape {
    pub slots: &'static [ParseShapeSlotSpec],
}

const RM_OBJECT_SHAPE_SLOTS: &[ParseShapeSlotSpec] = &[
    ParseShapeSlotSpec {
        slot: SlotId::RmObjectType,
        tokens: SHARED_OBJECT_TYPE_TOKENS,
        placeholder: None,
    },
    ParseShapeSlotSpec {
        slot: SlotId::RmObjectIdentifier,
        tokens: SIMPLE_SET_EXPR_TOKENS,
        placeholder: Some(ValueKind::NumericDigit),
    },
];
const RM_OBJECT_SHAPE_SLOT_IDS: &[SlotId] = &[SlotId::RmObjectType, SlotId::RmObjectIdentifier];

const RENAME_OBJECT_SHAPE_SLOTS: &[ParseShapeSlotSpec] = &[
    ParseShapeSlotSpec {
        slot: SlotId::RenameObjectType,
        tokens: SHARED_OBJECT_TYPE_TOKENS,
        placeholder: None,
    },
    ParseShapeSlotSpec {
        slot: SlotId::RenameSource,
        tokens: &[],
        placeholder: Some(ValueKind::IdentifierExpression),
    },
    ParseShapeSlotSpec {
        slot: SlotId::RenameTarget,
        tokens: &[],
        placeholder: Some(ValueKind::IdentifierExpression),
    },
];
const RENAME_OBJECT_SHAPE_SLOT_IDS: &[SlotId] = &[
    SlotId::RenameObjectType,
    SlotId::RenameSource,
    SlotId::RenameTarget,
];

const DEBUG_OBJECT_SHAPE_SLOTS: &[ParseShapeSlotSpec] = &[
    ParseShapeSlotSpec {
        slot: SlotId::DebugObjectType,
        tokens: SHARED_OBJECT_TYPE_TOKENS,
        placeholder: None,
    },
    ParseShapeSlotSpec {
        slot: SlotId::DebugObjectIdentifier,
        tokens: &[],
        placeholder: Some(ValueKind::IdentifierExpression),
    },
];
const DEBUG_OBJECT_SHAPE_SLOT_IDS: &[SlotId] =
    &[SlotId::DebugObjectType, SlotId::DebugObjectIdentifier];

const RM_OBJECT_SHAPE: ObjectCommandParseShape = ObjectCommandParseShape {
    slots: RM_OBJECT_SHAPE_SLOTS,
};

const RENAME_OBJECT_SHAPE: ObjectCommandParseShape = ObjectCommandParseShape {
    slots: RENAME_OBJECT_SHAPE_SLOTS,
};

const DEBUG_OBJECT_SHAPE: ObjectCommandParseShape = ObjectCommandParseShape {
    slots: DEBUG_OBJECT_SHAPE_SLOTS,
};

pub fn playback_command_parse_shape(
    shape_id: InstanceCommandParseShapeId,
) -> &'static InstanceCommandParseShape {
    match shape_id {
        InstanceCommandParseShapeId::Clip => &CLIP_PLAYBACK_SHAPE,
        InstanceCommandParseShapeId::Flow => &FLOW_PLAYBACK_SHAPE,
        InstanceCommandParseShapeId::Timecode => &TIMECODE_PLAYBACK_SHAPE,
        InstanceCommandParseShapeId::Timeline => &TIMELINE_PLAYBACK_SHAPE,
    }
}

pub fn playback_command_parse_shape_for_slot(
    slot: SlotId,
) -> Option<&'static InstanceCommandParseShape> {
    match slot {
        SlotId::ClipIdentifier | SlotId::ClipAction => Some(playback_command_parse_shape(
            InstanceCommandParseShapeId::Clip,
        )),
        SlotId::FlowIdentifier | SlotId::FlowAction => Some(playback_command_parse_shape(
            InstanceCommandParseShapeId::Flow,
        )),
        SlotId::TimecodeIdentifier | SlotId::TimecodeAction => Some(playback_command_parse_shape(
            InstanceCommandParseShapeId::Timecode,
        )),
        SlotId::TimelineIdentifier | SlotId::TimelineAction => Some(playback_command_parse_shape(
            InstanceCommandParseShapeId::Timeline,
        )),
        _ => None,
    }
}

pub fn playback_command_parse_shape_slots(
    shape_id: InstanceCommandParseShapeId,
) -> &'static [ParseShapeSlotSpec] {
    playback_command_parse_shape(shape_id).slots
}

pub fn playback_command_parse_shape_slot_ids(
    shape_id: InstanceCommandParseShapeId,
) -> &'static [SlotId] {
    match shape_id {
        InstanceCommandParseShapeId::Clip => CLIP_PLAYBACK_SHAPE_SLOT_IDS,
        InstanceCommandParseShapeId::Flow => FLOW_PLAYBACK_SHAPE_SLOT_IDS,
        InstanceCommandParseShapeId::Timecode => TIMECODE_PLAYBACK_SHAPE_SLOT_IDS,
        InstanceCommandParseShapeId::Timeline => TIMELINE_PLAYBACK_SHAPE_SLOT_IDS,
    }
}

pub fn object_command_parse_shape(
    shape_id: ObjectCommandParseShapeId,
) -> &'static ObjectCommandParseShape {
    match shape_id {
        ObjectCommandParseShapeId::Rm => &RM_OBJECT_SHAPE,
        ObjectCommandParseShapeId::Rename => &RENAME_OBJECT_SHAPE,
        ObjectCommandParseShapeId::Debug => &DEBUG_OBJECT_SHAPE,
    }
}

pub fn object_command_parse_shape_for_slot(
    slot: SlotId,
) -> Option<&'static ObjectCommandParseShape> {
    match slot {
        SlotId::RmObjectType | SlotId::RmObjectIdentifier => {
            Some(object_command_parse_shape(ObjectCommandParseShapeId::Rm))
        }
        SlotId::RenameObjectType | SlotId::RenameSource | SlotId::RenameTarget => Some(
            object_command_parse_shape(ObjectCommandParseShapeId::Rename),
        ),
        SlotId::DebugObjectType | SlotId::DebugObjectIdentifier => {
            Some(object_command_parse_shape(ObjectCommandParseShapeId::Debug))
        }
        _ => None,
    }
}

pub fn object_command_parse_shape_slots(
    shape_id: ObjectCommandParseShapeId,
) -> &'static [ParseShapeSlotSpec] {
    object_command_parse_shape(shape_id).slots
}

pub fn object_command_parse_shape_slot_ids(
    shape_id: ObjectCommandParseShapeId,
) -> &'static [SlotId] {
    match shape_id {
        ObjectCommandParseShapeId::Rm => RM_OBJECT_SHAPE_SLOT_IDS,
        ObjectCommandParseShapeId::Rename => RENAME_OBJECT_SHAPE_SLOT_IDS,
        ObjectCommandParseShapeId::Debug => DEBUG_OBJECT_SHAPE_SLOT_IDS,
    }
}
