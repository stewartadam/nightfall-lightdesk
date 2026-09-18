// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Event handlers for scene object commands.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;

use crate::websocket::SceneObjectDataProvider;
use crate::{
    SceneObjectCommand, SceneObjectPlacementPositionUpdate, SceneObjectPlacementRotationUpdate,
};

/// Applies user-facing scene-object commands and publishes their terminal outcomes.
pub fn crud_events(
    mut scene_object_provider: ResMut<SceneObjectDataProvider>,
    mut events: MessageReader<CommandEnvelope<SceneObjectCommand>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = apply_scene_object_command(&mut scene_object_provider, &event.command);
        let response = match result {
            Ok(()) => responder.succeed(event.command_id),
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "scene_object_command_completion_failed"
            );
        }
    }
}

/// Mutates scene-object storage and returns a stable domain failure when the request cannot apply.
fn apply_scene_object_command(
    scene_object_provider: &mut SceneObjectDataProvider,
    command: &SceneObjectCommand,
) -> Result<(), CommandError> {
    match command {
        SceneObjectCommand::StoreSceneObject(scene_object) => {
            tracing::debug!(
                scene_object_id = scene_object.identifiers.id,
                "storing_scene_object"
            );
            scene_object_provider
                .add(scene_object.clone())
                .map_err(|error| {
                    CommandError::new(
                        "scene_object.store_failed",
                        format!("Failed to store scene object: {error}"),
                    )
                })
        }
        SceneObjectCommand::DeleteSceneObject(id) => {
            tracing::debug!(scene_object_id = id, "deleting_scene_object");
            let uid = scene_object_provider
                .from_id(*id)
                .map(|object| object.identifiers.uid)
                .map_err(|_| scene_object_not_found(*id))?;
            scene_object_provider
                .remove(&uid)
                .map(|_| ())
                .map_err(|error| {
                    CommandError::new(
                        "scene_object.delete_failed",
                        format!("Failed to delete scene object {id}: {error}"),
                    )
                })
        }
        SceneObjectCommand::UpdateSceneObjectPlacement {
            id,
            position,
            rotation,
        } => {
            tracing::debug!(scene_object_id = id, "updating_scene_object_placement");
            let mut scene_object = scene_object_provider
                .from_id(*id)
                .map(|object| object.clone())
                .map_err(|_| scene_object_not_found(*id))?;

            if let Some(position) = position {
                match position {
                    SceneObjectPlacementPositionUpdate::All(value) => {
                        scene_object.placement.position = *value;
                    }
                    SceneObjectPlacementPositionUpdate::X(value) => {
                        scene_object.placement.position.x = *value;
                    }
                    SceneObjectPlacementPositionUpdate::Y(value) => {
                        scene_object.placement.position.y = *value;
                    }
                    SceneObjectPlacementPositionUpdate::Z(value) => {
                        scene_object.placement.position.z = *value;
                    }
                }
            }

            if let Some(rotation) = rotation {
                match rotation {
                    SceneObjectPlacementRotationUpdate::All(value) => {
                        scene_object.placement.rotation = *value;
                    }
                    SceneObjectPlacementRotationUpdate::X(value) => {
                        scene_object.placement.rotation.x = *value;
                    }
                    SceneObjectPlacementRotationUpdate::Y(value) => {
                        scene_object.placement.rotation.y = *value;
                    }
                    SceneObjectPlacementRotationUpdate::Z(value) => {
                        scene_object.placement.rotation.z = *value;
                    }
                }
            }

            scene_object_provider.add(scene_object).map_err(|error| {
                CommandError::new(
                    "scene_object.update_failed",
                    format!("Failed to update scene object {id}: {error}"),
                )
            })
        }
        SceneObjectCommand::UpdateSceneObjectProperties { id, properties } => {
            tracing::debug!(scene_object_id = id, "updating_scene_object_properties");
            let mut scene_object = scene_object_provider
                .from_id(*id)
                .map(|object| object.clone())
                .map_err(|_| scene_object_not_found(*id))?;
            scene_object.properties = properties.clone();
            scene_object.object_type = properties.object_type();
            scene_object_provider.add(scene_object).map_err(|error| {
                CommandError::new(
                    "scene_object.update_failed",
                    format!("Failed to update scene object {id}: {error}"),
                )
            })
        }
    }
}

/// Builds the stable failure returned when a scene-object ID cannot be resolved.
fn scene_object_not_found(id: u32) -> CommandError {
    CommandError::new(
        "scene_object.not_found",
        format!("Scene object {id} does not exist"),
    )
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;
    use crate::{CustomProperties, SceneObject};

    /// Creates a focused app containing the semantic scene-object lifecycle.
    fn scene_object_app() -> App {
        let mut app = App::new();
        app.init_resource::<SceneObjectDataProvider>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<SceneObjectCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, crud_events);
        app
    }

    /// Registers and submits one semantic scene-object command.
    fn submit_command(app: &mut App, command: SceneObjectCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("scene-object command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the terminal result produced by one submitted scene-object command.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("scene-object command should produce a terminal result")
    }

    /// Verifies a stored scene object exists before success is published.
    #[test]
    fn store_scene_object_mutates_before_success() {
        let mut app = scene_object_app();
        let object = SceneObject::new_custom(7, "Arch", CustomProperties::default());
        let command_id = submit_command(
            &mut app,
            SceneObjectCommand::StoreSceneObject(object.clone()),
        );

        app.update();

        assert_eq!(
            app.world()
                .resource::<SceneObjectDataProvider>()
                .from_id(7)
                .expect("stored scene object should exist")
                .identifiers
                .uid,
            object.identifiers.uid
        );
        let result = take_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert_eq!(result.outcome, CommandOutcome::succeeded());
    }

    /// Verifies an unknown scene object produces one stable failure.
    #[test]
    fn delete_unknown_scene_object_returns_failure() {
        let mut app = scene_object_app();
        submit_command(&mut app, SceneObjectCommand::DeleteSceneObject(404));

        app.update();

        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "scene_object.not_found"
        ));
    }
}
