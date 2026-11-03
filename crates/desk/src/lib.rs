// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk behavior that spans several show domains.
//!
//! Plugin crates can't depend on each other, so behavior that touches several of them lives
//! here: the `DeskCommand` entry point (including the showfile requests), masters and faders,
//! groups and Blueprints, console settings and shared panel layouts, virtual dimmers and
//! relations, per-playback intensity, and diagnostics. Code that concerns one domain only
//! belongs in that domain's crate.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_actions::ActionsPlugin;
use nightfall_clips::ClipsPlugin;
use nightfall_engine::{EnginePlugin, prelude::*};
use nightfall_framepace::FramePaceStats;
use nightfall_io::{
    AvailableUsbDmxDevices, IoRuntimeSettings, NetworkInterfaceState, NetworkStats,
};
use nightfall_undo::{UndoPlugin, prelude::*};

use crate::{
    desk_command::DeskCommand, prelude::*, resources::log_config::LogConfig,
    systems::event_handlers,
};

pub mod ast_conv;
pub mod automation_actions;
pub mod desk_command;
pub mod faders;
pub mod group_command;
pub mod masters;
mod panel_layouts;
pub mod resources;
pub mod settings;
pub mod systems;
pub mod undo;
pub mod websocket;

pub mod prelude {
    pub use crate::DeskPlugin;
    pub use crate::automation_actions::{
        FADER_BUTTON_ACTION_ID, FADER_GO_ACTION_ID, FADER_LEVEL_ACTION_ID, FaderActionArguments,
        MASTER_LEVEL_ACTION_ID, MASTER_OFF_ACTION_ID, MASTER_ON_ACTION_ID, MASTER_TOGGLE_ACTION_ID,
        MasterActionArguments, fader_button_action, fader_go_action, fader_level_action,
        master_level_action, master_toggle_action,
    };
    pub use crate::desk_command::{
        DeskCommand, ShowfileImportOptions, ShowfileImportPolicy, ShowfileRevisionSelection,
    };
    pub use crate::faders::{
        FaderAssignment, FaderButtonMode, FaderCommand, FaderConfig, FaderSnapshot, FaderUpdate,
        Faders, HeldButtonEffect, HeldButtonEffects,
    };
    pub use crate::group_command::GroupCommand;
    pub use crate::group_command::GroupOperation;
    pub use crate::masters::{
        FixtureMasterTarget, InstanceMasterTarget, MASTER_INTENSITY_ATTRIBUTES, Master,
        MasterCommand, MasterKind, MasterMode, MasterTarget, add_default_show_masters,
    };
    pub use crate::resources::ExclusiveResource;
    pub use crate::settings::{
        AvailableAudioDevices, DeskSettings, GraphicsReport, PanelLayoutArrangement,
        PanelLayoutRename, PanelLayoutVisibility, ReportedGraphics, SelectionFlattenPolicy,
        SequenceReorderRenumberPolicy, SettingsCommand, StoredPanelLayout, StoredPanelLayoutPanel,
        TelemetryConsent, TelemetryState, TimeDisplayPreference, TimelinePlacementPreference,
    };
    pub use crate::systems::relations::apply_virtual_relations;
    pub use crate::systems::vdim::{
        DEFAULT_GAMMA, VDIM_AFFECTED_ATTRIBUTES, apply_vdim, gamma_correct,
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
            app.is_plugin_added::<ActionsPlugin>(),
            "DeskPlugin requires ActionsPlugin (provides registered action invocation)"
        );
        assert!(
            app.is_plugin_added::<ClipsPlugin>(),
            "DeskPlugin requires ClipsPlugin (provides clip and instance playback)"
        );

        automation_actions::register_desk_actions(app);

        register_client_command::<DeskCommand>(app, Undo::Skipped);
        register_client_command::<GroupCommand>(app, Undo::Captured);
        app.add_message::<EngineOperationEnvelope<GroupOperation>>();
        register_client_command::<MasterCommand>(app, Undo::Captured);
        app.add_message::<masters::MasterUpdate>();
        register_client_command::<BlueprintCommand>(app, Undo::Captured);
        app.add_message::<EngineOperationEnvelope<BlueprintOperation>>();
        app.add_message::<BlueprintDefinitionChange>();
        app.init_resource::<BlueprintReferenceIndex>();
        app.init_resource::<GroupReferenceIndex>();
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
        register_client_command::<FaderCommand>(app, Undo::Captured);
        app.add_message::<FaderUpdate>();

        register_update_deserializer(app, "FaderUpdate", websocket::deserialize_fader_update);
        register_update_deserializer(app, "MasterUpdate", websocket::deserialize_master_update);

        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::DeskAstConverter>(
        );

        app.init_resource::<DataProvider<Group>>();
        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<DataProvider<Blueprint>>();
        app.init_resource::<GlobalVariables>();
        app.init_resource::<NetworkStats>();
        app.init_resource::<DeskSettings>();
        app.init_resource::<IoRuntimeSettings>();
        app.init_resource::<nightfall_io::ExternalControlState>();
        app.init_resource::<crate::settings::TelemetryState>();
        app.init_resource::<crate::settings::ReportedGraphics>();
        app.init_resource::<AvailableAudioDevices>();
        app.init_resource::<AvailableUsbDmxDevices>();
        app.init_resource::<Faders>();
        app.init_resource::<HeldButtonEffects>();
        app.init_resource::<NetworkInterfaceState>();
        app.init_resource::<FramePaceStats>();
        app.insert_resource(self.log_config.clone());
        websocket::register_websocket_performance_diagnostics(app);

        // Register undoable commands
        {
            let mut registry = app.world_mut().resource_mut::<UndoRegistry>();
            registry.register::<BlueprintCommand>();
            registry.register::<GroupCommand>();
            registry.register::<MasterCommand>();
        }

        app.add_message::<ClientDisconnected>();
        app.add_systems(
            Update,
            (
                faders::expand_fader_button_commands,
                faders::end_released_flashes,
            )
                .chain()
                .after(DeskEventSet::EvalExpansion)
                .in_set(PendingCommandExpansion),
        );

        // Speed masters scale playback speed after new instances get their clocks and before
        // clocks advance.
        app.add_systems(
            Render,
            masters::apply_playback_speed_masters
                .in_set(ClockUpdate)
                .after(nightfall_clips::playback::clocks::add_missing_instance_clocks)
                .before(nightfall_clips::playback::clocks::advance_realtime_instance_clocks),
        );

        app.add_systems(
            Update,
            (
                event_handlers::fixture_events::crud_events,
                event_handlers::group_events::crud_events,
                event_handlers::group_events::action_events.in_set(DeskEventSet::GroupActions),
                event_handlers::blueprint_events::crud_events.in_set(DeskEventSet::BlueprintCrud),
                event_handlers::blueprint_events::action_events
                    .in_set(DeskEventSet::BlueprintActions),
                event_handlers::debug_events::handle_events,
                faders::handle_fader_commands,
                faders::handle_fader_updates,
                systems::stale_inputs::clear_stale_input_channels,
            )
                .in_set(EventHandling),
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
                event_handlers::settings_events::sync_parameter_stream_from_settings,
            )
                .chain()
                .in_set(EventHandling),
        );

        app.add_systems(
            Update,
            (
                event_handlers::master_events::handle_events,
                masters::handle_master_updates,
            )
                .chain()
                .after(faders::handle_fader_commands)
                .in_set(EventHandling),
        );

        // Apply per-playback intensity scaling to the generated layers before compositing.
        app.add_systems(
            Render,
            (
                faders::resolve_held_button_effects,
                systems::instance_controls::apply_playback_intensity,
            )
                .chain()
                .after(LayerGeneration)
                .before(Compositing),
        );

        // apply virtual dimmer scaling and virtual relation masters after compositing
        app.add_systems(
            Render,
            (
                masters::apply_master_inhibition,
                systems::vdim::apply_vdim,
                systems::relations::apply_virtual_relations,
            )
                .chain()
                .in_set(VdimProcessing),
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

        // WebSocket forwarding systems owned by the desk plugin
        app.add_systems(Update, faders::sync_fader_state.after(EventHandling));

        app.add_systems(
            PostUpdate,
            (
                websocket::forward_group_commands,
                websocket::forward_clip_commands,
                websocket::forward_blueprint_commands,
                websocket::forward_desk_commands,
                // These read removals, which only last two updates.
                websocket::send_clips_on_change,
                websocket::send_instances_on_change,
                websocket::send_faders_on_change,
                websocket::send_armed_launches_on_change,
            )
                .in_set(ClientFeedback),
        );
        app.add_systems(
            Render,
            (
                websocket::send_groups_on_change,
                websocket::send_masters_on_change,
                websocket::send_blueprints_on_change,
                websocket::send_blueprint_dependencies_on_change,
                websocket::send_clips_on_clip_change,
                websocket::send_undo_state_on_change,
                websocket::send_settings_on_change,
                websocket::send_io_settings_on_change,
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
