// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_app::{App, Last, Update};
use moonshine_kind::Instance;
use nightfall_engine::prelude::EnginePayload;
use nightfall_fixtures::prelude::{MergeStrategy, Parameter, ParameterMetadata, ParameterValues};
use nightfall_fixtures::websocket::ParameterState;
use nightfall_undo::context::UndoContext;
use nightfall_undo::manager::{UndoEntry, UndoGroup, UndoManager};
use nightfall_undo::traits::UndoableOperation;

use super::*;

/// Test command used to verify undo-manager behavior without app dependencies.
#[derive(Debug, Clone, EnginePayload)]
struct TestUndoCommand;

impl UndoableOperation for TestUndoCommand {
    /// Produces no inverse because this command exists only to populate undo metadata.
    fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        None
    }

    /// Returns the stable description asserted by the undo-state tests.
    fn description(&self) -> String {
        "Test Undo Command".to_string()
    }
}

/// Removes any startup messages from a test websocket receiver.
fn drain_channel(rx: &async_channel::Receiver<Vec<u8>>) {
    while rx.try_recv().is_ok() {}
}

/// Decodes a discriminator-prefixed websocket payload into its JSON representation.
fn decode_ws_message(raw: &[u8]) -> serde_json::Value {
    assert!(
        !raw.is_empty(),
        "websocket payload must include discriminator"
    );
    minicbor_serde::from_slice::<serde_json::Value>(&raw[1..])
        .expect("failed to decode websocket payload")
}

/// Spawns a parameter with the requested attribute and merge strategy for layer tests.
fn spawn_parameter(
    app: &mut App,
    attribute: Attribute,
    merge_type: MergeStrategy,
) -> Instance<Parameter> {
    let entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: ParameterMetadata {
                resolution: DmxValueResolution::Coarse,
                native_unit: attribute.native_unit(),
                value_polarity: attribute.value_polarity(),
                attribute,
                min: 0.0,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                is_inverted: false,
                is_snap: false,
                merge_type,
                use_grandmaster: false,
            },
            values: ParameterValues::default(),
        })
        .id();

    unsafe { Instance::from_entity_unchecked(entity) }
}

#[test]
/// Verifies custom attributes retain their distinct labels in parameter snapshots.
fn parameter_state_serializes_custom_attributes_by_label() {
    let state = ParameterState {
        absolute: HashMap::from([(
            Attribute::Custom {
                label: "Tilt Speed".to_owned(),
            },
            ParameterValue::Absolute { value: 64.0 },
        )]),
        relative: HashMap::new(),
        output: HashMap::from([
            (
                Attribute::Custom {
                    label: "Tilt Speed".to_owned(),
                },
                128.0,
            ),
            (
                Attribute::Custom {
                    label: "Aux Strips Light Speed".to_owned(),
                },
                255.0,
            ),
        ]),
    };

    let serialized =
        serde_json::to_value(&state).expect("parameter state should serialize to JSON");

    assert_eq!(serialized["absolute"]["Tilt Speed"]["data"]["value"], 64.0);
    assert_eq!(serialized["output"]["Tilt Speed"], 128.0);
    assert_eq!(serialized["output"]["Aux Strips Light Speed"], 255.0);
    assert!(
        serialized["output"].get("Custom").is_none(),
        "custom attributes must not collide under the shared Custom key",
    );
}

#[test]
/// Verifies log-level commands are echoed as non-droppable desk messages.
fn forward_desk_commands_broadcasts_set_log_level() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let mut app = App::new();
    app.add_message::<CommandEnvelope<DeskCommand>>();
    app.insert_resource(ClientEventSink::new(tx));
    app.add_systems(Update, forward_desk_commands);

    app.world_mut().write_message(CommandEnvelope::new(
        DeskCommand::SetLogLevel("debug".to_string()),
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    ));

    app.update();

    let payload = rx
        .try_recv()
        .expect("expected websocket payload for SetLogLevel");
    assert_eq!(payload.first().copied(), Some(DISCRIMINATOR_NON_DROPPABLE));

    let payload_text = String::from_utf8_lossy(&payload);
    assert!(
        payload_text.contains("DeskCommand"),
        "payload did not include DeskCommand tag: {payload_text:?}"
    );
    assert!(
        payload_text.contains("SetLogLevel"),
        "payload did not include SetLogLevel variant: {payload_text:?}"
    );
    assert!(
        payload_text.contains("debug"),
        "payload did not include configured level: {payload_text:?}"
    );
}

#[test]
/// Verifies desk commands without a UI synchronization contract are not echoed.
fn forward_desk_commands_ignores_non_log_level() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let mut app = App::new();
    app.add_message::<CommandEnvelope<DeskCommand>>();
    app.insert_resource(ClientEventSink::new(tx));
    app.add_systems(Update, forward_desk_commands);

    app.world_mut().write_message(CommandEnvelope::new(
        DeskCommand::Eval("fixture 1 at full".to_string()),
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    ));

    app.update();

    assert!(
        rx.try_recv().is_err(),
        "non-log desk command should not be broadcast"
    );
}

#[test]
/// Verifies UI notifications are forwarded as non-droppable websocket messages.
fn forward_ui_notifications_broadcasts_show_toast() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let mut app = App::new();
    app.add_message::<UiNotification>();
    app.init_resource::<UiNotificationState>();
    app.insert_resource(ClientEventSink::new(tx));
    app.add_systems(Update, forward_ui_notifications);

    app.world_mut().write_message(UiNotification::ShowToast {
        level: crate::ui_notification::ToastLevel::Success,
        message: "done".to_string(),
    });

    app.update();

    let payload = rx
        .try_recv()
        .expect("expected websocket payload for UiNotification::ShowToast");
    assert_eq!(payload.first().copied(), Some(DISCRIMINATOR_NON_DROPPABLE));

    let payload_text = String::from_utf8_lossy(&payload);
    assert!(
        payload_text.contains("UiNotification"),
        "payload did not include UiNotification tag: {payload_text:?}"
    );
    assert!(
        payload_text.contains("ShowToast"),
        "payload did not include ShowToast variant: {payload_text:?}"
    );
    assert!(
        payload_text.contains("done"),
        "payload did not include toast message: {payload_text:?}"
    );
}

#[test]
/// Verifies queued startup notifications are replayed once and then drained.
fn flush_pending_ui_notifications_broadcasts_and_drains_notifications() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let broadcaster = ClientEventSink::new(tx);
    let mut pending = UiNotificationState::default();
    pending.push(UiNotification::ShowToast {
        level: crate::ui_notification::ToastLevel::Error,
        message: "startup failed".to_string(),
    });

    flush_pending_ui_notifications(Some(&mut pending), &broadcaster);

    let payload = rx
        .try_recv()
        .expect("expected websocket payload for pending UiNotification::ShowToast");
    assert_eq!(payload.first().copied(), Some(DISCRIMINATOR_NON_DROPPABLE));

    let payload_text = String::from_utf8_lossy(&payload);
    assert!(
        payload_text.contains("ShowToast"),
        "payload did not include ShowToast variant: {payload_text:?}"
    );
    assert!(
        payload_text.contains("startup failed"),
        "payload did not include toast message: {payload_text:?}"
    );

    flush_pending_ui_notifications(Some(&mut pending), &broadcaster);
    assert!(
        rx.try_recv().is_err(),
        "pending UI notifications should be drained after replay"
    );
}

#[test]
/// Reconnects must receive confirmed identity even after an unobserved internal resync.
fn resync_replays_showfile_identity_after_earlier_delivery() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let broadcaster = ClientEventSink::new(tx);
    let mut state = UiNotificationState::default();
    flush_pending_ui_notifications(Some(&mut state), &broadcaster);
    assert!(
        rx.try_recv().is_err(),
        "initial worlds have no confirmed identity"
    );
    state.push(UiNotification::current_showfile_changed(Some(
        "Sample Tour".to_string(),
    )));
    for _ in 0..2 {
        flush_pending_ui_notifications(Some(&mut state), &broadcaster);
        let payload = rx.try_recv().expect("identity must survive every resync");
        assert!(String::from_utf8_lossy(&payload).contains("Sample Tour"));
    }
}

#[test]
/// Live rename notifications replace the identity retained for a later reconnect.
fn forward_ui_notifications_updates_replayed_identity() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let mut app = App::new();
    app.add_message::<UiNotification>();
    app.init_resource::<UiNotificationState>();
    app.insert_resource(ClientEventSink::new(tx));
    app.add_systems(Update, forward_ui_notifications);
    app.world_mut().resource_mut::<UiNotificationState>().push(
        UiNotification::current_showfile_changed(Some("Old".to_string())),
    );
    app.world_mut()
        .write_message(UiNotification::current_showfile_changed(Some(
            "Renamed".to_string(),
        )));
    app.update();
    rx.try_recv().expect("live notification");
    let replay: Vec<_> = app
        .world_mut()
        .resource_mut::<UiNotificationState>()
        .take_for_resync()
        .collect();
    assert!(
        matches!(replay.as_slice(), [UiNotification::CurrentShowfileChanged { name: Some(name), .. }] if name == "Renamed")
    );
}

#[test]
/// Verifies an unchanged undo manager produces no repeated websocket traffic.
fn send_undo_state_on_change_does_not_broadcast_when_idle() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let mut app = App::new();
    app.insert_resource(ClientEventSink::new(tx));
    app.init_resource::<UndoManager>();
    app.add_systems(Update, send_undo_state_on_change);
    app.add_systems(Last, nightfall_undo::systems::finalize_detached_undo_groups);

    // Allow any startup frame noise, then assert no repeated UndoState traffic.
    app.update();
    drain_channel(&rx);

    app.update();
    app.update();

    assert!(
        rx.try_recv().is_err(),
        "did not expect undo state broadcasts while undo manager is idle"
    );
}

#[test]
/// Verifies undo stack changes broadcast complete developer-visible metadata.
fn send_undo_state_on_change_broadcasts_on_undo_stack_change() {
    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let mut app = App::new();
    app.insert_resource(ClientEventSink::new(tx));
    app.init_resource::<UndoManager>();
    app.add_systems(Update, send_undo_state_on_change);

    app.update();
    drain_channel(&rx);

    let entry = UndoEntry {
        command: Box::new(TestUndoCommand),
        description: "Add fixture".to_string(),
        command_id: Some(CommandId::new()),
    };
    app.world_mut()
        .resource_mut::<UndoManager>()
        .push_undo_group_direct(UndoGroup {
            entries: vec![entry],
            description: "Add fixture".to_string(),
            timestamp: std::time::Instant::now(),
            is_gurq_preserved: false,
            undo_id: UndoId::new(),
        });

    app.update();

    let payload = rx
        .try_recv()
        .expect("expected websocket payload for undo state change");
    let message = decode_ws_message(&payload);
    assert_eq!(message["type"], "UndoState");
    assert_eq!(message["data"]["can_undo"], true);
    assert_eq!(message["data"]["undo_depth"], 1);
    assert_eq!(message["data"]["undo_description"], "Add fixture");
    assert_eq!(message["data"]["undo_stack"][0]["order"], 0);
    assert_eq!(
        message["data"]["undo_stack"][0]["description"],
        "Add fixture"
    );
    assert_eq!(message["data"]["undo_stack"][0]["entry_count"], 1);
    assert!(
        message["data"]["undo_stack"][0]["age_ms"]
            .as_u64()
            .is_some(),
        "expected undo stack age in milliseconds"
    );
    assert_eq!(message["data"]["undo_stack"][0]["is_gurq_preserved"], false);
    assert_eq!(
        message["data"]["undo_stack"][0]["entry_descriptions"][0],
        "Add fixture"
    );
    assert_eq!(
        message["data"]["undo_stack"][0]["correlation_ids"]
            .as_array()
            .expect("expected correlation IDs")
            .len(),
        1
    );
    assert_eq!(
        message["data"]["redo_stack"]
            .as_array()
            .expect("expected redo stack")
            .len(),
        0
    );
}

#[test]
/// Verifies a parameter reports an active transition during its fade-in window.
fn is_transition_active_reports_active_during_fade_in() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::LTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());

    let active = is_transition_active(
        &parameters_query,
        parameter.into(),
        &ParameterValue::Absolute { value: 255.0 },
        &MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
        51.0,
        Some(&nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(200),
            released_at: None,
        }),
    );

    assert!(active);
}

#[test]
/// Verifies a completed fade-in no longer reports an active transition.
fn is_transition_active_reports_inactive_after_fade_in_completes() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::LTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());

    let active = is_transition_active(
        &parameters_query,
        parameter.into(),
        &ParameterValue::Absolute { value: 255.0 },
        &MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
        255.0,
        Some(&nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_secs(1),
            released_at: None,
        }),
    );

    assert!(!active);
}

#[test]
/// Verifies negative HTP relative values use fade-out timing.
fn is_transition_active_uses_fade_out_timing_for_htp_relative_fade_down() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::HTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());

    let active = is_transition_active(
        &parameters_query,
        parameter.into(),
        &ParameterValue::Relative { offset: -30.0 },
        &MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::from_millis(500),
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
        90.0,
        Some(&nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(300),
            released_at: None,
        }),
    );

    assert!(active);
}

/// Verifies transition reporting uses a supplied playback-clock elapsed duration.
#[test]
fn is_transition_active_uses_explicit_compositing_context_when_present() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::LTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());

    let active = is_transition_active(
        &parameters_query,
        parameter.into(),
        &ParameterValue::Absolute { value: 255.0 },
        &MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
        127.0,
        Some(&nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(500),
            released_at: None,
        }),
    );

    assert!(active);
}

/// Verifies websocket transition state honors each transition's source-local start anchor.
#[test]
fn computed_transition_state_uses_compositing_context_per_transition_start_position() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::LTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let mut param_map = bimap::BiMap::new();
    param_map.insert((fixture_ref, Attribute::Red), parameter);

    let mut layer = Layer::new("clocked".to_owned(), Priority::default());
    layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 255.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::from_millis(900),
                release_position: None,
            }),
        ),
    );
    let mut output = ComputedLayer::default();
    output.absolute.insert(parameter, 25.0);
    let compositing_context = LayerCompositingContext {
        position: Duration::from_secs(1),
        released_at: None,
    };

    let transition_state = computed_transition_fixture_state(
        &layer,
        &output,
        &param_map,
        &parameters_query,
        false,
        Some(&compositing_context),
    );

    assert_eq!(transition_state.len(), 1);
    assert_eq!(transition_state[0].fixture_uid, fixture_uid);
    assert_eq!(
        transition_state[0].parameters[0].get(&Attribute::Red),
        Some(&true)
    );
}
