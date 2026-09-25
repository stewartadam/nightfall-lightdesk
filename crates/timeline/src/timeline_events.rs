// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles events related to timelines
use std::time::Duration;

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::prelude::IdExpr;
use nightfall_actions::{ActionReference, ActionRegistry};
use nightfall_clips::{Clip, ClipOperation};
use nightfall_compositor::prelude::ReleaseMarker;
#[cfg(test)]
use nightfall_desk::prelude::start_clip_action;
use nightfall_engine::prelude::*;
use nightfall_instances::{InstanceClock, InstanceClockSource, InstanceControls};
#[cfg(test)]
use nightfall_timecode::TimecodeCommand;
use nightfall_timecode::prelude::{Timecode, TimecodeEvent, TimecodeGenerator};
use uuid::Uuid;

use crate::prelude::*;
use crate::recording::{
    TimelineCommandOrigins, TimelineRecordingSessions, write_timeline_clip_action,
};

mod beatgrid;
mod cleanup;
mod contracts;
mod creation;
mod crud;
mod editing;
mod recording_mutations;
mod runtime;
#[cfg(test)]
mod tests;
mod timecode_lifecycle;

#[cfg(test)]
use beatgrid::{
    applied_beatgrid_bpm, apply_millis_delta_clamped, apply_millis_delta_preserve_span,
};
#[cfg(test)]
use cleanup::release_timeline_owned_entities;
pub(crate) use contracts::TimelineActionsChanged;
#[cfg(test)]
use creation::{TimelineTimecodeStoreMode, remove_timeline_creation, store_timeline_creation};
#[cfg(test)]
use crud::apply_stored_timeline_to_materialized;
pub use runtime::handle_timeline_events;
pub use timecode_lifecycle::handle_timecode_events;

/// Timecode storage and materialization state used by timeline CRUD operations.
#[derive(SystemParam)]
pub(crate) struct TimelineTimecodeStore<'w, 's> {
    /// Persisted timecode definitions.
    provider: ResMut<'w, DataProvider<Timecode>>,
    /// Materialized timecode generators.
    generators: Query<'w, 's, (Entity, &'static TimecodeGenerator)>,
}

/// Recording resources mutated alongside timeline CRUD operations.
#[derive(SystemParam)]
pub(crate) struct TimelineRecordingStores<'w> {
    /// Runtime recording state by timeline ID.
    states: ResMut<'w, TimelineRecordingStates>,
    /// In-progress recording sessions by timeline ID.
    sessions: ResMut<'w, TimelineRecordingSessions>,
}

/// Cohesive mutable dependencies shared by timeline definition command handlers.
#[derive(SystemParam)]
pub(crate) struct TimelineMutationContext<'w, 's> {
    /// Deferred ECS mutation queue.
    commands: Commands<'w, 's>,
    /// Materialized timelines synchronized with persisted definitions.
    timelines: Query<'w, 's, (Entity, &'static mut MaterializedTimeline)>,
    /// Clip definitions used when cleaning timeline-owned playback.
    clip_query: Query<'w, 's, &'static Clip>,
    /// Playback clocks and controls detached during timeline cleanup.
    instance_clocks: Query<
        'w,
        's,
        (
            Option<&'static mut InstanceClock>,
            Option<&'static mut InstanceControls>,
        ),
    >,
    /// Persisted timeline definitions.
    timeline_data_provider: ResMut<'w, DataProvider<Timeline>>,
    /// Persisted and materialized timecode state.
    timecode_store: TimelineTimecodeStore<'w, 's>,
    /// Recording state coupled to timeline definitions.
    recording: TimelineRecordingStores<'w>,
    /// Asynchronous beat-grid proposal state.
    beatgrid_runtime: ResMut<'w, crate::beatgrid_detection::BeatgridDetectionRuntime>,
    /// Websocket broadcaster used by beat-grid detection requests.
    broadcaster: Res<'w, ClientEventSink>,
    /// Clip actions emitted while cleaning timeline-owned playback.
    ev_clip: MessageWriter<'w, EngineOperationEnvelope<ClipOperation>>,
    /// Origins retained for timeline-issued clip actions.
    timeline_command_origins: ResMut<'w, TimelineCommandOrigins>,
    /// Exact-once command lifecycle responder.
    responder: CommandResponder<'w>,
    /// Optional live reconstruction notifications.
    action_events: Option<MessageWriter<'w, TimelineActionsChanged>>,
    /// Registered actions that stored timeline actions are validated against.
    action_registry: Option<Res<'w, ActionRegistry>>,
}

/// Returns the timeline actions a command would newly store, with their track IDs.
///
/// `StoreTimeline` only yields actions that are new or whose reference changed relative to
/// the stored timeline, so editing a timeline loaded with a legacy invalid action still
/// succeeds. Undo-owned creation restores are not revalidated.
fn actions_to_store<'a>(
    command: &'a TimelineCommand,
    timelines: &DataProvider<Timeline>,
) -> Vec<(&'a str, &'a Action)> {
    /// Flattens every action of a timeline with its track ID.
    fn all(timeline: &Timeline) -> impl Iterator<Item = (&str, &Action)> {
        timeline.tracks.iter().flat_map(|track| {
            track
                .actions
                .iter()
                .map(move |action| (track.id.as_str(), action))
        })
    }
    match command {
        TimelineCommand::StoreTimeline(timeline) => {
            let stored = timelines.get(timeline.identifiers.uid).ok();
            all(timeline)
                .filter(|(_, action)| {
                    stored.as_ref().is_none_or(|stored| {
                        !all(stored).any(|(_, existing)| {
                            existing.id == action.id && existing.action == action.action
                        })
                    })
                })
                .collect()
        }
        TimelineCommand::CreateTimeline { timeline, .. } => all(timeline).collect(),
        TimelineCommand::InsertRecordedActions {
            track_id, actions, ..
        } => actions
            .iter()
            .map(|action| (track_id.as_str(), action))
            .collect(),
        _ => Vec::new(),
    }
}

/// Rejects a timeline command that would store an action the timeline cannot run.
///
/// See [`validate_timeline_action`]. Without an action registry, as in focused tests,
/// nothing is validated.
fn validate_stored_actions(
    command: &TimelineCommand,
    timelines: &DataProvider<Timeline>,
    registry: Option<&ActionRegistry>,
) -> Result<(), CommandError> {
    let Some(registry) = registry else {
        return Ok(());
    };
    for (track_id, action) in actions_to_store(command, timelines) {
        if let Err(error) = validate_timeline_action(registry, &action.action) {
            return Err(CommandError {
                code: error.code,
                message: format!(
                    "Timeline action '{}' cannot be stored: {}",
                    action.label, error.message
                ),
                details: Some(serde_json::json!({
                    "track_id": track_id,
                    "action_id": action.id,
                    "action": action.action,
                    "details": error.details,
                })),
            });
        }
    }
    Ok(())
}

/// Coordinate persisted timeline command families and internal recording actions.
pub fn crud_events(
    mut context: TimelineMutationContext,
    mut events: MessageReader<CommandEnvelope<TimelineCommand>>,
    mut actions: MessageReader<EngineOperationEnvelope<TimelineOperation>>,
) {
    for event in events.read() {
        if let Err(error) = validate_stored_actions(
            &event.command,
            &context.timeline_data_provider,
            context.action_registry.as_deref(),
        ) {
            if context.responder.is_active(event.command_id)
                && let Err(completion) = context.responder.fail(event.command_id, error)
            {
                tracing::error!(%completion, "timeline_command_failure_failed");
            }
            continue;
        }
        match &event.command {
            TimelineCommand::StoreTimeline(_)
            | TimelineCommand::RenameTimeline { .. }
            | TimelineCommand::DeleteTimeline(_) => crud::handle_command(&mut context, event),
            TimelineCommand::CreateTimeline { .. }
            | TimelineCommand::RestoreTimelineCreation { .. }
            | TimelineCommand::DeleteCreatedTimeline { .. } => {
                creation::handle_command(&mut context, event);
            }
            TimelineCommand::StoreTimelineMarker { .. }
            | TimelineCommand::DeleteTimelineMarker { .. }
            | TimelineCommand::StoreTimelineRegion { .. }
            | TimelineCommand::DeleteTimelineRegion { .. }
            | TimelineCommand::SetTimelineLoopRange { .. } => {
                editing::handle_command(&mut context, event);
            }
            TimelineCommand::SetTimelineRecording { .. }
            | TimelineCommand::InsertRecordedActions { .. }
            | TimelineCommand::DeleteRecordedActions { .. }
            | TimelineCommand::NudgeTimelineSelection { .. } => {
                recording_mutations::handle_command(&mut context, event);
            }
            TimelineCommand::RequestBeatgridDetection { .. }
            | TimelineCommand::ApplyBeatgridProposal { .. }
            | TimelineCommand::RejectBeatgridProposal { .. }
            | TimelineCommand::SetBeatgridStart { .. } => {
                beatgrid::handle_command(&mut context, event);
            }
            _ => {}
        }
    }

    for event in actions.read() {
        recording_mutations::handle_action(&mut context, event);
    }
}

/// Report successful completion for one directly handled timeline command.
fn succeed_timeline_command(responder: &mut CommandResponder, command_id: CommandId) {
    if !responder.is_active(command_id) {
        return;
    }
    if let Err(error) = responder.succeed(command_id) {
        tracing::error!(%error, "timeline_command_completion_failed");
    }
}

/// Reports a structured failure for one directly handled timeline command.
fn fail_timeline_command(responder: &mut CommandResponder, command_id: CommandId, message: String) {
    if !responder.is_active(command_id) {
        return;
    }
    if let Err(error) = responder.fail(
        command_id,
        CommandError::new("timeline.command_failed", message),
    ) {
        tracing::error!(%error, "timeline_command_failure_failed");
    }
}

/// Finishes a tracked timeline mutation after its persistence attempt.
fn finish_persisted_timeline_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    persisted: bool,
    failure_message: String,
) {
    if persisted {
        succeed_timeline_command(responder, command_id);
    } else {
        fail_timeline_command(responder, command_id, failure_message);
    }
}
