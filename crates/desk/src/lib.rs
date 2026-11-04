// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk behavior that spans several show domains.
//!
//! Plugin crates can't depend on each other, so behavior that touches several of them lives
//! here: the playback and layer stack feeds, and diagnostics. Code that concerns one domain only
//! belongs in that domain's crate.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_controls::ControlsPlugin;
use nightfall_engine::{EnginePlugin, prelude::*};
use nightfall_framepace::FramePaceStats;
use nightfall_undo::UndoPlugin;

pub mod resources;
pub mod websocket;

pub mod prelude {
    pub use crate::DeskPlugin;
    pub use crate::resources::ExclusiveResource;
}

/// Plugin for adding desk functionality to the app
pub struct DeskPlugin;

impl Plugin for DeskPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering DeskPlugin");
        assert!(
            app.is_plugin_added::<EnginePlugin>(),
            "DeskPlugin requires EnginePlugin (provides CommandIngressRouter)"
        );
        assert!(
            app.is_plugin_added::<UndoPlugin>(),
            "DeskPlugin requires UndoPlugin (provides PendingCommandBuffer, UndoRegistry)"
        );
        assert!(
            app.is_plugin_added::<ControlsPlugin>(),
            "DeskPlugin requires ControlsPlugin (provides held fader buttons for playback feeds)"
        );

        app.init_resource::<websocket::LayerStackPublication>();
        app.init_resource::<GlobalVariables>();
        app.init_resource::<FramePaceStats>();
        websocket::register_websocket_performance_diagnostics(app);

        app.add_systems(
            PostUpdate,
            // Reads removals, which only last two updates.
            websocket::send_instances_on_change.in_set(ClientFeedback),
        );
        app.add_systems(
            Render,
            // Layer stack slots refer to the parameter layout published before it.
            websocket::handle_low_freq_updates
                .after(websocket::send_parameter_state)
                .in_set(ClientOutput),
        );

        app.add_systems(
            Update,
            websocket::handle_resync_state
                .in_set(ResyncHandling)
                // Playbacks refer to the clips sent before them.
                .after(nightfall_clips::websocket::handle_resync_state)
                // The showfile identity follows the desk snapshot it describes.
                .before(nightfall_engine::ui_notification::send_pending_ui_notifications_on_resync),
        );
    }
}
