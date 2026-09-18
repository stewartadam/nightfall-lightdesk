// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI input handling crate
//!
//! This crate provides MIDI device discovery, input monitoring, and configurable
//! action mappings for triggering clip commands.

#![warn(missing_docs)]

use std::time::{Duration, Instant};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_actions::{ActionInvocation, ActionSurface, ActionsPlugin};
use nightfall_engine::prelude::*;
use tokio::sync::mpsc::UnboundedReceiver;

pub mod command;
pub mod mapping;
mod service;
mod websocket;

use command::{MidiCommand, MidiLastEvent};
use mapping::MidiMappings;
use service::MidiInputEvent;

type RawMidiEvent = MidiInputEvent;
const MIDI_DEVICE_REFRESH_INTERVAL: Duration = Duration::from_secs(1);

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::InputMidiPlugin;
    pub use crate::command::{MidiCommand, MidiLastEvent, MidiMapping};
    pub use crate::mapping::MidiMappings;
    pub use crate::websocket::MidiDevice;
}

/// Plugin for handling MIDI input
pub struct InputMidiPlugin;

impl Plugin for InputMidiPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering InputMidiPlugin");
        assert!(
            app.is_plugin_added::<ActionsPlugin>(),
            "InputMidiPlugin requires ActionsPlugin (provides registered action invocation)"
        );
        let midi_service = service::process_midi_input_service();
        let _ = midi_service.ensure_started();
        let midi_client = midi_service.client();
        let midi_rx = midi_client.subscribe().unwrap_or_else(|| {
            let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawMidiEvent>();
            rx
        });

        app.insert_resource(MidiDevices::new(midi_client.device_names()));
        app.insert_resource(MidiEventReceiver(midi_rx));
        app.init_resource::<MidiMappings>();
        app.init_resource::<LastMidiEvent>();

        // Register command type and deserializer
        register_ingress_command::<MidiCommand>(app);
        app.add_message::<MidiInput>();
        register_command_deserializer::<MidiCommand>(app, websocket::deserialize_midi_command);

        // Add systems
        // Poll raw input and resolve mappings before registered actions are dispatched.
        app.add_systems(
            Update,
            (refresh_midi_devices, midi_event_system, handle_midi_events)
                .chain()
                .in_set(InputHandling),
        );

        app.add_systems(Update, handle_midi_crud.in_set(EventHandling));

        app.add_systems(Update, websocket::send_midi_state.in_set(ClientOutput));

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// Resource holding connected MIDI device names.
#[derive(Resource, Default)]
pub struct MidiDevices(Vec<String>);

impl MidiDevices {
    fn new(device_names: Vec<String>) -> Self {
        Self(device_names)
    }

    /// Get the list of connected device names.
    pub fn device_names(&self) -> Vec<String> {
        self.0.clone()
    }
}

/// Resource holding the channel receiver for MIDI events
#[derive(Resource)]
struct MidiEventReceiver(UnboundedReceiver<RawMidiEvent>);

/// Resource tracking the most recent MIDI event for UI display
#[derive(Resource, Default)]
pub struct LastMidiEvent(pub Option<MidiLastEvent>);

/// Runtime MIDI observation consumed by mapping dispatch without a user-command identity.
#[derive(Clone, Debug, Message)]
struct MidiInput(MidiLastEvent);

/// System that polls the MIDI event channel and writes events to the ECS event stream
fn midi_event_system(
    mut midi_rx: ResMut<MidiEventReceiver>,
    mut last_event: ResMut<LastMidiEvent>,
    mut event_writer: MessageWriter<MidiInput>,
) {
    while let Ok(raw_event) = midi_rx.0.try_recv() {
        tracing::trace!(
            "Received MIDI event: device={}, channel={}, note={}, velocity={}",
            raw_event.device,
            raw_event.channel,
            raw_event.note,
            raw_event.velocity
        );

        let midi_last_event = MidiLastEvent {
            device: raw_event.device,
            channel: raw_event.channel,
            note: raw_event.note,
            velocity: raw_event.velocity,
        };

        // Update the last event resource for UI display
        last_event.0 = Some(midi_last_event.clone());

        event_writer.write(MidiInput(midi_last_event));
    }
}

/// Poll the process-wide MIDI service and push changed device names to websocket clients.
fn refresh_midi_devices(
    mut next_refresh_deadline: Local<Option<Instant>>,
    mut devices: ResMut<MidiDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    let now = Instant::now();
    if next_refresh_deadline.is_some_and(|deadline| now < deadline) {
        return;
    }
    *next_refresh_deadline = Some(now + MIDI_DEVICE_REFRESH_INTERVAL);

    let midi_service = service::process_midi_input_service();
    let _ = midi_service.refresh();
    let device_names = midi_service.client().device_names();
    if devices.0 != device_names {
        devices.0 = device_names;
        websocket::send_device_list(&devices, &broadcaster);
    }
}

/// System that processes MIDI events and dispatches actions based on mappings
fn handle_midi_events(
    mut events: MessageReader<MidiInput>,
    mappings: Res<MidiMappings>,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    for event in events.read() {
        let midi_event = &event.0;
        if let Some(action) = mappings.lookup(
            &midi_event.device,
            midi_event.channel,
            midi_event.note,
            midi_event.velocity,
        ) {
            tracing::debug!(?midi_event, ?action, "MIDI mapping matched");

            invocations.write(ActionInvocation::scalar(
                action.clone(),
                ActionSurface::Midi,
                normalized_midi_value(midi_event.velocity),
            ));
        }
    }
}

/// Converts a MIDI byte to the normalized scalar used by registered invokers.
fn normalized_midi_value(value: u8) -> f32 {
    f32::from(value) / 127.0
}

/// System that handles MIDI CRUD commands (StoreMappings, DeleteMapping)
fn handle_midi_crud(
    mut events: MessageReader<CommandEnvelope<MidiCommand>>,
    mut mappings: ResMut<MidiMappings>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = match &event.command {
            MidiCommand::StoreMappings(new_mappings) => {
                tracing::info!("Storing {} MIDI mappings", new_mappings.len());
                mappings.set_mappings(new_mappings.clone());
                responder.succeed(event.command_id)
            }
            MidiCommand::DeleteMapping(index) => {
                if mappings.delete_mapping(*index as usize) {
                    tracing::info!("Deleted MIDI mapping at index {}", index);
                    responder.succeed(event.command_id)
                } else {
                    responder.fail(
                        event.command_id,
                        CommandError::new(
                            "midi.mapping_not_found",
                            format!("MIDI mapping index {index} does not exist"),
                        ),
                    )
                }
            }
        };
        if let Err(error) = result {
            tracing::error!(command_id = %event.command_id, %error, "midi_command_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;

    use super::*;

    /// Creates a focused app containing semantic MIDI mapping CRUD.
    fn midi_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<MidiMappings>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<MidiCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, handle_midi_crud);
        app
    }

    /// Registers and submits one MIDI mapping command.
    fn submit_command(app: &mut App, command: MidiCommand) {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("MIDI command should register");
        app.world_mut().write_message(envelope);
    }

    /// Drains one terminal result from the focused MIDI app.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("MIDI command should return a terminal result")
    }

    /// Verifies MIDI mappings preserve domain arguments without interpreting them.
    #[test]
    fn registered_action_arguments_remain_opaque() {
        let arguments = serde_json::json!({ "domainValue": 7 });
        let action = nightfall_actions::ActionReference::new("domain.action", arguments.clone());

        assert_eq!(action.id.as_str(), "domain.action");
        assert_eq!(action.arguments, arguments);
    }

    /// Verifies the minimum MIDI value maps to the minimum normalized scalar.
    #[test]
    fn midi_zero_maps_to_zero_percent() {
        assert_eq!(normalized_midi_value(0), 0.0);
    }

    /// Verifies the maximum MIDI value maps to the maximum normalized scalar.
    #[test]
    fn midi_max_maps_to_full_percent() {
        assert_eq!(normalized_midi_value(127), 1.0);
    }

    /// Verifies the MIDI midpoint preserves byte-range normalization.
    #[test]
    fn midi_midpoint_maps_to_expected_percent() {
        let scaled = normalized_midi_value(64);
        assert!((scaled - 0.503_937).abs() < 0.001);
    }

    /// Verifies replacing MIDI mappings returns success after resource mutation.
    #[test]
    fn store_mappings_mutates_before_success() {
        let mut app = midi_command_app();
        submit_command(&mut app, MidiCommand::StoreMappings(Vec::new()));
        app.update();
        assert!(app.world().resource::<MidiMappings>().mappings().is_empty());
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
    }

    /// Verifies deleting an unknown MIDI mapping returns a stable failure.
    #[test]
    fn delete_unknown_mapping_returns_failure() {
        let mut app = midi_command_app();
        submit_command(&mut app, MidiCommand::DeleteMapping(4));
        app.update();
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "midi.mapping_not_found"
        ));
    }
}
