// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Completion group catalog definitions (presentation-only).

use std::sync::OnceLock;

use super::contracts::{
    CompletionGroupId, CompletionGroupSpec, CompletionGroupVisibilitySpec, FrontierPredicate,
};
use crate::slots::contracts::{ClauseId, SlotId};

/// Returns the immutable completion-group catalog used by slot planning.
pub fn completion_group_specs() -> &'static [CompletionGroupSpec] {
    static CATALOG: OnceLock<Vec<CompletionGroupSpec>> = OnceLock::new();
    CATALOG.get_or_init(build_catalog).as_slice()
}

/// Defines every completion-group specification and its activation rules.
fn build_catalog() -> Vec<CompletionGroupSpec> {
    vec![
        completion_group(
            CompletionGroupId::Command,
            "Command Type",
            1000,
            &[SlotId::CommandHead],
            &[pred(&[], Some(SlotId::CommandHead), None)],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::ProgrammerSelection,
            "Selection",
            950,
            &[SlotId::SelectionType],
            &[pred(
                &[ClauseId::Programmer],
                Some(SlotId::SelectionType),
                None,
            )],
            vis(&[SlotId::SelectionType], &[]),
        ),
        completion_group(
            CompletionGroupId::ProgrammerSelectionIdentifier,
            "Selection Identifier",
            949,
            &[SlotId::SelectionIdentifier],
            &[
                pred(
                    &[ClauseId::Programmer, ClauseId::ProgrammerSelection],
                    Some(SlotId::SelectionIdentifier),
                    None,
                ),
                pred(
                    &[ClauseId::Programmer, ClauseId::ProgrammerSelection],
                    None,
                    Some(ClauseId::ProgrammerSelectionIdentifier),
                ),
            ],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::ProgrammerSetAttribute,
            "Set Attribute",
            940,
            &[SlotId::SetAttrAttribute, SlotId::SetAttrValue],
            &[
                pred(
                    &[ClauseId::Programmer],
                    Some(SlotId::SetAttrAttribute),
                    None,
                ),
                pred(&[ClauseId::Programmer], Some(SlotId::SetAttrValue), None),
            ],
            vis(&[SlotId::SetAttrAttribute, SlotId::SetAttrValue], &[]),
        ),
        completion_group(
            CompletionGroupId::ProgrammerIntensity,
            "Set Intensity",
            939,
            &[SlotId::SetAttrValue],
            &[pred(
                &[
                    ClauseId::Programmer,
                    ClauseId::ProgrammerAttributeActions,
                    ClauseId::ProgrammerSetAttributeItem,
                ],
                Some(SlotId::SetAttrValue),
                None,
            )],
            CompletionGroupVisibilitySpec {
                excludes_local_slots: vec![SlotId::SetAttrAttribute],
                ..vis(&[SlotId::SetAttrValue], &[])
            },
        ),
        completion_group(
            CompletionGroupId::ProgrammerTimings,
            "Timing",
            930,
            &[
                SlotId::TimingsKeyword,
                SlotId::TimingsDirection,
                SlotId::TimingsGlobalDuration,
                SlotId::TimingsOverrideAttribute,
                SlotId::TimingsOverrideDuration,
            ],
            &[
                pred(&[ClauseId::Programmer], Some(SlotId::TimingsKeyword), None),
                pred(
                    &[ClauseId::Programmer],
                    Some(SlotId::TimingsDirection),
                    None,
                ),
                pred(
                    &[ClauseId::Programmer],
                    Some(SlotId::TimingsGlobalDuration),
                    None,
                ),
                pred(
                    &[ClauseId::Programmer],
                    Some(SlotId::TimingsOverrideAttribute),
                    None,
                ),
                pred(
                    &[ClauseId::Programmer],
                    Some(SlotId::TimingsOverrideDuration),
                    None,
                ),
            ],
            vis(
                &[
                    SlotId::TimingsKeyword,
                    SlotId::TimingsDirection,
                    SlotId::TimingsOverrideAttribute,
                    SlotId::TimingsOverrideDuration,
                ],
                &[],
            ),
        ),
        completion_group(
            CompletionGroupId::ProgrammerPlacement3d,
            "3D placement",
            920,
            &[SlotId::PlacementAction, SlotId::PlacementAxisValue],
            &[
                pred(
                    &[ClauseId::Programmer],
                    None,
                    Some(ClauseId::ProgrammerPlacement3d),
                ),
                pred(&[ClauseId::Programmer], Some(SlotId::PlacementAction), None),
                pred(
                    &[ClauseId::Programmer],
                    Some(SlotId::PlacementAxisValue),
                    None,
                ),
            ],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::FxIdentifier,
            "Identifier",
            910,
            &[SlotId::FxIdentifier],
            &[pred(&[ClauseId::Fx], Some(SlotId::FxIdentifier), None)],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::FxAction,
            "Action",
            905,
            &[SlotId::FxAction],
            &[pred(&[ClauseId::Fx], Some(SlotId::FxAction), None)],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::StepFx,
            "Step",
            900,
            &[SlotId::StoreFxAction, SlotId::StepFxSelectionHead],
            &[pred(
                &[ClauseId::Store, ClauseId::StepFx],
                Some(SlotId::StepFxSelectionHead),
                None,
            )],
            vis(&[], &[SlotId::StoreFxAction]),
        ),
        completion_group(
            CompletionGroupId::StepFxSelection,
            "Selection",
            895,
            &[
                SlotId::StepFxSelectionHead,
                SlotId::StepFxSelectionIdentifier,
            ],
            &[
                pred(
                    &[ClauseId::Store, ClauseId::StepFx],
                    Some(SlotId::StepFxSelectionHead),
                    None,
                ),
                pred(
                    &[ClauseId::Store, ClauseId::StepFx],
                    Some(SlotId::StepFxSelectionIdentifier),
                    None,
                ),
                pred(
                    &[ClauseId::Store, ClauseId::StepFx],
                    None,
                    Some(ClauseId::StepFxSelection),
                ),
            ],
            vis(
                &[
                    SlotId::StepFxSelectionHead,
                    SlotId::StepFxSelectionIdentifier,
                ],
                &[SlotId::StepFxSelectionHead],
            ),
        ),
        completion_group(
            CompletionGroupId::StepFxDuration,
            "Step Duration",
            890,
            &[SlotId::StepFxDuration],
            &[
                pred(&[ClauseId::Store], Some(SlotId::StepFxDuration), None),
                pred(
                    &[ClauseId::Store, ClauseId::StepFx, ClauseId::StepFxSelection],
                    None,
                    Some(ClauseId::StepFxDuration),
                ),
            ],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::StepFxAttribute,
            "Step Attribute",
            885,
            &[SlotId::StepFxStepAttribute],
            &[
                pred(&[ClauseId::Store], Some(SlotId::StepFxStepAttribute), None),
                pred(
                    &[ClauseId::Store, ClauseId::StepFx],
                    None,
                    Some(ClauseId::StepFxStepDefinition),
                ),
                pred(
                    &[ClauseId::Store, ClauseId::StepFx, ClauseId::StepFxDuration],
                    None,
                    Some(ClauseId::StepFxStepDefinition),
                ),
            ],
            vis(&[], &[SlotId::StoreFxAction]),
        ),
        completion_group(
            CompletionGroupId::StepFxAttributeBaseline,
            "Initial value",
            880,
            &[SlotId::StepFxAttributeBaseline],
            &[pred(
                &[ClauseId::Store],
                Some(SlotId::StepFxAttributeBaseline),
                None,
            )],
            vis(&[], &[SlotId::StepFxStepAttribute]),
        ),
        completion_group(
            CompletionGroupId::StepFxValues,
            "Step Values",
            875,
            &[SlotId::StepFxStepValues],
            &[pred(
                &[ClauseId::Store],
                Some(SlotId::StepFxStepValues),
                None,
            )],
            vis(&[], &[SlotId::StepFxStepAttribute]),
        ),
        completion_group(
            CompletionGroupId::StepFxShaping,
            "Step Shaping",
            870,
            &[SlotId::StepFxAttributeShaping],
            &[pred(
                &[ClauseId::Store],
                Some(SlotId::StepFxAttributeShaping),
                None,
            )],
            vis(&[], &[SlotId::StepFxStepAttribute]),
        ),
        completion_group(
            CompletionGroupId::PatchSource,
            "Source",
            860,
            &[
                SlotId::PatchSourceEndpoint,
                SlotId::PatchSourceUniverse,
                SlotId::PatchSourceAddress,
            ],
            &[
                pred(&[ClauseId::Patch], Some(SlotId::PatchSourceEndpoint), None),
                pred(&[ClauseId::Patch], Some(SlotId::PatchSourceUniverse), None),
                pred(&[ClauseId::Patch], Some(SlotId::PatchSourceAddress), None),
                pred(&[ClauseId::Patch], None, Some(ClauseId::PatchSource)),
            ],
            vis(
                &[SlotId::PatchSourceEndpoint, SlotId::PatchSourceUniverse],
                &[],
            ),
        ),
        completion_group(
            CompletionGroupId::PatchDmxAddress,
            "DMX address",
            855,
            &[SlotId::PatchSourceUniverse, SlotId::PatchSourceAddress],
            &[
                pred(&[ClauseId::Patch], Some(SlotId::PatchSourceUniverse), None),
                pred(&[ClauseId::Patch], Some(SlotId::PatchSourceAddress), None),
            ],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::PatchTarget,
            "Target",
            850,
            &[SlotId::PatchTargetEndpoint],
            &[
                pred(&[ClauseId::Patch], Some(SlotId::PatchTargetEndpoint), None),
                pred(&[ClauseId::Patch], None, Some(ClauseId::PatchTarget)),
            ],
            vis(&[SlotId::PatchTargetEndpoint], &[]),
        ),
        completion_group(
            CompletionGroupId::ClipIdentifier,
            "Identifier",
            845,
            &[SlotId::ClipIdentifier],
            &[pred(&[ClauseId::Clip], Some(SlotId::ClipIdentifier), None)],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::ClipAction,
            "Action",
            840,
            &[SlotId::ClipIdentifier, SlotId::ClipAction],
            &[
                pred(&[ClauseId::Clip], Some(SlotId::ClipAction), None),
                pred(&[ClauseId::Clip], None, Some(ClauseId::ClipAction)),
            ],
            vis(&[], &[SlotId::ClipIdentifier]),
        ),
        completion_group(
            CompletionGroupId::Clear,
            "Clear",
            830,
            &[SlotId::ClearTarget, SlotId::QualifierKeyword],
            &[
                pred(&[ClauseId::Clear], Some(SlotId::ClearTarget), None),
                pred(&[ClauseId::Clear], Some(SlotId::QualifierKeyword), None),
            ],
            vis(&[SlotId::ClearTarget, SlotId::QualifierKeyword], &[]),
        ),
        completion_group(
            CompletionGroupId::ClearAttributes,
            "Specific Attributes",
            825,
            &[SlotId::QualifierKeyword, SlotId::QualifierAttributeList],
            &[
                pred(&[ClauseId::Clear], Some(SlotId::QualifierKeyword), None),
                pred(
                    &[ClauseId::Clear],
                    Some(SlotId::QualifierAttributeList),
                    None,
                ),
            ],
            vis(&[], &[SlotId::QualifierKeyword]),
        ),
        completion_group(
            CompletionGroupId::ChannelOverrideIdentifier,
            "Identifier",
            820,
            &[SlotId::ChannelOverrideIdentifier],
            &[pred(
                &[ClauseId::ChannelOverride],
                Some(SlotId::ChannelOverrideIdentifier),
                None,
            )],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::ChannelOverrideValue,
            "DMX Value",
            815,
            &[
                SlotId::ChannelOverrideIdentifier,
                SlotId::ChannelOverrideValue,
            ],
            &[pred(
                &[ClauseId::ChannelOverride],
                Some(SlotId::ChannelOverrideValue),
                None,
            )],
            vis(&[], &[SlotId::ChannelOverrideIdentifier]),
        ),
        completion_group(
            CompletionGroupId::ReleaseAttributes,
            "Attributes",
            810,
            &[SlotId::QualifierKeyword, SlotId::QualifierAttributeList],
            &[
                pred(&[ClauseId::Release], Some(SlotId::QualifierKeyword), None),
                pred(
                    &[ClauseId::Release],
                    Some(SlotId::QualifierAttributeList),
                    None,
                ),
                pred(
                    &[ClauseId::Release],
                    None,
                    Some(ClauseId::ReleaseAttributes),
                ),
            ],
            vis(&[], &[SlotId::QualifierKeyword]),
        ),
        completion_group(
            CompletionGroupId::ReleaseChannel,
            "Channel",
            805,
            &[SlotId::ReleaseChannelExpr],
            &[pred(
                &[ClauseId::Release],
                Some(SlotId::ReleaseChannelExpr),
                None,
            )],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::RmObjectType,
            "Object Type",
            800,
            &[SlotId::RmObjectType],
            &[pred(&[ClauseId::Rm], Some(SlotId::RmObjectType), None)],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::RmObjectIdentifier,
            "Object Identifier",
            795,
            &[SlotId::RmObjectType, SlotId::RmObjectIdentifier],
            &[pred(
                &[ClauseId::Rm],
                Some(SlotId::RmObjectIdentifier),
                None,
            )],
            vis(&[], &[SlotId::RmObjectType]),
        ),
        completion_group(
            CompletionGroupId::StoreObjectType,
            "Object Type",
            790,
            &[SlotId::StoreObjectType],
            &[pred(
                &[ClauseId::Store],
                Some(SlotId::StoreObjectType),
                None,
            )],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::StoreObjectIdentifier,
            "Object Identifier",
            788,
            &[SlotId::StoreObjectType, SlotId::StoreObjectIdentifier],
            &[pred(
                &[ClauseId::Store],
                Some(SlotId::StoreObjectIdentifier),
                None,
            )],
            vis(&[], &[SlotId::StoreObjectType]),
        ),
        completion_group(
            CompletionGroupId::StoreCueRef,
            "Cue Ref",
            785,
            &[SlotId::StoreObjectType, SlotId::StoreCueRef],
            &[pred(&[ClauseId::Store], Some(SlotId::StoreCueRef), None)],
            vis(&[], &[SlotId::StoreObjectType]),
        ),
        completion_group(
            CompletionGroupId::StoreGroupIdentifier,
            "Group Identifier",
            780,
            &[SlotId::StoreObjectType, SlotId::StoreGroupIdentifier],
            &[pred(
                &[ClauseId::Store],
                Some(SlotId::StoreGroupIdentifier),
                None,
            )],
            vis(&[], &[SlotId::StoreObjectType]),
        ),
        completion_group(
            CompletionGroupId::StoreBlueprint,
            "Blueprint",
            775,
            &[SlotId::StoreObjectType, SlotId::StoreBlueprintIdentifier],
            &[pred(
                &[ClauseId::Store],
                Some(SlotId::StoreBlueprintIdentifier),
                None,
            )],
            vis(&[], &[SlotId::StoreObjectType]),
        ),
        completion_group(
            CompletionGroupId::StoreBlueprintFilter,
            "Blueprint Filter",
            765,
            &[
                SlotId::StoreBlueprintIdentifier,
                SlotId::QualifierKeyword,
                SlotId::QualifierAttributeList,
            ],
            &[
                pred(
                    &[ClauseId::Store, ClauseId::StoreBlueprint],
                    Some(SlotId::QualifierKeyword),
                    None,
                ),
                pred(
                    &[ClauseId::Store, ClauseId::StoreBlueprint],
                    Some(SlotId::QualifierAttributeList),
                    None,
                ),
                pred(
                    &[ClauseId::Store],
                    Some(SlotId::QualifierAttributeList),
                    None,
                ),
            ],
            vis(&[], &[SlotId::StoreBlueprintIdentifier]),
        ),
        completion_group(
            CompletionGroupId::Rename,
            "Rename",
            760,
            &[
                SlotId::RenameObjectType,
                SlotId::RenameSource,
                SlotId::RenameTarget,
            ],
            &[
                pred(&[ClauseId::Rename], Some(SlotId::RenameObjectType), None),
                pred(&[ClauseId::Rename], Some(SlotId::RenameSource), None),
                pred(&[ClauseId::Rename], Some(SlotId::RenameTarget), None),
            ],
            vis(
                &[
                    SlotId::RenameObjectType,
                    SlotId::RenameSource,
                    SlotId::RenameTarget,
                ],
                &[],
            ),
        ),
        completion_group(
            CompletionGroupId::RenameObjectType,
            "Object Type",
            755,
            &[SlotId::RenameObjectType],
            &[pred(
                &[ClauseId::Rename],
                Some(SlotId::RenameObjectType),
                None,
            )],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::FlowIdentifier,
            "Identifier",
            750,
            &[SlotId::FlowIdentifier],
            &[pred(&[ClauseId::Flow], Some(SlotId::FlowIdentifier), None)],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::FlowAction,
            "Action",
            745,
            &[SlotId::FlowIdentifier, SlotId::FlowAction],
            &[
                pred(&[ClauseId::Flow], Some(SlotId::FlowAction), None),
                pred(&[ClauseId::Flow], None, Some(ClauseId::FlowAction)),
            ],
            vis(&[], &[SlotId::FlowIdentifier]),
        ),
        completion_group(
            CompletionGroupId::TimecodeIdentifier,
            "Identifier",
            740,
            &[SlotId::TimecodeIdentifier],
            &[pred(
                &[ClauseId::Timecode],
                Some(SlotId::TimecodeIdentifier),
                None,
            )],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::TimecodeAction,
            "Action",
            735,
            &[SlotId::TimecodeIdentifier, SlotId::TimecodeAction],
            &[
                pred(&[ClauseId::Timecode], Some(SlotId::TimecodeAction), None),
                pred(&[ClauseId::Timecode], None, Some(ClauseId::TimecodeAction)),
            ],
            vis(&[], &[SlotId::TimecodeIdentifier]),
        ),
        completion_group(
            CompletionGroupId::TimelineIdentifier,
            "Identifier",
            730,
            &[SlotId::TimelineIdentifier],
            &[pred(
                &[ClauseId::Timeline],
                Some(SlotId::TimelineIdentifier),
                None,
            )],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::TimelineAction,
            "Action",
            725,
            &[SlotId::TimelineIdentifier, SlotId::TimelineAction],
            &[
                pred(&[ClauseId::Timeline], Some(SlotId::TimelineAction), None),
                pred(&[ClauseId::Timeline], None, Some(ClauseId::TimelineAction)),
            ],
            vis(&[], &[SlotId::TimelineIdentifier]),
        ),
        completion_group(
            CompletionGroupId::LogLevel,
            "Log Level",
            720,
            &[SlotId::LogLevel],
            &[
                pred(&[ClauseId::Log], Some(SlotId::LogLevel), None),
                pred(&[ClauseId::Log], None, Some(ClauseId::LogLevel)),
            ],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::LogFilter,
            "Log Filter",
            715,
            &[SlotId::LogFilterField, SlotId::LogFilterValue],
            &[
                pred(&[ClauseId::Log], Some(SlotId::LogFilterField), None),
                pred(&[ClauseId::Log], Some(SlotId::LogFilterValue), None),
                pred(&[ClauseId::Log], None, Some(ClauseId::LogFilter)),
            ],
            vis(&[SlotId::LogFilterField, SlotId::LogFilterValue], &[]),
        ),
        completion_group(
            CompletionGroupId::LogFixture,
            "Log Fixture",
            710,
            &[SlotId::LogFixtureIdentifier, SlotId::LogFixtureAttribute],
            &[
                pred(&[ClauseId::Log], Some(SlotId::LogFixtureIdentifier), None),
                pred(&[ClauseId::Log], Some(SlotId::LogFixtureAttribute), None),
                pred(&[ClauseId::Log], None, Some(ClauseId::LogFixture)),
            ],
            vis(
                &[SlotId::LogFixtureIdentifier, SlotId::LogFixtureAttribute],
                &[],
            ),
        ),
        completion_group(
            CompletionGroupId::RecallCueRef,
            "Cue ref",
            705,
            &[SlotId::RecallCueRef],
            &[pred(&[ClauseId::Recall], Some(SlotId::RecallCueRef), None)],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::DebugObject,
            "Object",
            700,
            &[SlotId::DebugObjectType, SlotId::DebugObjectIdentifier],
            &[
                pred(&[ClauseId::Debug], Some(SlotId::DebugObjectType), None),
                pred(
                    &[ClauseId::Debug],
                    Some(SlotId::DebugObjectIdentifier),
                    None,
                ),
            ],
            vis(
                &[SlotId::DebugObjectType, SlotId::DebugObjectIdentifier],
                &[],
            ),
        ),
        completion_group(
            CompletionGroupId::SleepDuration,
            "Sleep Duration",
            695,
            &[SlotId::SleepDuration],
            &[pred(&[ClauseId::Sleep], Some(SlotId::SleepDuration), None)],
            vis(&[], &[]),
        ),
        completion_group(
            CompletionGroupId::FpsValue,
            "FPS Target",
            690,
            &[SlotId::FpsValue],
            &[pred(&[ClauseId::Fps], Some(SlotId::FpsValue), None)],
            vis(&[], &[]),
        ),
    ]
}

/// Builds a single completion-group catalog entry.
fn completion_group(
    id: CompletionGroupId,
    label: &'static str,
    priority: u16,
    slots: &[SlotId],
    frontier_predicates: &[FrontierPredicate],
    activation: CompletionGroupVisibilitySpec,
) -> CompletionGroupSpec {
    CompletionGroupSpec {
        id,
        label,
        frontier_predicates: frontier_predicates.to_vec(),
        activation,
        priority,
        slots: slots.to_vec(),
    }
}

const fn pred(
    clause_path_prefix: &'static [ClauseId],
    slot: Option<SlotId>,
    next_clause: Option<ClauseId>,
) -> FrontierPredicate {
    FrontierPredicate {
        clause_path_prefix,
        slot,
        rule: None,
        next_clause,
    }
}

/// Builds visibility requirements without excluding any clause-local fills.
fn vis(
    requires_any_slots: &[SlotId],
    requires_all_slots: &[SlotId],
) -> CompletionGroupVisibilitySpec {
    CompletionGroupVisibilitySpec {
        excludes_local_slots: Vec::new(),
        requires_any_slots: requires_any_slots.to_vec(),
        requires_all_slots: requires_all_slots.to_vec(),
    }
}
