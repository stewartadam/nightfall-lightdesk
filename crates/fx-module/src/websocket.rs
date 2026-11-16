// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
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

/// The fx module definitions feed.
#[derive(SystemParam)]
pub(crate) struct FxModulesFeed<'w> {
    fx_modules: Res<'w, DataProvider<StoredFxModule>>,
}

impl ClientFeed for FxModulesFeed<'static> {
    /// Publishes every stored fx module definition.
    fn publish(feed: &FxModulesFeed<'_>, sink: &ClientEventSink) {
        let fx_module_list: Vec<StoredFxModule> = feed
            .fx_modules
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &FxModuleWsMessage::FxModuleDefinitions(&fx_module_list),
        );
    }
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

#[cfg(test)]
mod tests {
    use nightfall::prelude::{Identifiers, SpatialSelection};
    use nightfall_undo::{dispatcher, prelude::*};
    use uuid::Uuid;

    use super::*;

    /// Verifies a WebSocket module deletion captures its exact restore command for undo.
    #[test]
    fn websocket_delete_captures_undo() {
        let mut world = World::new();
        world.init_resource::<PendingCommandBuffer>();
        world.init_resource::<PendingEngineOperationBuffer>();
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

        let command = decode_client_command::<FxModuleCommand>(
            serde_json::json!({ "type": "DeleteFxModule", "data": 42 }),
        )
        .expect("module delete should deserialize");
        submit_client_command(
            &mut world,
            CommandId::new(),
            UndoId::new(),
            command,
            Undo::Captured,
        );
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
