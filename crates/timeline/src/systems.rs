// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timeline logic
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use moonshine_kind::prelude::{InstanceMut, InstanceRef};
use nightfall::prelude::*;
use nightfall_actions::{ActionInvocation, ActionRegistry, ActionSurface};
#[cfg(feature = "audio")]
use nightfall_audio::prelude::*;
use nightfall_clips::{
    Clip, ClipAction, ClipCommand, ClipLookup, ClipLookupSnapshot, MaterializedClip, Source,
};
use nightfall_compositor::prelude::{Layer, ObjectRefMarker, ReleaseMarker};
use nightfall_cues::prelude::{
    Cue, CueDurationResolver, MaterializedCue, MaterializedSequence, PlaybackReleaseTiming,
    Sequence, SequenceTimelineSeekPlayback, sequence_playback_duration_profile,
    spawn_reconstructed_sequence_for_clip, spawn_released_reconstructed_sequence_for_clip,
};
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::{FixtureDataProviderExt, Parameter};
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_fx::prelude::{
    Fx, StepFx, spawn_reconstructed_fx_for_clip, spawn_reconstructed_step_fx_for_clip,
};
use nightfall_instances::{
    DomainInstanceReconstructionRequest, InstanceClock, InstanceClockDiscontinuity,
    InstanceClockSource, InstanceControls, InstanceId, InstanceOptions, Owner,
    instance_clock_from_reconstruction_timing_with_rate,
};
use nightfall_playback_planner::{
    EvaluatedInstanceState, PlannedNoOpReason, PlannedPlaybackIntervention,
    PlannedPlaybackInterventionKind, PlannedPlaybackLifecycle, PlannedPlaybackSource,
    PlannedPlaybackSourceKind, PlaybackDurationProfile, PlaybackExtent,
    PlaybackReconstructionTiming, TimelinePlaybackActionOperation, TimelinePlaybackActionPlan,
};
use nightfall_selection::filter_existing_selection;
use nightfall_timecode::prelude::*;
use uuid::Uuid;

use crate::components::{MaterializedTimeline, SpawnedEntityType};
use crate::planner::{TimelinePlanningAction, TimelinePlaybackSourceResolver, plan_timeline_at};
use crate::prelude::{
    ActionKind, ParameterType, TimelineAction, TimelineCommand, TimelineLookaheadMode,
    TimelineNondeterministicSeekBehavior, TimelineSeekBehavior, TimelineStopBehavior,
};
use crate::recording::{TimelineCommandOrigins, write_timeline_clip_action};

mod lifecycle;
mod live;
mod lookahead;
mod parameters;
mod pause_sync;
mod planner_adapter;
mod seek;

pub use lifecycle::{
    PendingStoppedTimelineReleaseClocks, cleanup_timeline_entities,
    detach_stopped_timeline_release_clocks, record_stopped_timeline_release_clocks,
    reset_timeline_triggers_system, stop_timeline_owned_clips,
};
#[cfg(feature = "audio")]
pub use live::handle_timeline_audio_system;
pub use live::{process_actions_system, update_timeline_system};
pub use lookahead::{
    populate_materialized_lookahead_assertions_system, update_timeline_lookahead_layers_system,
    update_timeline_lookahead_sources_system,
};
pub use parameters::process_parameters_system;
pub use pause_sync::{TimelinePausedPlaybackRates, sync_timeline_paused_instance_controls_system};
#[cfg(test)]
use planner_adapter::{
    intervention_reconstruction_timing_from_evaluated_instance,
    reconstruction_timing_from_evaluated_instance,
    release_reconstruction_timing_from_evaluated_instance,
};
pub use seek::{
    TimelineReconstructionDeferredFlush, clear_timeline_reconstruction_deferred_flush,
    handle_timeline_seek_system, mark_timeline_reconstruction_deferred_flush,
    timeline_reconstruction_deferred_flush_requested,
};

/// Returns timeline-specific playback options, preserving source defaults when unset.
fn instance_options_for_timeline(timeline: &MaterializedTimeline) -> Option<InstanceOptions> {
    lookahead_override_for_timeline(timeline).map(|lookahead_enabled| InstanceOptions {
        lookahead_enabled: Some(lookahead_enabled),
    })
}

/// Returns the explicit timeline-level lookahead override, if one exists.
fn lookahead_override_for_timeline(timeline: &MaterializedTimeline) -> Option<bool> {
    match timeline.timeline.lookahead {
        TimelineLookaheadMode::Inherit => None,
        TimelineLookaheadMode::Enabled => Some(true),
        TimelineLookaheadMode::Disabled => Some(false),
    }
}

/// Converts timeline-supported registered actions into native timeline action kinds.
fn normalized_registered_action_kind(
    action: &ActionKind,
    action_registry: Option<&ActionRegistry>,
) -> Option<ActionKind> {
    let ActionKind::RegisteredAction(action) = action else {
        return None;
    };

    let capability = action_registry?
        .resolve_capability::<TimelinePlaybackActionPlan>(action)
        .ok()
        .flatten()?;
    match capability.operation {
        TimelinePlaybackActionOperation::Start => Some(ActionKind::StartClip(capability.owner_uid)),
        TimelinePlaybackActionOperation::Stop => Some(ActionKind::StopClip(capability.owner_uid)),
        TimelinePlaybackActionOperation::Intervene(PlannedPlaybackInterventionKind::SequenceGo) => {
            Some(ActionKind::AdvanceSequence(capability.owner_uid))
        }
        TimelinePlaybackActionOperation::Intervene(
            PlannedPlaybackInterventionKind::SequenceBack,
        ) => Some(ActionKind::BackSequence(capability.owner_uid)),
        TimelinePlaybackActionOperation::Intervene(
            PlannedPlaybackInterventionKind::SequenceGotoCue(cue_index),
        ) => Some(ActionKind::JumpToCue {
            uid: capability.owner_uid,
            cue_index,
        }),
        TimelinePlaybackActionOperation::Intervene(PlannedPlaybackInterventionKind::Stop) => None,
    }
}

/// Returns the clip UID that should start playback for this timeline action.
fn timeline_start_clip_uid(
    action: &ActionKind,
    action_registry: Option<&ActionRegistry>,
) -> Option<Uuid> {
    match action {
        ActionKind::StartClip(uid) => Some(*uid),
        ActionKind::RegisteredAction(_) => {
            normalized_registered_action_kind(action, action_registry).and_then(|action| {
                match action {
                    ActionKind::StartClip(uid) => Some(uid),
                    _ => None,
                }
            })
        }
        _ => None,
    }
}

/// Returns the clip UID that should stop playback for this timeline action.
fn timeline_stop_clip_uid(
    action: &ActionKind,
    action_registry: Option<&ActionRegistry>,
) -> Option<Uuid> {
    match action {
        ActionKind::StopClip(uid) => Some(*uid),
        ActionKind::RegisteredAction(_) => {
            normalized_registered_action_kind(action, action_registry).and_then(|action| {
                match action {
                    ActionKind::StopClip(uid) => Some(uid),
                    _ => None,
                }
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
