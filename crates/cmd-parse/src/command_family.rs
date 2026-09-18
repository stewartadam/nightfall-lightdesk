// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared command-family metadata derived from the grammar root clauses.

use crate::completion_groups::contracts::CompletionGroupId;
use crate::parser::analysis::{TokenId, ValueKind};
use crate::slots::contracts::{ClauseId, root_clause_for_command_head};

/// Expected-token categories used to describe command-head parsing rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FamilyExpectedToken {
    Token(TokenId),
    Placeholder(ValueKind),
}

/// Policy for command families whose head is exactly one token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SingleTokenHeadPolicy {
    None,
    Replace(&'static [FamilyExpectedToken]),
    Clear,
}

/// Dispatch target selected after structural command parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StructuralAstDispatchKind {
    ObjectProperty,
    ColorPath,
    CueBlock,
    Utility,
    Programmer,
    Fx,
    Patch,
    Clip,
    ChannelOverride,
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
}

/// Static metadata that groups related command heads and their parse behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandFamilySpec {
    pub root_clause: ClauseId,
    pub completion_groups: &'static [CompletionGroupId],
    pub single_token_head_policy: SingleTokenHeadPolicy,
    pub hidden_exact_head_groups: &'static [CompletionGroupId],
    pub structural_ast_dispatch: StructuralAstDispatchKind,
}

const PROGRAMMER_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::ProgrammerSelection,
    CompletionGroupId::ProgrammerSelectionIdentifier,
    CompletionGroupId::ProgrammerSetAttribute,
    CompletionGroupId::ProgrammerIntensity,
    CompletionGroupId::ProgrammerTimings,
    CompletionGroupId::ProgrammerPlacement3d,
];
const FX_GROUPS: &[CompletionGroupId] =
    &[CompletionGroupId::FxIdentifier, CompletionGroupId::FxAction];
const PATCH_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::PatchSource,
    CompletionGroupId::PatchDmxAddress,
    CompletionGroupId::PatchTarget,
];
const CLIP_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::ClipIdentifier,
    CompletionGroupId::ClipAction,
];
const CHANNEL_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::ChannelOverrideIdentifier,
    CompletionGroupId::ChannelOverrideValue,
];
const RELEASE_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::ReleaseAttributes,
    CompletionGroupId::ReleaseChannel,
];
const CLEAR_GROUPS: &[CompletionGroupId] =
    &[CompletionGroupId::Clear, CompletionGroupId::ClearAttributes];
const FLOW_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::FlowIdentifier,
    CompletionGroupId::FlowAction,
];
const TIMECODE_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::TimecodeIdentifier,
    CompletionGroupId::TimecodeAction,
];
const TIMELINE_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::TimelineIdentifier,
    CompletionGroupId::TimelineAction,
];
const RM_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::RmObjectType,
    CompletionGroupId::RmObjectIdentifier,
];
const RENAME_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::Rename,
    CompletionGroupId::RenameObjectType,
];
const STORE_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::StoreObjectType,
    CompletionGroupId::StoreObjectIdentifier,
    CompletionGroupId::StoreCueRef,
    CompletionGroupId::StoreGroupIdentifier,
    CompletionGroupId::StoreBlueprint,
    CompletionGroupId::StoreBlueprintFilter,
    CompletionGroupId::StepFx,
    CompletionGroupId::StepFxSelection,
    CompletionGroupId::StepFxDuration,
    CompletionGroupId::StepFxAttribute,
    CompletionGroupId::StepFxAttributeBaseline,
    CompletionGroupId::StepFxValues,
    CompletionGroupId::StepFxShaping,
];
const LOG_GROUPS: &[CompletionGroupId] = &[
    CompletionGroupId::LogLevel,
    CompletionGroupId::LogFilter,
    CompletionGroupId::LogFixture,
];
const RECALL_GROUPS: &[CompletionGroupId] = &[CompletionGroupId::RecallCueRef];
const DEBUG_GROUPS: &[CompletionGroupId] = &[CompletionGroupId::DebugObject];
const SLEEP_GROUPS: &[CompletionGroupId] = &[CompletionGroupId::SleepDuration];
const FPS_GROUPS: &[CompletionGroupId] = &[CompletionGroupId::FpsValue];

const RELEASE_SINGLE_TOKEN_OVERRIDE: &[FamilyExpectedToken] = &[
    FamilyExpectedToken::Token(TokenId::Attribute),
    FamilyExpectedToken::Token(TokenId::Channel),
];
const RECALL_SINGLE_TOKEN_OVERRIDE: &[FamilyExpectedToken] = &[
    FamilyExpectedToken::Token(TokenId::Cue),
    FamilyExpectedToken::Token(TokenId::Blueprint),
];
const SLEEP_SINGLE_TOKEN_OVERRIDE: &[FamilyExpectedToken] =
    &[FamilyExpectedToken::Placeholder(ValueKind::DurationValue)];
const FPS_SINGLE_TOKEN_OVERRIDE: &[FamilyExpectedToken] =
    &[FamilyExpectedToken::Placeholder(ValueKind::NumericDigit)];

const COMMAND_FAMILY_SPECS: &[CommandFamilySpec] = &[
    CommandFamilySpec {
        root_clause: ClauseId::ObjectProperty,
        completion_groups: &[],
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::ObjectProperty,
    },
    CommandFamilySpec {
        root_clause: ClauseId::CueColorPath,
        completion_groups: &[],
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::ColorPath,
    },
    CommandFamilySpec {
        root_clause: ClauseId::CopyColorPath,
        completion_groups: &[],
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::ColorPath,
    },
    CommandFamilySpec {
        root_clause: ClauseId::CueBlock,
        completion_groups: &[],
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::CueBlock,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Utility,
        completion_groups: &[],
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Utility,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Showfile,
        completion_groups: &[],
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Utility,
    },
    CommandFamilySpec {
        root_clause: ClauseId::NewShowfile,
        completion_groups: &[],
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Utility,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Programmer,
        completion_groups: PROGRAMMER_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Programmer,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Fx,
        completion_groups: FX_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Fx,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Patch,
        completion_groups: PATCH_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Patch,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Clip,
        completion_groups: CLIP_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Clip,
    },
    CommandFamilySpec {
        root_clause: ClauseId::ChannelOverride,
        completion_groups: CHANNEL_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::ChannelOverride,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Release,
        completion_groups: RELEASE_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::Replace(RELEASE_SINGLE_TOKEN_OVERRIDE),
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Release,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Clear,
        completion_groups: CLEAR_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Clear,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Flow,
        completion_groups: FLOW_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Flow,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Timecode,
        completion_groups: TIMECODE_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Timecode,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Timeline,
        completion_groups: TIMELINE_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Timeline,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Rm,
        completion_groups: RM_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Rm,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Rename,
        completion_groups: RENAME_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::Clear,
        hidden_exact_head_groups: RENAME_GROUPS,
        structural_ast_dispatch: StructuralAstDispatchKind::Rename,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Store,
        completion_groups: STORE_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Store,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Log,
        completion_groups: LOG_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::None,
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Log,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Recall,
        completion_groups: RECALL_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::Replace(RECALL_SINGLE_TOKEN_OVERRIDE),
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Recall,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Debug,
        completion_groups: DEBUG_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::Clear,
        hidden_exact_head_groups: DEBUG_GROUPS,
        structural_ast_dispatch: StructuralAstDispatchKind::Debug,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Sleep,
        completion_groups: SLEEP_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::Replace(SLEEP_SINGLE_TOKEN_OVERRIDE),
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Sleep,
    },
    CommandFamilySpec {
        root_clause: ClauseId::Fps,
        completion_groups: FPS_GROUPS,
        single_token_head_policy: SingleTokenHeadPolicy::Replace(FPS_SINGLE_TOKEN_OVERRIDE),
        hidden_exact_head_groups: &[],
        structural_ast_dispatch: StructuralAstDispatchKind::Fps,
    },
];

pub fn command_family_specs() -> &'static [CommandFamilySpec] {
    COMMAND_FAMILY_SPECS
}

pub fn command_family_for_root_clause(root_clause: ClauseId) -> Option<&'static CommandFamilySpec> {
    command_family_specs()
        .iter()
        .find(|spec| spec.root_clause == root_clause)
}

pub fn command_family_for_head(head: TokenId) -> Option<&'static CommandFamilySpec> {
    root_clause_for_command_head(head).and_then(command_family_for_root_clause)
}

#[cfg(test)]
mod tests {
    use super::{
        SingleTokenHeadPolicy, StructuralAstDispatchKind, command_family_for_head,
        command_family_for_root_clause,
    };
    use crate::completion_groups::contracts::CompletionGroupId;
    use crate::parser::analysis::TokenId;
    use crate::slots::contracts::ClauseId;

    #[test]
    fn programmer_heads_share_the_same_family() {
        let fixture = command_family_for_head(TokenId::Fixture).expect("fixture family");
        let group = command_family_for_head(TokenId::Group).expect("group family");
        let parameter = command_family_for_head(TokenId::Parameter).expect("parameter family");

        assert_eq!(fixture.root_clause, ClauseId::Programmer);
        assert_eq!(fixture.root_clause, group.root_clause);
        assert_eq!(fixture.root_clause, parameter.root_clause);
    }

    #[test]
    fn rename_family_metadata_is_keyed_by_root_clause() {
        let rename = command_family_for_root_clause(ClauseId::Rename).expect("rename family");
        assert_eq!(
            rename.hidden_exact_head_groups,
            &[
                CompletionGroupId::Rename,
                CompletionGroupId::RenameObjectType
            ]
        );
        assert_eq!(
            rename.single_token_head_policy,
            SingleTokenHeadPolicy::Clear
        );
        assert_eq!(
            rename.structural_ast_dispatch,
            StructuralAstDispatchKind::Rename
        );
    }
}
