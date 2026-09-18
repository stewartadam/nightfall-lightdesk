// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration and semantic outcomes for object-library commands.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_scene_objects::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::commands::{
    AvailableObjectInfo, GetObjectProfileResponse, ListAvailableObjectsResponse,
    ObjectLibraryCommand,
};
use crate::manager::{
    ObjectLibraryManager, ObjectProfile, encode_object_path, object_bundle_version,
};
use crate::watcher::ObjectLibraryEvent;

/// Wrapper for serializing object-library messages with the WebSocket wire format.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum ObjectLibraryWsMessage<'a> {
    /// List of available objects.
    ListAvailableObjectsResponse(&'a ListAvailableObjectsResponse),
    /// Object profile information.
    GetObjectProfileResponse(&'a GetObjectProfileResponse),
    /// An object-library command retained for wire-schema compatibility during UI migration.
    ObjectLibraryCommand(&'a ObjectLibraryCommand),
}

#[derive(Clone, Debug)]
enum ObjectLibraryCommandSuccess {
    Applied,
    AvailableObjects(ListAvailableObjectsResponse),
    ObjectProfile(Box<GetObjectProfileResponse>),
}

/// Domain-local outcome emitted after an object-library command has applied.
#[derive(Clone, Debug, Message)]
pub struct ObjectLibraryCommandResult {
    command_id: CommandId,
    result: Result<ObjectLibraryCommandSuccess, CommandError>,
}

/// Deserializes one object-library command into its semantic envelope.
pub fn deserialize_object_library_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: ObjectLibraryCommand = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse ObjectLibraryCommand: {error}"))?;

    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));
    Ok(())
}

/// Applies object-library commands and emits one domain-local result per request.
pub fn handle_object_library_commands(
    mut events: MessageReader<CommandEnvelope<ObjectLibraryCommand>>,
    mut library: ResMut<ObjectLibraryManager>,
    mut scene_objects: ResMut<SceneObjectDataProvider>,
    broadcaster: Res<ClientEventSink>,
    mut results: MessageWriter<ObjectLibraryCommandResult>,
) {
    for event in events.read() {
        let result = match &event.command {
            ObjectLibraryCommand::ListAvailableObjects => {
                list_available_objects(&library, &broadcaster)
                    .map(ObjectLibraryCommandSuccess::AvailableObjects)
            }
            ObjectLibraryCommand::GetObjectProfile { name } => {
                get_object_profile(&library, name, &broadcaster)
                    .map(Box::new)
                    .map(ObjectLibraryCommandSuccess::ObjectProfile)
            }
            ObjectLibraryCommand::RefreshLibrary => refresh_library(&mut library),
            ObjectLibraryCommand::CreateObject {
                metadata,
                glb_content,
            } => create_object(&library, metadata, glb_content),
            ObjectLibraryCommand::UploadObject { filename, content } => {
                upload_object(&library, filename, content)
            }
            ObjectLibraryCommand::DeleteObjects(names) => delete_objects(&mut library, names),
            ObjectLibraryCommand::CreateSceneObjectFromLibrary {
                id,
                object_name,
                label,
                update_existing_ids,
            } => create_scene_object_from_library(
                &library,
                &mut scene_objects,
                *id,
                object_name,
                label.as_deref(),
                update_existing_ids,
            ),
            ObjectLibraryCommand::UpdateSceneObjectsFromLibrary { scene_object_ids } => {
                update_scene_objects_from_library(&library, &mut scene_objects, scene_object_ids)
            }
        };

        results.write(ObjectLibraryCommandResult {
            command_id: event.command_id,
            result,
        });
    }
}

/// Publishes terminal command results after object-library mutations complete.
pub fn finish_object_library_commands(
    mut events: MessageReader<ObjectLibraryCommandResult>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let response = match &event.result {
            Ok(ObjectLibraryCommandSuccess::Applied) => responder.succeed(event.command_id),
            Ok(ObjectLibraryCommandSuccess::AvailableObjects(response)) => {
                responder.succeed_with_output(event.command_id, response)
            }
            Ok(ObjectLibraryCommandSuccess::ObjectProfile(response)) => {
                responder.succeed_with_output(event.command_id, response)
            }
            Err(error) => responder.fail(event.command_id, error.clone()),
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "object_library_command_completion_failed"
            );
        }
    }
}

/// Builds and publishes the current list of available library objects.
fn list_available_objects(
    library: &ObjectLibraryManager,
    broadcaster: &ClientEventSink,
) -> Result<ListAvailableObjectsResponse, CommandError> {
    let objects = library
        .list_objects()
        .into_iter()
        .map(available_object_info)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            CommandError::new(
                "object_library.metadata_failed",
                format!("Failed to load object metadata: {error}"),
            )
        })?;
    let response = ListAvailableObjectsResponse { objects };
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ObjectLibraryWsMessage::ListAvailableObjectsResponse(&response),
    );
    tracing::debug!(count = response.objects.len(), "sent_available_objects");
    Ok(response)
}

/// Builds and publishes one requested object profile.
fn get_object_profile(
    library: &ObjectLibraryManager,
    name: &str,
    broadcaster: &ClientEventSink,
) -> Result<GetObjectProfileResponse, CommandError> {
    let profile = library.find_object(name).ok_or_else(|| {
        CommandError::new(
            "object_library.not_found",
            format!("Object {name} does not exist in the library"),
        )
    })?;
    let info = available_object_info(profile).map_err(|error| {
        CommandError::new(
            "object_library.metadata_failed",
            format!("Failed to load object metadata: {error}"),
        )
    })?;
    let response = GetObjectProfileResponse {
        info,
        metadata: profile.metadata.clone(),
    };
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ObjectLibraryWsMessage::GetObjectProfileResponse(&response),
    );
    Ok(response)
}

/// Rescans the object library and reports whether the refreshed index is usable.
fn refresh_library(
    library: &mut ObjectLibraryManager,
) -> Result<ObjectLibraryCommandSuccess, CommandError> {
    library.scan().map_err(|error| {
        CommandError::new(
            "object_library.refresh_failed",
            format!("Failed to refresh object library: {error}"),
        )
    })?;
    tracing::info!(count = library.object_count(), "object_library_refreshed");
    Ok(ObjectLibraryCommandSuccess::Applied)
}

/// Creates a new object bundle from submitted metadata and GLB bytes.
fn create_object(
    library: &ObjectLibraryManager,
    metadata: &crate::metadata::ObjectMetadata,
    glb_content: &[u8],
) -> Result<ObjectLibraryCommandSuccess, CommandError> {
    library
        .create_object(metadata, glb_content)
        .map_err(|error| {
            CommandError::new(
                "object_library.create_failed",
                format!("Failed to create object: {error}"),
            )
        })?;
    tracing::info!(name = %metadata.name, "object_library_object_created");
    Ok(ObjectLibraryCommandSuccess::Applied)
}

/// Stores an uploaded object bundle in the library directory.
fn upload_object(
    library: &ObjectLibraryManager,
    filename: &str,
    content: &[u8],
) -> Result<ObjectLibraryCommandSuccess, CommandError> {
    library.upload_object(filename, content).map_err(|error| {
        CommandError::new(
            "object_library.upload_failed",
            format!("Failed to upload object {filename}: {error}"),
        )
    })?;
    Ok(ObjectLibraryCommandSuccess::Applied)
}

/// Deletes the requested library bundles and reports every failed name.
fn delete_objects(
    library: &mut ObjectLibraryManager,
    names: &[String],
) -> Result<ObjectLibraryCommandSuccess, CommandError> {
    let errors = names
        .iter()
        .filter_map(|name| {
            library
                .delete_object(name)
                .err()
                .map(|error| format!("{name}: {error}"))
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        tracing::info!(count = names.len(), "object_library_objects_deleted");
        return Ok(ObjectLibraryCommandSuccess::Applied);
    }
    Err(CommandError::new(
        "object_library.delete_failed",
        format!("Failed to delete some objects: {}", errors.join(", ")),
    )
    .with_details(serde_json::json!({ "errors": errors })))
}

/// Creates one scene object and atomically refreshes any supplied existing objects.
fn create_scene_object_from_library(
    library: &ObjectLibraryManager,
    scene_objects: &mut SceneObjectDataProvider,
    id: u32,
    object_name: &str,
    label: Option<&str>,
    update_existing_ids: &[u32],
) -> Result<ObjectLibraryCommandSuccess, CommandError> {
    if scene_objects.from_id(id).is_ok() {
        return Err(CommandError::new(
            "object_library.scene_object_id_in_use",
            format!("Scene object ID {id} is already in use"),
        ));
    }
    let profile = find_profile(library, object_name)?;
    let asset_version = profile_version(profile)?;
    let model_path = encode_object_path(&profile.file_path);

    let updates = update_existing_ids
        .iter()
        .map(|update_id| {
            let existing = find_scene_object(scene_objects, *update_id)?;
            scene_object_for_profile(existing, profile, &model_path, &asset_version)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let scene_object = SceneObject::new_custom(
        id,
        label.unwrap_or(&profile.metadata.name),
        CustomProperties {
            model_path,
            scale: profile.metadata.scale,
            color_override: None,
            library_object_name: Some(profile.metadata.name.clone()),
            library_object_version: Some(asset_version),
        },
    );
    validate_scene_object_changes(scene_objects, updates.iter().chain([&scene_object]))?;
    commit_scene_object_changes(scene_objects, updates.into_iter().chain([scene_object]))?;

    tracing::info!(
        scene_object_id = id,
        object_name,
        "library_scene_object_created"
    );
    Ok(ObjectLibraryCommandSuccess::Applied)
}

/// Atomically refreshes linked scene objects from their current library bundles.
fn update_scene_objects_from_library(
    library: &ObjectLibraryManager,
    scene_objects: &mut SceneObjectDataProvider,
    scene_object_ids: &[u32],
) -> Result<ObjectLibraryCommandSuccess, CommandError> {
    let updates = scene_object_ids
        .iter()
        .map(|id| {
            let existing = find_scene_object(scene_objects, *id)?;
            let custom = custom_properties(&existing)?;
            let object_name = custom.library_object_name.as_deref().ok_or_else(|| {
                CommandError::new(
                    "object_library.scene_object_not_linked",
                    format!("Scene object {id} is not linked to an object-library asset"),
                )
            })?;
            let profile = find_profile(library, object_name)?;
            let asset_version = profile_version(profile)?;
            let model_path = encode_object_path(&profile.file_path);
            scene_object_for_profile(existing, profile, &model_path, &asset_version)
        })
        .collect::<Result<Vec<_>, _>>()?;

    validate_scene_object_changes(scene_objects, &updates)?;
    let updated_count = updates.len();
    commit_scene_object_changes(scene_objects, updates)?;
    tracing::info!(updated_count, "library_scene_objects_updated");
    Ok(ObjectLibraryCommandSuccess::Applied)
}

/// Resolves one object profile or returns a stable not-found failure.
fn find_profile<'a>(
    library: &'a ObjectLibraryManager,
    object_name: &str,
) -> Result<&'a ObjectProfile, CommandError> {
    library.find_object(object_name).ok_or_else(|| {
        CommandError::new(
            "object_library.not_found",
            format!("Object {object_name} does not exist in the library"),
        )
    })
}

/// Computes the content fingerprint used to link a scene object to its bundle version.
fn profile_version(profile: &ObjectProfile) -> Result<String, CommandError> {
    object_bundle_version(&profile.file_path).map_err(|error| {
        CommandError::new(
            "object_library.fingerprint_failed",
            format!("Failed to fingerprint object bundle: {error}"),
        )
    })
}

/// Clones one scene object by numeric ID for pre-commit validation.
fn find_scene_object(
    scene_objects: &SceneObjectDataProvider,
    id: u32,
) -> Result<SceneObject, CommandError> {
    scene_objects
        .from_id(id)
        .map(|object| object.clone())
        .map_err(|_| {
            CommandError::new(
                "object_library.scene_object_not_found",
                format!("Scene object {id} does not exist"),
            )
        })
}

/// Returns custom properties or rejects non-library-compatible scene-object kinds.
fn custom_properties(scene_object: &SceneObject) -> Result<&CustomProperties, CommandError> {
    match &scene_object.properties {
        SceneObjectProperties::Custom(properties) => Ok(properties),
        _ => Err(CommandError::new(
            "object_library.scene_object_not_custom",
            format!(
                "Scene object {} is not a custom object",
                scene_object.identifiers.id
            ),
        )),
    }
}

/// Builds an updated scene-object value without mutating the provider.
fn scene_object_for_profile(
    mut scene_object: SceneObject,
    profile: &ObjectProfile,
    model_path: &str,
    asset_version: &str,
) -> Result<SceneObject, CommandError> {
    let existing = custom_properties(&scene_object)?.clone();
    scene_object.properties = SceneObjectProperties::Custom(CustomProperties {
        model_path: model_path.to_string(),
        scale: existing.scale,
        color_override: existing.color_override,
        library_object_name: Some(profile.metadata.name.clone()),
        library_object_version: Some(asset_version.to_string()),
    });
    Ok(scene_object)
}

/// Validates every planned scene-object write before the first mutation is committed.
fn validate_scene_object_changes<'a>(
    scene_objects: &SceneObjectDataProvider,
    changes: impl IntoIterator<Item = &'a SceneObject>,
) -> Result<(), CommandError> {
    for scene_object in changes {
        scene_objects.validate_add(scene_object).map_err(|error| {
            CommandError::new(
                "object_library.scene_object_store_failed",
                format!(
                    "Failed to validate scene object {}: {error}",
                    scene_object.identifiers.id
                ),
            )
        })?;
    }
    Ok(())
}

/// Commits a fully validated set of scene-object writes.
fn commit_scene_object_changes(
    scene_objects: &mut SceneObjectDataProvider,
    changes: impl IntoIterator<Item = SceneObject>,
) -> Result<(), CommandError> {
    for scene_object in changes {
        let id = scene_object.identifiers.id;
        scene_objects.add(scene_object).map_err(|error| {
            CommandError::new(
                "object_library.scene_object_store_failed",
                format!("Failed to store scene object {id}: {error}"),
            )
        })?;
    }
    Ok(())
}

/// Broadcasts the available-object list when a library scan completes.
pub fn send_available_objects_on_change(
    library: Res<ObjectLibraryManager>,
    broadcaster: Res<ClientEventSink>,
    mut events: MessageReader<ObjectLibraryEvent>,
) {
    for event in events.read() {
        if !matches!(event, ObjectLibraryEvent::ScanCompleted { .. }) {
            continue;
        }
        let objects = library
            .list_objects()
            .iter()
            .filter_map(|profile| match available_object_info(profile) {
                Ok(info) => Some(info),
                Err(error) => {
                    tracing::warn!(
                        object_name = profile.name(),
                        %error,
                        "object_library_refresh_entry_skipped"
                    );
                    None
                }
            })
            .collect();
        let response = ListAvailableObjectsResponse { objects };
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ObjectLibraryWsMessage::ListAvailableObjectsResponse(&response),
        );
    }
}

/// Converts a stored object profile into its transport-facing summary.
fn available_object_info(profile: &ObjectProfile) -> Result<AvailableObjectInfo, String> {
    let asset_version = object_bundle_version(&profile.file_path)
        .map_err(|error| format!("{} ({})", error, profile.file_path.display()))?;
    Ok(AvailableObjectInfo {
        name: profile.name().to_string(),
        category: profile.category().to_string(),
        description: profile.metadata.description.clone(),
        scale: profile.metadata.scale,
        tags: profile.metadata.tags.clone(),
        model_path: encode_object_path(&profile.file_path),
        asset_version,
    })
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use bevy_ecs::message::Messages;
    use tempfile::TempDir;

    use super::*;

    /// Creates a focused app containing the complete object-library command lifecycle.
    fn object_library_app(temp_dir: &TempDir) -> App {
        let mut app = App::new();
        app.insert_resource(
            ObjectLibraryManager::with_path(temp_dir.path().to_path_buf())
                .expect("empty object library should initialize"),
        );
        app.init_resource::<SceneObjectDataProvider>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<ObjectLibraryCommand>>();
        app.add_message::<ObjectLibraryCommandResult>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        let (sender, _receiver) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(
            Update,
            (
                handle_object_library_commands,
                finish_object_library_commands,
            )
                .chain(),
        );
        app
    }

    /// Registers and submits one object-library command to the focused app.
    fn submit_command(app: &mut App, command: ObjectLibraryCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("object-library command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the terminal result produced by one object-library command.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("object-library command should produce a terminal result")
    }

    /// Verifies list commands return their domain data through the terminal result.
    #[test]
    fn list_available_objects_returns_typed_output() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let mut app = object_library_app(&temp_dir);
        let command_id = submit_command(&mut app, ObjectLibraryCommand::ListAvailableObjects);

        app.update();

        let result = take_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert!(matches!(
            result.outcome,
            CommandOutcome::Succeeded { output: Some(ref output) }
                if output.value == serde_json::json!({ "objects": [] })
        ));
    }

    /// Verifies a missing profile returns one stable object-library failure.
    #[test]
    fn get_missing_object_profile_returns_failure() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let mut app = object_library_app(&temp_dir);
        submit_command(
            &mut app,
            ObjectLibraryCommand::GetObjectProfile {
                name: "missing".to_string(),
            },
        );

        app.update();

        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "object_library.not_found"
        ));
    }

    /// Verifies a rejected multi-object refresh leaves earlier valid objects unchanged.
    #[test]
    fn rejected_scene_object_refresh_is_atomic() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let mut library = ObjectLibraryManager::with_path(temp_dir.path().to_path_buf())
            .expect("empty object library should initialize");
        library
            .create_object(&crate::metadata::ObjectMetadata::new("Arch"), b"glb")
            .expect("test object bundle should be created");
        library
            .scan()
            .expect("test object bundle should be indexed");

        let mut scene_objects = SceneObjectDataProvider::default();
        let linked = SceneObject::new_custom(
            1,
            "Linked",
            CustomProperties {
                library_object_name: Some("Arch".to_string()),
                library_object_version: Some("old-version".to_string()),
                ..Default::default()
            },
        );
        scene_objects
            .add(linked)
            .expect("linked scene object should be stored");
        scene_objects
            .add(SceneObject::new_truss(
                2,
                "Truss",
                TrussProperties::default(),
            ))
            .expect("non-custom scene object should be stored");

        let result = update_scene_objects_from_library(&library, &mut scene_objects, &[1, 2]);

        assert!(matches!(
            result,
            Err(CommandError { ref code, .. })
                if code == "object_library.scene_object_not_custom"
        ));
        let stored = scene_objects
            .from_id(1)
            .expect("linked scene object should remain");
        assert!(matches!(
            &stored.properties,
            SceneObjectProperties::Custom(properties)
                if properties.library_object_version.as_deref() == Some("old-version")
        ));
    }

    /// Verifies deserialization preserves admitted command and undo context.
    #[test]
    fn deserialize_object_library_command_writes_semantic_envelope() {
        let mut world = World::new();
        world.insert_resource(Messages::<CommandEnvelope<ObjectLibraryCommand>>::default());
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        deserialize_object_library_command(
            &mut world,
            serde_json::json!({ "type": "RefreshLibrary" }),
            command_id,
            undo_id,
        )
        .expect("object-library command should deserialize");

        let messages = world
            .resource_mut::<Messages<CommandEnvelope<ObjectLibraryCommand>>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].command_id, command_id.into());
        assert_eq!(messages[0].undo_id, undo_id.into());
        assert!(matches!(
            messages[0].command,
            ObjectLibraryCommand::RefreshLibrary
        ));
    }
}
