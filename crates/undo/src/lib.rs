// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::{EnginePlugin, prelude::*};

use crate::commands::UndoCommand;
use crate::dispatcher::UndoRegistry;
use crate::manager::UndoManager;

pub mod commands;
pub mod context;
pub mod dispatcher;
pub mod manager;
pub mod systems;
pub mod traits;
pub mod websocket;

pub mod prelude {
    pub use crate::UndoPlugin;
    pub use crate::commands::UndoCommand;
    pub use crate::context::UndoContext;
    pub use crate::dispatcher::UndoRegistry;
    pub use crate::manager::{UndoConfig, UndoEntry, UndoGroup, UndoManager};
    pub use crate::traits::UndoableOperation;
}

/// Plugin that enables undo/redo functionality across the console.
pub struct UndoPlugin;

impl Plugin for UndoPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering UndoPlugin");
        assert!(
            app.is_plugin_added::<EnginePlugin>(),
            "UndoPlugin requires EnginePlugin (provides CommandIngressRouter)"
        );

        register_ingress_command::<UndoCommand>(app);

        // Register WebSocket deserializer for UndoCommand
        register_command_deserializer::<UndoCommand>(app, websocket::deserialize_undo_command);

        // Initialize resources
        app.init_resource::<UndoManager>();
        app.init_resource::<PendingCommandBuffer>();
        app.init_resource::<PendingEngineActionBuffer>();

        // Initialize UndoRegistry to capture the undoable command types registered by plugin crates
        app.init_resource::<UndoRegistry>();

        // Process pending commands (must run before EventHandling to capture inverses)
        app.add_systems(
            Update,
            (
                dispatcher::process_pending_commands,
                dispatcher::process_pending_actions,
            )
                .chain()
                .after(InputHandling)
                .before(EventHandling),
        );

        // Register handler systems
        app.add_systems(Update, systems::handle_undo_commands.in_set(EventHandling));
        app.add_systems(
            Last,
            (
                systems::finish_command_undo_groups,
                systems::finalize_detached_undo_groups,
            )
                .chain(),
        );
    }
}
