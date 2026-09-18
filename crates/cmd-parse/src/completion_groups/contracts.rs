// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Completion group catalog contracts.

use serde::{Deserialize, Serialize};

use crate::parser::analysis::GrammarRuleId;
use crate::slots::contracts::{ClauseId, SlotId};

macro_rules! completion_group_ids {
    ($( $(#[$meta:meta])* $variant:ident => $id:literal, )+ ) => {
        /// Stable identifier for a UI completion group.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        pub enum CompletionGroupId {
            $(
                #[serde(rename = $id)]
                $(#[$meta])*
                $variant,
            )+
        }

        impl CompletionGroupId {
            /// Returns the stable serialized identifier for this completion group.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $id,)+
                }
            }
        }
    };
}

completion_group_ids! {
    Command => "command",
    ProgrammerSelection => "programmer/selection",
    ProgrammerSelectionIdentifier => "programmer/selection/identifier",
    ProgrammerSetAttribute => "programmer/set_attribute",
    ProgrammerIntensity => "programmer/intensity",
    ProgrammerTimings => "programmer/timings",
    ProgrammerPlacement3d => "programmer/3d_placement",
    FxIdentifier => "fx/identifier",
    /// Completion group for FX action keywords such as `start`, `stop`, and `rate`.
    FxAction => "fx/action",
    StepFx => "fx/step",
    StepFxSelection => "fx/step/selection",
    StepFxDuration => "fx/step/duration",
    StepFxAttribute => "fx/step/attribute",
    StepFxAttributeBaseline => "fx/step/attribute/initial_value",
    StepFxValues => "fx/step/values",
    StepFxShaping => "fx/step/shaping",
    PatchSource => "patch/source",
    PatchDmxAddress => "patch/dmx_address",
    PatchTarget => "patch/target",
    ClipIdentifier => "clip/identifier",
    ClipAction => "clip/action",
    Clear => "clear",
    ClearAttributes => "clear/attributes",
    ChannelOverrideIdentifier => "channel_override/identifier",
    ChannelOverrideValue => "channel_override/value",
    ReleaseAttributes => "release/attributes",
    ReleaseChannel => "release/channel",
    RmObjectType => "rm/object_type",
    RmObjectIdentifier => "rm/object_identifier",
    StoreObjectType => "store/object_type",
    StoreObjectIdentifier => "store/object_identifier",
    StoreCueRef => "store/cue_ref",
    StoreGroupIdentifier => "store/group_identifier",
    StoreBlueprint => "store/blueprint",
    StoreBlueprintFilter => "store/blueprint/filter",
    Rename => "rename",
    RenameObjectType => "rename/object_type",
    FlowIdentifier => "flow/identifier",
    FlowAction => "flow/action",
    TimecodeIdentifier => "timecode/identifier",
    TimecodeAction => "timecode/action",
    TimelineIdentifier => "timeline/identifier",
    TimelineAction => "timeline/action",
    LogLevel => "log/level",
    LogFilter => "log/filter",
    LogFixture => "log/fixture",
    RecallCueRef => "recall/cue_ref",
    DebugObject => "debug/object",
    SleepDuration => "sleep/duration",
    FpsValue => "fps/value",
}

/// Declarative definition of one completion group surfaced by the planner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionGroupSpec {
    /// Stable identifier for the group.
    pub id: CompletionGroupId,
    /// UI label shown for the group.
    pub label: &'static str,
    /// Parser-frontier predicates that activate the group.
    pub frontier_predicates: Vec<FrontierPredicate>,
    /// Additional slot-based visibility requirements.
    pub activation: CompletionGroupVisibilitySpec,
    /// Relative sort priority among visible groups.
    pub priority: u16,
    /// Slots associated with this group's UI intent.
    pub slots: Vec<SlotId>,
}

/// One parser-frontier predicate that can activate a completion group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrontierPredicate {
    /// Required clause-path prefix for the expectation.
    pub clause_path_prefix: &'static [ClauseId],
    /// Required slot target, when activation is slot-specific.
    pub slot: Option<SlotId>,
    /// Required grammar rule, when activation is rule-specific.
    pub rule: Option<GrammarRuleId>,
    /// Required next clause, when activation comes from clause entry.
    pub next_clause: Option<ClauseId>,
}

/// Additional slot-based visibility gates for a completion group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionGroupVisibilitySpec {
    /// Filled slots that hide the group when owned by the frontier's clause instance.
    pub excludes_local_slots: Vec<SlotId>,
    /// At least one slot must be the frontier target or filled on its owning branch.
    pub requires_any_slots: Vec<SlotId>,
    /// Every slot must be the frontier target or filled on its owning branch.
    pub requires_all_slots: Vec<SlotId>,
}
