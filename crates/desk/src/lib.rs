// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_actions::ActionsPlugin;
use nightfall_clips::{ClipAction, ClipCommand, RestoreClipSource};
use nightfall_engine::{EnginePlugin, prelude::*};
use nightfall_framepace::FramePaceStats;
#[cfg(feature = "fx-module-host")]
use nightfall_fx_module::FxModuleRuntimeNotification;
use nightfall_instances::{
    ClipInstanceAttachment, ClipInstanceRequest, InstanceCommand, InstanceControlUpdate,
    PlaybackAction, PlaybackReleaseAction,
};
use nightfall_io::{AvailableUsbDmxDevices, IoRuntimeSettings, NetworkInterfaceState};
use nightfall_undo::{UndoPlugin, prelude::*};

use crate::{
    desk_command::DeskCommand, prelude::*, resources::log_config::LogConfig,
    systems::event_handlers,
};

pub mod ast_conv;
pub mod automation_actions;
pub mod blueprint_command;
mod clips;
pub mod controls;
pub mod desk_command;
pub mod group_command;
pub mod instances;
pub mod masters;
mod object_crud;
pub mod resources;
pub mod settings;
pub mod systems;
pub mod ui_notification;
pub mod undo;
pub mod websocket;

pub mod prelude {
    pub use crate::DeskPlugin;
    pub use crate::automation_actions::{
        CLIP_GO_ACTION_ID, CLIP_START_ACTION_ID, CLIP_STOP_ACTION_ID, CONTROL_SET_ACTION_ID,
        ClipActionArguments, ClipTarget, ControlActionArguments, DESK_EVAL_ACTION_ID,
        DeskEvalActionArguments, clip_target_for_action, desk_eval_action,
        desk_eval_command_for_action, go_clip_action, set_control_action, start_clip_action,
        stop_clip_action,
    };
    pub use crate::blueprint_command::{
        BlueprintAction, BlueprintCommand, BlueprintDefinitionChange, BlueprintReferenceIndex,
    };
    pub use crate::controls::{
        ControlAssignment, ControlCommand, ControlSnapshot, ControlUpdate, Controls,
    };
    pub use crate::desk_command::{
        DeskAction, DeskCommand, ShowfileImportOptions, ShowfileImportPolicy,
        ShowfileRevisionSelection, ShowfileSaveOptions,
    };
    pub use crate::group_command::GroupAction;
    pub use crate::group_command::GroupCommand;
    pub use crate::instances::{ClipReleaseAfterInstance, InstanceIndex};
    pub use crate::masters::{
        FixtureMasterTarget, InstanceMasterTarget, MASTER_INTENSITY_ATTRIBUTES, Master,
        MasterCommand, MasterKind, MasterMode, MasterTarget,
    };
    pub use crate::resources::ExclusiveResource;
    pub use crate::resources::network_stats::{NetworkOutputSendFailure, NetworkStats};
    pub use crate::resources::variables::GlobalVariables;
    pub use crate::settings::{
        ActivePanelLayout, AvailableAudioDevices, DeskSettings, SelectionFlattenPolicy,
        SequenceReorderRenumberPolicy, SettingsCommand, StoredPanelLayout, StoredPanelLayoutPanel,
        TimeDisplayPreference, TimelinePlacementPreference,
    };
    pub use crate::systems::vdim::{
        DEFAULT_GAMMA, VDIM_AFFECTED_ATTRIBUTES, apply_vdim, gamma_correct,
    };
    pub use crate::ui_notification::{PendingUiNotifications, ToastLevel, UiNotification};
}

/// Plugin for adding desk functionality to the app
pub struct DeskPlugin {
    pub log_config: LogConfig,
}

impl Plugin for DeskPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering DeskPlugin");
        app.init_resource::<event_handlers::clip_events::PendingClipPlaybackRates>();
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

        automation_actions::register_desk_actions(app);

        register_ingress_command::<DeskCommand>(app);
        register_engine_action::<DeskAction>(app);
        register_ingress_command::<ClipCommand>(app);
        register_engine_action::<ClipAction>(app);
        register_ingress_command::<GroupCommand>(app);
        app.add_message::<EngineActionEnvelope<GroupAction>>();
        register_ingress_command::<MasterCommand>(app);
        app.add_message::<masters::MasterUpdate>();
        register_ingress_command::<BlueprintCommand>(app);
        app.add_message::<EngineActionEnvelope<BlueprintAction>>();
        app.add_message::<BlueprintDefinitionChange>();
        app.init_resource::<BlueprintReferenceIndex>();
        app.add_message::<OperationResult<(), CommandError>>();
        app.add_message::<UiNotification>();
        app.add_message::<NotificationEnvelope<nightfall_io::IoRuntimeNotification>>();
        app.add_systems(
            Update,
            event_handlers::forward_io_runtime_notifications.in_set(ClientOutput),
        );
        register_ingress_command::<SettingsCommand>(app);
        app.add_message::<event_handlers::settings_events::SettingsCommandResult>();
        register_ingress_command::<InstanceCommand>(app);
        register_engine_action::<PlaybackAction>(app);
        register_engine_action::<PlaybackReleaseAction>(app);
        app.add_message::<InstanceControlUpdate>();
        register_ingress_command::<ControlCommand>(app);
        app.add_message::<ControlUpdate>();
        app.add_message::<RequestEnvelope<ClipInstanceRequest>>();
        app.add_message::<EventEnvelope<ClipInstanceAttachment>>();
        #[cfg(feature = "fx-module-host")]
        app.add_message::<NotificationEnvelope<FxModuleRuntimeNotification>>();

        register_command_deserializer::<DeskCommand>(app, websocket::deserialize_desk_command);
        register_command_deserializer::<GroupCommand>(app, websocket::deserialize_group_command);
        register_command_deserializer::<MasterCommand>(app, websocket::deserialize_master_command);
        register_command_deserializer::<ClipCommand>(app, websocket::deserialize_clip_command);
        register_command_deserializer::<BlueprintCommand>(
            app,
            websocket::deserialize_blueprint_command,
        );
        register_command_deserializer::<SettingsCommand>(
            app,
            websocket::deserialize_settings_command,
        );
        register_command_deserializer::<InstanceCommand>(
            app,
            websocket::deserialize_playback_command,
        );
        register_command_deserializer::<ControlCommand>(
            app,
            websocket::deserialize_control_command,
        );
        register_update_deserializer(app, "ControlUpdate", websocket::deserialize_control_update);

        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::DeskAstConverter>(
        );

        app.init_resource::<DataProvider<Group>>();
        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<DataProvider<Blueprint>>();
        app.init_resource::<InstanceIndex>();
        app.init_resource::<GlobalVariables>();
        app.init_resource::<NetworkStats>();
        app.init_resource::<DeskSettings>();
        app.init_resource::<IoRuntimeSettings>();
        app.init_resource::<nightfall_io::ExternalControlState>();
        app.init_resource::<AvailableAudioDevices>();
        app.init_resource::<AvailableUsbDmxDevices>();
        app.init_resource::<Controls>();
        app.init_resource::<NetworkInterfaceState>();
        app.init_resource::<PendingUiNotifications>();
        app.init_resource::<FramePaceStats>();
        app.init_resource::<DelayedCommandQueue>();
        app.insert_resource(self.log_config.clone());
        websocket::register_websocket_performance_diagnostics(app);

        // Register undoable commands
        {
            let mut registry = app.world_mut().resource_mut::<UndoRegistry>();
            registry.register::<BlueprintCommand>();
            registry.register::<GroupCommand>();
            registry.register::<MasterCommand>();
            registry.register::<ClipCommand>();
            registry.register_action::<RestoreClipSource>();
        }

        // Register event dispatchers for undo helper commands
        register_engine_action::<RestoreClipSource>(app);

        // Process scheduled commands before the undo system processes pending commands
        // This ensures commands that have reached their scheduled time are moved to
        // PendingCommandBuffer before undo processing
        app.add_systems(
            Update,
            systems::scheduled_commands::process_scheduled_commands
                .after(InputHandling)
                .before(nightfall_undo::dispatcher::process_pending_commands),
        );
        app.add_systems(
            Update,
            systems::event_handlers::desk_events::expand_pending_eval_commands
                .after(systems::scheduled_commands::process_scheduled_commands)
                .before(nightfall_undo::dispatcher::process_pending_commands),
        );

        // Maintain InstanceIndex on spawn/despawn, and sync clip active state
        app.add_systems(
            Update,
            (
                instances::add_instances_to_index,
                instances::remove_instances_from_index,
                // Must run after both index systems so new instances are indexed
                // and removed instances are de-indexed before we check for orphans
                instances::sync_active_state_on_instance_despawn
                    .after(instances::add_instances_to_index)
                    .after(instances::remove_instances_from_index),
            ),
        );
        app.add_systems(
            Update,
            blueprint_command::rebuild_step_fx_blueprint_reference_index,
        );

        app.add_systems(
            Update,
            (
                instances::add_missing_instance_clocks,
                ApplyDeferred,
                masters::apply_playback_rate_masters,
                instances::advance_realtime_instance_clocks,
            )
                .chain()
                .in_set(ClockUpdate),
        );

        app.add_systems(
            Update,
            (
                event_handlers::clip_events::forward_clip_ingress_actions
                    .before(event_handlers::clip_events::handle_clip_rate_commands)
                    .before(event_handlers::clip_events::route_clip_playback_actions),
                event_handlers::clip_events::handle_configuration_commands,
                event_handlers::clip_events::crud_events,
                event_handlers::clip_events::handle_restore_clip_source,
                event_handlers::fixture_events::crud_events,
                event_handlers::group_events::crud_events,
                event_handlers::group_events::action_events,
                event_handlers::blueprint_events::crud_events,
                event_handlers::blueprint_events::action_events,
                event_handlers::debug_events::handle_events,
                event_handlers::instance_events::handle_events,
                event_handlers::instance_events::handle_playback_commands,
                event_handlers::clip_events::handle_clip_rate_commands
                    .before(event_handlers::instance_events::handle_playback_control_updates),
                event_handlers::instance_events::handle_playback_control_updates,
                controls::handle_control_commands,
                controls::handle_control_updates,
                #[cfg(feature = "fx-module-host")]
                event_handlers::forward_fx_module_runtime_notifications,
                event_handlers::desk_events::handle_eval,
                systems::stale_inputs::clear_stale_input_channels,
            )
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

        app.add_systems(
            Update,
            (
                event_handlers::master_events::handle_events,
                masters::handle_master_updates,
            )
                .chain()
                .after(controls::handle_control_commands)
                .in_set(EventHandling),
        );

        #[cfg(feature = "fx-module-host")]
        let route_clip_playback_actions = event_handlers::clip_events::route_clip_playback_actions
            .before(nightfall_fx::events::handle_events)
            .before(nightfall_flow::events::handle_events)
            .before(nightfall_fx_module::events::handle_clip_commands)
            .before(event_handlers::instance_events::handle_playback_commands);
        #[cfg(not(feature = "fx-module-host"))]
        let route_clip_playback_actions = event_handlers::clip_events::route_clip_playback_actions
            .before(nightfall_fx::events::handle_events)
            .before(nightfall_flow::events::handle_events)
            .before(event_handlers::instance_events::handle_playback_commands);

        app.add_systems(
            Update,
            (
                event_handlers::clip_events::forward_clip_playback_requests
                    .before(event_handlers::clip_events::route_clip_playback_actions),
                route_clip_playback_actions,
            )
                .in_set(EventHandling),
        );

        app.add_systems(
            Update,
            event_handlers::clip_events::handle_clip_playback_attachments
                .after(LayerGeneration)
                .before(Compositing),
        );

        // Apply per-playback intensity scaling before compositing
        app.add_systems(
            Update,
            systems::instance_controls::apply_playback_intensity
                .after(LayerGeneration)
                .before(Compositing),
        );

        // apply virtual dimmer scaling after compositing
        app.add_systems(
            Update,
            (masters::apply_master_inhibition, systems::vdim::apply_vdim)
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
            event_handlers::settings_events::refresh_network_interface_state.in_set(EventHandling),
        );

        // WebSocket forwarding systems owned by the desk plugin
        app.add_systems(Update, controls::sync_control_state.after(EventHandling));

        app.add_systems(
            Update,
            (
                websocket::forward_group_commands,
                websocket::forward_clip_commands,
                websocket::forward_blueprint_commands,
                websocket::forward_desk_commands,
                websocket::forward_ui_notifications,
                websocket::send_groups_on_change,
                websocket::send_masters_on_change,
                websocket::send_blueprints_on_change,
                websocket::send_blueprint_dependencies_on_change,
                websocket::send_clips_on_change,
                websocket::send_clips_on_clip_change,
                websocket::send_instances_on_change,
                websocket::send_controls_on_change,
                websocket::send_undo_state_on_change,
                websocket::send_settings_on_change,
                websocket::send_io_settings_on_change,
                websocket::send_available_audio_devices_on_change,
                websocket::send_available_usb_dmx_devices_on_change,
                websocket::handle_low_freq_updates,
            )
                .in_set(ClientOutput),
        );

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}
