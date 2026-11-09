// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Park: holds fixture parameters at fixed values over every other source of output.
//!
//! A parked parameter outputs the value it had when it was parked, whatever cues, FX, the
//! programmer, masters or virtual dimmers do, until it is unparked. It is show insurance for a
//! dead mover, house lights or a fixture that must not move. Park is show-wide state, saved with
//! the show, and survives `release` and `clear`. See [`output`] for where park applies in the
//! render pipeline.

use bevy_app::{App, Plugin, Update};
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall_actions::{ActionAppExt, ActionDescriptor};
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::{ParkedOutput, ParkedVirtualIntensity};
use nightfall_undo::prelude::*;
#[cfg(not(target_arch = "wasm32"))]
use nightfall_workspace_hack as _;

mod ast_conv;
pub mod command;
pub mod output;
pub mod state;
mod undo;
mod websocket;

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use crate::ParkPlugin;
    pub use crate::command::ParkCommand;
    pub use crate::state::{ParameterKey, ParkedParameter, ParkedParameters};
}

/// Stable action ID for unparking every parked parameter.
pub const PARK_UNPARK_ALL_ACTION_ID: &str = "park.unpark_all";

/// Plugin that parks fixture parameters and holds them in output.
pub struct ParkPlugin;

impl Plugin for ParkPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<state::ParkedParameters>();
        app.init_resource::<output::ParkTargets>();
        register_client_command::<command::ParkCommand>(app, Undo::Captured);
        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::ParkAstConverter>(
        );
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<command::ParkCommand>();
        app.register_command_action::<serde::de::IgnoredAny, command::ParkCommand, _>(
            ActionDescriptor::new(PARK_UNPARK_ALL_ACTION_ID, "Unpark all", "Park")
                .with_description("Unparks every parked parameter so it follows playback again"),
            |_world, _arguments| Ok(command::ParkCommand::UnparkAll),
        );

        app.add_systems(Update, command::handle_park_commands.in_set(EventHandling));
        app.add_systems(
            Render,
            (
                (
                    output::resolve_park_targets,
                    output::apply_parked_virtual_intensity,
                )
                    .chain()
                    .in_set(ParkedVirtualIntensity),
                output::apply_parked_output.in_set(ParkedOutput),
            ),
        );
        app.add_resource_feed::<state::ParkedParameters>();
    }
}
