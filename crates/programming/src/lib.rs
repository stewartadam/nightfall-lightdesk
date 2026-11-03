// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programming: the operator's working selection and live values, and the groups and Blueprints
//! built from them.
//!
//! [`ProgrammingPlugin`] holds the active fixture selection and the values set on it, paints them
//! into the programmer layer that the compositor merges with playbacks, and handles clearing and
//! releasing them. It also stores programmer contents into cues, Blueprints, and groups, recalls
//! them back into the programmer, and owns the group and Blueprint stores with their commands
//! and undo support.

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::prelude::{Blueprint, Group};
use nightfall_actions::{ActionAppExt, ActionDescriptor};
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::action_model::{ProgrammerOperation, UserCommand};
use crate::resources::Programmer;

pub mod action_model;
pub mod ast_conv;
pub mod blueprints;
pub mod command_planner;
pub mod events;
pub mod groups;
pub mod painter;
pub mod resources;
pub mod undo;
pub mod websocket;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::ProgrammingPlugin;
    pub use crate::action_model::{
        AttributeFilter, ClearCommand, ClearTarget, ProgrammerOperation, ReleaseCommand,
        ReleaseTarget, Scope, UserCommand,
    };
    pub use crate::blueprints::{BlueprintCommand, BlueprintOperation};
    pub use crate::command_planner::{ProgrammerCommandPlanner, ProgrammerPlanContext};
    pub use crate::events::{
        ProgrammerAttributeOperation, ProgrammerAttributeSource, ProgrammerCommand, StoreCueId,
        StoreCuePartId, StoreCueWorkflows, StoreMode,
    };
    pub use crate::groups::{GroupCommand, GroupOperation};
    pub use crate::resources::{Programmer, ProgrammerMode};
    pub use crate::undo::{RemoveProgrammerInstructionByUuid, RestoreProgrammerState};
}

/// Plugin for adding programmer functionality to the app
pub struct ProgrammingPlugin;
/// Stable action ID for clearing the programmer.
pub const PROGRAMMER_CLEAR_ACTION_ID: &str = "programmer.clear";

impl Plugin for ProgrammingPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering ProgrammingPlugin");
        register_client_command::<events::ProgrammerCommand>(app, Undo::Captured);
        register_client_command::<UserCommand>(app, Undo::Captured);
        register_engine_operation::<ProgrammerOperation>(app);
        app.register_command_action::<serde::de::IgnoredAny, events::ProgrammerCommand, _>(
            ActionDescriptor::new(PROGRAMMER_CLEAR_ACTION_ID, "Clear programmer", "Programmer")
                .with_description("Clears the programmer selection and values"),
            |_world, _arguments| Ok(events::ProgrammerCommand::ClearProgrammer),
        );
        nightfall_engine::protocol::dispatch_ast::register_converter::<
            ast_conv::ProgrammerAstConverter,
        >();
        register_engine_operation::<undo::RestoreProgrammerState>(app);
        register_engine_operation::<undo::RemoveProgrammerInstructionByUuid>(app);
        register_client_command::<groups::GroupCommand>(app, Undo::Captured);
        app.add_message::<EngineOperationEnvelope<groups::GroupOperation>>();
        register_client_command::<blueprints::BlueprintCommand>(app, Undo::Captured);
        app.add_message::<EngineOperationEnvelope<blueprints::BlueprintOperation>>();
        app.add_message::<OperationResult<(), CommandError>>();
        app.init_resource::<DataProvider<Group>>();
        app.init_resource::<DataProvider<Blueprint>>();
        app.init_resource::<BlueprintReferenceIndex>();
        app.init_resource::<GroupReferenceIndex>();
        app.publish_object_changes::<Blueprint>();

        app.add_systems(
            PostUpdate,
            websocket::forward_programmer_commands.in_set(ClientFeedback),
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
        app.init_resource::<events::PendingProgrammerActionWorkflows>();

        // Register undoable commands
        {
            let mut registry = app.world_mut().resource_mut::<UndoRegistry>();
            registry.register::<events::ProgrammerCommand>();
            registry.register_operation::<undo::RestoreProgrammerState>();
            registry.register_operation::<undo::RemoveProgrammerInstructionByUuid>();
            registry.register::<groups::GroupCommand>();
            registry.register::<blueprints::BlueprintCommand>();
        }

        app.add_systems(
            Update,
            events::plan_pending_user_commands
                .after(DeskEventSet::EvalExpansion)
                .in_set(PendingCommandExpansion),
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
                    // Selection changes and releases land before blueprint applications, so a
                    // command batch that releases one blueprint and applies another (a board
                    // press in a solo region) keeps the new values.
                    events::handle_blueprint_events.after(events::handle_programmer_events),
                    events::rebuild_programmer_blueprint_reference_index
                        .after(events::handle_blueprint_events)
                        .after(events::handle_programmer_events)
                        .before(blueprints::events::crud_events),
                    groups::events::crud_events,
                    groups::events::action_events,
                    blueprints::events::crud_events,
                    blueprints::events::action_events,
                    events::resume_store_object_workflows
                        .after(groups::events::action_events)
                        .after(blueprints::events::action_events),
                    events::handle_undo_events,
                    events::handle_remove_instruction_events,
                )
                    .in_set(EventHandling),
                events::finish_programmer_action_workflows.after(EventHandling),
            ),
        );
        app.add_systems(
            Render,
            painter::materialize_and_paint_programmer.in_set(LayerGeneration),
        );
    }
}
