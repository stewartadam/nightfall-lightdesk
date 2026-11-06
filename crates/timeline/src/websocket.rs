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
use bevy_ecs::system::SystemParam;
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::TimelineCommand;
use crate::recording::{TimelineRecordingSessions, TimelineRecordingStates};
use crate::timeline::{
    BeatgridDetectionFailed, BeatgridDetectionReady, BeatgridDetectionStarted, Timeline,
    TimelineLookaheadActionStatus, TimelineLookaheadActionStatuses, TimelinePlannedCue,
    TimelinePlannedCuesByAction,
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
    /// Sequence cue each timeline Go, Back, and jump action lands on
    TimelinePlannedCuesByAction(&'a [TimelinePlannedCue]),
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

/// Forward timeline commands to the UI for reactive handling.
///
/// Note: CRUD commands (StoreTimeline, RenameTimeline, DeleteTimeline) are
/// intentionally NOT forwarded here because the command echo would be sent
/// before we know if the operation succeeded. Instead, we rely on
/// [`TimelinesFeed`] to send full definitions after changes.
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
            | TimelineCommand::SetBeatgridStart { .. }
            | TimelineCommand::PlayTimeline(_)
            | TimelineCommand::PauseTimeline(_)
            | TimelineCommand::TogglePlayback(_) => {}
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

/// The timeline definitions feed, sent when definitions change and not when runtime timeline
/// state mutates.
#[derive(SystemParam)]
pub(crate) struct TimelinesFeed<'w> {
    timelines: Res<'w, DataProvider<Timeline>>,
}

impl ClientFeed for TimelinesFeed<'static> {
    /// Publishes every timeline definition in ID order.
    fn publish(feed: &TimelinesFeed<'_>, sink: &ClientEventSink) {
        let mut list: Vec<Timeline> = feed
            .timelines
            .iter()
            .map(|timeline| timeline.value().clone())
            .collect();
        list.sort_by_key(|timeline| timeline.identifiers.id);
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &TimelineWsMessage::TimelineDefinitions(&list),
        );
    }
}

impl ResourceFeed for TimelineRecordingStates {
    /// Publishes every timeline's runtime recording state.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &TimelineWsMessage::TimelineRecordingStates(&self.sorted_states()),
        );
    }
}

impl ResourceFeed for TimelineRecordingSessions {
    /// Publishes the actions staged by every active recording session.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &TimelineWsMessage::TimelineRecordingPreviews(&self.sorted_previews()),
        );
    }
}

impl ResourceFeed for TimelineLookaheadActionStatuses {
    /// Publishes every timeline action's runtime lookahead eligibility.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &TimelineWsMessage::TimelineLookaheadActionStatuses(&self.statuses),
        );
    }
}

impl ResourceFeed for TimelinePlannedCuesByAction {
    /// Publishes the sequence cue each Go, Back, and jump action lands on.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &TimelineWsMessage::TimelinePlannedCuesByAction(&self.cues),
        );
    }
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
