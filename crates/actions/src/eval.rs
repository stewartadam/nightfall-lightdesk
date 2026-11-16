// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The command-language eval action, which runs a command line as if it were typed.

use bevy_app::App;
use bevy_ecs::prelude::World;
use nightfall_engine::prelude::EngineCommand;
use nightfall_playback_planner::TimelineEvalActionPlan;
use serde::{Deserialize, Serialize};

use crate::{
    ActionAppExt, ActionDescriptor, ActionId, ActionInvocation, ActionParameter,
    ActionParameterKind, ActionReference, ActionRegistry, ExternalCommandInvocation,
    InvocationDispatch, InvocationError, submit_command,
};

/// Stable action ID for evaluating a desk command.
pub const DESK_EVAL_ACTION_ID: &str = "desk.eval";

/// Persisted arguments for desk command evaluation actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DeskEvalActionArguments {
    /// Command text evaluated by the desk command parser.
    pub command: String,
}

/// Creates a persisted desk-eval action reference.
pub fn desk_eval_action(command: impl Into<String>) -> ActionReference {
    ActionReference::with_arguments(
        DESK_EVAL_ACTION_ID,
        &DeskEvalActionArguments {
            command: command.into(),
        },
    )
    .expect("desk eval action arguments should serialize")
}

/// Registers the eval action and the timeline plan that replays its command text.
///
/// [`crate::ActionsPlugin`] calls this; focused apps without the plugin can call it directly.
/// Registering it again does nothing, so such an app can still add the plugin afterwards.
pub fn register_eval_action(app: &mut App) {
    let already_registered = app
        .world()
        .get_resource::<ActionRegistry>()
        .is_some_and(|registry| registry.get(&ActionId::new(DESK_EVAL_ACTION_ID)).is_some());
    if already_registered {
        return;
    }
    app.register_action::<DeskEvalActionArguments, _>(
        ActionDescriptor::new(DESK_EVAL_ACTION_ID, "Evaluate command", "Desk")
            .with_description("Runs a desk command line as if it were typed")
            .with_parameter(ActionParameter::required(
                "command",
                "Command",
                ActionParameterKind::Text,
            )),
        invoke_desk_eval,
    )
    .register_action_capability::<DeskEvalActionArguments, TimelineEvalActionPlan, _>(
        DESK_EVAL_ACTION_ID,
        TimelineEvalActionPlan::CAPABILITY,
        |arguments| {
            Ok(TimelineEvalActionPlan {
                command: arguments.command,
            })
        },
    );
}

/// Submits a tracked eval command and announces the command text to the invoking surface.
fn invoke_desk_eval(
    world: &mut World,
    arguments: DeskEvalActionArguments,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    let command_id = submit_command(
        world,
        invocation,
        EngineCommand::Eval(arguments.command.clone()),
    )?;
    world.write_message(ExternalCommandInvocation {
        invocation_id: invocation.invocation_id,
        command_id,
        command: arguments.command,
        surface: invocation.surface,
        source: invocation.source_label(),
    });
    Ok(InvocationDispatch::Submitted { command_id })
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;
    use nightfall_engine::prelude::{CommandTracker, PendingCommandBuffer};

    use super::*;
    use crate::{ActionSurface, ActionsPlugin, InvocationOutcome, InvocationResult};

    /// Verifies eval invocations submit tracked commands and announce their source.
    #[test]
    fn desk_eval_action_submits_command_and_source_notification() {
        let mut app = App::new();
        app.init_resource::<CommandTracker>();
        app.init_resource::<PendingCommandBuffer>();
        app.add_plugins(ActionsPlugin);
        app.world_mut().write_message(
            ActionInvocation::trigger(desk_eval_action("clip 1 go"), ActionSurface::Osc)
                .with_source("OSC 127.0.0.1:9000"),
        );

        app.update();

        let pending = app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain();
        let [envelope] = pending.as_slice() else {
            panic!("eval invocation should queue one desk command");
        };
        assert!(matches!(
            envelope.payload.as_any().downcast_ref::<EngineCommand>(),
            Some(EngineCommand::Eval(value)) if value == "clip 1 go"
        ));
        assert!(
            app.world()
                .resource::<CommandTracker>()
                .is_active(envelope.command_id)
        );
        let notifications = app
            .world_mut()
            .resource_mut::<Messages<ExternalCommandInvocation>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].command_id, envelope.command_id);
        assert_eq!(notifications[0].source, "OSC 127.0.0.1:9000");
        let result = app
            .world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .expect("the eval action should emit an invocation result");
        assert!(matches!(
            result.outcome,
            InvocationOutcome::Submitted { command_id } if command_id == envelope.command_id
        ));
    }
}
