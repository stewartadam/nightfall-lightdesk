// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Client commands that invoke registered actions by reference.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::descriptor::ActionSurface;
use crate::invocation::{ActionInvocation, ActionReference, InvocationOutcome};

/// Commands clients send to invoke backend actions from keybindings or the palette.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ActionCommand {
    /// Invokes one action as a trigger from a client surface.
    Invoke {
        /// Action and arguments to invoke.
        action: ActionReference,
        /// Client surface that invoked the action.
        surface: ActionSurface,
    },
}

impl IngressCommand for ActionCommand {}

/// Deserializes an action command from websocket JSON into its typed envelope.
pub fn deserialize_action_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: ActionCommand = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse ActionCommand: {error}"))?;
    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));
    Ok(())
}

/// Turns client invoke commands into action invocations that finish the commands.
///
/// The command stays active until the invocation is dispatched, which then finishes it with
/// the invocation's immediate outcome through [`complete_invoke_command`].
pub fn handle_action_commands(
    mut events: MessageReader<CommandEnvelope<ActionCommand>>,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    for event in events.read() {
        let ActionCommand::Invoke { action, surface } = &event.command;
        invocations.write(
            ActionInvocation::trigger(action.clone(), *surface)
                .with_source(surface.label())
                .completing(event.command_id),
        );
    }
}

/// Finishes a client invoke command with the dispatched invocation's immediate outcome.
///
/// A rejected invocation fails the command with the invocation's code, message, and details.
/// Any other outcome succeeds with the serialized [`InvocationOutcome`] as output, so a
/// submitted domain command can be correlated through its own `CommandResult`.
pub fn complete_invoke_command(
    world: &mut World,
    command_id: CommandId,
    outcome: &InvocationOutcome,
) {
    let outcome = match outcome {
        InvocationOutcome::Failed(error) => CommandOutcome::failed(error.clone().into()),
        outcome => match CommandOutput::from_serializable(outcome) {
            Ok(output) => CommandOutcome::with_output(output),
            Err(error) => {
                tracing::error!(%command_id, %error, "action_command_output_serialization_failed");
                CommandOutcome::succeeded()
            }
        },
    };
    if let Err(error) = finish_command_in_world(world, command_id, outcome) {
        tracing::error!(%command_id, %error, "action_command_completion_failed");
    }
}
