// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bevy plugin for fixture library integration

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_websocket::WebsocketPlugin;

use crate::commands::FixtureLibraryCommand;
use crate::library_archives::{LibraryArchives, sync_library_archives};
use crate::manager::FixtureLibraryManager;
use crate::watcher::{FixtureLibraryEvent, FixtureLibraryWatcher};

/// Plugin for fixture library functionality
pub struct FixtureLibraryPlugin;

impl Plugin for FixtureLibraryPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering FixtureLibraryPlugin");
        assert!(
            app.is_plugin_added::<WebsocketPlugin>(),
            "FixtureLibraryPlugin requires WebsocketPlugin (provides HttpRouteRegistry)"
        );

        // Initialize the fixture library manager as a resource
        app.init_resource::<FixtureLibraryManager>();

        // Register the fixture library message
        app.add_message::<FixtureLibraryEvent>();

        // Register fixture library commands with the engine
        register_ingress_command::<FixtureLibraryCommand>(app);
        app.add_message::<crate::websocket::FixtureLibraryCommandResult>();
        register_command_deserializer::<FixtureLibraryCommand>(
            app,
            crate::websocket::deserialize_fixture_library_command,
        );

        // Register archive media routes, restricted to archives the library indexes
        let archives = LibraryArchives::default();
        app.insert_resource(archives.clone());
        let mut routes = app
            .world_mut()
            .resource_mut::<nightfall_websocket::prelude::HttpRouteRegistry>();
        routes.register(
            "/api/mesh/{gdtf_path}/{model_name}",
            axum::routing::get(crate::http_routes::serve_mesh).with_state(archives.clone()),
        );
        routes.register(
            "/api/wheel-media/{gdtf_path}/{media_name}",
            axum::routing::get(crate::http_routes::serve_wheel_media).with_state(archives),
        );

        // Try to initialize the file watcher (optional - may fail if library path doesn't exist)
        if let Ok(manager) = FixtureLibraryManager::new() {
            let library_path = manager.library_path().to_path_buf();
            match FixtureLibraryWatcher::new(library_path) {
                Ok(watcher) => {
                    app.insert_resource(watcher);
                    tracing::info!(
                        "Fixture library enabled, watching '{}'",
                        manager.library_path().display()
                    );
                }
                Err(e) => {
                    tracing::warn!("Failed to initialize fixture library watcher: {}", e);
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
                crate::websocket::handle_fixture_library_commands,
                crate::websocket::finish_fixture_library_commands,
            )
                .chain()
                .in_set(EventHandling),
        );
        app.add_systems(
            Update,
            crate::websocket::send_available_fixtures_on_change.in_set(ClientOutput),
        );

        // Register geometry provider so fixtures crate can access geometry
        app.add_systems(Startup, (register_geometry_provider, sync_library_archives));
        app.add_systems(
            Update,
            (register_geometry_provider, sync_library_archives).before(ClientOutput),
        );
    }
}

/// Wrapper that implements GeometryProvider using the fixture library.
struct LibraryGeometryProvider(std::sync::Arc<std::sync::RwLock<FixtureLibraryManager>>);

impl nightfall_fixtures::prelude::GeometryProvider for LibraryGeometryProvider {
    /// Resolves geometry against the current installed and packaged fixture index.
    fn get_geometry(
        &self,
        make: &str,
        model: &str,
        mode: &str,
    ) -> Option<nightfall_fixtures::prelude::FixtureGeometry> {
        self.0.read().ok()?.get_geometry(make, model, mode)
    }
}

/// Refreshes fixture geometry lookup when the library or selected showfile package changes.
fn register_geometry_provider(mut commands: Commands, library: Res<FixtureLibraryManager>) {
    if !library.is_changed() {
        return;
    }
    let library_arc = std::sync::Arc::new(std::sync::RwLock::new(library.clone()));

    commands.insert_resource(nightfall_fixtures::prelude::GeometryProviderResource::new(
        LibraryGeometryProvider(library_arc),
    ));
    tracing::debug!(
        "Registered geometry provider from fixture library ({} fixtures)",
        library.fixture_count()
    );
}
