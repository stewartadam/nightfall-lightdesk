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
    mut events: MessageReader<ResyncRequested>,
    devices: Res<MidiDevices>,
    mappings: Res<MidiMappings>,
    last_event: Res<LastMidiEvent>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_device_list(&devices, &broadcaster);
    send_mappings(&mappings, &broadcaster);
    if let Some(ref event) = last_event.0 {
        send_last_event(event, &broadcaster);
    }
}

/// System to periodically send MIDI state updates
pub fn send_midi_state(
    devices: Res<MidiDevices>,
    mappings: Res<MidiMappings>,
    last_event: Res<LastMidiEvent>,
    broadcaster: Res<ClientEventSink>,
) {
    // Only send if resources have changed
    if devices.is_changed() {
        send_device_list(&devices, &broadcaster);
    }

    if mappings.is_changed() {
        tracing::debug!(
            "MIDI mappings changed, broadcasting {} mappings",
            mappings.mappings().len()
        );
        send_mappings(&mappings, &broadcaster);
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
fn send_mappings(mappings: &MidiMappings, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiMappings(mappings.mappings()),
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
