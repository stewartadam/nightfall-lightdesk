// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Macros: numbered show objects holding command-line text that runs in order when started.
//!
//! A macro runs through the same desk command path as typed input, one statement at a time,
//! so every surface that can fire an action (boards, MIDI, OSC, keyboard, timeline) and the
//! `macro <id> start` command share one runner. See [`runner`] for how runs advance and how
//! they group into undo steps.

use bevy_app::{App, Plugin, PostUpdate, Update};
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;
#[cfg(not(target_arch = "wasm32"))]
use nightfall_workspace_hack as _;

pub mod actions;
mod ast_conv;
pub mod command;
pub mod runner;
mod undo;
pub mod websocket;

pub mod prelude {
    pub use crate::MacrosPlugin;
    pub use crate::actions::{
        MACRO_RELEASE_ACTION_ID, MACRO_START_ACTION_ID, MACRO_STOP_ACTION_ID, MacroActionArguments,
        release_macro_action, start_macro_action, stop_macro_action,
    };
    pub use crate::command::MacroCommand;
    pub use crate::runner::{MacroRunPhase, MacroRunStatus, MacroRuns};
}

/// Plugin that stores macros, runs them and exposes them to clients and action surfaces.
pub struct MacrosPlugin;

impl Plugin for MacrosPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<DataProvider<Macro>>();
        app.init_resource::<runner::MacroRuns>();
        register_ingress_command::<command::MacroCommand>(app);
        register_command_deserializer::<command::MacroCommand>(
            app,
            websocket::deserialize_macro_command,
        );
        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::MacroAstConverter>(
        );
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<command::MacroCommand>();
        actions::register_macro_actions(app);

        app.add_systems(
            Update,
            (
                (runner::record_statement_results, runner::advance_macro_runs)
                    .chain()
                    .after(EventHandling)
                    .before(ResyncHandling),
                command::handle_macro_commands.in_set(EventHandling),
                websocket::handle_resync_state.in_set(ResyncHandling),
            ),
        );
        app.add_systems(
            PostUpdate,
            (
                websocket::send_macros_on_change,
                websocket::send_macro_runs_on_change,
            )
                .in_set(ClientFeedback),
        );
    }
}
