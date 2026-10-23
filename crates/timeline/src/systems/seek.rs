// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::lifecycle::*;
use super::planner_adapter::*;
use super::*;

mod cue;
mod dispatch;
mod flow;
mod fx;
mod fx_module;
mod planning;
mod reconcile;
mod requests;
mod sequence;
mod tracking;

use cue::TimelineCueSeekMaterializer;
use dispatch::TimelineSeekDispatch;
use flow::TimelineFlowSeekMaterializer;
use fx::TimelineFxSeekMaterializer;
use fx_module::TimelineFxModuleSeekMaterializer;
use planning::*;
use reconcile::*;
pub use requests::{
    TimelineReconstructionDeferredFlush, TimelineReconstructionEvents,
    clear_timeline_reconstruction_deferred_flush, mark_timeline_reconstruction_deferred_flush,
    timeline_reconstruction_deferred_flush_requested,
};
use requests::{TimelineReconstructionReason, collect_timeline_reconstruction_requests};
use sequence::TimelineSequenceSeekMaterializer;

/// Encapsulates the complete ECS dependency set used by the staged seek coordinator.
#[derive(SystemParam)]
pub struct TimelineSeekPipeline<'w, 's> {
    /// Source definitions and runtime indexes needed during deterministic planning.
    planning: TimelineSeekPlanningParams<'w, 's>,
    /// Cue and sequence reconstruction dependencies, kept in a set because sequences write the
    /// parameters that cues read.
    cue_sequence_materializers: ParamSet<
        'w,
        's,
        (
            TimelineCueSeekMaterializer<'w, 's>,
            TimelineSequenceSeekMaterializer<'w, 's>,
        ),
    >,
    /// Classic and step FX reconstruction dependencies.
    fx_materializer: TimelineFxSeekMaterializer<'w, 's>,
    /// Shared action lookup, reconciliation, and dispatch dependencies.
    dispatch: TimelineSeekDispatch<'w>,
    /// Runtime queries used by stale-entity reconciliation.
    reconciliation: TimelineSeekReconciliationParams<'w, 's>,
    /// Stable clip identity lookup used by planning and action dispatch.
    clip_lookup: ClipLookup<'w, 's>,
}

/// Coordinates ordered timeline reconstruction stages for explicit seeks and action mutations.
pub fn handle_timeline_seek_system(
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
    mut action_cursors: Query<&mut TimelineActionCursor>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    mut reconstruction_events: TimelineReconstructionEvents,
    pipeline: TimelineSeekPipeline,
    mut source_owned_materializers: ParamSet<(
        TimelineFxModuleSeekMaterializer,
        TimelineFlowSeekMaterializer,
    )>,
    mut commands: Commands,
) {
    let TimelineSeekPipeline {
        planning,
        mut cue_sequence_materializers,
        fx_materializer,
        mut dispatch,
        reconciliation,
        clip_lookup,
    } = pipeline;
    let clip_snapshot = clip_lookup.snapshot();

    let reconstruction_requests = collect_timeline_reconstruction_requests(
        &mut timeline_query,
        &timecode_query,
        &mut reconstruction_events,
    );
    for (timeline_entity, request) in reconstruction_requests {
        if let Ok((_, mut timeline)) = timeline_query.get_mut(timeline_entity) {
            let seek_behavior = timeline.timeline.seek_behavior;
            if matches!(request.reason, TimelineReconstructionReason::Seek)
                && seek_behavior != TimelineSeekBehavior::MovePlayheadOnly
                && !timeline.is_active
            {
                // Activate the timeline when seeking (if not already active).
                timeline.activate();
            }
            // Live action triggering resumes from the seek target, or re-evaluates every action
            // after an edit.
            if timeline.is_active
                && let Ok(mut cursor) = action_cursors.get_mut(timeline_entity)
            {
                match request.reason {
                    TimelineReconstructionReason::Seek => cursor.seek_to(
                        request
                            .timecode_position
                            .saturating_sub(timeline.timeline.timecode_start),
                    ),
                    // A seek handled since the last render keeps precedence over a later edit,
                    // as it does when both arrive together, unless the seek only moved the
                    // playhead.
                    TimelineReconstructionReason::ActionsChanged
                        if cursor.seek_pending()
                            && seek_behavior != TimelineSeekBehavior::MovePlayheadOnly => {}
                    TimelineReconstructionReason::ActionsChanged => cursor.rewind(),
                }
            }
            if matches!(request.reason, TimelineReconstructionReason::Seek)
                && seek_behavior == TimelineSeekBehavior::MovePlayheadOnly
            {
                continue;
            }
            // Calculate the timeline seek position (offset by timecode start)
            let timeline_position = if request.timecode_position >= timeline.timeline.timecode_start
            {
                request.timecode_position - timeline.timeline.timecode_start
            } else {
                // Seeking before timeline start, effectively reset
                Duration::ZERO
            };

            tracing::debug!(
                timeline_id = %timeline.timeline.identifiers.id,
                position = ?timeline_position,
                "Seeking timeline"
            );

            // Mark that audio needs syncing for the new position
            timeline.audio_needs_sync = true;
            let reconstruction_plan = plan_timeline_reconstruction(
                &timeline,
                timeline_position,
                dispatch.action_registry.as_deref(),
                &planning,
                &clip_snapshot,
            );

            let mut reconstruction_state = reconcile_timeline_runtime_entities(
                &mut timeline,
                request.reason,
                &reconstruction_plan,
                &reconciliation,
                &mut dispatch,
                &mut commands,
            );

            tracking::reset_timeline_reconstruction_tracking(&mut timeline);

            cue::materialize_timeline_cues(
                &cue_sequence_materializers.p0(),
                &mut commands,
                &reconstruction_plan,
                timeline.timeline.identifiers.uid,
                &mut reconstruction_state,
            );
            fx::materialize_timeline_fx(
                &fx_materializer,
                &mut commands,
                &reconstruction_plan,
                timeline.timeline.identifiers.uid,
                &clip_snapshot,
                &mut reconstruction_state,
            );
            {
                let mut materializer = source_owned_materializers.p0();
                fx_module::materialize_timeline_fx_modules(
                    &mut materializer,
                    &reconstruction_plan,
                    timeline.timeline.identifiers.uid,
                    &clip_snapshot,
                    &mut reconstruction_state,
                );
            }
            {
                let mut materializer = source_owned_materializers.p1();
                flow::materialize_timeline_flows(
                    &mut materializer,
                    &reconstruction_plan,
                    timeline.timeline.identifiers.uid,
                    &clip_snapshot,
                    &mut reconstruction_state,
                );
            }
            sequence::materialize_timeline_sequences(
                &mut cue_sequence_materializers.p1(),
                &mut commands,
                &timeline,
                &reconstruction_plan,
                &clip_snapshot,
                &mut reconstruction_state,
            );

            dispatch::dispatch_timeline_reconstruction_actions(
                &mut dispatch,
                &mut timeline,
                request.reason,
                &reconstruction_plan,
                &reconstruction_state,
                &clip_snapshot,
            );

            tracking::commit_timeline_reconstruction_tracking(
                &mut timeline,
                std::mem::take(&mut reconstruction_state.tracked_spawned_entities),
            );
        }
    }
}
