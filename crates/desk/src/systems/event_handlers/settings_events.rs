// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles settings commands

#[cfg(feature = "native-network-watch")]
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::Duration;

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::{
    BindingValidationSettings, InputDmxUniverses, InputUniverseStaleTimeout,
    ParameterStateProjection,
};
use nightfall_io::prelude::{
    AvailableUsbDmxDevices, ExternalControlSettings, InputUniverseVisibilityMode,
    IoRuntimeSettings, NetworkDmxOutputTargets, NetworkInterfaceInfo, NetworkInterfaceState,
    NetworkInterfaceStatus, UsbDmxDeviceInfo, UsbDmxOutputTargets,
    resolve_network_interface_status, sanitize_dmx_output_rate_hz,
    sanitize_input_signal_loss_timeout,
};

use crate::panel_layouts;
use crate::prelude::DeskSettings;
use crate::settings::{
    AvailableAudioDevices, GraphicsReport, ReportedGraphics, SettingsCommand, TelemetryConsent,
    TelemetryState,
};

#[derive(Clone, Debug)]
enum SettingsCommandOutcome {
    Applied,
    NetworkInterfaces {
        interfaces: Vec<NetworkInterfaceInfo>,
        status: NetworkInterfaceStatus,
    },
    AudioDevices(std::collections::HashMap<String, String>),
    UsbDmxDevices(Vec<UsbDmxDeviceInfo>),
    /// The command was refused and changed nothing.
    Rejected(CommandError),
}

impl From<Result<(), CommandError>> for SettingsCommandOutcome {
    /// Maps a settings edit to an applied or rejected outcome.
    fn from(result: Result<(), CommandError>) -> Self {
        match result {
            Ok(()) => Self::Applied,
            Err(error) => Self::Rejected(error),
        }
    }
}

/// Returns wall-clock milliseconds since the Unix epoch for layout timestamps.
fn now_ms() -> f64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Domain-local result emitted after one settings command has applied.
#[derive(Clone, Debug, Message)]
pub struct SettingsCommandResult {
    command_id: CommandId,
    result: SettingsCommandOutcome,
}

/// Settings resources used by mutation and enumeration commands.
#[derive(SystemParam)]
pub struct SettingsCommandParams<'w> {
    settings: ResMut<'w, DeskSettings>,
    io_settings: ResMut<'w, IoRuntimeSettings>,
    external_control: ResMut<'w, nightfall_io::ExternalControlState>,
    telemetry: ResMut<'w, TelemetryState>,
    reported_graphics: ResMut<'w, ReportedGraphics>,
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

impl SettingsCommandParams<'_> {
    /// Stores the host's external control preferences, ignoring them on hosts that cannot persist
    /// external control state.
    fn set_external_control(&mut self, value: &ExternalControlSettings) -> SettingsCommandOutcome {
        if self.external_control.available {
            self.external_control.settings = value.clone();
        }
        SettingsCommandOutcome::Applied
    }

    /// Stores the user's telemetry consent, ignoring it on hosts without telemetry storage.
    fn set_telemetry_consent(&mut self, value: TelemetryConsent) -> SettingsCommandOutcome {
        if self.telemetry.available {
            self.telemetry.consent = value;
        }
        SettingsCommandOutcome::Applied
    }

    /// Replaces the anonymous telemetry identifier with a fresh random UUID on hosts with
    /// telemetry storage.
    fn reset_telemetry_install_id(&mut self) -> SettingsCommandOutcome {
        if self.telemetry.available {
            self.telemetry.install_id = uuid::Uuid::new_v4().to_string();
        }
        SettingsCommandOutcome::Applied
    }

    /// Keeps a sanitized copy of a client's graphics report for usage reports, only on hosts that
    /// can send them.
    fn report_graphics(&mut self, report: &GraphicsReport) -> SettingsCommandOutcome {
        if self.telemetry.available {
            self.reported_graphics.0 = Some(report.sanitized());
        }
        SettingsCommandOutcome::Applied
    }

    /// Sanitizes network DMX output targets and stores them in both the showfile settings and
    /// the live output target resource.
    fn set_network_dmx_outputs(
        &mut self,
        value: &NetworkDmxOutputTargets,
    ) -> SettingsCommandOutcome {
        let sanitized = value.sanitized();
        self.io_settings.network_dmx_outputs = sanitized.clone();
        *self.network_dmx_outputs = sanitized;
        tracing::debug!("Network DMX output targets updated");
        SettingsCommandOutcome::Applied
    }

    /// Sanitizes USB DMX output targets and stores them in both the showfile settings and the
    /// live output target resource.
    fn set_usb_dmx_outputs(&mut self, value: &UsbDmxOutputTargets) -> SettingsCommandOutcome {
        let sanitized = value.sanitized();
        self.io_settings.usb_dmx_outputs = sanitized.clone();
        *self.usb_dmx_outputs = sanitized;
        tracing::debug!("USB DMX output targets updated");
        SettingsCommandOutcome::Applied
    }

    /// Clamps the input signal-loss timeout and applies it to both the showfile settings and the
    /// fixture-facing stale input timeout.
    fn set_input_signal_loss_timeout(&mut self, value: Duration) -> SettingsCommandOutcome {
        let timeout = sanitize_input_signal_loss_timeout(value);
        self.io_settings.input_signal_loss_timeout = timeout;
        self.input_universe_stale_timeout.0 = timeout;
        tracing::debug!(
            value = ?self.io_settings.input_signal_loss_timeout,
            "Input signal loss timeout set"
        );
        SettingsCommandOutcome::Applied
    }

    /// Clamps the network DMX packet rate into its supported range before storing it.
    fn set_dmx_output_rate(&mut self, value: u32) -> SettingsCommandOutcome {
        self.io_settings.dmx_output_rate_hz = sanitize_dmx_output_rate_hz(value);
        tracing::debug!(
            value = self.io_settings.dmx_output_rate_hz,
            "DMX output rate set"
        );
        SettingsCommandOutcome::Applied
    }

    /// Switches which input universes are shown, discarding the detected universes when the mode
    /// actually changes so the views repopulate under the new filter.
    fn set_input_universe_visibility_mode(
        &mut self,
        value: InputUniverseVisibilityMode,
    ) -> SettingsCommandOutcome {
        if self.io_settings.input_universe_visibility_mode != value {
            self.input_universes.clear();
        }
        self.io_settings.input_universe_visibility_mode = value;
        *self.input_universe_visibility_mode = value;
        tracing::debug!(value = ?value, "Input universe visibility mode set");
        SettingsCommandOutcome::Applied
    }

    /// Broadcasts the current network interface snapshot and returns it with the resolved
    /// interface status as the command output.
    fn network_interfaces(&self) -> SettingsCommandOutcome {
        let status =
            resolve_network_interface_status(&self.io_settings, &self.network_interface_state);
        crate::websocket::send_network_interface_state(
            &self.io_settings,
            &self.network_interface_state,
            &self.broadcaster,
        );
        SettingsCommandOutcome::NetworkInterfaces {
            interfaces: self.network_interface_state.available_interfaces.clone(),
            status,
        }
    }

    /// Broadcasts the known audio output devices and returns them as the command output.
    fn audio_devices(&self) -> SettingsCommandOutcome {
        crate::websocket::send_available_audio_devices(
            &self.available_audio_devices,
            &self.broadcaster,
        );
        SettingsCommandOutcome::AudioDevices(self.available_audio_devices.0.clone())
    }

    /// Broadcasts the compatible USB DMX devices and returns them as the command output.
    fn usb_dmx_devices(&self) -> SettingsCommandOutcome {
        crate::websocket::send_available_usb_dmx_devices(
            &self.available_usb_dmx_devices.0,
            &self.broadcaster,
        );
        SettingsCommandOutcome::UsbDmxDevices(self.available_usb_dmx_devices.0.clone())
    }
}

/// Expands to one exhaustive `match` over a [`SettingsCommand`], generating an arm for each plain
/// field setter listed under `fields` and passing every remaining arm through unchanged.
///
/// A field row `Variant => resource.field` copies the variant's payload into `field` of the
/// [`SettingsCommandParams`] resource named `resource`, logs the new value, and reports
/// [`SettingsCommandOutcome::Applied`]. Commands that validate, gate on host capabilities, or
/// update more than one resource are written as explicit arms after the field rows.
macro_rules! dispatch_settings_command {
    (
        match $command:expr, $params:ident {
            fields { $($variant:ident => $resource:ident . $field:ident,)* }
            $($arm:pat => $body:expr,)*
        }
    ) => {
        match $command {
            $(
                SettingsCommand::$variant(value) => {
                    $params.$resource.$field = ToOwned::to_owned(value);
                    tracing::debug!(
                        setting = stringify!($variant),
                        value = ?$params.$resource.$field,
                        "Setting applied"
                    );
                    SettingsCommandOutcome::Applied
                }
            )*
            $($arm => $body,)*
        }
    };
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

/// Applies each incoming settings command to the settings resources and emits its outcome for
/// [`finish_commands`] to publish.
pub fn handle_events(
    mut events: MessageReader<CommandEnvelope<SettingsCommand>>,
    mut params: SettingsCommandParams,
    mut results: MessageWriter<SettingsCommandResult>,
) {
    for event in events.read() {
        let result = dispatch_settings_command! {
            match &event.command, params {
                fields {
                    SetProgrammerAutoSelect => settings.programmer_auto_select,
                    SetAudioDevice => settings.audio_device,
                    SetSequenceReorderRenumberPolicy => settings.sequence_reorder_renumber_policy,
                    SetSelectionFlattenPolicy => settings.selection_flatten_policy,
                    SetTimeDisplayPreference => settings.time_display_preference,
                    SetTimelinePlacementPreference => settings.timeline_placement_preference,
                    SetShowfileBackupRetention => settings.showfile_backup_retention,
                    SetParameterKeyframesOnly => settings.parameter_keyframes_only,
                    SetNetworkInterface => io_settings.network_interface,
                    SetNetworkOutputEnabled => io_settings.network_output_enabled,
                    SetNetworkInputEnabled => io_settings.network_input_enabled,
                    SetUsbOutputEnabled => io_settings.usb_output_enabled,
                    SetInputSignalLossPolicy => io_settings.input_signal_loss_policy,
                    SetBindingValidationMode => binding_validation_settings.mode,
                }
                SettingsCommand::SetExternalControl(value) => params.set_external_control(value),
                SettingsCommand::SetTelemetryConsent(value) => params.set_telemetry_consent(*value),
                SettingsCommand::ResetTelemetryInstallId => params.reset_telemetry_install_id(),
                SettingsCommand::ReportGraphics(report) => params.report_graphics(report),
                SettingsCommand::SetNetworkDmxOutputs(value) => {
                    params.set_network_dmx_outputs(value)
                },
                SettingsCommand::SetUsbDmxOutputs(value) => params.set_usb_dmx_outputs(value),
                SettingsCommand::SetInputSignalLossTimeout(value) => {
                    params.set_input_signal_loss_timeout(*value)
                },
                SettingsCommand::SetDmxOutputRate(value) => params.set_dmx_output_rate(*value),
                SettingsCommand::SetInputUniverseVisibilityMode(value) => {
                    params.set_input_universe_visibility_mode(*value)
                },
                SettingsCommand::CreatePanelLayout(layout) => {
                    panel_layouts::create(&mut params.settings, layout).into()
                },
                SettingsCommand::SavePanelLayoutArrangement(arrangement) => {
                    panel_layouts::save_arrangement(&mut params.settings, arrangement, now_ms())
                        .into()
                },
                SettingsCommand::RenamePanelLayout(rename) => {
                    panel_layouts::rename(&mut params.settings, rename, now_ms()).into()
                },
                SettingsCommand::SetPanelLayoutVisibility(visibility) => {
                    panel_layouts::set_visibility(&mut params.settings, visibility).into()
                },
                SettingsCommand::DeletePanelLayout(id) => {
                    panel_layouts::delete(&mut params.settings, id).into()
                },
                SettingsCommand::ReorderPanelLayouts(ids) => {
                    panel_layouts::reorder(&mut params.settings, ids).into()
                },
                SettingsCommand::SetDefaultPanelLayout(id) => {
                    panel_layouts::set_default(&mut params.settings, id.as_deref()).into()
                },
                SettingsCommand::GetAvailableNetworkInterfaces => params.network_interfaces(),
                SettingsCommand::GetAvailableAudioDevices => params.audio_devices(),
                SettingsCommand::GetAvailableUsbDmxDevices => params.usb_dmx_devices(),
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
            SettingsCommandOutcome::Applied => responder.succeed(event.command_id),
            SettingsCommandOutcome::NetworkInterfaces { interfaces, status } => responder
                .succeed_with_output(
                    event.command_id,
                    serde_json::json!({ "interfaces": interfaces, "status": status }),
                ),
            SettingsCommandOutcome::AudioDevices(devices) => {
                responder.succeed_with_output(event.command_id, devices)
            }
            SettingsCommandOutcome::UsbDmxDevices(devices) => {
                responder.succeed_with_output(event.command_id, devices)
            }
            SettingsCommandOutcome::Rejected(error) => {
                responder.fail(event.command_id, error.clone())
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

/// Applies the showfile's parameter stream mode to the client projection whenever desk settings
/// change, whether from a settings command or a loaded showfile.
pub fn sync_parameter_stream_from_settings(
    settings: Res<DeskSettings>,
    mut projection: ResMut<ParameterStateProjection>,
) {
    if settings.is_changed() {
        projection.set_keyframes_only(settings.parameter_keyframes_only);
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
        app.init_resource::<TelemetryState>();
        app.init_resource::<ReportedGraphics>();
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
        app.add_message::<CommandNoticeReply>();
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

    /// Verifies consent and identifier commands update host telemetry state only where it can be stored.
    #[test]
    fn telemetry_commands_require_available_host() {
        let mut app = settings_command_app();
        let consent = crate::settings::TelemetryConsent {
            decided: true,
            share_usage: true,
            share_errors: false,
        };
        submit_command(&mut app, SettingsCommand::SetTelemetryConsent(consent));
        app.update();
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
        assert_eq!(
            app.world().resource::<TelemetryState>().consent,
            Default::default(),
            "an unavailable host must ignore consent changes"
        );

        {
            let mut state = app.world_mut().resource_mut::<TelemetryState>();
            state.available = true;
            state.install_id = "before".into();
        }
        submit_command(&mut app, SettingsCommand::SetTelemetryConsent(consent));
        submit_command(&mut app, SettingsCommand::ResetTelemetryInstallId);
        app.update();
        let state = app.world().resource::<TelemetryState>();
        assert_eq!(state.consent, consent);
        assert_ne!(state.install_id, "before");
        assert!(uuid::Uuid::parse_str(&state.install_id).is_ok());
    }

    /// Verifies graphics reports are kept only where usage reports can be sent, and that each
    /// field is trimmed and bounded because any connected client may send one.
    #[test]
    fn graphics_reports_are_sanitized_and_require_available_host() {
        let mut app = settings_command_app();
        let report = crate::settings::GraphicsReport {
            gpu: Some(format!("  Apple M2 {}  ", "x".repeat(400))),
            backend: " WebGPU ".into(),
        };
        submit_command(&mut app, SettingsCommand::ReportGraphics(report.clone()));
        app.update();
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
        assert_eq!(app.world().resource::<ReportedGraphics>().0, None);

        app.world_mut().resource_mut::<TelemetryState>().available = true;
        submit_command(&mut app, SettingsCommand::ReportGraphics(report));
        app.update();
        let stored = app
            .world()
            .resource::<ReportedGraphics>()
            .0
            .clone()
            .unwrap();
        assert_eq!(stored.backend, "WebGPU");
        let gpu = stored.gpu.unwrap();
        assert!(gpu.starts_with("Apple M2 x"));
        assert_eq!(gpu.chars().count(), 160);

        submit_command(
            &mut app,
            SettingsCommand::ReportGraphics(crate::settings::GraphicsReport {
                gpu: Some("   ".into()),
                backend: "WebGL 2".into(),
            }),
        );
        app.update();
        assert_eq!(
            app.world()
                .resource::<ReportedGraphics>()
                .0
                .clone()
                .unwrap()
                .gpu,
            None
        );
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

    /// Verifies table-driven field setters write their payload into the resource each row names,
    /// whether that is desk settings, IO runtime settings, or binding validation settings.
    #[test]
    fn field_setters_update_their_target_resources() {
        let mut app = settings_command_app();
        let commands = [
            SettingsCommand::SetAudioDevice(Some("Main Output".into())),
            SettingsCommand::SetShowfileBackupRetention(3),
            SettingsCommand::SetNetworkInterface(Some("eth0".into())),
            SettingsCommand::SetUsbOutputEnabled(true),
            SettingsCommand::SetBindingValidationMode(
                nightfall_fixtures::prelude::BindingValidationMode::Permissive,
            ),
        ];
        let count = commands.len();
        for command in commands {
            submit_command(&mut app, command);
        }

        app.update();

        let settings = app.world().resource::<DeskSettings>();
        assert_eq!(settings.audio_device.as_deref(), Some("Main Output"));
        assert_eq!(settings.showfile_backup_retention, 3);
        let io_settings = app.world().resource::<IoRuntimeSettings>();
        assert_eq!(io_settings.network_interface.as_deref(), Some("eth0"));
        assert!(io_settings.usb_output_enabled);
        assert_eq!(
            app.world().resource::<BindingValidationSettings>().mode,
            nightfall_fixtures::prelude::BindingValidationMode::Permissive
        );
        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(results.len(), count);
        assert!(
            results
                .iter()
                .all(|result| result.outcome == CommandOutcome::succeeded())
        );
    }

    /// Verifies the keyframes-only setting reaches the parameter projection after the command
    /// applies, and again when settings are replaced wholesale as a showfile load does.
    #[test]
    fn parameter_keyframes_only_reaches_the_projection() {
        let mut app = settings_command_app();
        app.init_resource::<ParameterStateProjection>();
        app.add_systems(
            Update,
            sync_parameter_stream_from_settings.after(finish_commands),
        );
        submit_command(&mut app, SettingsCommand::SetParameterKeyframesOnly(true));
        app.update();
        assert!(
            app.world()
                .resource::<DeskSettings>()
                .parameter_keyframes_only
        );
        assert!(
            app.world()
                .resource::<ParameterStateProjection>()
                .keyframes_only()
        );

        app.insert_resource(DeskSettings::default());
        app.update();
        assert!(
            !app.world()
                .resource::<ParameterStateProjection>()
                .keyframes_only()
        );
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
        world.init_resource::<CommandTracker>();
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
