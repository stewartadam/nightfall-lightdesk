// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programmer-owned controller actions, sharing normal command and undo behavior.

use bevy_app::App;
use nightfall_actions::{
    ActionDescriptor, ActionId, ActionInputKind, ActionRegistry, ActionSurface,
};
use serde::Deserialize;

/// Clears selection first, then programmer values on the next invocation.
pub const PROGRAMMER_CLEAR_ACTION_ID: &str = "programmer.clear";

/// Empty arguments deliberately reject accidental target or mode fields.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClearArguments {}

/// Registers programmer operations without exposing programmer dependencies to transports.
pub fn register_programmer_actions(app: &mut App) {
    app.init_resource::<ActionRegistry>();
    app.world_mut().resource_mut::<ActionRegistry>().register::<ClearArguments, _>(
        ActionDescriptor {
            id: ActionId::new(PROGRAMMER_CLEAR_ACTION_ID),
            capabilities: Vec::new(),
            label: "Clear programmer".into(),
            allowed_surfaces: vec![ActionSurface::Midi, ActionSurface::Osc, ActionSurface::Websocket],
            input_kind: ActionInputKind::Trigger,
            argument_schema: serde_json::json!({"type": "object", "additionalProperties": false}),
        },
        |world, _, invocation| nightfall_engine::action_commands::invoke_action_command(
            world, invocation, crate::events::ProgrammerCommand::ClearProgrammer,
        ),
    );
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;
    use nightfall_actions::{
        ActionInvocation, ActionReference, ActionsPlugin, InvocationOutcome, InvocationResult,
    };
    use nightfall_engine::prelude::*;

    use super::*;

    /// Controller clearing enters the existing tracked undo pipeline and rejects unknown options.
    #[test]
    fn clear_uses_tracked_programmer_command() {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.init_resource::<CommandTracker>();
        app.init_resource::<PendingCommandBuffer>();
        app.add_message::<CommandEnvelope<crate::events::ProgrammerCommand>>();
        register_programmer_actions(&mut app);
        app.world_mut().write_message(ActionInvocation::trigger(
            ActionReference::new(PROGRAMMER_CLEAR_ACTION_ID, serde_json::json!({})),
            ActionSurface::Osc,
        ));
        app.update();
        let queued = app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].undo_id, queued[0].command_id.into());
        assert!(
            app.world()
                .resource::<CommandTracker>()
                .is_active(queued[0].command_id)
        );
        assert!(matches!(
            app.world_mut()
                .resource_mut::<Messages<InvocationResult>>()
                .drain()
                .next()
                .unwrap()
                .outcome,
            InvocationOutcome::Accepted
        ));
        let registry = app.world().resource::<ActionRegistry>();
        assert!(
            registry
                .validate_binding(
                    &ActionReference::new(
                        PROGRAMMER_CLEAR_ACTION_ID,
                        serde_json::json!({"all": true})
                    ),
                    ActionSurface::Osc,
                    ActionInputKind::Trigger,
                )
                .is_err()
        );
    }
}
