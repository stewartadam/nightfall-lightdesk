// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Boards: operator-arranged grids of buttons for clips, groups, blueprints and masters.
//!
//! Boards are shared showfile objects edited one element at a time. A board press runs the
//! target's default action through the action registry, and button states are derived from
//! the live show and published to every client.

use bevy_app::{App, Plugin, PostUpdate, Update};
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;
#[cfg(not(target_arch = "wasm32"))]
// Leaf crate: mark the cargo-hakari workspace-hack as used so cargo's unused_dependencies lint passes.
use nightfall_workspace_hack as _;

pub mod command;
pub mod press;
pub mod status;
mod undo;
pub mod websocket;

pub mod prelude {
    pub use crate::BoardsPlugin;
    pub use crate::command::BoardCommand;
    pub use crate::press::{BOARD_PRESS_ACTION_ID, BoardPressArguments};
    pub use crate::status::{BoardElementStatus, BoardItem, BoardItemState, BoardStatus};
}

/// Plugin registering board storage, commands, undo, the press action and publication.
pub struct BoardsPlugin;

impl Plugin for BoardsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<DataProvider<Board>>();
        register_ingress_command::<command::BoardCommand>(app);
        register_buffered_command::<command::BoardCommand>(app);
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<command::BoardCommand>();
        press::register_board_press_action(app);

        app.add_systems(Update, command::handle_board_commands.in_set(EventHandling));
        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
        app.add_systems(
            PostUpdate,
            (
                websocket::send_boards_on_change,
                websocket::send_board_states_on_change,
            )
                .in_set(ClientFeedback),
        );
    }
}
