// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for MIDI input
//!
//! This module provides:
//! - Command deserializer for MidiCommand
//! - Broadcasters for device list, mappings, and last event

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::command::{MidiCommand, MidiLastEvent, MidiMapping};
use crate::mapping::MidiMappings;
use crate::{LastMidiEvent, MidiDevices};

/// MIDI device information sent to the UI
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct MidiDevice {
    /// Device name
    pub name: String,
}

/// WebSocket message types for MIDI
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
#[allow(clippy::enum_variant_names)]
enum MidiWsMessage<'a> {
    /// List of connected MIDI devices
    MidiDeviceList(&'a [MidiDevice]),
    /// Current MIDI mappings configuration
    MidiMappings(&'a [MidiMapping]),
    /// Per-row validation failures; null entries remain eligible for dispatch.
    MidiMappingDiagnostics(Vec<Option<CommandError>>),
    /// Last received MIDI event (for identification)
    MidiLastEvent(&'a MidiLastEvent),
}

/// Deserialize and dispatch MidiCommand from JSON
pub fn deserialize_midi_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: MidiCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse MidiCommand: {}", e))?;

    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));

    Ok(())
}

/// System to send MIDI state on resync
pub fn handle_resync_state(
    world: &World,
    mut events: MessageReader<ResyncRequested>,
    devices: Res<MidiDevices>,
    mappings: Res<MidiMappings>,
    registry: Res<nightfall_actions::ActionRegistry>,
    last_event: Res<LastMidiEvent>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_device_list(&devices, &broadcaster);
    send_mappings(
        &mappings,
        mappings.target_validation_errors(world, &registry, &mappings.validation_errors(&registry)),
        &broadcaster,
    );
    if let Some(ref event) = last_event.0 {
        send_last_event(event, &broadcaster);
    }
}

/// System to periodically send MIDI state updates
pub fn send_midi_state(
    world: &World,
    mut contract_errors: Local<Option<Vec<Option<CommandError>>>>,
    mut published_errors: Local<Option<Vec<Option<CommandError>>>>,
    devices: Res<MidiDevices>,
    mappings: Res<MidiMappings>,
    registry: Res<nightfall_actions::ActionRegistry>,
    last_event: Res<LastMidiEvent>,
    broadcaster: Res<ClientEventSink>,
) {
    // Only send if resources have changed
    if devices.is_changed() {
        send_device_list(&devices, &broadcaster);
    }

    if contract_errors.is_none() || mappings.is_changed() || registry.is_changed() {
        *contract_errors = Some(mappings.validation_errors(&registry));
    }
    let errors = mappings.target_validation_errors(
        world,
        &registry,
        contract_errors.as_deref().unwrap_or_default(),
    );
    if mappings.is_changed() || published_errors.as_ref() != Some(&errors) {
        tracing::debug!(
            "MIDI mappings changed, broadcasting {} mappings",
            mappings.mappings().len()
        );
        send_mappings(&mappings, errors.clone(), &broadcaster);
        *published_errors = Some(errors);
    }

    if last_event.is_changed() {
        if let Some(ref event) = last_event.0 {
            send_last_event(event, &broadcaster);
        }
    }
}

/// Send device list to WebSocket clients
pub(crate) fn send_device_list(devices: &MidiDevices, broadcaster: &ClientEventSink) {
    let device_list: Vec<MidiDevice> = devices
        .device_names()
        .into_iter()
        .map(|name| MidiDevice { name })
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiDeviceList(&device_list),
    );
    tracing::trace!("Sending MIDI device list to WebSocket clients");
}

/// Send mappings to WebSocket clients
fn send_mappings(
    mappings: &MidiMappings,
    diagnostics: Vec<Option<CommandError>>,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiMappings(mappings.mappings()),
    );
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiMappingDiagnostics(diagnostics),
    );
    tracing::trace!("Sending MIDI mappings to WebSocket clients");
}

/// Send last MIDI event to WebSocket clients
fn send_last_event(event: &MidiLastEvent, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_DROPPABLE,
        &MidiWsMessage::MidiLastEvent(event),
    );
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;

    use super::*;

    /// Target deletion and restoration publish diagnostics without changing the saved binding.
    #[test]
    fn target_diagnostics_follow_domain_changes_without_repeated_broadcasts() {
        use nightfall_actions::{
            ActionDescriptor, ActionId, ActionInputKind, ActionRegistry, ActionSurface,
            InvocationDispatch, InvocationError,
        };
        #[derive(Resource)]
        struct TargetAvailable;
        #[derive(serde::Deserialize)]
        #[serde(tag = "type", content = "data")]
        enum Snapshot {
            MidiMappings(Vec<MidiMapping>),
        }

        let (sender, receiver) = async_channel::unbounded();
        let mut app = bevy_app::App::new();
        app.insert_resource(ClientEventSink::new(sender));
        app.init_resource::<MidiDevices>();
        app.init_resource::<LastMidiEvent>();
        app.init_resource::<ActionRegistry>();
        app.insert_resource(TargetAvailable);
        let mapping = MidiMapping {
            id: uuid::Uuid::new_v4(),
            device_name: "Controller".into(),
            channel: 0x90,
            note: 42,
            velocity: None,
            input: crate::command::MidiBindingInput::Press,
            action: nightfall_actions::ActionReference::new("test.target", serde_json::json!({})),
        };
        let mut mappings = MidiMappings::new();
        mappings.set_mappings(vec![mapping.clone()]);
        app.insert_resource(mappings);
        let mut registry = app.world_mut().resource_mut::<ActionRegistry>();
        registry.register::<Value, _>(
            ActionDescriptor {
                id: ActionId::new("test.target"),
                label: "Test target".into(),
                allowed_surfaces: vec![ActionSurface::Midi],
                input_kind: ActionInputKind::Trigger,
                argument_schema: serde_json::json!({}),
                capabilities: vec![],
            },
            |_, _, _| Ok(InvocationDispatch::succeeded()),
        );
        registry.register_target_validator::<Value, _>("test.target", |world, _| {
            if world.contains_resource::<TargetAvailable>() {
                Ok(())
            } else {
                Err(InvocationError::new(
                    "test.target_missing",
                    "Target was deleted",
                ))
            }
        });
        app.add_message::<ResyncRequested>();
        app.add_systems(
            bevy_app::Update,
            (send_midi_state, handle_resync_state).chain(),
        );
        app.update();
        while receiver.try_recv().is_ok() {}
        app.update();
        assert!(receiver.try_recv().is_err());

        for available in [false, true] {
            if available {
                app.world_mut().insert_resource(TargetAvailable);
            } else {
                app.world_mut().remove_resource::<TargetAvailable>();
            }
            app.update();
            let bytes = receiver.try_recv().unwrap();
            let Snapshot::MidiMappings(snapshot) = minicbor_serde::from_slice(&bytes[1..]).unwrap();
            assert_eq!(snapshot, vec![mapping.clone()]);
            let bytes = receiver.try_recv().unwrap();
            assert_eq!(bytes[0], DISCRIMINATOR_NON_DROPPABLE);
            let diagnostic: Value = minicbor_serde::from_slice(&bytes[1..]).unwrap();
            assert_eq!(diagnostic["type"], "MidiMappingDiagnostics");
            if available {
                assert!(diagnostic["data"][0].is_null());
            } else {
                assert_eq!(diagnostic["data"][0]["code"], "test.target_missing");
            }
            assert_eq!(
                app.world().resource::<MidiMappings>().mappings(),
                &[mapping.clone()]
            );
            app.update();
            assert!(receiver.try_recv().is_err());
            app.world_mut()
                .write_message(ResyncRequested { command_id: None });
            app.update();
            let resynced: Vec<Value> = std::iter::from_fn(|| receiver.try_recv().ok())
                .filter_map(|bytes| minicbor_serde::from_slice::<Value>(&bytes[1..]).ok())
                .filter(|message| message["type"] == "MidiMappingDiagnostics")
                .collect();
            assert_eq!(resynced, vec![diagnostic]);
        }
    }

    /// Loaded unavailable actions retain their row and publish a reliable diagnostic alongside it.
    #[test]
    fn mapping_snapshot_includes_validation_diagnostics() {
        let (sender, receiver) = async_channel::unbounded();
        let sink = ClientEventSink::new(sender);
        let mut mappings = MidiMappings::new();
        mappings.set_mappings(vec![MidiMapping {
            id: uuid::Uuid::new_v4(),
            device_name: "Controller".into(),
            channel: 0x90,
            note: 42,
            velocity: None,
            input: crate::command::MidiBindingInput::Press,
            action: nightfall_actions::ActionReference::new(
                "missing.action",
                serde_json::json!({}),
            ),
        }]);
        send_mappings(
            &mappings,
            mappings.validation_errors(&nightfall_actions::ActionRegistry::default()),
            &sink,
        );
        assert_eq!(receiver.try_recv().unwrap()[0], DISCRIMINATOR_NON_DROPPABLE);
        let bytes = receiver.try_recv().unwrap();
        assert_eq!(bytes[0], DISCRIMINATOR_NON_DROPPABLE);
        let diagnostic: Value = minicbor_serde::from_slice(&bytes[1..]).unwrap();
        assert_eq!(diagnostic["type"], "MidiMappingDiagnostics");
        assert_eq!(diagnostic["data"][0]["code"], "action.not_registered");
        assert_eq!(mappings.mappings().len(), 1);
    }

    #[test]
    fn deserialize_midi_command_writes_semantic_envelope() {
        let mut world = World::new();
        world.insert_resource(Messages::<CommandEnvelope<MidiCommand>>::default());

        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        deserialize_midi_command(
            &mut world,
            serde_json::json!({
                "type": "DeleteMapping",
                "data": 3
            }),
            command_id,
            undo_id,
        )
        .expect("midi command should deserialize");

        let messages: Vec<_> = world
            .resource_mut::<Messages<CommandEnvelope<MidiCommand>>>()
            .drain()
            .collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].command_id, command_id);
        assert_eq!(messages[0].undo_id, undo_id);
        assert!(matches!(messages[0].command, MidiCommand::DeleteMapping(3)));
    }
}
