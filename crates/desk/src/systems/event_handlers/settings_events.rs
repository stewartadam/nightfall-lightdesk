// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles settings commands

#[cfg(feature = "native-network-watch")]
use std::sync::mpsc::{self, Receiver, TryRecvError};

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::{
    BindingValidationSettings, InputDmxUniverses, InputUniverseStaleTimeout,
};
use nightfall_io::prelude::{
    AvailableUsbDmxDevices, InputUniverseVisibilityMode, IoRuntimeSettings,
    NetworkDmxOutputTargets, NetworkInterfaceInfo, NetworkInterfaceState, NetworkInterfaceStatus,
    UsbDmxDeviceInfo, UsbDmxOutputTargets, resolve_network_interface_status,
    sanitize_input_signal_loss_timeout,
};

use crate::prelude::DeskSettings;
use crate::settings::{AvailableAudioDevices, SettingsCommand};

#[derive(Clone, Debug)]
enum SettingsCommandSuccess {
    Applied,
    NetworkInterfaces {
        interfaces: Vec<NetworkInterfaceInfo>,
        status: NetworkInterfaceStatus,
    },
    AudioDevices(std::collections::HashMap<String, String>),
    UsbDmxDevices(Vec<UsbDmxDeviceInfo>),
}

/// Domain-local result emitted after one settings command has applied.
#[derive(Clone, Debug, Message)]
pub struct SettingsCommandResult {
    command_id: CommandId,
    result: SettingsCommandSuccess,
}

/// Settings resources used by mutation and enumeration commands.
#[derive(SystemParam)]
pub struct SettingsCommandParams<'w> {
    settings: ResMut<'w, DeskSettings>,
    io_settings: ResMut<'w, IoRuntimeSettings>,
    external_control: ResMut<'w, nightfall_io::ExternalControlState>,
    binding_validation_settings: ResMut<'w, BindingValidationSettings>,
    input_universe_stale_timeout: ResMut<'w, InputUniverseStaleTimeout>,
    input_universe_visibility_mode: ResMut<'w, InputUniverseVisibilityMode>,
    input_universes: ResMut<'w, InputDmxUniverses>,
    network_dmx_outputs: ResMut<'w, NetworkDmxOutputTargets>,
    usb_dmx_outputs: ResMut<'w, UsbDmxOutputTargets>,
    available_audio_devices: Res<'w, AvailableAudioDevices>,
    available_usb_dmx_devices: Res<'w, AvailableUsbDmxDevices>,
    network_interface_state: Res<'w, NetworkInterfaceState>,
    broadcaster: Res<'w, ClientEventSink>,
}

/// Resource that owns the background network-interface polling task.
#[cfg(feature = "native-network-watch")]
pub struct NetworkInterfaceWatcher {
    _handle: netwatcher::WatchHandle,
    event_rx: Receiver<()>,
    disconnected: bool,
}

/// Start network-interface watch callbacks and cache a handle to keep the watcher alive.
#[cfg(feature = "native-network-watch")]
pub fn init_network_interface_watcher(world: &mut World) {
    let (event_tx, event_rx) = mpsc::channel();
    match netwatcher::watch_interfaces_with_callback(move |_| {
        let _ = event_tx.send(());
    }) {
        Ok(handle) => {
            world.insert_non_send(NetworkInterfaceWatcher {
                _handle: handle,
                event_rx,
                disconnected: false,
            });
        }
        Err(error) => {
            tracing::warn!(
                ?error,
                "Could not start network interface watcher; interface state will not auto-refresh"
            );
        }
    }
}

/// Handles incoming settings commands
pub fn handle_events(
    mut events: MessageReader<CommandEnvelope<SettingsCommand>>,
    mut params: SettingsCommandParams,
    mut results: MessageWriter<SettingsCommandResult>,
) {
    for event in events.read() {
        let result = match &event.command {
            SettingsCommand::SetProgrammerAutoSelect(value) => {
                params.settings.programmer_auto_select = *value;
                tracing::debug!("Programmer auto-select set to: {}", value);
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetExternalControl(value) => {
                if params.external_control.available {
                    params.external_control.settings = value.clone();
                }
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetNetworkInterface(value) => {
                params.io_settings.network_interface = value.clone();
                tracing::debug!(value = ?value, "Network interface set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetNetworkOutputEnabled(value) => {
                params.io_settings.network_output_enabled = *value;
                tracing::debug!(value, "Network output enabled set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetNetworkInputEnabled(value) => {
                params.io_settings.network_input_enabled = *value;
                tracing::debug!(value, "Network input enabled set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetUsbOutputEnabled(value) => {
                params.io_settings.usb_output_enabled = *value;
                tracing::debug!(value, "USB output enabled set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetNetworkDmxOutputs(value) => {
                let sanitized = value.sanitized();
                params.io_settings.network_dmx_outputs = sanitized.clone();
                *params.network_dmx_outputs = sanitized;
                tracing::debug!("Network DMX output targets updated");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetUsbDmxOutputs(value) => {
                let sanitized = value.sanitized();
                params.io_settings.usb_dmx_outputs = sanitized.clone();
                *params.usb_dmx_outputs = sanitized;
                tracing::debug!("USB DMX output targets updated");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetInputSignalLossPolicy(value) => {
                params.io_settings.input_signal_loss_policy = *value;
                tracing::debug!(
                    value = ?params.io_settings.input_signal_loss_policy,
                    "Input signal loss policy set"
                );
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetInputSignalLossTimeout(value) => {
                let timeout = sanitize_input_signal_loss_timeout(*value);
                params.io_settings.input_signal_loss_timeout = timeout;
                params.input_universe_stale_timeout.0 = timeout;
                tracing::debug!(
                    value = ?params.io_settings.input_signal_loss_timeout,
                    "Input signal loss timeout set"
                );
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetBindingValidationMode(value) => {
                params.binding_validation_settings.mode = *value;
                tracing::debug!(value = ?value, "Binding validation mode set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetAudioDevice(value) => {
                params.settings.audio_device = value.clone();
                tracing::debug!(value = ?value, "Audio device set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetSequenceReorderRenumberPolicy(value) => {
                params.settings.sequence_reorder_renumber_policy = *value;
                tracing::debug!(
                    value = ?value,
                    "Sequence reorder renumber policy set"
                );
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetInputUniverseVisibilityMode(value) => {
                if params.io_settings.input_universe_visibility_mode != *value {
                    params.input_universes.clear();
                }
                params.io_settings.input_universe_visibility_mode = *value;
                *params.input_universe_visibility_mode = *value;
                tracing::debug!(
                    value = ?value,
                    "Input universe visibility mode set"
                );
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetSelectionFlattenPolicy(value) => {
                params.settings.selection_flatten_policy = *value;
                tracing::debug!(value = ?value, "Selection flatten policy set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetTimeDisplayPreference(value) => {
                params.settings.time_display_preference = *value;
                tracing::debug!(value = ?value, "Time display preference set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetTimelinePlacementPreference(value) => {
                params.settings.timeline_placement_preference = *value;
                tracing::debug!(value = ?value, "Timeline placement preference set");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetShowfileBackupRetention(value) => {
                params.settings.showfile_backup_retention = *value;
                tracing::debug!("Showfile backup retention set to: {}", value);
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetPanelLayouts(value) => {
                params.settings.panel_layouts = value.clone();
                tracing::debug!(count = value.len(), "Panel layouts updated");
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::SetActivePanelLayout(value) => {
                params.settings.active_panel_layout = value.clone();
                tracing::debug!(
                    has_layout = params.settings.active_panel_layout.is_some(),
                    "Active panel layout updated"
                );
                SettingsCommandSuccess::Applied
            }
            SettingsCommand::GetAvailableNetworkInterfaces => {
                let status = resolve_network_interface_status(
                    &params.io_settings,
                    &params.network_interface_state,
                );
                crate::websocket::send_network_interface_state(
                    &params.io_settings,
                    &params.network_interface_state,
                    &params.broadcaster,
                );
                SettingsCommandSuccess::NetworkInterfaces {
                    interfaces: params.network_interface_state.available_interfaces.clone(),
                    status,
                }
            }
            SettingsCommand::GetAvailableAudioDevices => {
                crate::websocket::send_available_audio_devices(
                    &params.available_audio_devices,
                    &params.broadcaster,
                );
                SettingsCommandSuccess::AudioDevices(params.available_audio_devices.0.clone())
            }
            SettingsCommand::GetAvailableUsbDmxDevices => {
                crate::websocket::send_available_usb_dmx_devices(
                    &params.available_usb_dmx_devices.0,
                    &params.broadcaster,
                );
                SettingsCommandSuccess::UsbDmxDevices(params.available_usb_dmx_devices.0.clone())
            }
        };
        results.write(SettingsCommandResult {
            command_id: event.command_id,
            result,
        });
    }
}

/// Publishes terminal settings results after mutations and snapshots are complete.
pub fn finish_commands(
    mut events: MessageReader<SettingsCommandResult>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let response = match &event.result {
            SettingsCommandSuccess::Applied => responder.succeed(event.command_id),
            SettingsCommandSuccess::NetworkInterfaces { interfaces, status } => responder
                .succeed_with_output(
                    event.command_id,
                    serde_json::json!({ "interfaces": interfaces, "status": status }),
                ),
            SettingsCommandSuccess::AudioDevices(devices) => {
                responder.succeed_with_output(event.command_id, devices)
            }
            SettingsCommandSuccess::UsbDmxDevices(devices) => {
                responder.succeed_with_output(event.command_id, devices)
            }
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "settings_command_completion_failed"
            );
        }
    }
}

/// Keeps the shared network DMX output target resource in sync with showfile settings.
pub fn sync_network_dmx_outputs_from_settings(
    settings: Res<IoRuntimeSettings>,
    mut network_dmx_outputs: ResMut<NetworkDmxOutputTargets>,
    mut usb_dmx_outputs: ResMut<UsbDmxOutputTargets>,
) {
    if !settings.is_changed() {
        return;
    }
    let sanitized = settings.network_dmx_outputs.sanitized();
    if *network_dmx_outputs != sanitized {
        *network_dmx_outputs = sanitized;
    }
    let sanitized_usb_outputs = settings.usb_dmx_outputs.sanitized();
    if *usb_dmx_outputs != sanitized_usb_outputs {
        *usb_dmx_outputs = sanitized_usb_outputs;
    }
}

/// Keeps the fixture-facing stale input timeout resource in sync with showfile settings.
pub fn sync_input_stale_timeout_from_settings(
    mut settings: ParamSet<(Res<IoRuntimeSettings>, ResMut<IoRuntimeSettings>)>,
    mut input_universe_stale_timeout: ResMut<InputUniverseStaleTimeout>,
) {
    let (timeout, should_sanitize_settings) = {
        let settings = settings.p0();
        if !settings.is_changed() {
            return;
        }

        let timeout = sanitize_input_signal_loss_timeout(settings.input_signal_loss_timeout);
        (timeout, settings.input_signal_loss_timeout != timeout)
    };

    if input_universe_stale_timeout.0 != timeout {
        input_universe_stale_timeout.0 = timeout;
    }
    if should_sanitize_settings {
        settings.p1().input_signal_loss_timeout = timeout;
    }
}

/// Refresh the cached network interface snapshot when watcher events arrive.
#[cfg(feature = "native-network-watch")]
pub fn refresh_network_interface_state(
    mut network_interface_state: ResMut<NetworkInterfaceState>,
    network_interface_watcher: Option<NonSendMut<NetworkInterfaceWatcher>>,
) {
    let Some(mut network_interface_watcher) = network_interface_watcher else {
        return;
    };
    if network_interface_watcher.disconnected {
        return;
    }

    let mut saw_event = false;
    loop {
        match network_interface_watcher.event_rx.try_recv() {
            Ok(()) => {
                saw_event = true;
            }
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                tracing::warn!(
                    "Network interface watcher disconnected; interface state will not auto-refresh"
                );
                network_interface_watcher.disconnected = true;
                break;
            }
        }
    }

    if !saw_event {
        return;
    }

    let next_state = NetworkInterfaceState::capture();
    if *network_interface_state != next_state {
        *network_interface_state = next_state;
    }
}

#[cfg(test)]
mod command_tests {
    use std::collections::HashMap;

    use bevy_app::{App, Update};
    use bevy_ecs::message::Messages;

    use super::*;

    /// Creates a focused app containing the semantic settings-command lifecycle.
    fn settings_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<DeskSettings>();
        app.init_resource::<IoRuntimeSettings>();
        app.init_resource::<nightfall_io::ExternalControlState>();
        app.init_resource::<BindingValidationSettings>();
        app.init_resource::<InputUniverseStaleTimeout>();
        app.init_resource::<InputUniverseVisibilityMode>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<NetworkDmxOutputTargets>();
        app.init_resource::<UsbDmxOutputTargets>();
        app.init_resource::<AvailableAudioDevices>();
        app.init_resource::<AvailableUsbDmxDevices>();
        app.insert_resource(NetworkInterfaceState {
            available_interfaces: Vec::new(),
            default_interface: None,
        });
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<SettingsCommand>>();
        app.add_message::<SettingsCommandResult>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        let (sender, _receiver) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(Update, (handle_events, finish_commands).chain());
        app
    }

    /// Registers and submits one settings command to the focused app.
    fn submit_command(app: &mut App, command: SettingsCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("settings command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the terminal result produced by one settings command.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("settings command should produce a terminal result")
    }

    /// Verifies host preferences update independently from showfile transport settings.
    #[test]
    fn external_control_command_changes_only_host_state() {
        let mut app = settings_command_app();
        app.world_mut()
            .resource_mut::<nightfall_io::ExternalControlState>()
            .available = true;
        let before = app.world().resource::<IoRuntimeSettings>().clone();
        let settings = nightfall_io::ExternalControlSettings {
            enabled: true,
            interface: Some("lan".into()),
        };
        submit_command(
            &mut app,
            SettingsCommand::SetExternalControl(settings.clone()),
        );
        app.update();
        assert_eq!(
            app.world()
                .resource::<nightfall_io::ExternalControlState>()
                .settings,
            settings
        );
        assert_eq!(*app.world().resource::<IoRuntimeSettings>(), before);
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
    }

    /// Verifies a setting mutation is visible before terminal success is published.
    #[test]
    fn setting_mutation_precedes_success() {
        let mut app = settings_command_app();
        let command_id = submit_command(&mut app, SettingsCommand::SetProgrammerAutoSelect(true));

        app.update();

        assert!(
            app.world()
                .resource::<DeskSettings>()
                .programmer_auto_select
        );
        let result = take_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert_eq!(result.outcome, CommandOutcome::succeeded());
    }

    /// Verifies device enumeration data is carried by the terminal command result.
    #[test]
    fn audio_device_request_returns_typed_output() {
        let mut app = settings_command_app();
        app.world_mut()
            .insert_resource(AvailableAudioDevices(HashMap::from([(
                "device-1".to_string(),
                "Main Output".to_string(),
            )])));
        submit_command(&mut app, SettingsCommand::GetAvailableAudioDevices);

        app.update();

        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Succeeded { output: Some(ref output) }
                if output.value == serde_json::json!({ "device-1": "Main Output" })
        ));
    }

    /// Verifies WebSocket deserialization preserves semantic command context.
    #[test]
    fn deserialize_settings_command_writes_semantic_envelope() {
        let mut world = World::new();
        world.insert_resource(Messages::<CommandEnvelope<SettingsCommand>>::default());
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        crate::websocket::deserialize_settings_command(
            &mut world,
            serde_json::json!({
                "type": "SetProgrammerAutoSelect",
                "data": true
            }),
            command_id,
            undo_id,
        )
        .expect("settings command should deserialize");

        let messages = world
            .resource_mut::<Messages<CommandEnvelope<SettingsCommand>>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].command_id, command_id);
        assert_eq!(messages[0].undo_id, undo_id);
        assert!(matches!(
            messages[0].command,
            SettingsCommand::SetProgrammerAutoSelect(true)
        ));
    }
}
