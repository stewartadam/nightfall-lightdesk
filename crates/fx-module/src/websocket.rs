// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::{
    FxModuleCommand, FxModulePreviewUpdate, ListAvailableFxModulesResponse, StoredFxModule,
};

/// Websocket messages exchanged with FX module clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum FxModuleWsMessage<'a> {
    FxModuleDefinitions(&'a [StoredFxModule]),
    ListAvailableFxModulesResponse(&'a ListAvailableFxModulesResponse),
    #[allow(dead_code)]
    FxModuleCommand(&'a FxModuleCommand),
}

/// Deserialize and queue fx module commands from JSON so undo is captured before dispatch.
pub fn deserialize_fx_module_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: FxModuleCommand = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse FxModuleCommand: {error}"))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
    Ok(())
}

/// Deserializes and dispatches an untracked FX module preview update from JSON.
pub fn deserialize_fx_module_preview_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: FxModulePreviewUpdate = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse FxModulePreviewUpdate: {error}"))?;

    world.write_message(update);
    Ok(())
}

/// Forward fx module commands to the UI for reactive handling.
pub fn forward_fx_module_commands(
    mut events: MessageReader<CommandEnvelope<FxModuleCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    for _event in events.read() {}
}

/// Send fx module definitions when the provider changes.
pub fn send_fx_module_on_change(
    fx_module_provider: Res<DataProvider<StoredFxModule>>,
    broadcaster: Res<ClientEventSink>,
) {
    if fx_module_provider.is_changed() {
        send_fx_module(fx_module_provider, broadcaster);
    }
}

/// Send the current fx module definitions to websocket clients.
pub fn send_fx_module(
    fx_module_provider: Res<DataProvider<StoredFxModule>>,
    broadcaster: Res<ClientEventSink>,
) {
    let fx_module_list: Vec<StoredFxModule> = fx_module_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FxModuleWsMessage::FxModuleDefinitions(&fx_module_list),
    );
}

/// Send the current available fx module catalog to websocket clients.
pub fn send_available_fx_modules(
    response: &ListAvailableFxModulesResponse,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FxModuleWsMessage::ListAvailableFxModulesResponse(response),
    );
}

/// Resend fx module state on engine resync.
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    fx_module_provider: Res<DataProvider<StoredFxModule>>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if should_resync {
        send_fx_module(fx_module_provider, broadcaster);
    }
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::{Identifiers, SpatialSelection};
    use nightfall_undo::{dispatcher, prelude::*};
    use uuid::Uuid;

    use super::*;

    /// Verifies management commands enter pending dispatch for undo capture.
    #[test]
    fn deserialize_fx_module_command_queues_pending_command() {
        let mut world = World::new();
        world.insert_resource(PendingCommandBuffer::default());
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        deserialize_fx_module_command(
            &mut world,
            serde_json::json!({ "type": "DeleteFxModule", "data": 42 }),
            command_id,
            undo_id,
        )
        .expect("module command should deserialize");

        let queued = world.resource_mut::<PendingCommandBuffer>().drain();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].command_id, command_id);
        assert_eq!(queued[0].undo_id, undo_id);
        assert!(matches!(
            queued[0].payload.as_any().downcast_ref::<FxModuleCommand>(),
            Some(FxModuleCommand::DeleteFxModule(42))
        ));
    }

    /// Verifies a WebSocket module deletion captures its exact restore command for undo.
    #[test]
    fn websocket_delete_captures_undo() {
        let mut world = World::new();
        world.init_resource::<PendingCommandBuffer>();
        world.init_resource::<PendingEngineActionBuffer>();
        world.init_resource::<UndoManager>();
        world.init_resource::<UndoRegistry>();
        world.init_resource::<CommandTracker>();
        world.init_resource::<DataProvider<StoredFxModule>>();
        let module_uid = Uuid::from_u128(0x601);
        world
            .resource_mut::<DataProvider<StoredFxModule>>()
            .add(StoredFxModule {
                identifiers: Identifiers {
                    id: 42,
                    uid: module_uid,
                    label: "Undo module".to_string(),
                },
                module_name: "undo-module".to_string(),
                selection: SpatialSelection::default(),
                config: Default::default(),
            })
            .expect("module should insert cleanly");
        world
            .resource_mut::<UndoRegistry>()
            .register::<FxModuleCommand>();

        deserialize_fx_module_command(
            &mut world,
            serde_json::json!({ "type": "DeleteFxModule", "data": 42 }),
            CommandId::new(),
            UndoId::new(),
        )
        .expect("module delete should deserialize");
        dispatcher::process_pending_commands(&mut world);
        world
            .resource_mut::<UndoManager>()
            .finalize_detached_groups();

        let inverse = world
            .resource::<UndoManager>()
            .peek_undo()
            .expect("WebSocket delete should enter undo history")
            .entries[0]
            .command
            .as_any()
            .downcast_ref::<FxModuleCommand>()
            .expect("undo should remain in the module domain");
        let FxModuleCommand::RestoreDeletedFxModule(definition) = inverse else {
            panic!("delete undo should restore the exact definition");
        };
        assert_eq!(definition.identifiers.uid, module_uid);
    }
}
