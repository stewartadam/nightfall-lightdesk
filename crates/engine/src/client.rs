// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Client command registration and submission.
//!
//! A client command either has its undo captured, so it queues on the
//! [`PendingCommandBuffer`] where planning and undo capture run before typed
//! dispatch, or skips undo and is written straight out as a tracked
//! [`CommandEnvelope`] message. [`register_client_command`] wires a command
//! type for one of the two, so domains don't write their own deserializer.
use bevy_app::prelude::*;
use bevy_ecs::message::Message;
use bevy_ecs::prelude::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::prelude::*;

/// Whether a client command passes through undo capture before dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Undo {
    /// Queue on the [`PendingCommandBuffer`], where planning and undo capture
    /// run before the command is dispatched.
    Captured,
    /// Skip undo and write a [`CommandEnvelope`] immediately, carrying the
    /// origin and reply target the [`CommandTracker`] admitted for it.
    Skipped,
}

/// Registers `T` as a client command: adds its envelope message and ingress
/// route, and decodes client payloads into `T` before submitting them with
/// the given [`Undo`] behavior.
pub fn register_client_command<T>(app: &mut App, undo: Undo)
where
    T: IngressCommand + EnginePayload + EngineIngressMeta + Clone + DeserializeOwned,
    CommandEnvelope<T>: Message,
{
    register_ingress_command::<T>(app);
    let deserializer = match undo {
        Undo::Captured => deserialize_undo_captured::<T>,
        Undo::Skipped => deserialize_undo_skipped::<T>,
    };
    register_command_deserializer::<T>(app, deserializer);
}

/// Submits an already decoded client command with the given [`Undo`] behavior.
pub fn submit_client_command<T>(
    world: &mut World,
    command_id: CommandId,
    undo_id: UndoId,
    command: T,
    undo: Undo,
) where
    T: EnginePayload,
    CommandEnvelope<T>: Message,
{
    match undo {
        Undo::Captured => {
            world
                .resource_mut::<PendingCommandBuffer>()
                .push(PayloadEnvelope::with_context(
                    command_id,
                    undo_id,
                    Box::new(command),
                ))
        }
        Undo::Skipped => {
            let envelope = world
                .resource::<CommandTracker>()
                .admitted_envelope(command_id, undo_id, command);
            // These commands skip dispatch, where the session history records the others.
            crate::session_history::record_session_command(
                command_id,
                &envelope.command,
                &envelope.origin,
                None,
            );
            world.write_message(envelope);
        }
    }
}

/// Decodes a client payload into `T`, naming the command module in the error
/// so a malformed payload reports which domain rejected it.
pub fn decode_client_command<T: EngineIngressMeta + DeserializeOwned>(
    json: Value,
) -> Result<T, String> {
    serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse {}: {error}", T::COMMAND_MODULE))
}

/// Deserializer registered for [`Undo::Captured`] commands.
fn deserialize_undo_captured<T>(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String>
where
    T: EnginePayload + EngineIngressMeta + DeserializeOwned,
    CommandEnvelope<T>: Message,
{
    let command = decode_client_command::<T>(json)?;
    submit_client_command(world, command_id, undo_id, command, Undo::Captured);
    Ok(())
}

/// Deserializer registered for [`Undo::Skipped`] commands.
fn deserialize_undo_skipped<T>(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String>
where
    T: EnginePayload + EngineIngressMeta + DeserializeOwned,
    CommandEnvelope<T>: Message,
{
    let command = decode_client_command::<T>(json)?;
    submit_client_command(world, command_id, undo_id, command, Undo::Skipped);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a world with a tracker that admitted `command_id` for client 4.
    fn tracked_world(command_id: CommandId, undo_id: UndoId) -> World {
        let mut world = World::new();
        world.init_resource::<CommandTracker>();
        world.init_resource::<PendingCommandBuffer>();
        world.insert_resource(Messages::<CommandEnvelope<EngineCommand>>::default());
        world
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                undo_id,
                CommandOrigin::WebUi,
                ReplyTarget::Client(ClientId(4)),
            )
            .unwrap();
        world
    }

    /// Verifies a command that skips undo keeps the tracked command, undo and reply
    /// identity on the envelope it writes.
    #[test]
    fn undo_skipped_command_writes_tracked_envelope() {
        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        let mut world = tracked_world(command_id, undo_id);

        deserialize_undo_skipped::<EngineCommand>(
            &mut world,
            serde_json::to_value(EngineCommand::SetFps(30)).unwrap(),
            command_id,
            undo_id,
        )
        .expect("engine command should deserialize");

        let messages: Vec<_> = world
            .resource_mut::<Messages<CommandEnvelope<EngineCommand>>>()
            .drain()
            .collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].command_id, command_id);
        assert_eq!(messages[0].undo_id, undo_id);
        assert_eq!(messages[0].reply_target, ReplyTarget::Client(ClientId(4)));
        assert!(matches!(messages[0].command, EngineCommand::SetFps(30)));
    }

    /// Verifies a command with undo captured queues once with its command and undo
    /// identity instead of being written as a message.
    #[test]
    fn undo_captured_command_queues_with_context() {
        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        let mut world = tracked_world(command_id, undo_id);

        deserialize_undo_captured::<EngineCommand>(
            &mut world,
            serde_json::to_value(EngineCommand::ResyncState).unwrap(),
            command_id,
            undo_id,
        )
        .expect("engine command should deserialize");

        let queued = world.resource_mut::<PendingCommandBuffer>().drain();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].command_id, command_id);
        assert_eq!(queued[0].undo_id, undo_id);
        assert!(
            world
                .resource_mut::<Messages<CommandEnvelope<EngineCommand>>>()
                .drain()
                .next()
                .is_none()
        );
    }

    /// Verifies a malformed payload is rejected with the command module named
    /// and leaves nothing queued.
    #[test]
    fn malformed_payload_names_the_command_module() {
        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        let mut world = tracked_world(command_id, undo_id);

        let error = deserialize_undo_captured::<EngineCommand>(
            &mut world,
            serde_json::json!({ "type": "NoSuchCommand" }),
            command_id,
            undo_id,
        )
        .unwrap_err();

        assert!(
            error.starts_with(&format!(
                "Failed to parse {}:",
                EngineCommand::COMMAND_MODULE
            )),
            "{error}"
        );
        assert!(
            world
                .resource_mut::<PendingCommandBuffer>()
                .drain()
                .is_empty()
        );
    }
}
