// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo implementations for scene object commands.

use nightfall_undo::prelude::*;

use crate::websocket::SceneObjectDataProvider;
use crate::{
    SceneObject, SceneObjectCommand, SceneObjectPlacementPositionUpdate,
    SceneObjectPlacementRotationUpdate,
};

impl UndoableOperation for SceneObjectCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let scene_objects = ctx.world.resource::<SceneObjectDataProvider>();

        match self {
            SceneObjectCommand::StoreSceneObject(scene_object) => {
                // Check if this is update vs create
                match scene_objects.get(scene_object.identifiers.uid) {
                    Ok(existing) => {
                        // Update: return command to restore previous state
                        Some(Box::new(SceneObjectCommand::StoreSceneObject(
                            existing.clone(),
                        )))
                    }
                    Err(_) => {
                        // Create: inverse is delete
                        Some(Box::new(SceneObjectCommand::DeleteSceneObject(
                            scene_object.identifiers.id,
                        )))
                    }
                }
            }
            SceneObjectCommand::DeleteSceneObject(id) => {
                // Capture full scene object state before deletion
                scene_objects.from_id(*id).ok().map(|scene_object_ref| {
                    Box::new(SceneObjectCommand::StoreSceneObject(
                        scene_object_ref.clone(),
                    )) as Box<dyn UndoableOperation>
                })
            }
            SceneObjectCommand::UpdateSceneObjectPlacement { id, .. } => {
                // Snapshot current placement before update
                scene_objects.from_id(*id).ok().map(|scene_object_ref| {
                    let old_placement = scene_object_ref.placement.clone();
                    Box::new(SceneObjectCommand::UpdateSceneObjectPlacement {
                        id: *id,
                        position: Some(SceneObjectPlacementPositionUpdate::All(
                            old_placement.position,
                        )),
                        rotation: Some(SceneObjectPlacementRotationUpdate::All(
                            old_placement.rotation,
                        )),
                    }) as Box<dyn UndoableOperation>
                })
            }
            SceneObjectCommand::UpdateSceneObjectProperties { id, .. } => {
                // Snapshot current properties before update
                scene_objects.from_id(*id).ok().map(|scene_object_ref| {
                    Box::new(SceneObjectCommand::UpdateSceneObjectProperties {
                        id: *id,
                        properties: scene_object_ref.properties.clone(),
                    }) as Box<dyn UndoableOperation>
                })
            }
        }
    }

    fn description(&self) -> String {
        match self {
            SceneObjectCommand::StoreSceneObject(obj) => {
                format!("Store Scene Object {}", obj.identifiers.id)
            }
            SceneObjectCommand::DeleteSceneObject(id) => format!("Delete Scene Object {}", id),
            SceneObjectCommand::UpdateSceneObjectPlacement { id, .. } => {
                format!("Update Scene Object {} Placement", id)
            }
            SceneObjectCommand::UpdateSceneObjectProperties { id, .. } => {
                format!("Update Scene Object {} Properties", id)
            }
        }
    }
}

/// Restore a scene object snapshot (for undo)
pub fn restore_scene_object(
    scene_object_provider: &mut SceneObjectDataProvider,
    scene_object: SceneObject,
) {
    if let Err(e) = scene_object_provider.add(scene_object.clone()) {
        tracing::warn!(
            "Failed to restore scene object {}: {}",
            scene_object.identifiers.id,
            e
        );
    }
}
