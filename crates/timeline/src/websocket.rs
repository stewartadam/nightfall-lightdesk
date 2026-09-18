// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for timeline commands.
//!
//! This module handles self-registration with the websocket infrastructure and
//! owns all timeline-related websocket forwarding logic.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::TimelineCommand;
use crate::recording::{TimelineRecordingSessions, TimelineRecordingStates};
use crate::timeline::{
    BeatgridDetectionFailed, BeatgridDetectionReady, BeatgridDetectionStarted, Timeline,
    TimelineLookaheadActionStatus, TimelineLookaheadActionStatuses,
};

/// Wrapper for serializing timeline messages with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum TimelineWsMessage<'a> {
    /// List of all timelines
    TimelineDefinitions(&'a [Timeline]),
    /// Runtime recording state for timelines
    TimelineRecordingStates(&'a [crate::recording::TimelineRecordingState]),
    /// Actions staged by active timeline recording sessions
    TimelineRecordingPreviews(&'a [crate::recording::TimelineRecordingPreview]),
    /// Runtime lookahead eligibility state for timeline actions
    TimelineLookaheadActionStatuses(&'a [TimelineLookaheadActionStatus]),
    /// A timeline command for reactive UI handling
    #[allow(dead_code)]
    TimelineCommand(&'a TimelineCommand),
    /// Beatgrid detection started notification
    BeatgridDetectionStarted(&'a BeatgridDetectionStarted),
    /// Beatgrid detection proposal notification
    BeatgridDetectionReady(&'a BeatgridDetectionReady),
    /// Beatgrid detection failure notification
    BeatgridDetectionFailed(&'a BeatgridDetectionFailed),
}

/// Deserialize and dispatch TimelineCommand from JSON.
///
/// This function is registered with the `CommandDeserializerRegistry` to handle
/// incoming timeline commands from the UI. It deserializes the JSON payload into a
/// `TimelineCommand` and queues it through pending command dispatch so undo can
/// capture an inverse before domain handlers mutate timeline state.
pub fn deserialize_timeline_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: TimelineCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse TimelineCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Forward timeline commands to the UI for reactive handling.
///
/// Note: CRUD commands (StoreTimeline, RenameTimeline, DeleteTimeline) are
/// intentionally NOT forwarded here because the command echo would be sent
/// before we know if the operation succeeded. Instead, we rely on
/// send_timelines_on_change to send full definitions after changes.
pub fn forward_timeline_commands(
    mut events: MessageReader<CommandEnvelope<TimelineCommand>>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        match &event.command {
            TimelineCommand::StoreTimeline(_)
            | TimelineCommand::CreateTimeline { .. }
            | TimelineCommand::RestoreTimelineCreation { .. }
            | TimelineCommand::DeleteCreatedTimeline { .. }
            | TimelineCommand::StoreTimelineMarker { .. }
            | TimelineCommand::DeleteTimelineMarker { .. }
            | TimelineCommand::StoreTimelineRegion { .. }
            | TimelineCommand::DeleteTimelineRegion { .. }
            | TimelineCommand::SetTimelineLoopRange { .. }
            | TimelineCommand::InsertRecordedActions { .. }
            | TimelineCommand::DeleteRecordedActions { .. }
            | TimelineCommand::NudgeTimelineSelection { .. }
            | TimelineCommand::DeleteTimeline(_)
            | TimelineCommand::RenameTimeline { .. }
            | TimelineCommand::RequestBeatgridDetection { .. }
            | TimelineCommand::ApplyBeatgridProposal { .. }
            | TimelineCommand::RejectBeatgridProposal { .. }
            | TimelineCommand::SetBeatgridStart { .. } => {}
            TimelineCommand::StartTimeline(_)
            | TimelineCommand::StopTimeline(_)
            | TimelineCommand::SetTimelineRecording { .. } => {
                broadcaster.publish(
                    DISCRIMINATOR_NON_DROPPABLE,
                    &TimelineWsMessage::TimelineCommand(&event.command),
                );
            }
        }
    }
}

/// Send timeline definitions when DataProvider<Timeline> changes.
pub fn send_timelines_on_change(
    timeline_data_provider: Res<DataProvider<Timeline>>,
    broadcaster: Res<ClientEventSink>,
) {
    // Send only when timeline definitions change, not when runtime timeline state mutates.
    if !timeline_data_provider.is_changed() {
        return;
    }
    tracing::trace!("Sending timelines due to Timeline DataProvider change");
    send_timelines(timeline_data_provider, broadcaster.clone());
}

/// Send timelines to UI.
pub fn send_timelines(
    timeline_data_provider: Res<DataProvider<Timeline>>,
    broadcaster: ClientEventSink,
) {
    let mut list: Vec<Timeline> = timeline_data_provider
        .iter()
        .map(|timeline| timeline.value().clone())
        .collect();
    list.sort_by_key(|timeline| timeline.identifiers.id);

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TimelineWsMessage::TimelineDefinitions(&list),
    );
    tracing::trace!("Sending timeline definitions to websocket clients");
}

/// Send runtime timeline recording states when changed.
pub fn send_timeline_recording_states_on_change(
    recording_states: Res<TimelineRecordingStates>,
    broadcaster: Res<ClientEventSink>,
) {
    if !recording_states.is_changed() {
        return;
    }

    send_timeline_recording_states(&recording_states, &broadcaster);
}

/// Send runtime timeline recording states to UI.
pub fn send_timeline_recording_states(
    recording_states: &TimelineRecordingStates,
    broadcaster: &ClientEventSink,
) {
    let states = recording_states.sorted_states();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TimelineWsMessage::TimelineRecordingStates(&states),
    );
    tracing::trace!("Sending timeline recording states to websocket clients");
}

/// Send active timeline recording previews when changed.
pub fn send_timeline_recording_previews_on_change(
    recording_sessions: Res<TimelineRecordingSessions>,
    broadcaster: Res<ClientEventSink>,
) {
    if !recording_sessions.is_changed() {
        return;
    }

    send_timeline_recording_previews(&recording_sessions, &broadcaster);
}

/// Send active timeline recording previews to UI.
pub fn send_timeline_recording_previews(
    recording_sessions: &TimelineRecordingSessions,
    broadcaster: &ClientEventSink,
) {
    let previews = recording_sessions.sorted_previews();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TimelineWsMessage::TimelineRecordingPreviews(&previews),
    );
    tracing::trace!("Sending timeline recording previews to websocket clients");
}

/// Send runtime lookahead action statuses when changed.
pub fn send_timeline_lookahead_item_statuses_on_change(
    statuses: Res<TimelineLookaheadActionStatuses>,
    broadcaster: Res<ClientEventSink>,
) {
    if !statuses.is_changed() {
        return;
    }

    send_timeline_lookahead_item_statuses(&statuses, &broadcaster);
}

/// Send runtime lookahead action statuses to UI.
pub fn send_timeline_lookahead_item_statuses(
    statuses: &TimelineLookaheadActionStatuses,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TimelineWsMessage::TimelineLookaheadActionStatuses(&statuses.statuses),
    );
    tracing::trace!("Sending timeline lookahead action statuses to websocket clients");
}

/// Broadcast beatgrid detection started.
pub fn broadcast_beatgrid_detection_started(
    broadcaster: &ClientEventSink,
    message: &BeatgridDetectionStarted,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TimelineWsMessage::BeatgridDetectionStarted(message),
    );
}

/// Broadcast beatgrid detection proposal ready.
pub fn broadcast_beatgrid_detection_ready(
    broadcaster: &ClientEventSink,
    message: &BeatgridDetectionReady,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TimelineWsMessage::BeatgridDetectionReady(message),
    );
}

/// Broadcast beatgrid detection failure.
pub fn broadcast_beatgrid_detection_failed(
    broadcaster: &ClientEventSink,
    message: &BeatgridDetectionFailed,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TimelineWsMessage::BeatgridDetectionFailed(message),
    );
}

/// Handle ResyncState by sending timelines immediately
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    timeline_data_provider: Res<DataProvider<Timeline>>,
    recording_states: Res<TimelineRecordingStates>,
    recording_sessions: Res<TimelineRecordingSessions>,
    lookahead_statuses: Res<TimelineLookaheadActionStatuses>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_timelines(timeline_data_provider, broadcaster.clone());
    send_timeline_recording_states(&recording_states, &broadcaster);
    send_timeline_recording_previews(&recording_sessions, &broadcaster);
    send_timeline_lookahead_item_statuses(&lookahead_statuses, &broadcaster);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// Verifies websocket timeline commands pass through undo-aware pending dispatch.
    fn deserialize_timeline_command_queues_pending_command_with_undo_id() {
        let mut world = World::new();
        world.insert_resource(PendingCommandBuffer::default());

        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        deserialize_timeline_command(
            &mut world,
            serde_json::json!({
                "type": "StopTimeline",
                "data": 9
            }),
            command_id,
            undo_id,
        )
        .expect("timeline command should deserialize");

        let pending_commands = world
            .resource_mut::<PendingCommandBuffer>()
            .drain()
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(pending_commands.len(), 1);
        assert_eq!(pending_commands[0].command_id, command_id);
        assert_eq!(pending_commands[0].undo_id, undo_id);
        assert!(matches!(
            pending_commands[0]
                .payload
                .as_any()
                .downcast_ref::<TimelineCommand>(),
            Some(TimelineCommand::StopTimeline(9))
        ));
    }
}
