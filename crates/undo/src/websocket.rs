// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for undo commands.
//!
//! This module provides the deserializer for UndoCommand that allows the UI
//! to send undo/redo commands via WebSocket.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde_json::Value;

use crate::commands::UndoCommand;

/// Deserialize and dispatch UndoCommand from JSON.
///
/// This function is registered with the `CommandDeserializerRegistry` to handle
/// incoming undo commands from the UI. It deserializes the JSON payload into an
/// `UndoCommand` and sends it as a typed event for the undo system handlers.
pub fn deserialize_undo_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: UndoCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse UndoCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_undo_command_queues_undo_with_command_context() {
        let mut world = World::new();
        world.init_resource::<PendingCommandBuffer>();

        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        deserialize_undo_command(
            &mut world,
            serde_json::json!({
                "type": "Undo",
                "data": {}
            }),
            command_id,
            undo_id,
        )
        .expect("undo command should deserialize");

        let messages = world.resource_mut::<PendingCommandBuffer>().drain();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].command_id, command_id);
        assert_eq!(messages[0].undo_id, undo_id);
        assert!(matches!(
            messages[0].payload.as_any().downcast_ref::<UndoCommand>(),
            Some(UndoCommand::Undo { .. })
        ));
    }
}
