// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Connects domain automation invokers to existing command completion and undo groups.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall_actions::{
    ActionId, ActionInvocation, InvocationDispatch, InvocationError, InvocationId,
    InvocationOutcome, InvocationResult,
};

use crate::command_lifecycle::FinishedCommand;
use crate::prelude::*;

/// Reliable action lifecycle envelope for native and embedded clients.
#[derive(serde::Serialize, serde::Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ActionResultMessage {
    InvocationResult(InvocationResult),
}

/// Publishes discrete outcomes and failures without streaming successful continuous samples.
pub(crate) fn publish_action_results(
    results: Option<Res<Messages<InvocationResult>>>,
    registry: Option<Res<nightfall_actions::ActionRegistry>>,
    mut cursor: Local<bevy_ecs::message::MessageCursor<InvocationResult>>,
    sink: Res<ClientEventSink>,
) {
    let Some(results) = results else {
        return;
    };
    for result in cursor.read(&results) {
        let continuous = registry
            .as_ref()
            .and_then(|registry| registry.get(&result.action_id))
            .is_some_and(|descriptor| {
                descriptor.input_kind == nightfall_actions::ActionInputKind::Scalar
            });
        if continuous && !matches!(result.outcome, InvocationOutcome::Failed(_)) {
            continue;
        }
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ActionResultMessage::InvocationResult(result.clone()),
        );
    }
}

/// Correlation retained only until the domain's existing command handler finishes.
#[derive(Default, Resource)]
pub(crate) struct ActionCommandInvocations(HashMap<CommandId, (InvocationId, ActionId)>);

/// Queues a domain command with its normal completion and undo semantics.
pub fn invoke_action_command<T: IngressCommand + Clone>(
    world: &mut World,
    invocation: &ActionInvocation,
    command: T,
) -> Result<InvocationDispatch, InvocationError> {
    enqueue_action_command(world, invocation, command, ReplyTarget::Detached)?;
    Ok(InvocationDispatch::Accepted)
}

/// Queues a tracked action command and returns its identity for domain-specific notifications.
pub fn enqueue_action_command<T: IngressCommand + Clone>(
    world: &mut World,
    invocation: &ActionInvocation,
    command: T,
    reply_target: ReplyTarget,
) -> Result<CommandId, InvocationError> {
    if !world.contains_resource::<Messages<CommandEnvelope<T>>>()
        || !world.contains_resource::<PendingCommandBuffer>()
    {
        return Err(InvocationError::new(
            "action.command_unavailable",
            "The action's command handler is unavailable",
        ));
    }
    let envelope = CommandEnvelope::new(
        command,
        CommandOrigin::Remote(format!("{:?}", invocation.surface)),
        reply_target,
    );
    world
        .get_resource_mut::<CommandTracker>()
        .ok_or_else(|| {
            InvocationError::new(
                "action.command_unavailable",
                "Command tracking is unavailable",
            )
        })?
        .register(&envelope)
        .map_err(|error| {
            InvocationError::new("action.command_registration_failed", error.to_string())
        })?;
    world.init_resource::<ActionCommandInvocations>();
    world.resource_mut::<ActionCommandInvocations>().0.insert(
        envelope.command_id,
        (invocation.invocation_id, invocation.action.id.clone()),
    );
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            envelope.command_id,
            envelope.undo_id,
            Box::new(envelope.command),
        ));
    Ok(envelope.command_id)
}

/// Returns domain completion to the action caller without duplicating command execution.
pub(crate) fn finish_action_commands(
    mut finished: MessageReader<FinishedCommand>,
    mut pending: ResMut<ActionCommandInvocations>,
    results: Option<ResMut<Messages<InvocationResult>>>,
) {
    let Some(mut results) = results else {
        return;
    };
    for command in finished.read() {
        let Some((invocation_id, action_id)) = pending.0.remove(&command.command_id) else {
            continue;
        };
        let outcome = match &command.outcome {
            CommandOutcome::Succeeded { output } => InvocationOutcome::Succeeded {
                output: output.as_ref().map(|output| output.value.clone()),
            },
            CommandOutcome::Failed(error) => {
                InvocationOutcome::Failed(InvocationError::new(&error.code, &error.message))
            }
        };
        results.write(InvocationResult {
            invocation_id,
            action_id,
            outcome,
        });
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_actions::{ActionReference, ActionSurface};

    use super::*;
    use crate::{
        EngineCommand,
        command_lifecycle::{CommandReply, finish_command_in_world},
    };

    /// Discrete lifecycle and unknown-action failures arrive reliably, while scalar success stays local.
    #[test]
    fn action_results_publish_reliably_without_scalar_success_traffic() {
        use nightfall_actions::{ActionDescriptor, ActionInputKind, ActionRegistry};
        let (sender, receiver) = async_channel::unbounded();
        let mut app = App::new();
        app.insert_resource(ClientEventSink::new(sender));
        app.init_resource::<ActionRegistry>();
        app.add_message::<InvocationResult>();
        app.add_systems(Update, publish_action_results);
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register::<serde_json::Value, _>(
                ActionDescriptor {
                    id: ActionId::new("test.fader"),
                    label: "Fader".into(),
                    capabilities: vec![],
                    allowed_surfaces: vec![ActionSurface::Midi],
                    input_kind: ActionInputKind::Scalar,
                    argument_schema: serde_json::json!({}),
                },
                |_, _, _| Ok(InvocationDispatch::succeeded()),
            );
        let invocation_id = InvocationId::default();
        let outcomes = [
            ("test.button", InvocationOutcome::Accepted),
            ("test.button", InvocationOutcome::Succeeded { output: None }),
            ("test.fader", InvocationOutcome::Accepted),
            ("test.fader", InvocationOutcome::Succeeded { output: None }),
            (
                "test.fader",
                InvocationOutcome::Failed(InvocationError::new("target.missing", "Target removed")),
            ),
            (
                "test.unknown",
                InvocationOutcome::Failed(InvocationError::new(
                    "action.not_registered",
                    "Unknown action",
                )),
            ),
        ];
        for (id, outcome) in &outcomes {
            app.world_mut().write_message(InvocationResult {
                invocation_id,
                action_id: ActionId::new(*id),
                outcome: outcome.clone(),
            });
        }
        app.update();
        for index in [0, 1, 4, 5] {
            let bytes = receiver.try_recv().expect("reliable result");
            assert_eq!(bytes[0], DISCRIMINATOR_NON_DROPPABLE);
            let ActionResultMessage::InvocationResult(result) =
                minicbor_serde::from_slice(&bytes[1..]).unwrap();
            assert_eq!(result.invocation_id, invocation_id);
            assert_eq!(result.action_id.as_str(), outcomes[index].0);
            assert_eq!(result.outcome, outcomes[index].1);
        }
        assert!(receiver.try_recv().is_err());
        app.update();
        assert!(receiver.try_recv().is_err());
    }

    /// Deferred failures keep their action identity and use the command's undo group.
    #[test]
    fn domain_failure_completes_the_original_action_invocation() {
        let mut app = App::new();
        app.init_resource::<CommandTracker>();
        app.init_resource::<PendingCommandBuffer>();
        app.init_resource::<ActionCommandInvocations>();
        app.add_message::<CommandEnvelope<EngineCommand>>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<InvocationResult>();
        app.add_systems(Update, finish_action_commands);
        let invocation = ActionInvocation::trigger(
            ActionReference::new("test.resync", serde_json::json!({})),
            ActionSurface::Midi,
        );
        assert_eq!(
            invoke_action_command(app.world_mut(), &invocation, EngineCommand::ResyncState)
                .unwrap(),
            InvocationDispatch::Accepted
        );
        let command = app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(command.undo_id, command.command_id.into());
        assert!(
            app.world()
                .resource::<CommandTracker>()
                .is_active(command.command_id)
        );
        finish_command_in_world(
            app.world_mut(),
            command.command_id,
            CommandOutcome::Failed(CommandError::new(
                "test.failure",
                "Domain rejected the operation",
            )),
        )
        .unwrap();
        app.update();
        let result = app
            .world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .unwrap();
        assert_eq!(result.invocation_id, invocation.invocation_id);
        assert!(
            matches!(result.outcome, InvocationOutcome::Failed(error) if error.code == "test.failure")
        );
        assert!(
            app.world()
                .resource::<ActionCommandInvocations>()
                .0
                .is_empty()
        );
    }
}
