// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reusable parse specs shared across parser layers.

use crate::parser::analysis::{TokenId, ValueKind};
use crate::slots::contracts::{SlotId, SuppressRule};

const ATTRIBUTE_TOKENS: &[TokenId] = &[
    TokenId::Intensity,
    TokenId::Red,
    TokenId::Green,
    TokenId::Blue,
    TokenId::White,
];

const RANGEABLE_DURATION_TOKENS: &[TokenId] = &[
    TokenId::Plus,
    TokenId::Minus,
    TokenId::Dot,
    TokenId::GreaterThan,
];

const SIMPLE_DURATION_TOKENS: &[TokenId] = &[TokenId::Plus, TokenId::Minus, TokenId::Dot];

const DURATION_UNITS: &[&str] = &["seconds", "sec", "ms", "bpm", "hz", "s", "%"];

const ATTRIBUTE_RESERVED_HEADS: &[&str] = &[
    "channel",
    "chan",
    "ch",
    "fx",
    "flow",
    "clip",
    "exec",
    "e",
    "cue",
    "c",
    "sequence",
    "seq",
    "s",
    "timecode",
    "tc",
    "timeline",
    "tl",
    "fixture",
    "fix",
    "f",
    "parameter",
    "param",
    "p",
    "group",
    "grp",
    "g",
    "blueprint",
    "bp",
    "path",
    "color-path",
    "colour-path",
    "colorpath",
    "colourpath",
    "color_path",
    "colour_path",
    "delete",
    "del",
    "rm",
    "patch",
    "store",
    "recall",
    "rename",
    "mv",
    "save",
    "load",
    "help",
    "quit",
    "clear",
    "release",
    "debug",
    "fps",
    "log",
    "undo",
    "redo",
    "sleep",
];

const TIMING_OVERRIDE_FORBIDDEN_WORDS: &[&str] = &["fade", "delay"];

const NONE_SUPPRESS: &[SuppressRule] = &[];
const SET_ATTR_SUPPRESS: &[SuppressRule] = &[SuppressRule::ExcludeFilledAttributesInSlot {
    slot: SlotId::SetAttrAttribute,
}];
const QUALIFIER_ATTR_SUPPRESS: &[SuppressRule] = &[SuppressRule::ExcludeFilledAttributesInSlot {
    slot: SlotId::QualifierAttributeList,
}];
const TIMING_ATTR_SUPPRESS: &[SuppressRule] = &[SuppressRule::ExcludeFilledAttributesInSlot {
    slot: SlotId::TimingsOverrideAttribute,
}];
const STEP_FX_ATTR_SUPPRESS: &[SuppressRule] = &[SuppressRule::ExcludeFilledAttributesInSlot {
    slot: SlotId::StepFxStepAttribute,
}];

/// Named attribute parse specs covered by parser surface tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeParseSpecId {
    Standard,
    TimingOverride,
}

/// Expected parser behavior for one attribute command surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttributeParseSpec {
    pub offered_tokens: &'static [TokenId],
    pub forbid_reserved_heads: bool,
    pub forbidden_words: &'static [&'static str],
    pub forbidden_word_error: &'static str,
    pub allow_quoted: bool,
    pub allow_custom_word: bool,
}

const STANDARD_ATTRIBUTE_PARSE_SPEC: AttributeParseSpec = AttributeParseSpec {
    offered_tokens: ATTRIBUTE_TOKENS,
    forbid_reserved_heads: true,
    forbidden_words: &[],
    forbidden_word_error: "",
    allow_quoted: true,
    allow_custom_word: true,
};

const TIMING_OVERRIDE_ATTRIBUTE_PARSE_SPEC: AttributeParseSpec = AttributeParseSpec {
    offered_tokens: ATTRIBUTE_TOKENS,
    forbid_reserved_heads: true,
    forbidden_words: TIMING_OVERRIDE_FORBIDDEN_WORDS,
    forbidden_word_error: "timing keyword cannot be used as timing override attribute",
    allow_quoted: true,
    allow_custom_word: true,
};

/// Validation failures detected while building attribute parse specs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeSurfaceError {
    ReservedCommandHead,
    ForbiddenWord,
}

/// Named multi-attribute parse specs covered by parser surface tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeCollectionParseSpecId {
    ProgrammerSet,
    Qualifier,
    TimingOverride,
    StepFxStep,
    StoreFixtureOffset,
    LogFixture,
}

/// Expected parser behavior for one multi-attribute command surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttributeCollectionParseSpec {
    pub attribute_spec: &'static AttributeParseSpec,
    pub suppress: &'static [SuppressRule],
    pub can_skip: bool,
}

const PROGRAMMER_SET_ATTRIBUTE_COLLECTION_PARSE_SPEC: AttributeCollectionParseSpec =
    AttributeCollectionParseSpec {
        attribute_spec: &STANDARD_ATTRIBUTE_PARSE_SPEC,
        suppress: SET_ATTR_SUPPRESS,
        can_skip: false,
    };

const QUALIFIER_ATTRIBUTE_COLLECTION_PARSE_SPEC: AttributeCollectionParseSpec =
    AttributeCollectionParseSpec {
        attribute_spec: &STANDARD_ATTRIBUTE_PARSE_SPEC,
        suppress: QUALIFIER_ATTR_SUPPRESS,
        can_skip: true,
    };

const TIMING_OVERRIDE_ATTRIBUTE_COLLECTION_PARSE_SPEC: AttributeCollectionParseSpec =
    AttributeCollectionParseSpec {
        attribute_spec: &TIMING_OVERRIDE_ATTRIBUTE_PARSE_SPEC,
        suppress: TIMING_ATTR_SUPPRESS,
        can_skip: true,
    };

const STEP_FX_ATTRIBUTE_COLLECTION_PARSE_SPEC: AttributeCollectionParseSpec =
    AttributeCollectionParseSpec {
        attribute_spec: &STANDARD_ATTRIBUTE_PARSE_SPEC,
        suppress: STEP_FX_ATTR_SUPPRESS,
        can_skip: false,
    };

const STORE_FIXTURE_OFFSET_ATTRIBUTE_COLLECTION_PARSE_SPEC: AttributeCollectionParseSpec =
    AttributeCollectionParseSpec {
        attribute_spec: &STANDARD_ATTRIBUTE_PARSE_SPEC,
        suppress: NONE_SUPPRESS,
        can_skip: false,
    };

const LOG_FIXTURE_ATTRIBUTE_COLLECTION_PARSE_SPEC: AttributeCollectionParseSpec =
    AttributeCollectionParseSpec {
        attribute_spec: &STANDARD_ATTRIBUTE_PARSE_SPEC,
        suppress: NONE_SUPPRESS,
        can_skip: true,
    };

/// Named duration parse specs covered by parser surface tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationParseSpecId {
    Timing,
    StepFx,
    Sleep,
}

/// Expected parser behavior for one duration command surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DurationParseSpec {
    pub offered_tokens: &'static [TokenId],
    pub placeholder: ValueKind,
    pub can_skip: bool,
}

const TIMING_DURATION_PARSE_SPEC: DurationParseSpec = DurationParseSpec {
    offered_tokens: RANGEABLE_DURATION_TOKENS,
    placeholder: ValueKind::DurationValue,
    can_skip: true,
};

const STEP_FX_DURATION_PARSE_SPEC: DurationParseSpec = DurationParseSpec {
    offered_tokens: &[],
    placeholder: ValueKind::DurationValue,
    can_skip: false,
};

const SLEEP_DURATION_PARSE_SPEC: DurationParseSpec = DurationParseSpec {
    offered_tokens: SIMPLE_DURATION_TOKENS,
    placeholder: ValueKind::DurationValue,
    can_skip: false,
};

pub fn attribute_token_ids() -> &'static [TokenId] {
    ATTRIBUTE_TOKENS
}

pub fn attribute_parse_spec(spec_id: AttributeParseSpecId) -> &'static AttributeParseSpec {
    match spec_id {
        AttributeParseSpecId::Standard => &STANDARD_ATTRIBUTE_PARSE_SPEC,
        AttributeParseSpecId::TimingOverride => &TIMING_OVERRIDE_ATTRIBUTE_PARSE_SPEC,
    }
}

pub fn attribute_collection_parse_spec(
    spec_id: AttributeCollectionParseSpecId,
) -> &'static AttributeCollectionParseSpec {
    match spec_id {
        AttributeCollectionParseSpecId::ProgrammerSet => {
            &PROGRAMMER_SET_ATTRIBUTE_COLLECTION_PARSE_SPEC
        }
        AttributeCollectionParseSpecId::Qualifier => &QUALIFIER_ATTRIBUTE_COLLECTION_PARSE_SPEC,
        AttributeCollectionParseSpecId::TimingOverride => {
            &TIMING_OVERRIDE_ATTRIBUTE_COLLECTION_PARSE_SPEC
        }
        AttributeCollectionParseSpecId::StepFxStep => &STEP_FX_ATTRIBUTE_COLLECTION_PARSE_SPEC,
        AttributeCollectionParseSpecId::StoreFixtureOffset => {
            &STORE_FIXTURE_OFFSET_ATTRIBUTE_COLLECTION_PARSE_SPEC
        }
        AttributeCollectionParseSpecId::LogFixture => &LOG_FIXTURE_ATTRIBUTE_COLLECTION_PARSE_SPEC,
    }
}

pub fn attribute_collection_parse_spec_for_slot(
    slot: SlotId,
) -> Option<&'static AttributeCollectionParseSpec> {
    match slot {
        SlotId::SetAttrAttribute => Some(attribute_collection_parse_spec(
            AttributeCollectionParseSpecId::ProgrammerSet,
        )),
        SlotId::QualifierAttributeList => Some(attribute_collection_parse_spec(
            AttributeCollectionParseSpecId::Qualifier,
        )),
        SlotId::TimingsOverrideAttribute => Some(attribute_collection_parse_spec(
            AttributeCollectionParseSpecId::TimingOverride,
        )),
        SlotId::StepFxStepAttribute => Some(attribute_collection_parse_spec(
            AttributeCollectionParseSpecId::StepFxStep,
        )),
        SlotId::StoreFixtureOffsetAttribute => Some(attribute_collection_parse_spec(
            AttributeCollectionParseSpecId::StoreFixtureOffset,
        )),
        SlotId::LogFixtureAttribute => Some(attribute_collection_parse_spec(
            AttributeCollectionParseSpecId::LogFixture,
        )),
        _ => None,
    }
}

pub fn attribute_parse_spec_for_slot(slot: SlotId) -> Option<&'static AttributeParseSpec> {
    attribute_collection_parse_spec_for_slot(slot).map(|spec| spec.attribute_spec)
}

pub fn duration_parse_spec(spec_id: DurationParseSpecId) -> &'static DurationParseSpec {
    match spec_id {
        DurationParseSpecId::Timing => &TIMING_DURATION_PARSE_SPEC,
        DurationParseSpecId::StepFx => &STEP_FX_DURATION_PARSE_SPEC,
        DurationParseSpecId::Sleep => &SLEEP_DURATION_PARSE_SPEC,
    }
}

pub fn duration_parse_spec_for_slot(slot: SlotId) -> Option<&'static DurationParseSpec> {
    match slot {
        SlotId::TimingsGlobalDuration | SlotId::TimingsOverrideDuration => {
            Some(duration_parse_spec(DurationParseSpecId::Timing))
        }
        SlotId::StepFxDuration => Some(duration_parse_spec(DurationParseSpecId::StepFx)),
        SlotId::SleepDuration => Some(duration_parse_spec(DurationParseSpecId::Sleep)),
        _ => None,
    }
}

pub fn duration_unit_texts() -> &'static [&'static str] {
    DURATION_UNITS
}

pub fn duration_value_prefix(raw: &str) -> bool {
    let value = raw.trim();
    if value.is_empty() {
        return false;
    }
    if matches!(value, "+" | "-") {
        return true;
    }

    let bytes = value.as_bytes();
    let mut index = 0usize;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    if !matches!(bytes.get(index), Some(b'0'..=b'9')) {
        return false;
    }
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if matches!(bytes.get(index), Some(b'.')) {
        index += 1;
        while matches!(bytes.get(index), Some(b'0'..=b'9')) {
            index += 1;
        }
    }

    matches!(
        value[index..].to_ascii_lowercase().as_str(),
        "" | "%"
            | "s"
            | "se"
            | "sec"
            | "seco"
            | "secon"
            | "second"
            | "seconds"
            | "m"
            | "ms"
            | "b"
            | "bp"
            | "bpm"
            | "h"
            | "hz"
    )
}

pub fn validate_attribute_surface(
    spec: &AttributeParseSpec,
    surface: &str,
) -> Result<(), AttributeSurfaceError> {
    if spec.forbid_reserved_heads && is_reserved_command_head_text(surface) {
        return Err(AttributeSurfaceError::ReservedCommandHead);
    }

    if spec
        .forbidden_words
        .iter()
        .any(|word| word.eq_ignore_ascii_case(surface))
    {
        return Err(AttributeSurfaceError::ForbiddenWord);
    }

    Ok(())
}

pub fn attribute_surface_is_allowed(spec: &AttributeParseSpec, surface: &str) -> bool {
    validate_attribute_surface(spec, surface).is_ok()
}

pub fn attribute_lexeme_is_allowed(
    spec: &AttributeParseSpec,
    surface: &str,
    token_id: Option<TokenId>,
    is_quoted: bool,
) -> bool {
    if is_quoted {
        return spec.allow_quoted;
    }

    if let Some(token_id) = token_id {
        return spec.offered_tokens.contains(&token_id);
    }

    spec.allow_custom_word
        && surface.chars().all(|ch| ch.is_ascii_alphabetic())
        && attribute_surface_is_allowed(spec, surface)
}

pub fn is_reserved_command_head_text(token: &str) -> bool {
    ATTRIBUTE_RESERVED_HEADS
        .iter()
        .any(|head| head.eq_ignore_ascii_case(token))
}
