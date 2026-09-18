// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bevy plugin for object library integration

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_websocket::WebsocketPlugin;

use crate::commands::ObjectLibraryCommand;
use crate::manager::ObjectLibraryManager;
use crate::watcher::{ObjectLibraryEvent, ObjectLibraryWatcher};

/// Plugin for object library functionality
pub struct ObjectLibraryPlugin;

impl Plugin for ObjectLibraryPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering ObjectLibraryPlugin");
        assert!(
            app.is_plugin_added::<WebsocketPlugin>(),
            "ObjectLibraryPlugin requires WebsocketPlugin (provides HttpRouteRegistry)"
        );

        // Initialize the object library manager as a resource
        app.init_resource::<ObjectLibraryManager>();

        // Register the object library message
        app.add_message::<ObjectLibraryEvent>();

        // Register object library commands with the engine
        register_ingress_command::<ObjectLibraryCommand>(app);
        app.add_message::<crate::websocket::ObjectLibraryCommandResult>();
        register_command_deserializer::<ObjectLibraryCommand>(
            app,
            crate::websocket::deserialize_object_library_command,
        );

        // Register HTTP routes for model serving
        app.world_mut()
            .resource_mut::<nightfall_websocket::prelude::HttpRouteRegistry>()
            .register(
                "/api/object-model/{object_path}",
                axum::routing::get(crate::http_routes::serve_object_model),
            );

        // Try to initialize the file watcher
        if let Ok(manager) = ObjectLibraryManager::new() {
            let library_path = manager.library_path().to_path_buf();
            match ObjectLibraryWatcher::new(library_path) {
                Ok(watcher) => {
                    app.insert_resource(watcher);
                    tracing::info!(
                        "Object library enabled, watching '{}'",
                        manager.library_path().display()
                    );
                }
                Err(e) => {
                    tracing::warn!("Failed to initialize object library watcher: {}", e);
                }
            }
        }

        // Add file watching systems
        app.add_systems(
            Update,
            (
                crate::watcher::process_watcher_events,
                crate::watcher::handle_library_changes,
            )
                .chain(),
        );

        // Add WebSocket systems
        app.add_systems(
            Update,
            (
                crate::websocket::handle_object_library_commands,
                crate::websocket::finish_object_library_commands,
            )
                .chain()
                .in_set(EventHandling),
        );
        app.add_systems(
            Update,
            crate::websocket::send_available_objects_on_change.in_set(ClientOutput),
        );
    }
}
