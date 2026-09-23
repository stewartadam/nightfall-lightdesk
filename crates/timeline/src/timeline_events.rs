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
use nightfall_actions::ActionReference;
use nightfall_clips::{Clip, ClipAction};
use nightfall_compositor::prelude::ReleaseMarker;
#[cfg(test)]
use nightfall_desk::prelude::{ClipTarget, start_clip_action};
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
pub(crate) mod validation;

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
    /// Domain registrations used to validate saved action bindings before mutation.
    action_registry: Option<Res<'w, nightfall_actions::ActionRegistry>>,
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
    ev_clip: MessageWriter<'w, EngineActionEnvelope<ClipAction>>,
    /// Origins retained for timeline-issued clip actions.
    timeline_command_origins: ResMut<'w, TimelineCommandOrigins>,
    /// Exact-once command lifecycle responder.
    responder: CommandResponder<'w>,
    /// Optional live reconstruction notifications.
    action_events: Option<MessageWriter<'w, TimelineActionsChanged>>,
}

/// Coordinate persisted timeline command families and internal recording actions.
pub fn crud_events(
    mut context: TimelineMutationContext,
    mut events: MessageReader<CommandEnvelope<TimelineCommand>>,
    mut actions: MessageReader<EngineActionEnvelope<TimelineAction>>,
) {
    for event in events.read() {
        if let Err(error) =
            validation::validate_command(&event.command, context.action_registry.as_deref())
        {
            fail_timeline_command(&mut context.responder, event.command_id, error);
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
        if let TimelineAction::InsertRecordedActions { actions, .. } = &event.action
            && let Err(error) =
                validation::validate_actions(actions.iter(), context.action_registry.as_deref())
        {
            tracing::warn!(operation_id = %event.operation_id, %error, "Rejected recorded action bindings");
            continue;
        }
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
