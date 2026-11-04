// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use async_channel::Receiver;
use bevy_app::{App, Update};
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall_desk::prelude::{AvailableAudioDevices, SettingsCommand};
use nightfall_desk::systems::event_handlers::settings_events;
use nightfall_engine::prelude::{
    ClientEventSink, CommandEnvelope, CommandOrigin, EventHandling, OutboundFrame, ReplyTarget,
    SettingsAppExt, SettingsPlugin,
};
use nightfall_fixtures::IO_SETTINGS_SECTION;
use nightfall_fixtures::prelude::{
    InputDmxUniverses, InputUniverseStaleTimeout, RouteValidationMode, RouteValidationSettings,
};
use nightfall_io::prelude::{
    AvailableUsbDmxDevices, ExternalControlState, InputSignalLossPolicy,
    InputUniverseVisibilityMode, IoRuntimeSettings, NetworkDmxOutputTargets, NetworkInterfaceState,
    UsbDmxOutputTarget, UsbDmxOutputTargets,
};

/// Discards every message currently buffered on `rx`, stopping once it is empty or closed.
fn drain_channel(rx: &Receiver<OutboundFrame>) {
    while rx.try_recv().is_ok() {}
}

fn decode_ws_message(raw: &[u8]) -> serde_json::Value {
    assert!(
        !raw.is_empty(),
        "websocket payload must include discriminator"
    );
    minicbor_serde::from_slice::<serde_json::Value>(&raw[1..])
        .expect("failed to decode websocket payload")
}

/// Creates the resources required by the semantic settings command handler.
fn settings_command_app() -> (App, Receiver<OutboundFrame>) {
    let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
    let mut app = App::new();
    app.add_message::<CommandEnvelope<SettingsCommand>>();
    app.add_message::<settings_events::SettingsCommandResult>();
    app.init_resource::<IoRuntimeSettings>();
    app.init_resource::<ExternalControlState>();
    app.init_resource::<nightfall_desk::prelude::TelemetryState>();
    app.init_resource::<nightfall_desk::prelude::ReportedGraphics>();
    app.init_resource::<RouteValidationSettings>();
    app.init_resource::<InputUniverseVisibilityMode>();
    app.init_resource::<InputUniverseStaleTimeout>();
    app.init_resource::<InputDmxUniverses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<AvailableAudioDevices>();
    app.init_resource::<AvailableUsbDmxDevices>();
    app.insert_resource(NetworkInterfaceState {
        available_interfaces: Vec::new(),
        default_interface: None,
    });
    app.insert_resource(ClientEventSink::new(tx));
    app.add_systems(Update, settings_events::handle_events.in_set(EventHandling));
    (app, rx)
}

/// Sends the showfile's IO settings to clients through the settings registry, as the engine does.
fn broadcast_io_settings(app: &mut App) {
    app.add_plugins(SettingsPlugin);
    app.register_settings_section(IO_SETTINGS_SECTION);
}

/// Submits one independently tracked settings command to a focused handler test.
fn submit_settings_command(app: &mut App, command: SettingsCommand) {
    app.world_mut().write_message(CommandEnvelope::new(
        command,
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    ));
}

/// Verifies signal-loss policy and stale timeout updates are broadcast and mirrored to fixtures.
#[test]
fn broadcasts_input_signal_loss_policy_and_timeout() {
    let (mut app, rx) = settings_command_app();
    broadcast_io_settings(&mut app);

    app.update();
    drain_channel(&rx);

    submit_settings_command(
        &mut app,
        SettingsCommand::SetInputSignalLossPolicy(InputSignalLossPolicy::ClearAfterTimeout {}),
    );
    submit_settings_command(
        &mut app,
        SettingsCommand::SetInputSignalLossTimeout(Duration::ZERO),
    );

    app.update();

    let raw = rx
        .try_recv()
        .expect("expected websocket settings broadcast after settings command");
    let message = decode_ws_message(&raw.bytes);
    assert_eq!(message["type"], "Settings");
    assert_eq!(
        message["data"]["sections"]["io"]["input_signal_loss_policy"]["type"],
        "ClearAfterTimeout"
    );
    assert_eq!(
        message["data"]["sections"]["io"]["input_signal_loss_timeout"]["secs"],
        0
    );
    assert_eq!(
        message["data"]["sections"]["io"]["input_signal_loss_timeout"]["nanos"],
        1_000_000
    );
    assert_eq!(
        app.world().resource::<InputUniverseStaleTimeout>().0,
        Duration::from_millis(1)
    );
}

/// Verifies DMX output rate updates are clamped to the supported range and broadcast to clients.
#[test]
fn broadcasts_clamped_dmx_output_rate() {
    let (mut app, rx) = settings_command_app();
    broadcast_io_settings(&mut app);
    app.update();
    drain_channel(&rx);

    submit_settings_command(&mut app, SettingsCommand::SetDmxOutputRate(30));
    app.update();
    let message = decode_ws_message(
        &rx.try_recv()
            .expect("expected websocket settings broadcast after rate change")
            .bytes,
    );
    assert_eq!(message["type"], "Settings");
    assert_eq!(message["data"]["sections"]["io"]["dmx_output_rate_hz"], 30);

    submit_settings_command(&mut app, SettingsCommand::SetDmxOutputRate(500));
    app.update();
    assert_eq!(
        app.world()
            .resource::<IoRuntimeSettings>()
            .dmx_output_rate_hz,
        60
    );
}

#[test]
fn updates_route_validation_mode_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(
        &mut app,
        SettingsCommand::SetRouteValidationMode(RouteValidationMode::Permissive),
    );

    app.update();

    assert_eq!(
        app.world().resource::<RouteValidationSettings>().mode,
        RouteValidationMode::Permissive
    );
}

/// Verifies USB output target updates are sanitized and mirrored to fixtures.
#[test]
fn updates_usb_dmx_outputs_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(
        &mut app,
        SettingsCommand::SetUsbDmxOutputs(UsbDmxOutputTargets {
            targets: vec![
                UsbDmxOutputTarget {
                    id: "udmx".to_string(),
                    device: "usb-serial-1".to_string(),
                    device_label: Some("Anyma uDMX".to_string()),
                },
                UsbDmxOutputTarget {
                    id: "front-usb".to_string(),
                    device: "usb-serial-2".to_string(),
                    device_label: Some("Front uDMX".to_string()),
                },
            ],
        }),
    );

    app.update();

    let settings = app.world().resource::<IoRuntimeSettings>();
    assert_eq!(
        settings
            .usb_dmx_outputs
            .get("udmx")
            .map(|target| target.device.as_str()),
        Some("usb-serial-1")
    );
    assert!(settings.usb_dmx_outputs.get("front-usb").is_some());
    assert_eq!(
        settings
            .usb_dmx_outputs
            .get("front-usb")
            .and_then(|target| target.device_label.as_deref()),
        Some("Front uDMX")
    );
    assert_eq!(
        app.world().resource::<UsbDmxOutputTargets>(),
        &settings.usb_dmx_outputs
    );
}

#[test]
fn updates_usb_output_enabled_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(&mut app, SettingsCommand::SetUsbOutputEnabled(false));

    app.update();

    assert!(
        !app.world()
            .resource::<IoRuntimeSettings>()
            .usb_output_enabled
    );
}

#[test]
fn updates_input_universe_visibility_mode_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(
        &mut app,
        SettingsCommand::SetInputUniverseVisibilityMode(InputUniverseVisibilityMode::AllDetected),
    );

    app.update();

    assert_eq!(
        app.world()
            .resource::<IoRuntimeSettings>()
            .input_universe_visibility_mode,
        InputUniverseVisibilityMode::AllDetected
    );
    assert_eq!(
        *app.world().resource::<InputUniverseVisibilityMode>(),
        InputUniverseVisibilityMode::AllDetected
    );
}

/// Verifies stale timeout resource follows direct desk settings changes from showfile loads.
#[test]
fn syncs_input_stale_timeout_from_io_settings() {
    let mut app = App::new();
    app.init_resource::<IoRuntimeSettings>();
    app.init_resource::<ExternalControlState>();
    app.init_resource::<InputUniverseStaleTimeout>();
    app.add_systems(
        Update,
        settings_events::sync_input_stale_timeout_from_settings,
    );

    app.world_mut()
        .resource_mut::<IoRuntimeSettings>()
        .input_signal_loss_timeout = Duration::from_millis(750);
    app.update();

    assert_eq!(
        app.world().resource::<InputUniverseStaleTimeout>().0,
        Duration::from_millis(750)
    );

    app.world_mut()
        .resource_mut::<IoRuntimeSettings>()
        .input_signal_loss_timeout = Duration::ZERO;
    app.update();

    assert_eq!(
        app.world()
            .resource::<IoRuntimeSettings>()
            .input_signal_loss_timeout,
        Duration::from_millis(1)
    );
    assert_eq!(
        app.world().resource::<InputUniverseStaleTimeout>().0,
        Duration::from_millis(1)
    );
}
