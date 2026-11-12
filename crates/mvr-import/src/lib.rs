// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Importing a lighting rig from an MVR file into the current show.
//!
//! The flow has three steps:
//!
//! 1. The client uploads the file to [`http::UPLOAD_PATH`]. It is read off the engine
//!    thread into a [`rig::RigFile`] (fixtures, their types and placements) and kept under a
//!    session ID.
//! 2. [`RigImportCommand::Preview`] works out what importing would do with the chosen
//!    options: which fixture types come from the library or the file, each fixture's ID,
//!    label, patch and placement, and what cannot be imported. The show is not touched.
//! 3. [`RigImportCommand::Commit`] applies the same plan as a single
//!    `FixtureCommand::AddPatchedFixtures`, so one undo removes the whole import.

pub mod commands;
pub mod http;
pub mod placement;
pub mod plan;
pub mod preview;
pub mod rig;
pub mod sessions;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
pub use commands::RigImportCommand;
use nightfall_engine::prelude::*;
use nightfall_fixture_library::FixtureLibraryManager;
#[cfg(not(target_arch = "wasm32"))]
use nightfall_workspace_hack as _;
pub use sessions::RigImportSessions;

/// Commonly used rig import types.
pub mod prelude {
    pub use crate::RigImportPlugin;
    pub use crate::commands::RigImportCommand;
    pub use crate::preview::*;
    pub use crate::sessions::RigImportSessions;
}

/// Adds MVR rig import: the upload route and the preview, commit and discard commands.
///
/// Needs the fixture library, since imported fixtures are built from it.
pub struct RigImportPlugin;

impl Plugin for RigImportPlugin {
    /// Shares the session store with the upload route, registers the command for undo
    /// capture, and schedules commit expansion and the preview and discard handler.
    fn build(&self, app: &mut App) {
        assert!(
            app.world().contains_resource::<FixtureLibraryManager>(),
            "RigImportPlugin requires FixtureLibraryPlugin"
        );
        let sessions = RigImportSessions::default();
        app.insert_resource(sessions.clone());
        if let Some(mut routes) = app
            .world_mut()
            .get_resource_mut::<nightfall_websocket::prelude::HttpRouteRegistry>()
        {
            http::register_rig_import_routes(&mut routes, sessions);
        }
        register_client_command::<RigImportCommand>(app, Undo::Captured);
        app.add_systems(
            Update,
            commands::expand_rig_import_commits.in_set(PendingCommandExpansion),
        );
        app.add_systems(
            Update,
            commands::handle_rig_import_commands.in_set(EventHandling),
        );
    }
}
