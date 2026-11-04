// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk behavior that spans several show domains.
//!
//! Plugin crates can't depend on each other, so behavior that touches several of them lives
//! here: the `DeskCommand` entry point (including the showfile requests), host settings, the
//! clip, playback, group, and Blueprint feeds, and diagnostics. Code that concerns one domain
//! only belongs in that domain's crate.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_controls::ControlsPlugin;
use nightfall_engine::{EnginePlugin, prelude::*};
use nightfall_framepace::FramePaceStats;
use nightfall_io::{
    AvailableUsbDmxDevices, IoRuntimeSettings, NetworkInterfaceState, NetworkStats,
};
use nightfall_undo::UndoPlugin;

use crate::{
    desk_command::DeskCommand, prelude::*, resources::log_config::LogConfig,
    systems::event_handlers,
};

pub mod ast_conv;
pub mod desk_command;
pub mod resources;
pub mod settings;
pub mod systems;
pub mod websocket;

pub mod prelude {
    pub use crate::DeskPlugin;
    pub use crate::desk_command::{
        DeskCommand, ShowfileImportOptions, ShowfileImportPolicy, ShowfileRevisionSelection,
    };
    pub use crate::resources::ExclusiveResource;
    pub use crate::settings::{
        AvailableAudioDevices, GraphicsReport, ReportedGraphics, SettingsCommand, TelemetryConsent,
        TelemetryState,
    };
}

/// Plugin for adding desk functionality to the app
pub struct DeskPlugin {
    pub log_config: LogConfig,
}

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

        register_client_command::<DeskCommand>(app, Undo::Skipped);
        app.init_resource::<BlueprintReferenceIndex>();
        app.init_resource::<websocket::LayerStackPublication>();
        app.add_message::<OperationResult<(), CommandError>>();
        app.add_message::<NotificationEnvelope<nightfall_io::IoRuntimeNotification>>();
        app.add_systems(
            PostUpdate,
            event_handlers::forward_io_runtime_notifications
                .in_set(ClientFeedback)
                .before(nightfall_engine::ui_notification::forward_ui_notifications),
        );
        register_client_command::<SettingsCommand>(app, Undo::Skipped);
        app.add_message::<event_handlers::settings_events::SettingsCommandResult>();

        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::DeskAstConverter>(
        );

        app.init_resource::<DataProvider<Group>>();
        app.init_resource::<DataProvider<Blueprint>>();
        app.init_resource::<GlobalVariables>();
        app.init_resource::<NetworkStats>();
        app.init_resource::<IoRuntimeSettings>();
        app.init_resource::<nightfall_io::ExternalControlState>();
        app.init_resource::<crate::settings::TelemetryState>();
        app.init_resource::<crate::settings::ReportedGraphics>();
        app.init_resource::<AvailableAudioDevices>();
        app.init_resource::<AvailableUsbDmxDevices>();
        app.init_resource::<NetworkInterfaceState>();
        app.init_resource::<FramePaceStats>();
        app.insert_resource(self.log_config.clone());
        websocket::register_websocket_performance_diagnostics(app);

        app.add_systems(
            Update,
            event_handlers::debug_events::handle_events.in_set(EventHandling),
        );
        app.add_systems(
            Update,
            event_handlers::desk_events::reject_disk_storage_commands
                .run_if(not(disk_storage_available))
                .in_set(EventHandling),
        );

        app.add_systems(
            Update,
            (
                event_handlers::settings_events::handle_events,
                event_handlers::settings_events::finish_commands,
                event_handlers::settings_events::sync_network_dmx_outputs_from_settings,
                event_handlers::settings_events::sync_input_stale_timeout_from_settings,
            )
                .chain()
                .in_set(EventHandling),
        );

        #[cfg(feature = "native-network-watch")]
        app.add_systems(
            Startup,
            event_handlers::settings_events::init_network_interface_watcher,
        );
        #[cfg(feature = "native-network-watch")]
        app.add_systems(
            Update,
            (
                event_handlers::settings_events::refresh_network_interface_state,
                systems::network_interface_alerts::announce_network_interface_changes,
            )
                .chain()
                .in_set(EventHandling),
        );

        app.add_systems(
            PostUpdate,
            (
                websocket::forward_clip_commands,
                websocket::forward_desk_commands,
                // These read removals, which only last two updates.
                websocket::send_clips_on_change,
                websocket::send_instances_on_change,
                websocket::send_armed_launches_on_change,
            )
                .in_set(ClientFeedback),
        );
        app.add_systems(
            Render,
            (
                websocket::send_groups_on_change,
                websocket::send_blueprints_on_change,
                websocket::send_blueprint_dependencies_on_change,
                websocket::send_clips_on_clip_change,
                websocket::send_undo_state_on_change,
                websocket::send_host_state_on_change,
                websocket::send_available_audio_devices_on_change,
                websocket::send_available_usb_dmx_devices_on_change,
                // Layer stack slots refer to the parameter layout published before it.
                websocket::handle_low_freq_updates.after(websocket::send_parameter_state),
            )
                .in_set(ClientOutput),
        );

        app.add_systems(
            Update,
            (
                websocket::handle_resync_state,
                websocket::send_armed_launches_on_resync,
            )
                .in_set(ResyncHandling)
                // The showfile identity follows the desk snapshot it describes.
                .before(nightfall_engine::ui_notification::send_pending_ui_notifications_on_resync),
        );
    }
}
