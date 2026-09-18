// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for scene object commands.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::{SceneObject, SceneObjectCommand};

/// Type alias for the scene object data provider
pub type SceneObjectDataProvider = DataProvider<SceneObject>;

/// Wrapper for serializing scene object messages with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum SceneObjectWsMessage<'a> {
    /// List of all scene objects
    SceneObjectDefinitions(&'a [SceneObject]),
    /// Scene object command (for forwarding CRUD operations to UI)
    SceneObjectCommand(&'a SceneObjectCommand),
}

/// Deserialize and dispatch SceneObjectCommand from JSON.
pub fn deserialize_scene_object_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: SceneObjectCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse SceneObjectCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Send list of scene objects to websocket clients.
pub fn send_scene_objects(
    scene_object_provider: &SceneObjectDataProvider,
    broadcaster: &ClientEventSink,
) {
    let scene_objects: Vec<SceneObject> = scene_object_provider
        .iter()
        .map(|e| e.value().clone())
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &SceneObjectWsMessage::SceneObjectDefinitions(&scene_objects),
    );

    tracing::trace!(
        "Sending {} scene objects over websocket",
        scene_objects.len()
    );
}

/// Send scene objects when data provider changes
pub fn send_scene_objects_on_change(
    scene_object_provider: Res<SceneObjectDataProvider>,
    broadcaster: Res<ClientEventSink>,
) {
    if !scene_object_provider.is_changed() {
        return;
    }

    send_scene_objects(&scene_object_provider, &broadcaster);
}

/// Handle ResyncState by sending scene objects.
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    scene_object_provider: Res<SceneObjectDataProvider>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_scene_objects(&scene_object_provider, &broadcaster);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn deserialize_scene_object_command_preserves_command_and_undo_identity() {
        let mut world = World::new();
        world.init_resource::<PendingCommandBuffer>();

        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        let command_json = json!({
            "type": "UpdateSceneObjectPlacement",
            "data": {
                "id": 42,
                "position": { "type": "X", "data": 1.5 },
                "rotation": null
            }
        });

        let result =
            deserialize_scene_object_command(&mut world, command_json, command_id, undo_id);
        assert!(result.is_ok());

        let mut pending = world.resource_mut::<PendingCommandBuffer>();
        let drained = pending.drain();
        assert_eq!(drained.len(), 1);

        let cmd = &drained[0];
        assert_eq!(cmd.command_id, CommandId::from(command_id));
        assert_eq!(cmd.undo_id, UndoId::from(undo_id));

        let scene_object_cmd = cmd
            .payload
            .as_any()
            .downcast_ref::<SceneObjectCommand>()
            .expect("expected SceneObjectCommand");
        match scene_object_cmd {
            SceneObjectCommand::UpdateSceneObjectPlacement { id, position, .. } => {
                assert_eq!(*id, 42);
                match position {
                    Some(crate::SceneObjectPlacementPositionUpdate::X(value)) => {
                        assert!((value - 1.5).abs() <= f32::EPSILON);
                    }
                    other => panic!("unexpected position update: {:?}", other),
                }
            }
            other => panic!("unexpected command variant: {:?}", other),
        }
    }
}
