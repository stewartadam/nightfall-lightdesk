// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! This crate provides timeline functionality

#![warn(missing_docs)]

use std::time::Duration;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_instances::DomainInstanceReconstructionRequest;
use nightfall_timecode::prelude::Timecode;
use nightfall_undo::prelude::*;
#[cfg(feature = "http")]
use nightfall_websocket::WebsocketPlugin;
use serde::{Deserialize, Serialize};

use crate::prelude::*;

/// AST converter for timeline commands
pub mod ast_conv;
mod audio_integration;
#[cfg(feature = "beatgrid-detect")]
pub mod beat_model;
#[cfg(feature = "beatgrid-detect")]
#[doc(hidden)]
pub mod beat_this_detection;
mod beatgrid_detection;
mod browser_audio;
mod components;
mod diagnostics;
#[cfg(feature = "http")]
mod http_routes;
mod planner;
mod recording;
mod storage;
mod systems;
mod timeline;
mod timeline_events;
mod undo;
pub mod websocket;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::TimelinePlugin;
    pub use crate::browser_audio::{TimelineAudioDirective, TimelineAudioLoopRange};
    pub use crate::components::{MaterializedTimeline, SpawnedEntityType};
    pub use crate::recording::{
        TimelineRecordingPreview, TimelineRecordingState, TimelineRecordingStates,
    };
    pub use crate::timeline::{
        Action, ActionKind, AutomationLane, AutomationPoint, BeatMarker, BeatgridData,
        BeatgridDetectionFailed, BeatgridDetectionReady, BeatgridDetectionStarted,
        BeatgridProposal, BeatgridSource, ParameterType, Timeline, TimelineLookaheadActionBlocker,
        TimelineLookaheadActionStatus, TimelineLookaheadActionStatusKind,
        TimelineLookaheadActionStatuses, TimelineLookaheadMode, TimelineLoopRange, TimelineMarker,
        TimelineNondeterministicSeekBehavior, TimelineRegion, TimelineScrollMode,
        TimelineSeekBehavior, TimelineSelection, TimelineState, TimelineStopBehavior,
        TimelineTriggerMode, Track,
    };
    pub use crate::{TimelineAction, TimelineCommand};
}

/// Resource controlling process-wide timeline audio output.
#[cfg(feature = "audio")]
#[derive(Resource)]
pub(crate) struct TimelineAudioOutputEnabled(pub bool);

/// Plugin for adding timeline functionality to the app.
pub struct TimelinePlugin {
    audio_enabled: bool,
    browser_audio_enabled: bool,
    http_enabled: bool,
}

impl TimelinePlugin {
    /// Builds a timeline plugin with the supplied process-wide audio setting.
    #[must_use]
    pub const fn new(audio_enabled: bool) -> Self {
        Self {
            audio_enabled,
            browser_audio_enabled: false,
            http_enabled: true,
        }
    }

    /// Build a timeline plugin that emits bundled-media directives to a browser host.
    #[must_use]
    pub const fn browser_demo() -> Self {
        Self {
            audio_enabled: false,
            browser_audio_enabled: true,
            http_enabled: false,
        }
    }
}

impl Plugin for TimelinePlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering TimelinePlugin");
        #[cfg(feature = "http")]
        if self.http_enabled {
            assert!(
                app.is_plugin_added::<WebsocketPlugin>(),
                "TimelinePlugin with http requires WebsocketPlugin (provides HttpRouteRegistry)"
            );
        }
        #[cfg(not(feature = "http"))]
        let _ = self.http_enabled;
        register_ingress_command::<TimelineCommand>(app);
        register_engine_action::<TimelineAction>(app);
        nightfall_engine::protocol::dispatch_ast::register_converter::<
            ast_conv::TimelineAstConverter,
        >();
        register_command_deserializer::<TimelineCommand>(
            app,
            websocket::deserialize_timeline_command,
        );

        app.init_resource::<DataProvider<Timeline>>();
        app.init_resource::<beatgrid_detection::BeatgridDetectionRuntime>();
        app.init_resource::<recording::TimelineRecordingStates>();
        app.init_resource::<recording::TimelineRecordingSessions>();
        app.init_resource::<recording::TimelineCommandOrigins>();
        app.init_resource::<systems::TimelinePausedPlaybackRates>();
        app.init_resource::<systems::TimelineReconstructionDeferredFlush>();
        app.init_resource::<timeline::TimelineLookaheadActionStatuses>();
        #[cfg(feature = "audio")]
        app.insert_resource(TimelineAudioOutputEnabled(self.audio_enabled));
        #[cfg(not(feature = "audio"))]
        let _ = self.audio_enabled;
        diagnostics::register_timeline_diagnostics(app);
        app.add_message::<DomainInstanceReconstructionRequest>();
        app.add_message::<timeline_events::TimelineActionsChanged>();

        // Register undoable commands
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<TimelineCommand>();
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register_action::<TimelineAction>();
        #[cfg(feature = "http")]
        if self.http_enabled {
            app.world_mut()
                .resource_mut::<nightfall_websocket::prelude::HttpRouteRegistry>()
                .register(
                    "/api/showfiles/current/timeline-audio/{timeline_uid}",
                    axum::routing::post(crate::http_routes::upload_timeline_audio)
                        .layer(crate::http_routes::timeline_audio_upload_limit()),
                );
        }
        audio_integration::add_event_handling_systems(app);
        if self.browser_audio_enabled {
            app.add_systems(
                Update,
                browser_audio::emit_browser_audio_directives
                    .after(systems::update_timeline_system)
                    .in_set(LayerGeneration),
            );
        }

        app.add_systems(
            Update,
            (
                recording::record_timeline_actions_system.after(EventHandling),
                recording::finish_timeline_recording_sessions_system
                    .after(recording::record_timeline_actions_system),
                recording::clear_timeline_command_origins
                    .after(recording::finish_timeline_recording_sessions_system),
            )
                .before(ClientOutput),
        );

        // WebSocket forwarding and sends owned by timeline plugin
        app.add_systems(
            Update,
            (
                websocket::forward_timeline_commands,
                websocket::send_timelines_on_change,
                websocket::send_timeline_recording_states_on_change,
                websocket::send_timeline_recording_previews_on_change,
                websocket::send_timeline_lookahead_item_statuses_on_change,
            )
                .in_set(ClientOutput),
        );

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// User-facing commands for timeline runtime and persistence changes.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum TimelineCommand {
    /// Activate a timeline
    StartTimeline(u32),

    /// Deactivate a timeline
    StopTimeline(u32),

    /// Store a timeline object
    StoreTimeline(Timeline),

    /// Create a timeline and either reuse or create its same-numbered timecode.
    CreateTimeline {
        /// Timeline definition to create.
        timeline: Timeline,
        /// Default timecode to create when the same-numbered timecode does not exist.
        timecode: Timecode,
    },

    /// Restore a timeline creation during redo with its original ownership semantics.
    RestoreTimelineCreation {
        /// Timeline definition to restore.
        timeline: Timeline,
        /// Owned timecode to restore, or `None` when the timeline used a shared timecode.
        owned_timecode: Option<Timecode>,
    },

    /// Delete a timeline created as one atomic operation.
    DeleteCreatedTimeline {
        /// Exact UID of the timeline created by the operation.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: uuid::Uuid,
        /// Exact UID of its owned timecode, if the operation created one.
        owned_timecode_uid: Option<uuid::Uuid>,
    },

    /// Store or update a timeline marker.
    StoreTimelineMarker {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Marker data to store.
        marker: TimelineMarker,
    },

    /// Delete a timeline marker.
    DeleteTimelineMarker {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// UID of the marker to delete.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        marker_uid: uuid::Uuid,
    },

    /// Store or update a timeline region.
    StoreTimelineRegion {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Region data to store.
        region: TimelineRegion,
    },

    /// Delete a timeline region.
    DeleteTimelineRegion {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// UID of the region to delete.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        region_uid: uuid::Uuid,
    },

    /// Set or clear the persisted loop range for a timeline.
    SetTimelineLoopRange {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Loop range to store, or `None` to clear it.
        loop_range: Option<TimelineLoopRange>,
    },

    /// Set runtime-only timeline recording state.
    SetTimelineRecording {
        /// ID of the timeline to arm or disarm.
        timeline_id: u32,
        /// Whether the timeline should record external desk actions.
        enabled: bool,
        /// Track ID that should receive recorded actions.
        target_track_id: Option<String>,
    },

    /// Insert actions captured by timeline recording.
    InsertRecordedActions {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Track ID to insert into.
        track_id: String,
        /// Actions captured by the recorder.
        actions: Vec<Action>,
    },

    /// Delete recorded timeline actions by ID.
    DeleteRecordedActions {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Track ID to delete from.
        track_id: String,
        /// Action IDs to delete.
        action_ids: Vec<String>,
    },

    /// Nudge selected timeline objects by a signed millisecond delta.
    NudgeTimelineSelection {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Selected timeline objects to nudge.
        selection: Vec<TimelineSelection>,
        /// Signed delta in milliseconds.
        delta_ms: i32,
    },

    /// Request beatgrid detection for a timeline.
    RequestBeatgridDetection {
        /// ID of the timeline to analyze.
        timeline_id: u32,
    },

    /// Apply a previously generated beatgrid proposal.
    ApplyBeatgridProposal {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Proposal request identifier.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        request_id: uuid::Uuid,
        /// Optional override for beats per bar.
        beats_per_bar: Option<u8>,
        /// Optional beat offset (mod beats_per_bar) to choose downbeat phase.
        downbeat_offset: Option<u8>,
    },

    /// Reject and discard a previously generated beatgrid proposal.
    RejectBeatgridProposal {
        /// ID of the timeline whose proposal should be discarded.
        timeline_id: u32,
        /// Proposal request identifier.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        request_id: uuid::Uuid,
    },

    /// Set the absolute first-marker time for the persisted beatgrid and shift all markers accordingly.
    SetBeatgridStart {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Audio fingerprint guard to avoid applying stale alignment to different audio content.
        audio_fingerprint: String,
        /// Absolute time for beat marker index 0.
        first_marker_time: Duration,
    },

    /// Rename a timeline object
    RenameTimeline {
        /// ID of the timeline to rename
        id: u32,
        /// New ID for the timeline
        new_id: u32,
    },

    /// Delete a timeline object
    DeleteTimeline(u32),
}

impl IngressCommand for TimelineCommand {}

/// Concrete internal runtime control for materialized timelines.
#[derive(Debug, Clone, EnginePayload)]
pub enum TimelineAction {
    /// Activate a materialized timeline by numeric identifier.
    Start(u32),
    /// Deactivate a materialized timeline by numeric identifier.
    Stop(u32),
    /// Persist actions captured by a completed timeline recording session.
    InsertRecordedActions {
        /// ID of the timeline to update.
        timeline_id: u32,
        /// Track ID to insert into.
        track_id: String,
        /// Actions captured by the recorder.
        actions: Vec<Action>,
    },
}

impl EngineAction for TimelineAction {}
