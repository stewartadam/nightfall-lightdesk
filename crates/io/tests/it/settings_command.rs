// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The IO settings command through the engine's settings registry.

use std::time::Duration;

use async_channel::Receiver;
use bevy_app::App;
use nightfall_engine::EnginePlugin;
use nightfall_engine::prelude::{
    ClientEventSink, CommandEnvelope, CommandOrigin, CommandTracker, OutboundFrame, ReplyTarget,
};
use nightfall_io::prelude::{
    InputSignalLossPolicy, InputUniverseVisibilityMode, IoPlugin, IoRuntimeSettings,
    IoSettingsCommand, UsbDmxOutputTarget, UsbDmxOutputTargets,
};

/// Builds an engine app with the IO plugin whose client messages arrive on the returned channel.
fn io_app() -> (App, Receiver<OutboundFrame>) {
    let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
    let mut app = App::new();
    app.add_plugins(EnginePlugin);
    app.insert_resource(ClientEventSink::new(tx));
    app.add_plugins(IoPlugin);
    app.update();
    drain_channel(&rx);
    (app, rx)
}

/// Discards every message currently buffered on `rx`.
fn drain_channel(rx: &Receiver<OutboundFrame>) {
    while rx.try_recv().is_ok() {}
}

/// Decodes every buffered client message and returns the first one of type `Settings`.
fn next_settings_message(rx: &Receiver<OutboundFrame>) -> serde_json::Value {
    while let Ok(frame) = rx.try_recv() {
        let message: serde_json::Value =
            minicbor_serde::from_slice(&frame.bytes[1..]).expect("client message should decode");
        if message["type"] == "Settings" {
            return message;
        }
    }
    panic!("expected a Settings message");
}

/// Registers and submits one IO settings command.
fn submit(app: &mut App, command: IoSettingsCommand) {
    let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("IO settings command should register");
    app.world_mut().write_message(envelope);
}

/// Verifies signal-loss changes are sent to clients in the `io` settings section, with a zero
/// timeout clamped to one millisecond.
#[test]
fn signal_loss_changes_reach_clients() {
    let (mut app, rx) = io_app();
    submit(
        &mut app,
        IoSettingsCommand::SetInputSignalLossPolicy(InputSignalLossPolicy::ClearAfterTimeout {}),
    );
    submit(
        &mut app,
        IoSettingsCommand::SetInputSignalLossTimeout(Duration::ZERO),
    );
    app.update();

    let message = next_settings_message(&rx);
    let io = &message["data"]["sections"]["io"];
    assert_eq!(io["input_signal_loss_policy"]["type"], "ClearAfterTimeout");
    assert_eq!(io["input_signal_loss_timeout"]["secs"], 0);
    assert_eq!(io["input_signal_loss_timeout"]["nanos"], 1_000_000);
}

/// Verifies the output rate is sent to clients and clamped to the supported range.
#[test]
fn output_rate_is_clamped_and_sent() {
    let (mut app, rx) = io_app();
    submit(&mut app, IoSettingsCommand::SetDmxOutputRate(30));
    app.update();
    assert_eq!(
        next_settings_message(&rx)["data"]["sections"]["io"]["dmx_output_rate_hz"],
        30
    );

    submit(&mut app, IoSettingsCommand::SetDmxOutputRate(500));
    app.update();
    assert_eq!(
        app.world()
            .resource::<IoRuntimeSettings>()
            .dmx_output_rate_hz,
        60
    );
}

/// Verifies USB output targets are stored and mirrored into the targets USB output reads.
#[test]
fn usb_targets_reach_the_live_targets() {
    let (mut app, _rx) = io_app();
    submit(
        &mut app,
        IoSettingsCommand::SetUsbDmxOutputs(UsbDmxOutputTargets {
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

/// Verifies the visibility mode reaches both the settings and the resource input transports
/// read.
#[test]
fn visibility_mode_reaches_inputs() {
    let (mut app, _rx) = io_app();
    submit(
        &mut app,
        IoSettingsCommand::SetInputUniverseVisibilityMode(InputUniverseVisibilityMode::AllDetected),
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
