// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use async_channel::{Receiver, TryRecvError};
use bevy_app::{App, Update};
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall_desk::prelude::{
    ActivePanelLayout, AvailableAudioDevices, DeskSettings, SelectionFlattenPolicy,
    SequenceReorderRenumberPolicy, SettingsCommand, StoredPanelLayout, StoredPanelLayoutPanel,
    TimeDisplayPreference, TimelinePlacementPreference,
};
use nightfall_desk::systems::event_handlers::settings_events;
use nightfall_desk::websocket::{send_io_settings_on_change, send_settings_on_change};
use nightfall_engine::prelude::{ClientEventSink, CommandEnvelope, CommandOrigin, ReplyTarget};
use nightfall_fixtures::prelude::{
    BindingValidationMode, BindingValidationSettings, InputDmxUniverses, InputUniverseStaleTimeout,
};
use nightfall_io::prelude::{
    AvailableUsbDmxDevices, ExternalControlState, InputSignalLossPolicy,
    InputUniverseVisibilityMode, IoRuntimeSettings, NetworkDmxOutputTargets, NetworkInterfaceState,
    UsbDmxOutputTarget, UsbDmxOutputTargets,
};

fn drain_channel(rx: &Receiver<Vec<u8>>) {
    loop {
        match rx.try_recv() {
            Ok(_) => {}
            Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => break,
        }
    }
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
fn settings_command_app() -> (App, Receiver<Vec<u8>>) {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let mut app = App::new();
    app.add_message::<CommandEnvelope<SettingsCommand>>();
    app.add_message::<settings_events::SettingsCommandResult>();
    app.init_resource::<DeskSettings>();
    app.init_resource::<IoRuntimeSettings>();
    app.init_resource::<ExternalControlState>();
    app.init_resource::<BindingValidationSettings>();
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
    app.add_systems(Update, settings_events::handle_events);
    (app, rx)
}

/// Submits one independently tracked settings command to a focused handler test.
fn submit_settings_command(app: &mut App, command: SettingsCommand) {
    app.world_mut().write_message(CommandEnvelope::new(
        command,
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    ));
}

#[test]
fn broadcasts_settings_when_desk_settings_changes() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();

    let mut app = App::new();
    app.init_resource::<DeskSettings>();
    app.insert_resource(ClientEventSink::new(tx));
    app.add_systems(Update, send_settings_on_change);

    app.update();
    drain_channel(&rx);

    {
        let mut settings = app.world_mut().resource_mut::<DeskSettings>();
        settings.programmer_auto_select = true;
        settings.panel_layouts = vec![StoredPanelLayout {
            shown_in_switcher: true,
            id: "layout-b".to_string(),
            name: "Layout B".to_string(),
            version: 2,
            layout: serde_json::json!({ "grid": "b" }),
            panels: vec![StoredPanelLayoutPanel {
                id: "panel-Cues".to_string(),
                title: "Cues".to_string(),
                params: serde_json::json!({ "sequence": "main" }),
            }],
            created_at: 30.0,
            updated_at: 40.0,
        }];
    }
    app.update();

    let raw = rx
        .try_recv()
        .expect("expected websocket settings broadcast after settings change");
    let message = decode_ws_message(&raw);
    assert_eq!(message["type"], "Settings");
    assert_eq!(message["data"]["programmer_auto_select"], true);
    assert_eq!(message["data"]["panel_layouts"][0]["name"], "Layout B");
    assert_eq!(message["data"]["panel_layouts"][0]["layout"]["grid"], "b");
}

#[test]
fn does_not_broadcast_settings_without_change() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();

    let mut app = App::new();
    app.init_resource::<DeskSettings>();
    app.insert_resource(ClientEventSink::new(tx));
    app.add_systems(Update, send_settings_on_change);

    app.update();
    drain_channel(&rx);
    app.update();

    assert!(
        matches!(rx.try_recv(), Err(TryRecvError::Empty)),
        "did not expect websocket settings broadcast without settings change"
    );
}

/// Verifies signal-loss policy and stale timeout updates are broadcast and mirrored to fixtures.
#[test]
fn broadcasts_input_signal_loss_policy_and_timeout() {
    let (mut app, rx) = settings_command_app();
    app.add_systems(
        Update,
        send_io_settings_on_change.after(settings_events::handle_events),
    );

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
    let message = decode_ws_message(&raw);
    assert_eq!(message["type"], "IoSettings");
    assert_eq!(
        message["data"]["input_signal_loss_policy"]["type"],
        "ClearAfterTimeout"
    );
    assert_eq!(message["data"]["input_signal_loss_timeout"]["secs"], 0);
    assert_eq!(
        message["data"]["input_signal_loss_timeout"]["nanos"],
        1_000_000
    );
    assert_eq!(
        app.world().resource::<InputUniverseStaleTimeout>().0,
        Duration::from_millis(1)
    );
}

#[test]
fn updates_binding_validation_mode_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(
        &mut app,
        SettingsCommand::SetBindingValidationMode(BindingValidationMode::Permissive),
    );

    app.update();

    assert_eq!(
        app.world().resource::<BindingValidationSettings>().mode,
        BindingValidationMode::Permissive
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
fn updates_sequence_reorder_renumber_policy_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(
        &mut app,
        SettingsCommand::SetSequenceReorderRenumberPolicy(
            SequenceReorderRenumberPolicy::AutoRenumber,
        ),
    );

    app.update();

    assert_eq!(
        app.world()
            .resource::<DeskSettings>()
            .sequence_reorder_renumber_policy,
        SequenceReorderRenumberPolicy::AutoRenumber
    );
}

#[test]
fn deserializes_sequence_reorder_renumber_policy_settings_command() {
    let json = serde_json::json!({
        "type": "SetSequenceReorderRenumberPolicy",
        "data": "Prompt"
    });

    let command: SettingsCommand =
        serde_json::from_value(json).expect("expected Prompt settings command to deserialize");

    let SettingsCommand::SetSequenceReorderRenumberPolicy(policy) = command else {
        panic!("expected SetSequenceReorderRenumberPolicy command");
    };

    assert_eq!(policy, SequenceReorderRenumberPolicy::Prompt);
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

#[test]
fn updates_selection_flatten_policy_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(
        &mut app,
        SettingsCommand::SetSelectionFlattenPolicy(SelectionFlattenPolicy::Prompt),
    );

    app.update();

    assert_eq!(
        app.world()
            .resource::<DeskSettings>()
            .selection_flatten_policy,
        SelectionFlattenPolicy::Prompt
    );
}

#[test]
fn deserializes_selection_flatten_policy_settings_command() {
    let json = serde_json::json!({
        "type": "SetSelectionFlattenPolicy",
        "data": "Prompt"
    });

    let command: SettingsCommand = serde_json::from_value(json)
        .expect("expected Prompt selection flatten policy command to deserialize");

    let SettingsCommand::SetSelectionFlattenPolicy(policy) = command else {
        panic!("expected SetSelectionFlattenPolicy command");
    };

    assert_eq!(policy, SelectionFlattenPolicy::Prompt);
}

#[test]
fn updates_time_display_preference_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(
        &mut app,
        SettingsCommand::SetTimeDisplayPreference(TimeDisplayPreference::Milliseconds),
    );

    app.update();

    assert_eq!(
        app.world()
            .resource::<DeskSettings>()
            .time_display_preference,
        TimeDisplayPreference::Milliseconds
    );
}

#[test]
fn deserializes_time_display_preference_settings_command() {
    let json = serde_json::json!({
        "type": "SetTimeDisplayPreference",
        "data": "Bpm"
    });

    let command: SettingsCommand = serde_json::from_value(json)
        .expect("expected BPM time display preference command to deserialize");

    let SettingsCommand::SetTimeDisplayPreference(preference) = command else {
        panic!("expected SetTimeDisplayPreference command");
    };

    assert_eq!(preference, TimeDisplayPreference::Bpm);
}

/// Verifies settings commands update the timeline placement preference resource field.
#[test]
fn updates_timeline_placement_preference_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(
        &mut app,
        SettingsCommand::SetTimelinePlacementPreference(TimelinePlacementPreference::Cursor),
    );

    app.update();

    assert_eq!(
        app.world()
            .resource::<DeskSettings>()
            .timeline_placement_preference,
        TimelinePlacementPreference::Cursor
    );
}

/// Verifies timeline placement settings commands deserialize from UI JSON.
#[test]
fn deserializes_timeline_placement_preference_settings_command() {
    let json = serde_json::json!({
        "type": "SetTimelinePlacementPreference",
        "data": "Cursor"
    });

    let command: SettingsCommand = serde_json::from_value(json)
        .expect("expected cursor timeline placement preference command to deserialize");

    let SettingsCommand::SetTimelinePlacementPreference(preference) = command else {
        panic!("expected SetTimelinePlacementPreference command");
    };

    assert_eq!(preference, TimelinePlacementPreference::Cursor);
}

/// Verifies settings commands update the showfile backup retention resource field.
#[test]
fn updates_showfile_backup_retention_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    submit_settings_command(&mut app, SettingsCommand::SetShowfileBackupRetention(7));

    app.update();

    assert_eq!(
        app.world()
            .resource::<DeskSettings>()
            .showfile_backup_retention,
        7
    );
}

/// Verifies websocket payloads deserialize into the backup retention settings command.
#[test]
fn deserializes_showfile_backup_retention_settings_command() {
    let json = serde_json::json!({
        "type": "SetShowfileBackupRetention",
        "data": 3
    });

    let command: SettingsCommand = serde_json::from_value(json)
        .expect("expected showfile backup retention command to deserialize");

    let SettingsCommand::SetShowfileBackupRetention(retention) = command else {
        panic!("expected SetShowfileBackupRetention command");
    };

    assert_eq!(retention, 3);
}

/// Verifies settings commands update showfile-scoped named panel layouts.
#[test]
fn updates_panel_layouts_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    let layout = StoredPanelLayout {
        shown_in_switcher: true,
        id: "layout-a".to_string(),
        name: "Layout A".to_string(),
        version: 2,
        layout: serde_json::json!({ "grid": "a" }),
        panels: Vec::new(),
        created_at: 10.0,
        updated_at: 20.0,
    };
    submit_settings_command(
        &mut app,
        SettingsCommand::SetPanelLayouts(vec![layout.clone()]),
    );

    app.update();

    assert_eq!(
        app.world().resource::<DeskSettings>().panel_layouts,
        vec![layout]
    );
}

/// Verifies switcher visibility and order round-trip as properties of saved layouts.
#[test]
fn layout_visibility_and_order_round_trip() {
    let (mut app, _rx) = settings_command_app();
    let layouts: Vec<_> = [("second", true), ("hidden", false), ("first", true)]
        .into_iter()
        .map(|(id, shown_in_switcher)| StoredPanelLayout {
            id: id.into(),
            name: id.into(),
            shown_in_switcher,
            version: 2,
            layout: serde_json::json!({}),
            panels: Vec::new(),
            created_at: 0.0,
            updated_at: 0.0,
        })
        .collect();
    submit_settings_command(&mut app, SettingsCommand::SetPanelLayouts(layouts.clone()));
    app.update();
    let settings = app.world().resource::<DeskSettings>();
    let decoded: DeskSettings =
        serde_json::from_str(&serde_json::to_string(settings).unwrap()).unwrap();
    assert_eq!(decoded.panel_layouts, layouts);
}

/// Verifies settings commands update the showfile-scoped active panel layout.
#[test]
fn updates_active_panel_layout_from_settings_command() {
    let (mut app, _rx) = settings_command_app();

    let layout = ActivePanelLayout {
        layout_id: Some("layout-a".into()),
        version: 2,
        layout: serde_json::json!({ "grid": "active" }),
        panels: vec![StoredPanelLayoutPanel {
            id: "panel-Cues".to_string(),
            title: "Cues".to_string(),
            params: serde_json::json!({ "sequence": "main" }),
        }],
        updated_at: 50.0,
    };
    submit_settings_command(
        &mut app,
        SettingsCommand::SetActivePanelLayout(Some(layout.clone())),
    );

    app.update();

    assert_eq!(
        app.world().resource::<DeskSettings>().active_panel_layout,
        Some(layout)
    );
}
