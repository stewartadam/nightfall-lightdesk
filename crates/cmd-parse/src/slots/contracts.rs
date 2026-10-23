// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Slot contracts and semantic policy definitions.

use serde::{Deserialize, Serialize};

use crate::parser::analysis::{TokenId, ValueKind};

/// Stable identifier for an input position in a command clause.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotId {
    CompactPathSource,
    CompactPathTarget,
    SelectionSource,
    PropertyObjectType,
    PropertyObjectIdentifier,
    PropertyKeyword,
    PropertyEquals,
    PropertyTargetType,
    PropertyTargetIdentifier,
    PathIdentifier,
    PathKeyword,
    PathValue,
    LabelKeyword,
    LabelText,

    ReleaseStaleKeyword,
    ReleaseStaleSeparator,
    ReleaseInputsKeyword,
    CueOverwrite,
    ShowfileName,
    NewShowfileType,
    CommandHead,
    SelectionType,
    SelectionIdentifier,
    SetAttrAttribute,
    SetAttrValue,
    BlueprintResolution,
    TimingsKeyword,
    TimingsDirection,
    TimingsGlobalDuration,
    TimingsOverrideAttribute,
    TimingsOverrideDuration,
    PlacementAction,
    PlacementAxisValue,
    FxModuleKeyword,
    FxModuleIdentifier,
    FxModuleAction,
    FxIdentifier,
    /// FX action token slot (for verbs like `start`, `stop`, and `rate`) after an FX identifier.
    FxAction,
    /// Step FX creation token after a stored FX identifier.
    StoreFxAction,
    StepFxSelectionHead,
    StepFxSelectionIdentifier,
    StepFxSelectionTransform,
    StepFxDuration,
    StepFxGroupsKeyword,
    StepFxGroupsValue,
    StoreFxModulePayload,
    StepFxStepAttribute,
    StepFxAttributeBaseline,
    StepFxStepValues,
    StepFxAttributeShaping,
    PatchSourceEndpoint,
    PatchSourceUniverse,
    PatchSourceAddress,
    PatchTargetEndpoint,
    PatchPriority,
    PatchClone,
    ClipIdentifier,
    ClipAction,
    ClearTarget,
    QualifierKeyword,
    QualifierAttributeList,
    ChannelOverrideIdentifier,
    ChannelOverrideValue,
    ReleaseChannelExpr,
    RmObjectType,
    RmObjectIdentifier,
    StoreObjectType,
    StoreObjectIdentifier,
    StoreObjectPayload,
    StoreCueRef,
    StoreMode,
    StoreGroupIdentifier,
    StoreBlueprintIdentifier,
    StoreFixtureIdentifier,
    StoreFixtureMake,
    StoreFixtureModel,
    StoreFixtureMode,
    StoreFixtureOffsetKeyword,
    StoreFixtureOffsetAttribute,
    StoreFixtureOffsetValue,
    RenameObjectType,
    RenameSource,
    RenameTarget,
    FlowIdentifier,
    FlowAction,
    TimecodeIdentifier,
    TimecodeAction,
    TimelineIdentifier,
    TimelineAction,
    LogLevel,
    LogFilterField,
    LogFilterValue,
    LogFixtureIdentifier,
    LogFixtureAttribute,
    RecallCueRef,
    RecallSelectFlag,
    RecallBlueprintKeyword,
    RecallBlueprintIdentifier,
    RecallBlueprintResolution,
    DebugObjectType,
    DebugObjectIdentifier,
    SleepDuration,
    FpsValue,
    /// Tempo operation keyword or BPM value, including any numeric operand that follows it.
    TempoAction,
}

/// Stable identifier for a command grammar clause.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClauseId {
    RenameObjects,
    RenameCompactPaths,
    ProgrammerSelectionSource,
    ObjectProperty,
    StoreColorPath,
    ColorPathLabel,
    ProgrammerColorPath,
    CueColorPath,
    CopyColorPath,

    ReleaseStaleInputs,
    CueBlock,
    Utility,
    Showfile,
    NewShowfile,

    Programmer,
    ProgrammerSelection,
    ProgrammerSelectionIdentifier,
    ProgrammerAttributeActions,
    ProgrammerSetAttributeItem,
    ProgrammerTimings,
    ProgrammerTimingOverride,
    ProgrammerPlacement3d,
    Fx,
    FxModule,
    FxIdentifier,
    /// Clause for FX action verbs that operate on the current FX identifier.
    FxAction,
    StepFx,
    StoreFxModule,
    StepFxSelection,
    StepFxDuration,
    StepFxStepDefinition,
    Patch,
    PatchSource,
    PatchTarget,
    Clip,
    ClipIdentifier,
    ClipAction,
    ChannelOverride,
    Release,
    ReleaseChannel,
    ReleaseAttributes,
    Clear,
    ClearAttributes,
    Flow,
    FlowIdentifier,
    FlowAction,
    Timecode,
    TimecodeIdentifier,
    TimecodeAction,
    Timeline,
    TimelineIdentifier,
    TimelineAction,
    Rm,
    Rename,
    Store,
    StoreBlueprint,
    StoreBlueprintFilter,
    StoreFixture,
    StoreFixturePayload,
    StoreFixtureOffset,
    Log,
    LogLevel,
    LogFilter,
    LogFixture,
    Recall,
    RecallCue,
    RecallBlueprint,
    Debug,
    Sleep,
    Fps,
    Tempo,
}

/// Parse-time flag that records whether a clause supplied optional timing data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlagId {
    HasFade,
    HasDelay,
}

/// Completion and suppression rules for one slot in the grammar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotSpec {
    pub id: SlotId,
    pub offers: SlotOffers,
    pub policy: SlotPolicy,
}

/// Tokens or placeholder value kind that a slot can suggest to the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotOffers {
    pub tokens: &'static [TokenId],
    pub placeholder: Option<ValueKind>,
}

/// Rules that decide when a slot can be omitted or should hide suggestions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotPolicy {
    pub suppress: &'static [SuppressRule],
    pub can_skip: bool,
}

/// Suggestion filter used when a prior clause or slot already filled related input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SuppressRule {
    ExcludeFilledTokensInSlot { slot: SlotId },
    ExcludeFilledAttributesInSlot { slot: SlotId },
    ExcludeClauseAlreadyHasToken { clause: ClauseId },
}

/// Static clause/slot grammar definition shared by parser, traces, and projections.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandGrammar {
    pub roots: &'static [ClauseId],
    pub clauses: &'static [ClauseSchema],
}

/// One clause definition in the static grammar hierarchy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClauseSchema {
    pub id: ClauseId,
    pub label: &'static str,
    pub parent: Option<ClauseId>,
    pub children: &'static [ClauseChildSpec],
    pub slots: &'static [ClauseSlotSpec],
    pub entry: ClauseEntryKind,
    pub rules: &'static ClauseRules,
}

/// Conditional grammar rules that decide when a clause's children and slots may be used.
///
/// Children and slots without a rule are always available, subject to their cardinality.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClauseRules {
    pub children_mode: ChildrenMode,
    pub children: &'static [ChildRule],
    pub slots: &'static [SlotRule],
    pub frontier: FrontierRules,
}

/// Declares whether a clause's children can be combined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildrenMode {
    /// Any mix of children, each limited only by its own cardinality and rule.
    Any,
    /// The children are alternatives: once one is entered, only that child can continue.
    OneOf,
}

/// Availability rule for one child clause, evaluated against the parent clause instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChildRule {
    pub clause: ClauseId,
    pub when: ClauseCondition,
}

/// Availability rule for one slot, evaluated against the clause instance that owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotRule {
    pub slot: SlotId,
    pub when: ClauseCondition,
}

/// Predicate over one clause instance in a parse branch.
///
/// Conditions are const data so the grammar stays declarative and inspectable; logic that
/// cannot be expressed this way is named through [`ConditionHookId`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClauseCondition {
    /// Always satisfied.
    Always,
    /// Never satisfied: the target is only entered by other means, such as the root head.
    Never,
    /// The slot has at least one fill in the given scope.
    Filled(SlotScope, SlotId),
    /// The slot has a fill in the given scope whose keyword is one of the tokens.
    FilledWith(SlotScope, SlotId, &'static [TokenId]),
    /// The clause instance has a direct child of this clause kind.
    HasChild(ClauseId),
    /// The clause instance has at least one direct child.
    HasAnyChild,
    Not(&'static ClauseCondition),
    All(&'static [ClauseCondition]),
    Any(&'static [ClauseCondition]),
    /// Named parser logic for rules that do not fit the declarative forms.
    Hook(ConditionHookId),
}

/// Which consumed items a slot condition looks at, relative to the evaluated clause instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotScope {
    /// Fills owned by the clause instance itself.
    Own,
    /// Fills owned by the clause instance or any of its descendants.
    Subtree,
}

/// Parser-defined conditions that are referenced by name from the grammar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionHookId {
    /// A Bezier shaping expression has been opened but not yet closed with `)`.
    BezierShapingOpen,
}

/// How the autocomplete frontier sequences a clause's slots and children.
///
/// By default the frontier offers the first pending slot, then any available children in
/// grammar order. These flags adjust that order for clauses whose syntax needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrontierRules {
    /// Children offered on their own, ahead of this clause's slots, while they are available,
    /// not yet entered, and their condition holds.
    pub eager_children: &'static [ChildRule],
    /// While this clause's first required slot is pending, also offer its other required slots.
    pub offer_required_slots_together: bool,
    /// As a child: once reachable, the parent offers only this clause's entry until it is entered.
    pub blocks_parent_until_entered: bool,
    /// As a child: alongside the clause entry, also offer its first slot directly.
    pub project_initial_slot: bool,
}

/// Frontier ordering with no adjustments.
const DEFAULT_FRONTIER: FrontierRules = FrontierRules {
    eager_children: &[],
    offer_required_slots_together: false,
    blocks_parent_until_entered: false,
    project_initial_slot: false,
};

/// Rules for a clause without conditional children or slots; base for the other rule tables.
const DEFAULT_RULES: ClauseRules = ClauseRules {
    children_mode: ChildrenMode::Any,
    children: &[],
    slots: &[],
    frontier: DEFAULT_FRONTIER,
};

/// Rules for a clause without conditional children or slots.
pub const NO_RULES: &ClauseRules = &DEFAULT_RULES;

/// Rules for a clause whose children are mutually exclusive alternatives.
const ONE_OF_CHILDREN: &ClauseRules = &ClauseRules {
    children_mode: ChildrenMode::OneOf,
    ..DEFAULT_RULES
};

/// Rules for a child clause whose first slot is offered alongside its entry.
const PROJECT_INITIAL_SLOT: &ClauseRules = &ClauseRules {
    frontier: FrontierRules {
        project_initial_slot: true,
        ..DEFAULT_FRONTIER
    },
    ..DEFAULT_RULES
};

/// Rules for a child clause the parent must enter before offering anything after it.
const BLOCKS_PARENT_UNTIL_ENTERED: &ClauseRules = &ClauseRules {
    frontier: FrontierRules {
        blocks_parent_until_entered: true,
        ..DEFAULT_FRONTIER
    },
    ..DEFAULT_RULES
};

/// `channel` offers its value alongside the channel expression, for `channel 1 @ 50`.
const CHANNEL_OVERRIDE_RULES: &ClauseRules = &ClauseRules {
    frontier: FrontierRules {
        offer_required_slots_together: true,
        ..DEFAULT_FRONTIER
    },
    ..DEFAULT_RULES
};

/// Shorthand for a child rule in the const rule tables below.
const fn child_when(clause: ClauseId, when: ClauseCondition) -> ChildRule {
    ChildRule { clause, when }
}

/// Shorthand for a slot rule in the const rule tables below.
const fn slot_when(slot: SlotId, when: ClauseCondition) -> SlotRule {
    SlotRule { slot, when }
}

/// Shorthand for "the slot has a fill owned by this clause".
const fn own_filled(slot: SlotId) -> ClauseCondition {
    ClauseCondition::Filled(SlotScope::Own, slot)
}

/// Shorthand for "this clause's own fill of the slot is one of the tokens".
const fn own_is(slot: SlotId, tokens: &'static [TokenId]) -> ClauseCondition {
    ClauseCondition::FilledWith(SlotScope::Own, slot, tokens)
}

/// Shorthand for "this clause instance already has a child of the given kind".
const fn has(clause: ClauseId) -> ClauseCondition {
    ClauseCondition::HasChild(clause)
}

const RELEASE_RULES: &ClauseRules = &ClauseRules {
    children: &[
        // Stale inputs is a whole-command target and cannot mix with channel or attribute
        // targets; channel targets must come before attribute targets.
        child_when(
            ClauseId::ReleaseStaleInputs,
            ClauseCondition::Not(&ClauseCondition::Any(&[
                has(ClauseId::ReleaseStaleInputs),
                has(ClauseId::ReleaseChannel),
                has(ClauseId::ReleaseAttributes),
            ])),
        ),
        child_when(
            ClauseId::ReleaseChannel,
            ClauseCondition::Not(&ClauseCondition::Any(&[
                has(ClauseId::ReleaseStaleInputs),
                has(ClauseId::ReleaseAttributes),
            ])),
        ),
        child_when(
            ClauseId::ReleaseAttributes,
            ClauseCondition::Not(&has(ClauseId::ReleaseStaleInputs)),
        ),
    ],
    ..DEFAULT_RULES
};

const PROGRAMMER_RULES: &ClauseRules = &ClauseRules {
    children: &[
        // Entered only through a selection-source root head, never as a follow-up child.
        child_when(ClauseId::ProgrammerSelectionSource, ClauseCondition::Never),
        // A color path assignment replaces the attribute, placement and timing parts and is
        // only defined for fixture selections.
        child_when(
            ClauseId::ProgrammerColorPath,
            ClauseCondition::All(&[
                ClauseCondition::FilledWith(
                    SlotScope::Subtree,
                    SlotId::SelectionType,
                    &[TokenId::Fixture],
                ),
                ClauseCondition::Not(&ClauseCondition::Any(&[
                    has(ClauseId::ProgrammerAttributeActions),
                    has(ClauseId::ProgrammerPlacement3d),
                    has(ClauseId::ProgrammerTimings),
                ])),
            ]),
        ),
        child_when(
            ClauseId::ProgrammerSelection,
            ClauseCondition::Not(&ClauseCondition::Any(&[
                ClauseCondition::Filled(SlotScope::Subtree, SlotId::SelectionSource),
                has(ClauseId::ProgrammerColorPath),
            ])),
        ),
        child_when(
            ClauseId::ProgrammerTimings,
            ClauseCondition::Not(&has(ClauseId::ProgrammerColorPath)),
        ),
        // Attribute actions and 3D placement are alternatives, and timings close both.
        child_when(
            ClauseId::ProgrammerAttributeActions,
            ClauseCondition::Not(&ClauseCondition::Any(&[
                has(ClauseId::ProgrammerPlacement3d),
                has(ClauseId::ProgrammerTimings),
                has(ClauseId::ProgrammerColorPath),
            ])),
        ),
        child_when(
            ClauseId::ProgrammerPlacement3d,
            ClauseCondition::Not(&ClauseCondition::Any(&[
                has(ClauseId::ProgrammerAttributeActions),
                has(ClauseId::ProgrammerTimings),
                has(ClauseId::ProgrammerColorPath),
            ])),
        ),
    ],
    ..DEFAULT_RULES
};

const PROGRAMMER_TIMINGS_RULES: &ClauseRules = &ClauseRules {
    children: &[child_when(
        ClauseId::ProgrammerTimingOverride,
        own_filled(SlotId::TimingsKeyword),
    )],
    frontier: FrontierRules {
        project_initial_slot: true,
        ..DEFAULT_FRONTIER
    },
    ..DEFAULT_RULES
};

const FX_RULES: &ClauseRules = &ClauseRules {
    children: &[
        // `fx module ...` and `fx <id> ...` are separate command shapes.
        child_when(
            ClauseId::FxModule,
            ClauseCondition::Not(&ClauseCondition::Filled(
                SlotScope::Subtree,
                SlotId::FxIdentifier,
            )),
        ),
        child_when(
            ClauseId::FxIdentifier,
            ClauseCondition::Not(&ClauseCondition::Filled(
                SlotScope::Subtree,
                SlotId::FxModuleKeyword,
            )),
        ),
        child_when(
            ClauseId::FxAction,
            ClauseCondition::All(&[
                ClauseCondition::Filled(SlotScope::Subtree, SlotId::FxIdentifier),
                ClauseCondition::Not(&ClauseCondition::Filled(
                    SlotScope::Subtree,
                    SlotId::FxModuleKeyword,
                )),
            ]),
        ),
    ],
    ..DEFAULT_RULES
};

const PATCH_RULES: &ClauseRules = &ClauseRules {
    children: &[child_when(
        ClauseId::PatchTarget,
        has(ClauseId::PatchSource),
    )],
    slots: &[
        slot_when(SlotId::PatchPriority, has(ClauseId::PatchTarget)),
        slot_when(SlotId::PatchClone, has(ClauseId::PatchTarget)),
    ],
    ..DEFAULT_RULES
};

/// Object types whose store command takes a plain identifier after the type.
const STORE_IDENTIFIER_OBJECT_TYPES: &[TokenId] = &[
    TokenId::Clip,
    TokenId::Flow,
    TokenId::Fx,
    TokenId::Timecode,
    TokenId::Timeline,
];

/// Step FX and FX module payloads both follow `store fx <id>` and exclude each other.
const STORE_FX_PAYLOAD_READY: ClauseCondition = ClauseCondition::All(&[
    own_is(SlotId::StoreObjectType, &[TokenId::Fx]),
    own_filled(SlotId::StoreObjectIdentifier),
]);

const STORE_RULES: &ClauseRules = &ClauseRules {
    children: &[
        child_when(
            ClauseId::StoreColorPath,
            own_is(SlotId::StoreObjectType, &[TokenId::Path]),
        ),
        child_when(
            ClauseId::StoreBlueprint,
            own_is(SlotId::StoreObjectType, &[TokenId::Blueprint]),
        ),
        child_when(
            ClauseId::StoreFixture,
            own_is(SlotId::StoreObjectType, &[TokenId::Fixture]),
        ),
        child_when(
            ClauseId::StepFx,
            ClauseCondition::All(&[
                STORE_FX_PAYLOAD_READY,
                ClauseCondition::Not(&has(ClauseId::StoreFxModule)),
            ]),
        ),
        child_when(
            ClauseId::StoreFxModule,
            ClauseCondition::All(&[
                STORE_FX_PAYLOAD_READY,
                ClauseCondition::Not(&has(ClauseId::StepFx)),
            ]),
        ),
    ],
    // The object type picks which of the store slots apply.
    slots: &[
        slot_when(
            SlotId::StoreObjectType,
            ClauseCondition::Not(&own_filled(SlotId::StoreObjectType)),
        ),
        slot_when(
            SlotId::StoreObjectIdentifier,
            ClauseCondition::All(&[
                own_is(SlotId::StoreObjectType, STORE_IDENTIFIER_OBJECT_TYPES),
                ClauseCondition::Not(&ClauseCondition::HasAnyChild),
            ]),
        ),
        slot_when(
            SlotId::StoreObjectPayload,
            own_is(SlotId::StoreObjectType, &[TokenId::Flow]),
        ),
        slot_when(
            SlotId::StoreCueRef,
            own_is(SlotId::StoreObjectType, &[TokenId::Cue]),
        ),
        slot_when(
            SlotId::StoreMode,
            own_is(SlotId::StoreObjectType, &[TokenId::Cue]),
        ),
        slot_when(
            SlotId::StoreGroupIdentifier,
            own_is(SlotId::StoreObjectType, &[TokenId::Group]),
        ),
        slot_when(
            SlotId::StoreBlueprintIdentifier,
            ClauseCondition::All(&[
                own_is(SlotId::StoreObjectType, &[TokenId::Blueprint]),
                ClauseCondition::Not(&ClauseCondition::HasAnyChild),
            ]),
        ),
    ],
    // `store fixture` continues straight into the fixture definition.
    frontier: FrontierRules {
        eager_children: &[child_when(ClauseId::StoreFixture, ClauseCondition::Always)],
        ..DEFAULT_FRONTIER
    },
    ..DEFAULT_RULES
};

const STORE_FIXTURE_RULES: &ClauseRules = &ClauseRules {
    children_mode: ChildrenMode::OneOf,
    children: &[
        child_when(
            ClauseId::StoreFixturePayload,
            own_filled(SlotId::StoreFixtureIdentifier),
        ),
        child_when(
            ClauseId::StoreFixtureOffset,
            own_filled(SlotId::StoreFixtureIdentifier),
        ),
    ],
    ..DEFAULT_RULES
};

/// An attribute qualifier keyword (`attr`) cannot follow the attribute list it introduces.
const QUALIFIER_RULES: &ClauseRules = &ClauseRules {
    slots: &[slot_when(
        SlotId::QualifierKeyword,
        ClauseCondition::Not(&own_filled(SlotId::QualifierAttributeList)),
    )],
    ..DEFAULT_RULES
};

const CLEAR_RULES: &ClauseRules = &ClauseRules {
    slots: &[slot_when(
        SlotId::ClearTarget,
        ClauseCondition::Not(&has(ClauseId::ClearAttributes)),
    )],
    ..DEFAULT_RULES
};

const CUE_BLOCK_RULES: &ClauseRules = &ClauseRules {
    // Only `block` (not `unblock`) can overwrite existing tracking.
    slots: &[slot_when(
        SlotId::CueOverwrite,
        own_is(SlotId::CommandHead, &[TokenId::Block]),
    )],
    ..DEFAULT_RULES
};

const RENAME_OBJECTS_RULES: &ClauseRules = &ClauseRules {
    slots: &[
        slot_when(
            SlotId::RenameSource,
            ClauseCondition::Not(&own_filled(SlotId::RenameTarget)),
        ),
        slot_when(SlotId::RenameTarget, own_filled(SlotId::RenameSource)),
    ],
    ..DEFAULT_RULES
};

/// `rm patch` takes source/target endpoints instead of an object identifier.
const RM_IS_PATCH: ClauseCondition = own_is(SlotId::RmObjectType, &[TokenId::Patch]);
const RM_TARGET_STARTED: ClauseCondition = own_filled(SlotId::PatchTargetEndpoint);

const RM_RULES: &ClauseRules = &ClauseRules {
    slots: &[
        slot_when(
            SlotId::RmObjectIdentifier,
            ClauseCondition::Not(&RM_IS_PATCH),
        ),
        slot_when(
            SlotId::PatchSourceEndpoint,
            ClauseCondition::All(&[RM_IS_PATCH, ClauseCondition::Not(&RM_TARGET_STARTED)]),
        ),
        slot_when(
            SlotId::PatchSourceUniverse,
            ClauseCondition::All(&[
                RM_IS_PATCH,
                own_filled(SlotId::PatchSourceEndpoint),
                ClauseCondition::Not(&RM_TARGET_STARTED),
            ]),
        ),
        slot_when(
            SlotId::PatchSourceAddress,
            ClauseCondition::All(&[
                RM_IS_PATCH,
                own_filled(SlotId::PatchSourceEndpoint),
                ClauseCondition::Not(&RM_TARGET_STARTED),
            ]),
        ),
        slot_when(SlotId::PatchTargetEndpoint, RM_IS_PATCH),
        slot_when(
            SlotId::PatchPriority,
            ClauseCondition::All(&[RM_IS_PATCH, RM_TARGET_STARTED]),
        ),
        slot_when(
            SlotId::PatchClone,
            ClauseCondition::All(&[RM_IS_PATCH, RM_TARGET_STARTED]),
        ),
    ],
    ..DEFAULT_RULES
};

const STEP_FX_RULES: &ClauseRules = &ClauseRules {
    // `groups` is only offered between the duration and the first step definition.
    slots: &[
        slot_when(
            SlotId::StepFxGroupsKeyword,
            ClauseCondition::All(&[
                has(ClauseId::StepFxDuration),
                ClauseCondition::Not(&has(ClauseId::StepFxStepDefinition)),
                ClauseCondition::Not(&own_filled(SlotId::StepFxGroupsKeyword)),
            ]),
        ),
        slot_when(
            SlotId::StepFxGroupsValue,
            own_filled(SlotId::StepFxGroupsKeyword),
        ),
    ],
    // `store fx 1 step` must name its selection before anything else.
    frontier: FrontierRules {
        eager_children: &[child_when(
            ClauseId::StepFxSelection,
            own_filled(SlotId::StoreFxAction),
        )],
        ..DEFAULT_FRONTIER
    },
    ..DEFAULT_RULES
};

const STEP_FX_SELECTION_RULES: &ClauseRules = &ClauseRules {
    slots: &[slot_when(
        SlotId::StepFxSelectionTransform,
        own_filled(SlotId::StepFxSelectionIdentifier),
    )],
    ..DEFAULT_RULES
};

/// While a Bezier curve is open, only the shaping slot can take input.
const BEZIER_CLOSED: ClauseCondition =
    ClauseCondition::Not(&ClauseCondition::Hook(ConditionHookId::BezierShapingOpen));

const STEP_FX_STEP_DEFINITION_RULES: &ClauseRules = &ClauseRules {
    slots: &[
        slot_when(SlotId::StepFxStepAttribute, BEZIER_CLOSED),
        slot_when(SlotId::StepFxAttributeBaseline, BEZIER_CLOSED),
        slot_when(SlotId::StepFxStepValues, BEZIER_CLOSED),
    ],
    frontier: FrontierRules {
        blocks_parent_until_entered: true,
        ..DEFAULT_FRONTIER
    },
    ..DEFAULT_RULES
};

/// One child-clause relationship in the static grammar hierarchy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClauseChildSpec {
    pub clause: ClauseId,
    pub cardinality: ClauseCardinality,
}

/// One owned slot relationship in the static grammar hierarchy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClauseSlotSpec {
    pub slot: SlotId,
    pub cardinality: SlotCardinality,
}

/// Declares how a clause can be entered structurally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClauseEntryKind {
    /// A child clause entered by an explicit delimiter or keyword.
    Keyword(&'static [TokenId]),
    RootCommandHead(&'static [TokenId]),
    Structural,
}

/// Declares how many times a child clause may appear structurally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClauseCardinality {
    Required,
    Optional,
    Repeated,
}

/// Declares how many times a slot may appear structurally inside a clause.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotCardinality {
    Required,
    Optional,
    Repeated,
}

/// Declares which semantic hook family owns a clause subtree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClauseHookId {
    Programmer,
    Fx,
    Patch,
    Clip,
    Channel,
    Release,
    Clear,
    Flow,
    Timecode,
    Timeline,
    Rm,
    Rename,
    Store,
    Log,
    Recall,
    Debug,
    Sleep,
    Fps,
    Tempo,
}

const EMPTY_CHILDREN: &[ClauseChildSpec] = &[];
const EMPTY_SLOTS: &[ClauseSlotSpec] = &[];

const PROGRAMMER_HEADS: &[TokenId] = &[
    TokenId::LeftParen,
    TokenId::LeftBrace,
    TokenId::Quote,
    TokenId::Fixture,
    TokenId::Group,
    TokenId::Parameter,
];
const FX_HEADS: &[TokenId] = &[TokenId::Fx];
const PATCH_HEADS: &[TokenId] = &[TokenId::Patch];
const CLIP_HEADS: &[TokenId] = &[TokenId::Clip];
const CHANNEL_HEADS: &[TokenId] = &[TokenId::Channel];
const RELEASE_HEADS: &[TokenId] = &[TokenId::Release];
const CLEAR_HEADS: &[TokenId] = &[TokenId::Clear];
const FLOW_HEADS: &[TokenId] = &[TokenId::Flow];
const TIMECODE_HEADS: &[TokenId] = &[TokenId::Timecode];
const TIMELINE_HEADS: &[TokenId] = &[TokenId::Timeline];
const RM_HEADS: &[TokenId] = &[TokenId::Rm];
const RENAME_HEADS: &[TokenId] = &[TokenId::Rename];
const STORE_HEADS: &[TokenId] = &[TokenId::Store];
const LOG_HEADS: &[TokenId] = &[TokenId::Log];
const RECALL_HEADS: &[TokenId] = &[TokenId::Recall];
const DEBUG_HEADS: &[TokenId] = &[TokenId::Debug];
const SLEEP_HEADS: &[TokenId] = &[TokenId::Sleep];
const FPS_HEADS: &[TokenId] = &[TokenId::Fps];
const TEMPO_HEADS: &[TokenId] = &[TokenId::Tempo];

const PROGRAMMER_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::ProgrammerSelectionSource,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::ProgrammerColorPath,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::ProgrammerSelection,
        cardinality: ClauseCardinality::Required,
    },
    ClauseChildSpec {
        clause: ClauseId::ProgrammerTimings,
        cardinality: ClauseCardinality::Repeated,
    },
    ClauseChildSpec {
        clause: ClauseId::ProgrammerAttributeActions,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::ProgrammerPlacement3d,
        cardinality: ClauseCardinality::Optional,
    },
];
const PROGRAMMER_SELECTION_CHILDREN: &[ClauseChildSpec] = &[ClauseChildSpec {
    clause: ClauseId::ProgrammerSelectionIdentifier,
    cardinality: ClauseCardinality::Optional,
}];
const PROGRAMMER_SELECTION_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::SelectionType,
    cardinality: SlotCardinality::Required,
}];
const PROGRAMMER_SELECTION_IDENTIFIER_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::SelectionIdentifier,
    cardinality: SlotCardinality::Required,
}];
const PROGRAMMER_ATTRIBUTE_ACTIONS_CHILDREN: &[ClauseChildSpec] = &[ClauseChildSpec {
    clause: ClauseId::ProgrammerSetAttributeItem,
    cardinality: ClauseCardinality::Repeated,
}];
const PROGRAMMER_SET_ATTR_ITEM_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::SetAttrAttribute,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::SetAttrValue,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::BlueprintResolution,
        cardinality: SlotCardinality::Optional,
    },
];
const PROGRAMMER_TIMINGS_CHILDREN: &[ClauseChildSpec] = &[ClauseChildSpec {
    clause: ClauseId::ProgrammerTimingOverride,
    cardinality: ClauseCardinality::Repeated,
}];
const PROGRAMMER_TIMINGS_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::TimingsKeyword,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::TimingsDirection,
        cardinality: SlotCardinality::Repeated,
    },
    ClauseSlotSpec {
        slot: SlotId::TimingsGlobalDuration,
        cardinality: SlotCardinality::Repeated,
    },
];
const PROGRAMMER_TIMING_OVERRIDE_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::TimingsOverrideAttribute,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::TimingsOverrideDuration,
        cardinality: SlotCardinality::Required,
    },
];
const PROGRAMMER_PLACEMENT_3D_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::PlacementAction,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::PlacementAxisValue,
        cardinality: SlotCardinality::Repeated,
    },
];

const FX_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::FxModule,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::FxIdentifier,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::FxAction,
        cardinality: ClauseCardinality::Optional,
    },
];
const FX_IDENTIFIER_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::FxIdentifier,
    cardinality: SlotCardinality::Required,
}];
const FX_ACTION_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::FxAction,
    cardinality: SlotCardinality::Required,
}];
const STEP_FX_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::StepFxSelection,
        cardinality: ClauseCardinality::Required,
    },
    ClauseChildSpec {
        clause: ClauseId::StepFxDuration,
        cardinality: ClauseCardinality::Required,
    },
    ClauseChildSpec {
        clause: ClauseId::StepFxStepDefinition,
        cardinality: ClauseCardinality::Repeated,
    },
];
const STORE_STEP_FX_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::StoreFxAction,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::StepFxGroupsKeyword,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::StepFxGroupsValue,
        cardinality: SlotCardinality::Required,
    },
];
const STORE_FX_MODULE_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::StoreFxModulePayload,
    cardinality: SlotCardinality::Repeated,
}];
const STEP_FX_SELECTION_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::StepFxSelectionHead,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::StepFxSelectionIdentifier,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::StepFxSelectionTransform,
        cardinality: SlotCardinality::Repeated,
    },
];
const STEP_FX_DURATION_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::StepFxDuration,
    cardinality: SlotCardinality::Required,
}];
const STEP_FX_STEP_DEFINITION_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::StepFxStepAttribute,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::StepFxAttributeBaseline,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::StepFxStepValues,
        cardinality: SlotCardinality::Repeated,
    },
    ClauseSlotSpec {
        slot: SlotId::StepFxAttributeShaping,
        cardinality: SlotCardinality::Repeated,
    },
];

const PATCH_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::PatchPriority,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchClone,
        cardinality: SlotCardinality::Optional,
    },
];

const PATCH_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::PatchSource,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::PatchTarget,
        cardinality: ClauseCardinality::Optional,
    },
];
const PATCH_SOURCE_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::PatchSourceEndpoint,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchSourceUniverse,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchSourceAddress,
        cardinality: SlotCardinality::Optional,
    },
];
const PATCH_TARGET_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::PatchTargetEndpoint,
    cardinality: SlotCardinality::Required,
}];

const CLIP_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::ClipIdentifier,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::ClipAction,
        cardinality: ClauseCardinality::Optional,
    },
];
const CLIP_IDENTIFIER_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::ClipIdentifier,
    cardinality: SlotCardinality::Required,
}];
const CLIP_ACTION_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::ClipAction,
    cardinality: SlotCardinality::Required,
}];

const CHANNEL_OVERRIDE_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::ChannelOverrideIdentifier,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::ChannelOverrideValue,
        cardinality: SlotCardinality::Required,
    },
];

const RELEASE_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::ReleaseStaleInputs,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::ReleaseChannel,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::ReleaseAttributes,
        cardinality: ClauseCardinality::Optional,
    },
];
const RELEASE_CHANNEL_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::ReleaseChannelExpr,
    cardinality: SlotCardinality::Required,
}];
const RELEASE_ATTRIBUTES_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::QualifierKeyword,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::QualifierAttributeList,
        cardinality: SlotCardinality::Repeated,
    },
];

const CLEAR_CHILDREN: &[ClauseChildSpec] = &[ClauseChildSpec {
    clause: ClauseId::ClearAttributes,
    cardinality: ClauseCardinality::Optional,
}];
const CLEAR_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::ClearTarget,
    cardinality: SlotCardinality::Repeated,
}];
const CLEAR_ATTRIBUTES_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::QualifierKeyword,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::QualifierAttributeList,
        cardinality: SlotCardinality::Repeated,
    },
];

const FLOW_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::FlowIdentifier,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::FlowAction,
        cardinality: ClauseCardinality::Optional,
    },
];
const FLOW_IDENTIFIER_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::FlowIdentifier,
    cardinality: SlotCardinality::Required,
}];
const FLOW_ACTION_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::FlowAction,
    cardinality: SlotCardinality::Required,
}];

const TIMECODE_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::TimecodeIdentifier,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::TimecodeAction,
        cardinality: ClauseCardinality::Optional,
    },
];
const TIMECODE_IDENTIFIER_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::TimecodeIdentifier,
    cardinality: SlotCardinality::Required,
}];
const TIMECODE_ACTION_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::TimecodeAction,
    cardinality: SlotCardinality::Required,
}];

const TIMELINE_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::TimelineIdentifier,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::TimelineAction,
        cardinality: ClauseCardinality::Optional,
    },
];
const TIMELINE_IDENTIFIER_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::TimelineIdentifier,
    cardinality: SlotCardinality::Required,
}];
const TIMELINE_ACTION_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::TimelineAction,
    cardinality: SlotCardinality::Required,
}];

const RM_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::RmObjectType,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::RmObjectIdentifier,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchSourceEndpoint,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchSourceUniverse,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchSourceAddress,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchTargetEndpoint,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchPriority,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::PatchClone,
        cardinality: SlotCardinality::Optional,
    },
];

const RENAME_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::RenameObjectType,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::RenameSource,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::RenameTarget,
        cardinality: SlotCardinality::Required,
    },
];

const STORE_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::StoreColorPath,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::StoreBlueprint,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::StoreFixture,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::StepFx,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::StoreFxModule,
        cardinality: ClauseCardinality::Optional,
    },
];
const STORE_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::StoreObjectType,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreObjectIdentifier,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreObjectPayload,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreCueRef,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreMode,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreGroupIdentifier,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreBlueprintIdentifier,
        cardinality: SlotCardinality::Optional,
    },
];
const STORE_BLUEPRINT_CHILDREN: &[ClauseChildSpec] = &[ClauseChildSpec {
    clause: ClauseId::StoreBlueprintFilter,
    cardinality: ClauseCardinality::Optional,
}];
const STORE_BLUEPRINT_SLOTS: &[ClauseSlotSpec] = EMPTY_SLOTS;
const STORE_BLUEPRINT_FILTER_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::QualifierKeyword,
        cardinality: SlotCardinality::Optional,
    },
    ClauseSlotSpec {
        slot: SlotId::QualifierAttributeList,
        cardinality: SlotCardinality::Repeated,
    },
];
const STORE_FIXTURE_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::StoreFixtureOffset,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::StoreFixturePayload,
        cardinality: ClauseCardinality::Optional,
    },
];
const STORE_FIXTURE_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::StoreFixtureIdentifier,
    cardinality: SlotCardinality::Required,
}];
const STORE_FIXTURE_PAYLOAD_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::StoreFixtureMake,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreFixtureModel,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreFixtureMode,
        cardinality: SlotCardinality::Required,
    },
];
const STORE_FIXTURE_OFFSET_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::StoreFixtureOffsetKeyword,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreFixtureOffsetAttribute,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::StoreFixtureOffsetValue,
        cardinality: SlotCardinality::Repeated,
    },
];

const LOG_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::LogLevel,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::LogFilter,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::LogFixture,
        cardinality: ClauseCardinality::Optional,
    },
];
const LOG_LEVEL_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::LogLevel,
    cardinality: SlotCardinality::Repeated,
}];
const LOG_FILTER_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::LogFilterField,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::LogFilterValue,
        cardinality: SlotCardinality::Repeated,
    },
];
const LOG_FIXTURE_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::LogFixtureIdentifier,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::LogFixtureAttribute,
        cardinality: SlotCardinality::Optional,
    },
];

const RECALL_CHILDREN: &[ClauseChildSpec] = &[
    ClauseChildSpec {
        clause: ClauseId::RecallCue,
        cardinality: ClauseCardinality::Optional,
    },
    ClauseChildSpec {
        clause: ClauseId::RecallBlueprint,
        cardinality: ClauseCardinality::Optional,
    },
];
const RECALL_CUE_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::RecallCueRef,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::RecallSelectFlag,
        cardinality: SlotCardinality::Optional,
    },
];
const RECALL_BLUEPRINT_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::RecallBlueprintKeyword,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::RecallBlueprintIdentifier,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::RecallBlueprintResolution,
        cardinality: SlotCardinality::Optional,
    },
];
const DEBUG_SLOTS: &[ClauseSlotSpec] = &[
    ClauseSlotSpec {
        slot: SlotId::DebugObjectType,
        cardinality: SlotCardinality::Required,
    },
    ClauseSlotSpec {
        slot: SlotId::DebugObjectIdentifier,
        cardinality: SlotCardinality::Required,
    },
];
const SLEEP_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::SleepDuration,
    cardinality: SlotCardinality::Required,
}];
const FPS_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::FpsValue,
    cardinality: SlotCardinality::Required,
}];
const TEMPO_SLOTS: &[ClauseSlotSpec] = &[ClauseSlotSpec {
    slot: SlotId::TempoAction,
    cardinality: SlotCardinality::Required,
}];

const ROOT_CLAUSES: &[ClauseId] = &[
    ClauseId::ObjectProperty,
    ClauseId::CueColorPath,
    ClauseId::CopyColorPath,
    ClauseId::CueBlock,
    ClauseId::Utility,
    ClauseId::Showfile,
    ClauseId::NewShowfile,
    ClauseId::Programmer,
    ClauseId::Fx,
    ClauseId::Patch,
    ClauseId::Clip,
    ClauseId::ChannelOverride,
    ClauseId::Release,
    ClauseId::Clear,
    ClauseId::Flow,
    ClauseId::Timecode,
    ClauseId::Timeline,
    ClauseId::Rm,
    ClauseId::Rename,
    ClauseId::Store,
    ClauseId::Log,
    ClauseId::Recall,
    ClauseId::Debug,
    ClauseId::Sleep,
    ClauseId::Fps,
    ClauseId::Tempo,
];

const CLAUSE_SCHEMAS: &[ClauseSchema] = &[
    ClauseSchema {
        id: ClauseId::RenameObjects,
        label: "Objects",
        parent: Some(ClauseId::Rename),
        children: &[],
        slots: RENAME_SLOTS,
        rules: RENAME_OBJECTS_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::RenameCompactPaths,
        label: "Color paths",
        parent: Some(ClauseId::Rename),
        children: &[],
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::CompactPathSource,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::CompactPathTarget,
                cardinality: SlotCardinality::Required,
            },
        ],
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ProgrammerSelectionSource,
        label: "Selection",
        parent: Some(ClauseId::Programmer),
        children: &[],
        slots: &[ClauseSlotSpec {
            slot: SlotId::SelectionSource,
            cardinality: SlotCardinality::Required,
        }],
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ObjectProperty,
        label: "Object property",
        parent: None,
        children: &[],
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::PropertyObjectType,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::PropertyObjectIdentifier,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::PropertyKeyword,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::PropertyEquals,
                cardinality: SlotCardinality::Optional,
            },
            ClauseSlotSpec {
                slot: SlotId::PropertyTargetType,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::PropertyTargetIdentifier,
                cardinality: SlotCardinality::Required,
            },
        ],
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(&[TokenId::Set]),
    },
    ClauseSchema {
        id: ClauseId::Programmer,
        label: "Programmer",
        parent: None,
        children: PROGRAMMER_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: PROGRAMMER_RULES,
        entry: ClauseEntryKind::RootCommandHead(PROGRAMMER_HEADS),
    },
    ClauseSchema {
        id: ClauseId::ProgrammerSelection,
        label: "Selection",
        parent: Some(ClauseId::Programmer),
        children: PROGRAMMER_SELECTION_CHILDREN,
        slots: PROGRAMMER_SELECTION_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ProgrammerSelectionIdentifier,
        label: "Identifier",
        parent: Some(ClauseId::ProgrammerSelection),
        children: EMPTY_CHILDREN,
        slots: PROGRAMMER_SELECTION_IDENTIFIER_SLOTS,
        rules: BLOCKS_PARENT_UNTIL_ENTERED,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ProgrammerAttributeActions,
        label: "Attributes",
        parent: Some(ClauseId::Programmer),
        children: PROGRAMMER_ATTRIBUTE_ACTIONS_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ProgrammerSetAttributeItem,
        label: "Set Attribute",
        parent: Some(ClauseId::ProgrammerAttributeActions),
        children: EMPTY_CHILDREN,
        slots: PROGRAMMER_SET_ATTR_ITEM_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ProgrammerTimings,
        label: "Timing",
        parent: Some(ClauseId::Programmer),
        children: PROGRAMMER_TIMINGS_CHILDREN,
        slots: PROGRAMMER_TIMINGS_SLOTS,
        rules: PROGRAMMER_TIMINGS_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ProgrammerTimingOverride,
        label: "Override",
        parent: Some(ClauseId::ProgrammerTimings),
        children: EMPTY_CHILDREN,
        slots: PROGRAMMER_TIMING_OVERRIDE_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ProgrammerPlacement3d,
        label: "3D placement",
        parent: Some(ClauseId::Programmer),
        children: EMPTY_CHILDREN,
        slots: PROGRAMMER_PLACEMENT_3D_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Keyword(&[TokenId::ThreeD]),
    },
    ClauseSchema {
        id: ClauseId::Fx,
        label: "FX",
        parent: None,
        children: FX_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: FX_RULES,
        entry: ClauseEntryKind::RootCommandHead(FX_HEADS),
    },
    ClauseSchema {
        id: ClauseId::FxIdentifier,
        label: "Identifier",
        parent: Some(ClauseId::Fx),
        children: EMPTY_CHILDREN,
        slots: FX_IDENTIFIER_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::FxAction,
        label: "Action",
        parent: Some(ClauseId::Fx),
        children: EMPTY_CHILDREN,
        slots: FX_ACTION_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StepFx,
        label: "Step",
        parent: Some(ClauseId::Store),
        children: STEP_FX_CHILDREN,
        slots: STORE_STEP_FX_SLOTS,
        rules: STEP_FX_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StepFxSelection,
        label: "Selection",
        parent: Some(ClauseId::StepFx),
        children: EMPTY_CHILDREN,
        slots: STEP_FX_SELECTION_SLOTS,
        rules: STEP_FX_SELECTION_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StepFxDuration,
        label: "Duration",
        parent: Some(ClauseId::StepFx),
        children: EMPTY_CHILDREN,
        slots: STEP_FX_DURATION_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StepFxStepDefinition,
        label: "Attribute Step",
        parent: Some(ClauseId::StepFx),
        children: EMPTY_CHILDREN,
        slots: STEP_FX_STEP_DEFINITION_SLOTS,
        rules: STEP_FX_STEP_DEFINITION_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Patch,
        label: "Patch",
        parent: None,
        children: PATCH_CHILDREN,
        slots: PATCH_SLOTS,
        rules: PATCH_RULES,
        entry: ClauseEntryKind::RootCommandHead(PATCH_HEADS),
    },
    ClauseSchema {
        id: ClauseId::PatchSource,
        label: "Source",
        parent: Some(ClauseId::Patch),
        children: EMPTY_CHILDREN,
        slots: PATCH_SOURCE_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::PatchTarget,
        label: "Target",
        parent: Some(ClauseId::Patch),
        children: EMPTY_CHILDREN,
        slots: PATCH_TARGET_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Clip,
        label: "Clip",
        parent: None,
        children: CLIP_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(CLIP_HEADS),
    },
    ClauseSchema {
        id: ClauseId::ClipIdentifier,
        label: "Identifier",
        parent: Some(ClauseId::Clip),
        children: EMPTY_CHILDREN,
        slots: CLIP_IDENTIFIER_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ClipAction,
        label: "Action",
        parent: Some(ClauseId::Clip),
        children: EMPTY_CHILDREN,
        slots: CLIP_ACTION_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ChannelOverride,
        label: "Channel Override",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: CHANNEL_OVERRIDE_SLOTS,
        rules: CHANNEL_OVERRIDE_RULES,
        entry: ClauseEntryKind::RootCommandHead(CHANNEL_HEADS),
    },
    ClauseSchema {
        id: ClauseId::Release,
        label: "Release",
        parent: None,
        children: RELEASE_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: RELEASE_RULES,
        entry: ClauseEntryKind::RootCommandHead(RELEASE_HEADS),
    },
    ClauseSchema {
        id: ClauseId::ReleaseChannel,
        label: "Channel",
        parent: Some(ClauseId::Release),
        children: EMPTY_CHILDREN,
        slots: RELEASE_CHANNEL_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ReleaseAttributes,
        label: "Attributes",
        parent: Some(ClauseId::Release),
        children: EMPTY_CHILDREN,
        slots: RELEASE_ATTRIBUTES_SLOTS,
        rules: QUALIFIER_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Clear,
        label: "Clear",
        parent: None,
        children: CLEAR_CHILDREN,
        slots: CLEAR_SLOTS,
        rules: CLEAR_RULES,
        entry: ClauseEntryKind::RootCommandHead(CLEAR_HEADS),
    },
    ClauseSchema {
        id: ClauseId::ClearAttributes,
        label: "Attributes",
        parent: Some(ClauseId::Clear),
        children: EMPTY_CHILDREN,
        slots: CLEAR_ATTRIBUTES_SLOTS,
        rules: QUALIFIER_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Flow,
        label: "Flow",
        parent: None,
        children: FLOW_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(FLOW_HEADS),
    },
    ClauseSchema {
        id: ClauseId::FlowIdentifier,
        label: "Identifier",
        parent: Some(ClauseId::Flow),
        children: EMPTY_CHILDREN,
        slots: FLOW_IDENTIFIER_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::FlowAction,
        label: "Action",
        parent: Some(ClauseId::Flow),
        children: EMPTY_CHILDREN,
        slots: FLOW_ACTION_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Timecode,
        label: "Timecode",
        parent: None,
        children: TIMECODE_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(TIMECODE_HEADS),
    },
    ClauseSchema {
        id: ClauseId::TimecodeIdentifier,
        label: "Identifier",
        parent: Some(ClauseId::Timecode),
        children: EMPTY_CHILDREN,
        slots: TIMECODE_IDENTIFIER_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::TimecodeAction,
        label: "Action",
        parent: Some(ClauseId::Timecode),
        children: EMPTY_CHILDREN,
        slots: TIMECODE_ACTION_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Timeline,
        label: "Timeline",
        parent: None,
        children: TIMELINE_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(TIMELINE_HEADS),
    },
    ClauseSchema {
        id: ClauseId::TimelineIdentifier,
        label: "Identifier",
        parent: Some(ClauseId::Timeline),
        children: EMPTY_CHILDREN,
        slots: TIMELINE_IDENTIFIER_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::TimelineAction,
        label: "Action",
        parent: Some(ClauseId::Timeline),
        children: EMPTY_CHILDREN,
        slots: TIMELINE_ACTION_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Rm,
        label: "Remove",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: RM_SLOTS,
        rules: RM_RULES,
        entry: ClauseEntryKind::RootCommandHead(RM_HEADS),
    },
    ClauseSchema {
        id: ClauseId::Rename,
        label: "Rename",
        parent: None,
        children: &[
            ClauseChildSpec {
                clause: ClauseId::RenameObjects,
                cardinality: ClauseCardinality::Optional,
            },
            ClauseChildSpec {
                clause: ClauseId::RenameCompactPaths,
                cardinality: ClauseCardinality::Optional,
            },
        ],
        slots: &[],
        rules: ONE_OF_CHILDREN,
        entry: ClauseEntryKind::RootCommandHead(RENAME_HEADS),
    },
    ClauseSchema {
        id: ClauseId::Store,
        label: "Store",
        parent: None,
        children: STORE_CHILDREN,
        slots: STORE_SLOTS,
        rules: STORE_RULES,
        entry: ClauseEntryKind::RootCommandHead(STORE_HEADS),
    },
    ClauseSchema {
        id: ClauseId::StoreBlueprint,
        label: "Blueprint",
        parent: Some(ClauseId::Store),
        children: STORE_BLUEPRINT_CHILDREN,
        slots: STORE_BLUEPRINT_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StoreBlueprintFilter,
        label: "Filter",
        parent: Some(ClauseId::StoreBlueprint),
        children: EMPTY_CHILDREN,
        slots: STORE_BLUEPRINT_FILTER_SLOTS,
        rules: QUALIFIER_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StoreFixture,
        label: "Fixture",
        parent: Some(ClauseId::Store),
        children: STORE_FIXTURE_CHILDREN,
        slots: STORE_FIXTURE_SLOTS,
        rules: STORE_FIXTURE_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StoreFixturePayload,
        label: "FixturePayload",
        parent: Some(ClauseId::StoreFixture),
        children: EMPTY_CHILDREN,
        slots: STORE_FIXTURE_PAYLOAD_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StoreFixtureOffset,
        label: "FixtureOffset",
        parent: Some(ClauseId::StoreFixture),
        children: EMPTY_CHILDREN,
        slots: STORE_FIXTURE_OFFSET_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Log,
        label: "Log",
        parent: None,
        children: LOG_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: ONE_OF_CHILDREN,
        entry: ClauseEntryKind::RootCommandHead(LOG_HEADS),
    },
    ClauseSchema {
        id: ClauseId::LogLevel,
        label: "Level",
        parent: Some(ClauseId::Log),
        children: EMPTY_CHILDREN,
        slots: LOG_LEVEL_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::LogFilter,
        label: "Filter",
        parent: Some(ClauseId::Log),
        children: EMPTY_CHILDREN,
        slots: LOG_FILTER_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::LogFixture,
        label: "Fixture",
        parent: Some(ClauseId::Log),
        children: EMPTY_CHILDREN,
        slots: LOG_FIXTURE_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Recall,
        label: "Recall",
        parent: None,
        children: RECALL_CHILDREN,
        slots: EMPTY_SLOTS,
        rules: ONE_OF_CHILDREN,
        entry: ClauseEntryKind::RootCommandHead(RECALL_HEADS),
    },
    ClauseSchema {
        id: ClauseId::RecallCue,
        label: "Cue",
        parent: Some(ClauseId::Recall),
        children: EMPTY_CHILDREN,
        slots: RECALL_CUE_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::RecallBlueprint,
        label: "Blueprint",
        parent: Some(ClauseId::Recall),
        children: EMPTY_CHILDREN,
        slots: RECALL_BLUEPRINT_SLOTS,
        rules: PROJECT_INITIAL_SLOT,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Debug,
        label: "Debug",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: DEBUG_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(DEBUG_HEADS),
    },
    ClauseSchema {
        id: ClauseId::Sleep,
        label: "Sleep",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: SLEEP_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(SLEEP_HEADS),
    },
    ClauseSchema {
        id: ClauseId::Fps,
        label: "FPS",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: FPS_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(FPS_HEADS),
    },
    ClauseSchema {
        id: ClauseId::Tempo,
        label: "Tempo",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: TEMPO_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(TEMPO_HEADS),
    },
    ClauseSchema {
        id: ClauseId::StoreFxModule,
        label: "FX Module",
        parent: Some(ClauseId::Store),
        children: EMPTY_CHILDREN,
        slots: STORE_FX_MODULE_SLOTS,
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::FxModule,
        label: "Module",
        parent: Some(ClauseId::Fx),
        children: EMPTY_CHILDREN,
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::FxModuleKeyword,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::FxModuleIdentifier,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::FxModuleAction,
                cardinality: SlotCardinality::Required,
            },
        ],
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::Utility,
        label: "Command",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: &[],
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(&[
            TokenId::Help,
            TokenId::Quit,
            TokenId::Undo,
            TokenId::Redo,
        ]),
    },
    ClauseSchema {
        id: ClauseId::Showfile,
        label: "Showfile",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: &[ClauseSlotSpec {
            slot: SlotId::ShowfileName,
            cardinality: SlotCardinality::Repeated,
        }],
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(&[TokenId::Save, TokenId::Load]),
    },
    ClauseSchema {
        id: ClauseId::NewShowfile,
        label: "New showfile",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: &[ClauseSlotSpec {
            slot: SlotId::NewShowfileType,
            cardinality: SlotCardinality::Required,
        }],
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(&[TokenId::New]),
    },
    ClauseSchema {
        id: ClauseId::CueBlock,
        label: "Cue tracking",
        parent: None,
        children: EMPTY_CHILDREN,
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::RecallCueRef,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::CueOverwrite,
                cardinality: SlotCardinality::Optional,
            },
        ],
        rules: CUE_BLOCK_RULES,
        entry: ClauseEntryKind::RootCommandHead(&[TokenId::Block, TokenId::Unblock]),
    },
    ClauseSchema {
        id: ClauseId::ReleaseStaleInputs,
        label: "Stale inputs",
        parent: Some(ClauseId::Release),
        children: EMPTY_CHILDREN,
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::ReleaseStaleKeyword,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::ReleaseStaleSeparator,
                cardinality: SlotCardinality::Optional,
            },
            ClauseSlotSpec {
                slot: SlotId::ReleaseInputsKeyword,
                cardinality: SlotCardinality::Required,
            },
        ],
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::StoreColorPath,
        label: "Color path",
        parent: Some(ClauseId::Store),
        children: &[ClauseChildSpec {
            clause: ClauseId::ColorPathLabel,
            cardinality: ClauseCardinality::Optional,
        }],
        slots: &[ClauseSlotSpec {
            slot: SlotId::PathIdentifier,
            cardinality: SlotCardinality::Required,
        }],
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ColorPathLabel,
        label: "Label",
        parent: Some(ClauseId::StoreColorPath),
        children: &[],
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::LabelKeyword,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::LabelText,
                cardinality: SlotCardinality::Required,
            },
        ],
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::ProgrammerColorPath,
        label: "Color path",
        parent: Some(ClauseId::Programmer),
        children: &[],
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::PathKeyword,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::PathValue,
                cardinality: SlotCardinality::Required,
            },
        ],
        rules: NO_RULES,
        entry: ClauseEntryKind::Structural,
    },
    ClauseSchema {
        id: ClauseId::CueColorPath,
        label: "Cue color path",
        parent: None,
        children: &[],
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::StoreCueRef,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::PathKeyword,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::PathValue,
                cardinality: SlotCardinality::Required,
            },
        ],
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(&[TokenId::Cue]),
    },
    ClauseSchema {
        id: ClauseId::CopyColorPath,
        label: "Copy color path",
        parent: None,
        children: &[],
        slots: &[
            ClauseSlotSpec {
                slot: SlotId::PathKeyword,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::RenameSource,
                cardinality: SlotCardinality::Required,
            },
            ClauseSlotSpec {
                slot: SlotId::RenameTarget,
                cardinality: SlotCardinality::Required,
            },
        ],
        rules: NO_RULES,
        entry: ClauseEntryKind::RootCommandHead(&[TokenId::Copy]),
    },
];

const COMMAND_GRAMMAR: CommandGrammar = CommandGrammar {
    roots: ROOT_CLAUSES,
    clauses: CLAUSE_SCHEMAS,
};

/// Returns the authoritative static clause grammar.
pub const fn command_grammar() -> &'static CommandGrammar {
    &COMMAND_GRAMMAR
}

/// Returns the static grammar schema for one clause id.
pub const fn clause_schema(clause: ClauseId) -> &'static ClauseSchema {
    let mut index = 0;
    while index < CLAUSE_SCHEMAS.len() {
        if CLAUSE_SCHEMAS[index].id as usize == clause as usize {
            return &CLAUSE_SCHEMAS[index];
        }
        index += 1;
    }
    panic!("clause missing from command grammar")
}

/// Returns the authoritative parent clause from the static grammar.
pub const fn clause_parent(clause: ClauseId) -> Option<ClauseId> {
    clause_schema(clause).parent
}

/// Returns the static child-clause definitions for a clause.
pub const fn clause_children(clause: ClauseId) -> &'static [ClauseChildSpec] {
    clause_schema(clause).children
}

/// Returns the static slot definitions owned by a clause.
pub const fn clause_slots(clause: ClauseId) -> &'static [ClauseSlotSpec] {
    clause_schema(clause).slots
}

/// Returns the conditional availability rules for a clause's children and slots.
pub const fn clause_rules(clause: ClauseId) -> &'static ClauseRules {
    clause_schema(clause).rules
}

/// Returns the semantic hook family responsible for a clause subtree.
pub fn clause_hook_id(clause: ClauseId) -> Option<ClauseHookId> {
    let mut root = clause;
    while let Some(parent) = clause_parent(root) {
        root = parent;
    }

    Some(match root {
        ClauseId::Programmer => ClauseHookId::Programmer,
        ClauseId::Fx => ClauseHookId::Fx,
        ClauseId::Patch => ClauseHookId::Patch,
        ClauseId::Clip => ClauseHookId::Clip,
        ClauseId::ChannelOverride => ClauseHookId::Channel,
        ClauseId::Release | ClauseId::ReleaseChannel | ClauseId::ReleaseAttributes => {
            ClauseHookId::Release
        }
        ClauseId::Clear => ClauseHookId::Clear,
        ClauseId::Flow => ClauseHookId::Flow,
        ClauseId::Timecode => ClauseHookId::Timecode,
        ClauseId::Timeline => ClauseHookId::Timeline,
        ClauseId::Rm => ClauseHookId::Rm,
        ClauseId::Rename => ClauseHookId::Rename,
        ClauseId::Store => ClauseHookId::Store,
        ClauseId::Log => ClauseHookId::Log,
        ClauseId::Recall => ClauseHookId::Recall,
        ClauseId::Debug => ClauseHookId::Debug,
        ClauseId::Sleep => ClauseHookId::Sleep,
        ClauseId::Fps => ClauseHookId::Fps,
        ClauseId::Tempo => ClauseHookId::Tempo,
        _ => return None,
    })
}

/// Returns the user-facing display label for a clause.
pub const fn clause_display_label(clause: ClauseId) -> &'static str {
    clause_schema(clause).label
}

/// Returns the trace-tree label for a clause.
pub fn clause_trace_label(clause: ClauseId) -> String {
    if clause_parent(clause).is_none() {
        return match clause {
            ClauseId::Programmer => "ProgrammerCommand".to_owned(),
            ClauseId::Fx => "FxCommand".to_owned(),
            ClauseId::Patch => "PatchCommand".to_owned(),
            ClauseId::Clip => "ClipCommand".to_owned(),
            ClauseId::Flow => "FlowCommand".to_owned(),
            ClauseId::Timecode => "TimecodeCommand".to_owned(),
            ClauseId::Timeline => "TimelineCommand".to_owned(),
            ClauseId::Clear => "ClearCommand".to_owned(),
            ClauseId::Release => "ReleaseCommand".to_owned(),
            ClauseId::Rm => "RmCommand".to_owned(),
            ClauseId::Store => "StoreCommand".to_owned(),
            ClauseId::Rename => "RenameCommand".to_owned(),
            ClauseId::Log => "LogCommand".to_owned(),
            ClauseId::Recall => "RecallCommand".to_owned(),
            ClauseId::Debug => "DebugCommand".to_owned(),
            ClauseId::Sleep => "SleepCommand".to_owned(),
            ClauseId::Fps => "FpsCommand".to_owned(),
            ClauseId::Tempo => "TempoCommand".to_owned(),
            _ => format!("{clause:?}Command"),
        };
    }
    format!("{clause:?}Clause")
}

/// Returns the root clause entered by an exact top-level command head token.
pub fn root_clause_for_command_head(head: TokenId) -> Option<ClauseId> {
    command_grammar()
        .roots
        .iter()
        .copied()
        .find(|clause| match clause_schema(*clause).entry {
            ClauseEntryKind::RootCommandHead(tokens) => tokens.contains(&head),
            ClauseEntryKind::Structural | ClauseEntryKind::Keyword(_) => false,
        })
}

/// Returns a representative head token for a root clause.
pub fn command_head_token_for_root_clause(clause: ClauseId) -> Option<TokenId> {
    match clause_schema(clause).entry {
        ClauseEntryKind::RootCommandHead(tokens) => tokens.first().copied(),
        ClauseEntryKind::Structural | ClauseEntryKind::Keyword(_) => None,
    }
}

/// Returns the owning clause for a slot under a specific command head, if any.
pub fn clause_for_command_slot(slot: SlotId, head: TokenId) -> Option<ClauseId> {
    fn find_owner(slot: SlotId, clause: ClauseId) -> Option<ClauseId> {
        if clause_slots(clause).iter().any(|spec| spec.slot == slot) {
            return Some(clause);
        }
        for child in clause_children(clause) {
            if let Some(owner) = find_owner(slot, child.clause) {
                return Some(owner);
            }
        }
        None
    }

    let root = root_clause_for_command_head(head)?;
    find_owner(slot, root)
}
