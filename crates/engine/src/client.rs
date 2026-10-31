// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared websocket command deserializers.
//!
//! Most domains decode a client payload straight into their command type and
//! then either admit it as a tracked [`CommandEnvelope`] message or queue it
//! on the [`PendingCommandBuffer`] for planning and undo capture. These
//! helpers implement both routes once, so domains register them instead of
//! writing their own deserializer.
use bevy_app::prelude::*;
use bevy_ecs::message::Message;
use bevy_ecs::prelude::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::prelude::*;

/// Registers `T` so client payloads decode into `T` and are written as a
/// tracked [`CommandEnvelope`] carrying the origin and reply target the
/// [`CommandTracker`] admitted for that command.
pub fn register_admitted_command<T>(app: &mut App)
where
    T: EnginePayload + EngineIngressMeta + Clone + DeserializeOwned,
    CommandEnvelope<T>: Message,
{
    register_command_deserializer::<T>(app, deserialize_admitted_command::<T>);
}

/// Registers `T` so client payloads decode into `T` and queue on the
/// [`PendingCommandBuffer`], where planning and undo capture run before
/// typed dispatch.
pub fn register_buffered_command<T>(app: &mut App)
where
    T: EnginePayload + EngineIngressMeta + Clone + DeserializeOwned,
{
    register_command_deserializer::<T>(app, deserialize_buffered_command::<T>);
}

/// Decodes `json` into `T` and writes it as a [`CommandEnvelope`] in the
/// lifecycle context the [`CommandTracker`] admitted for `command_id`.
pub fn deserialize_admitted_command<T>(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String>
where
    T: EngineIngressMeta + DeserializeOwned,
    CommandEnvelope<T>: Message,
{
    admit_command(
        world,
        command_id,
        undo_id,
        decode_client_command::<T>(json)?,
    );
    Ok(())
}

/// Decodes `json` into `T` and queues it on the [`PendingCommandBuffer`]
/// with its command and undo identity.
pub fn deserialize_buffered_command<T>(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String>
where
    T: EnginePayload + EngineIngressMeta + DeserializeOwned,
{
    buffer_command(
        world,
        command_id,
        undo_id,
        decode_client_command::<T>(json)?,
    );
    Ok(())
}

/// Writes an already decoded command as a [`CommandEnvelope`] in the lifecycle
/// context the [`CommandTracker`] admitted for `command_id`.
pub fn admit_command<T>(world: &mut World, command_id: CommandId, undo_id: UndoId, command: T)
where
    CommandEnvelope<T>: Message,
{
    let envelope = world
        .resource::<CommandTracker>()
        .admitted_envelope(command_id, undo_id, command);
    world.write_message(envelope);
}

/// Queues an already decoded command on the [`PendingCommandBuffer`] with its
/// command and undo identity, so planning and undo capture run before dispatch.
pub fn buffer_command<T: EnginePayload>(
    world: &mut World,
    command_id: CommandId,
    undo_id: UndoId,
    command: T,
) {
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
}

/// Decodes a client payload into `T`, naming the command module in the error
/// so a malformed payload reports which domain rejected it.
pub fn decode_client_command<T: EngineIngressMeta + DeserializeOwned>(
    json: Value,
) -> Result<T, String> {
    serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse {}: {error}", T::COMMAND_MODULE))
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

    /// Verifies an admitted command keeps the tracked command, undo and reply
    /// identity on the envelope it writes.
    #[test]
    fn admitted_command_writes_tracked_envelope() {
        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        let mut world = tracked_world(command_id, undo_id);

        deserialize_admitted_command::<EngineCommand>(
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

    /// Verifies a buffered command queues once with its command and undo
    /// identity instead of being written as a message.
    #[test]
    fn buffered_command_queues_with_context() {
        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        let mut world = tracked_world(command_id, undo_id);

        deserialize_buffered_command::<EngineCommand>(
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

        let error = deserialize_buffered_command::<EngineCommand>(
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
