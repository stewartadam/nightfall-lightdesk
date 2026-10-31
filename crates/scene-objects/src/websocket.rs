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
    mut resync: ResyncReplies,
    scene_object_provider: Res<SceneObjectDataProvider>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };

    send_scene_objects(&scene_object_provider, &broadcaster);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Verifies the client's single-axis placement payload decodes into a
    /// placement update for that axis only.
    #[test]
    fn placement_update_payload_decodes_single_axis() {
        let command_json = json!({
            "type": "UpdateSceneObjectPlacement",
            "data": {
                "id": 42,
                "position": { "type": "X", "data": 1.5 },
                "rotation": null
            }
        });

        let scene_object_cmd: SceneObjectCommand =
            serde_json::from_value(command_json).expect("placement update should decode");
        match &scene_object_cmd {
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
