// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Main crate for the nightfall programmer interface
//!
//! This crate provides the core functionality for managing lighting cues and programmer operations
//! in the nightfall lighting control system.

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::action_model::{ProgrammerAction, UserCommand};
use crate::resources::Programmer;

pub mod action_model;
pub mod ast_conv;
pub mod automation_actions;
pub mod command_planner;
pub mod events;
pub mod painter;
pub mod resources;
pub mod undo;
pub mod websocket;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::ProgrammerPlugin;
    pub use crate::action_model::{
        AttributeFilter, ClearCommand, ClearTarget, ProgrammerAction, ReleaseCommand,
        ReleaseTarget, Scope, UserCommand,
    };
    pub use crate::command_planner::{ProgrammerCommandPlanner, ProgrammerPlanContext};
    pub use crate::events::{
        ProgrammerAttributeOperation, ProgrammerAttributeSource, ProgrammerCommand, StoreCueId,
        StoreCuePartId, StoreCueWorkflows, StoreMode,
    };
    pub use crate::resources::{Programmer, ProgrammerMode};
    pub use crate::undo::{RemoveProgrammerInstructionByUuid, RestoreProgrammerState};
}

/// Plugin for adding programmer functionality to the app
pub struct ProgrammerPlugin;
impl Plugin for ProgrammerPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering ProgrammerPlugin");
        automation_actions::register_programmer_actions(app);
        register_ingress_command::<events::ProgrammerCommand>(app);
        register_ingress_command::<UserCommand>(app);
        register_engine_action::<ProgrammerAction>(app);
        nightfall_engine::protocol::dispatch_ast::register_converter::<
            ast_conv::ProgrammerAstConverter,
        >();
        register_engine_action::<undo::RestoreProgrammerState>(app);
        register_engine_action::<undo::RemoveProgrammerInstructionByUuid>(app);

        register_command_deserializer::<events::ProgrammerCommand>(
            app,
            websocket::deserialize_programmer_command,
        );
        register_command_deserializer::<UserCommand>(app, websocket::deserialize_user_command);

        app.add_systems(
            Update,
            websocket::forward_programmer_commands
                .in_set(ClientOutput)
                .after(events::handle_programmer_events)
                .after(nightfall_desk::systems::event_handlers::blueprint_events::crud_events)
                .after(nightfall_desk::systems::event_handlers::blueprint_events::action_events)
                .after(events::handle_undo_events)
                .after(events::handle_remove_instruction_events),
        );

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );

        app.init_resource::<Programmer>();
        app.init_resource::<events::StoreCueWorkflows>();
        app.init_resource::<events::StoreObjectWorkflows>();
        app.init_resource::<events::SelectionFlattenApprovals>();
        app.init_resource::<events::PendingUserCommandPlans>();

        // Register undoable commands
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<events::ProgrammerCommand>();
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register_action::<undo::RestoreProgrammerState>();
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register_action::<undo::RemoveProgrammerInstructionByUuid>();

        app.add_systems(
            Update,
            events::plan_pending_user_commands
                .after(
                    nightfall_desk::systems::event_handlers::desk_events::expand_pending_eval_commands,
                )
                .before(nightfall_undo::dispatcher::process_pending_commands),
        );

        app.add_systems(
            Update,
            (
                (
                    events::handle_group_events,
                    events::handle_programmer_events
                        .after(nightfall_fixtures::events::handle_restore_fixture_snapshot),
                    events::handle_cue_events,
                    events::resume_store_cue_workflows
                        .after(nightfall_cues::events::cue_store_operations),
                    events::handle_blueprint_events,
                    events::rebuild_programmer_blueprint_reference_index
                        .after(events::handle_blueprint_events)
                        .after(events::handle_programmer_events)
                        .before(
                            nightfall_desk::systems::event_handlers::blueprint_events::crud_events,
                        ),
                    events::resume_store_object_workflows
                        .after(nightfall_desk::systems::event_handlers::group_events::action_events)
                        .after(
                            nightfall_desk::systems::event_handlers::blueprint_events::action_events,
                        ),
                    events::handle_undo_events,
                    events::handle_remove_instruction_events,
                )
                    .in_set(EventHandling),
                painter::materialize_and_paint_programmer.in_set(LayerGeneration),
            ),
        );
    }
}
