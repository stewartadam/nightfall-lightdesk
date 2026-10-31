// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timecode objects and the generators that advance them.
//!
//! A timecode is a clock that timelines follow. Its generator either runs on the engine's own
//! clock or chases an external source, reading the latest frame that an input service (MIDI
//! timecode, Art-Net timecode, or LTC audio) published to its feed.

#![warn(missing_docs)]

use std::time::Duration;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};

pub mod ast_conv;
pub mod components;
pub mod events;
pub mod external;
pub mod systems;
pub mod timecode;
mod undo;
pub mod websocket;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::TimecodePlugin;
    pub use crate::components::TimecodeGenerator;
    pub use crate::external::{
        ExternalTimecodeFeed, ExternalTimecodeFeeds, ExternalTimecodeFrame, PlayStateInference,
        SmpteTime,
    };
    pub use crate::timecode::{
        Timecode, TimecodeAudioInput, TimecodeRate, TimecodeSignal, TimecodeSource, TimecodeState,
    };
    pub use crate::{TimecodeCommand, TimecodeEvent, TimecodeOperation};
}

/// Plugin for adding timecode functionality to the app
pub struct TimecodePlugin;
impl Plugin for TimecodePlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering TimecodePlugin");
        register_ingress_command::<TimecodeCommand>(app);
        app.add_message::<EngineOperationEnvelope<TimecodeOperation>>();
        app.add_message::<TimecodeEvent>();
        nightfall_engine::protocol::dispatch_ast::register_converter::<
            ast_conv::TimecodeAstConverter,
        >();

        register_command_deserializer::<TimecodeCommand>(
            app,
            websocket::deserialize_timecode_command,
        );

        app.init_resource::<DataProvider<timecode::Timecode>>();
        app.init_resource::<external::ExternalTimecodeFeeds>();

        // Register undoable commands
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<TimecodeCommand>();

        app.add_systems(
            Render,
            (systems::update_timecode_system).in_set(ClockUpdate),
        );
        app.add_systems(
            Update,
            (
                events::handle_events,
                events::handle_actions,
                events::crud_events,
            )
                .in_set(EventHandling),
        );
        // WebSocket sends owned by timecode plugin
        app.add_systems(Render, websocket::send_timecodes.in_set(ClientOutput));

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// Engine commands for timecode actions
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum TimecodeCommand {
    /// Start a timecode
    StartTimecode(u32),

    /// Pause a timecode
    PauseTimecode(u32),

    /// Stop a timecode
    StopTimecode(u32),

    /// Seek a timecode
    SeekTimecode {
        /// ID of the timecode to seek
        id: u32,
        /// Position to seek to
        position: Duration,
    },

    /// Store a timecode
    StoreTimecode(timecode::Timecode),

    /// Rename a timecode
    RenameTimecode {
        /// ID of the timecode to rename
        id: u32,
        /// New ID for the timecode
        new_id: u32,
    },

    /// Delete a timecode
    DeleteTimecode(u32),
}

impl IngressCommand for TimecodeCommand {}

/// Concrete runtime operations owned by the timecode domain.
#[derive(Debug, Clone, EnginePayload)]
pub enum TimecodeOperation {
    /// Starts or resumes a timecode generator.
    Start(u32),
    /// Pauses a timecode generator without resetting its position.
    Pause(u32),
    /// Stops and resets a timecode generator.
    Stop(u32),
    /// Moves a timecode generator to an explicit position.
    Seek {
        /// Numeric timecode identifier.
        id: u32,
        /// Target generator position.
        position: Duration,
    },
}

impl EngineOperation for TimecodeOperation {}

/// Facts published after the timecode domain applies runtime or CRUD work.
#[derive(Debug, Clone, Message)]
pub enum TimecodeEvent {
    /// A timecode generator started or resumed.
    Started(u32),
    /// A timecode generator paused.
    Paused(u32),
    /// A timecode generator stopped and reset.
    Stopped(u32),
    /// A timecode generator moved to an explicit position.
    Seeked {
        /// Numeric timecode identifier.
        id: u32,
        /// Applied generator position.
        position: Duration,
    },
    /// A persisted timecode and its generator were deleted.
    Deleted(u32),
}
