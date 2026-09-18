// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! This crate provides uDMX USB output

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
pub mod systems;
pub mod timecode;
mod undo;
pub mod websocket;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::TimecodePlugin;
    pub use crate::components::TimecodeGenerator;
    pub use crate::timecode::{Timecode, TimecodeRate, TimecodeSource, TimecodeState};
    pub use crate::{TimecodeAction, TimecodeCommand, TimecodeEvent};
}

/// Plugin for adding timecode functionality to the app
pub struct TimecodePlugin;
impl Plugin for TimecodePlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering TimecodePlugin");
        register_ingress_command::<TimecodeCommand>(app);
        app.add_message::<EngineActionEnvelope<TimecodeAction>>();
        app.add_message::<TimecodeEvent>();
        nightfall_engine::protocol::dispatch_ast::register_converter::<
            ast_conv::TimecodeAstConverter,
        >();

        register_command_deserializer::<TimecodeCommand>(
            app,
            websocket::deserialize_timecode_command,
        );

        app.init_resource::<DataProvider<timecode::Timecode>>();

        // Register undoable commands
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<TimecodeCommand>();

        app.add_systems(
            Update,
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
        app.add_systems(Update, websocket::send_timecodes.in_set(ClientOutput));

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
pub enum TimecodeAction {
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

impl EngineAction for TimecodeAction {}

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
