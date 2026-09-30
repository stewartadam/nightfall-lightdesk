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
use nightfall_fixtures::library::commands::{
    finish_fixture_library_commands, register_fixture_library_commands,
};
use nightfall_websocket::WebsocketPlugin;

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
        register_fixture_library_commands(app);

        // Register HTTP routes for mesh and wheel image serving, restricted to
        // archives the library indexes.
        let archives = crate::http_routes::IndexedArchives::default();
        app.insert_resource(archives.clone());
        let mut routes = app
            .world_mut()
            .resource_mut::<nightfall_websocket::prelude::HttpRouteRegistry>();
        let mesh_archives = archives.clone();
        routes.register(
            "/api/mesh/{gdtf_path}/{model_name}",
            axum::routing::get(move |path| {
                crate::http_routes::serve_mesh(path, mesh_archives.clone())
            }),
        );
        routes.register(
            "/api/gdtf-wheel/{gdtf_path}/{media_name}",
            axum::routing::get(move |path| {
                crate::http_routes::serve_wheel_media(path, archives.clone())
            }),
        );

        // Watch the directory the manager already scanned (optional - may fail if it is unavailable)
        let library_path = app
            .world()
            .resource::<FixtureLibraryManager>()
            .library_path()
            .to_path_buf();
        match FixtureLibraryWatcher::new(library_path.clone()) {
            Ok(watcher) => {
                app.insert_resource(watcher);
                tracing::info!(
                    "Fixture library enabled, watching '{}'",
                    library_path.display()
                );
            }
            Err(e) => {
                tracing::warn!("Failed to initialize fixture library watcher: {}", e);
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
                finish_fixture_library_commands,
            )
                .chain()
                .in_set(EventHandling),
        );
        app.add_systems(
            Update,
            crate::websocket::send_available_fixtures_on_change.in_set(ClientOutput),
        );

        // Register geometry provider so fixtures crate can access geometry
        app.add_systems(Startup, register_geometry_provider);
        app.add_systems(Update, register_geometry_provider.before(ClientOutput));
    }
}

/// Geometry cache key: make, model, mode and recorded library revision.
type GeometryCacheKey = (String, String, String, Option<String>);

/// Wrapper that implements GeometryProvider using a snapshot of the fixture library.
///
/// Geometry is cached per fixture definition and mode, so broadcasting many
/// fixtures of one type parses its archive once. A new provider (and cache)
/// is created whenever the library changes.
struct LibraryGeometryProvider {
    library: std::sync::Arc<std::sync::RwLock<FixtureLibraryManager>>,
    cache: std::sync::Mutex<
        std::collections::HashMap<
            GeometryCacheKey,
            Option<nightfall_fixtures::prelude::FixtureGeometry>,
        >,
    >,
}

impl nightfall_fixtures::prelude::GeometryProvider for LibraryGeometryProvider {
    /// Resolves geometry for a fixture's own library revision.
    fn get_geometry(
        &self,
        fixture: &nightfall_fixtures::prelude::Fixture,
    ) -> Option<nightfall_fixtures::prelude::FixtureGeometry> {
        let key = (
            fixture.make.clone(),
            fixture.model.clone(),
            fixture.mode.clone(),
            fixture.library_asset_etag.clone(),
        );
        if let Some(cached) = self.cache.lock().ok()?.get(&key) {
            return cached.clone();
        }
        let geometry = self.library.read().ok()?.geometry_for_fixture(fixture);
        self.cache.lock().ok()?.insert(key, geometry.clone());
        geometry
    }
}

/// Returns the files the archive resource routes may open: indexed GDTF archives only.
///
/// OFL definitions are indexed files too, but they are not archives, so a
/// mesh or wheel-media request naming one is refused at the gate instead of
/// failing later during GDTF parsing.
fn servable_archives(
    library: &FixtureLibraryManager,
) -> impl Iterator<Item = std::path::PathBuf> + '_ {
    library
        .list_fixtures()
        .into_iter()
        .filter(|profile| matches!(profile.source, crate::manager::FixtureSource::Gdtf(_)))
        .map(|profile| profile.file_path.clone())
}

/// Refreshes fixture geometry lookup and the servable archive set when the library or selected showfile package changes.
fn register_geometry_provider(
    mut commands: Commands,
    library: Res<FixtureLibraryManager>,
    archives: Option<Res<crate::http_routes::IndexedArchives>>,
) {
    if !library.is_changed() {
        return;
    }
    if let Some(archives) = archives {
        archives.replace(servable_archives(&library));
    }
    let library_arc = std::sync::Arc::new(std::sync::RwLock::new(library.clone()));

    commands.insert_resource(nightfall_fixtures::prelude::GeometryProviderResource::new(
        LibraryGeometryProvider {
            library: library_arc,
            cache: Default::default(),
        },
    ));
    tracing::debug!(
        "Registered geometry provider from fixture library ({} fixtures)",
        library.fixture_count()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{ChannelSpec, GdtfBuilder, GeometrySpec, ModeSpec};

    /// Verifies only GDTF archives are servable, so an indexed OFL definition
    /// is refused by the resource routes rather than parsed as an archive.
    #[test]
    fn servable_archives_exclude_ofl_definitions() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("fixture.gdtf");
        GdtfBuilder::new("Test", "Archive")
            .geometry(GeometrySpec::generic("Body"))
            .mode(ModeSpec::new("Mode", "Body").channel(ChannelSpec::new("Body", "Dimmer", &[1])))
            .write_to(&archive);
        let ofl = dir.path().join("test-maker@test-fixture.json");
        std::fs::write(
            &ofl,
            serde_json::json!({
                "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
                "name": "Test Fixture",
                "categories": ["Other"],
                "meta": {
                    "authors": ["Nightfall"],
                    "createDate": "2026-09-05",
                    "lastModifyDate": "2026-09-05"
                },
                "availableChannels": {},
                "modes": []
            })
            .to_string(),
        )
        .unwrap();
        let library = FixtureLibraryManager::with_path(dir.path().to_path_buf()).unwrap();
        assert!(
            library
                .list_fixtures()
                .iter()
                .any(|profile| profile.file_path == ofl),
            "the OFL definition should be indexed"
        );

        let archives = crate::http_routes::IndexedArchives::default();
        archives.replace(servable_archives(&library));
        assert!(archives.contains(&archive.to_string_lossy()));
        assert!(!archives.contains(&ofl.to_string_lossy()));
    }
}
