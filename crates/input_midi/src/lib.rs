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
use nightfall_actions::{
    ActionInput, ActionInvocation, ActionRegistry, ActionSurface, ActionsPlugin, SourceEdgeStates,
    SourceSignal,
};
use nightfall_engine::prelude::*;
use tokio::sync::mpsc::UnboundedReceiver;

pub mod command;
pub mod mapping;
mod service;
mod websocket;

use command::{MidiCommand, MidiLastEvent, MidiSource};
use mapping::MidiMappings;
use service::MidiInputEvent;

type RawMidiEvent = MidiInputEvent;
const MIDI_DEVICE_REFRESH_INTERVAL: Duration = Duration::from_secs(1);

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::InputMidiPlugin;
    pub use crate::command::{MidiCommand, MidiLastEvent, MidiMapping, MidiSource};
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
        let waker = app.world().get_resource::<FrameWaker>().cloned();
        let midi_rx = midi_client.subscribe(waker).unwrap_or_else(|| {
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

        app.add_systems(Render, websocket::send_midi_state.in_set(ClientOutput));

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

/// Classified MIDI control activity consumed by mapping dispatch.
#[derive(Clone, Debug, Message)]
struct MidiInput {
    /// Device that sent the message.
    device: String,
    /// Control that sent the message.
    source: MidiSource,
    /// Button edge or level carried by the message.
    signal: SourceSignal,
}

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

        let classified =
            MidiSource::classify(raw_event.channel, raw_event.note, raw_event.velocity);
        let midi_last_event = MidiLastEvent {
            device: raw_event.device,
            channel: raw_event.channel,
            note: raw_event.note,
            velocity: raw_event.velocity,
            source: classified.map(|(source, _)| source),
        };

        // Update the last event resource for UI display
        last_event.0 = Some(midi_last_event.clone());

        if let Some((source, signal)) = classified {
            event_writer.write(MidiInput {
                device: midi_last_event.device,
                source,
                signal,
            });
        }
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

/// System that invokes the action bound to each MIDI control that sends a message.
///
/// The control's raw signal is adapted to the bound action's input kind, so a note can fire
/// a trigger and a level-reporting controller button fires once per press.
fn handle_midi_events(
    mut events: MessageReader<MidiInput>,
    mappings: Res<MidiMappings>,
    registry: Res<ActionRegistry>,
    mut edges: ResMut<SourceEdgeStates>,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    for event in events.read() {
        let Some(mapping) = mappings.lookup(&event.device, event.source) else {
            continue;
        };
        tracing::debug!(?event, action = ?mapping.action, "MIDI mapping matched");
        // Unknown actions still dispatch so the registry reports them as unregistered.
        let input = match registry.input_kind(&mapping.action.id) {
            Some(kind) => edges.adapt(mapping.id, kind, event.signal),
            None => Some(ActionInput::Trigger),
        };
        if let Some(input) = input {
            invocations.write(
                ActionInvocation::new(mapping.action.clone(), ActionSurface::Midi, input)
                    .with_source(format!("MIDI {}", event.device)),
            );
        }
    }
}

/// System that applies MIDI mapping edits and reports their terminal outcomes.
fn handle_midi_crud(
    mut events: MessageReader<CommandEnvelope<MidiCommand>>,
    mut mappings: ResMut<MidiMappings>,
    registry: Res<ActionRegistry>,
    mut edges: ResMut<SourceEdgeStates>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = match &event.command {
            MidiCommand::UpsertMapping(mapping) => {
                // Every MIDI control can drive every input kind through signal adaptation.
                match registry.validate_binding(&mapping.action, |_| true) {
                    Ok(()) => {
                        edges.forget(mapping.id);
                        let displaced = mappings.upsert(mapping.clone());
                        for id in &displaced {
                            edges.forget(*id);
                        }
                        responder.succeed_with_output(
                            event.command_id,
                            &serde_json::json!({ "replaced": displaced }),
                        )
                    }
                    Err(error) => responder.fail(
                        event.command_id,
                        CommandError::new(error.code, error.message),
                    ),
                }
            }
            MidiCommand::DeleteMapping(id) => {
                if mappings.delete(*id) {
                    edges.forget(*id);
                    responder.succeed(event.command_id)
                } else {
                    responder.fail(
                        event.command_id,
                        CommandError::new(
                            "midi.mapping_not_found",
                            format!("MIDI mapping {id} does not exist"),
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
    use crate::command::MidiMapping;

    /// Creates a focused app containing semantic MIDI mapping CRUD.
    fn midi_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<MidiMappings>();
        app.init_resource::<SourceEdgeStates>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<ActionRegistry>();
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register::<serde::de::IgnoredAny, _>(
                nightfall_actions::ActionDescriptor::new("test.trigger", "Test", "Tests"),
                |_world, _arguments, _invocation| {
                    Ok(nightfall_actions::InvocationDispatch::succeeded())
                },
            );
        app.add_message::<CommandEnvelope<MidiCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
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

    /// Verifies control changes classify as normalized levels on their channel.
    #[test]
    fn control_change_classifies_as_level() {
        let (source, signal) = MidiSource::classify(0xB3, 7, 127).expect("CC should classify");

        assert_eq!(
            source,
            MidiSource::ControlChange {
                channel: 3,
                controller: 7
            }
        );
        assert_eq!(signal, SourceSignal::Level(1.0));
    }

    /// Verifies note on and off classify as button edges on the same control.
    #[test]
    fn notes_classify_as_button_edges() {
        let note = MidiSource::Note {
            channel: 5,
            note: 60,
        };
        assert_eq!(
            MidiSource::classify(0x95, 60, 100),
            Some((note, SourceSignal::Button(true)))
        );
        assert_eq!(
            MidiSource::classify(0x95, 60, 0),
            Some((note, SourceSignal::Button(false)))
        );
        assert_eq!(
            MidiSource::classify(0x85, 60, 64),
            Some((note, SourceSignal::Button(false)))
        );
        assert_eq!(MidiSource::classify(0xF8, 0, 0), None);
    }

    /// Verifies pitch bend combines both data bytes into one 14-bit level.
    #[test]
    fn pitch_bend_classifies_as_fourteen_bit_level() {
        assert_eq!(
            MidiSource::classify(0xE0, 0x7F, 0x7F),
            Some((
                MidiSource::PitchBend { channel: 0 },
                SourceSignal::Level(1.0)
            ))
        );
    }

    /// Builds a note mapping bound to the test trigger action.
    fn note_mapping(id: u128, note: u8) -> MidiMapping {
        MidiMapping {
            id: uuid::Uuid::from_u128(id),
            device_name: "Pad".to_string(),
            source: MidiSource::Note { channel: 0, note },
            action: nightfall_actions::ActionReference::new("test.trigger", serde_json::json!({})),
        }
    }

    /// Verifies upserting a mapping on a bound control replaces it and reports the displaced ID.
    #[test]
    fn upsert_replaces_mapping_on_same_control() {
        let mut app = midi_command_app();
        submit_command(&mut app, MidiCommand::UpsertMapping(note_mapping(1, 60)));
        app.update();
        take_result(&mut app);

        submit_command(&mut app, MidiCommand::UpsertMapping(note_mapping(2, 60)));
        app.update();

        let mappings = app.world().resource::<MidiMappings>().mappings();
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].id, uuid::Uuid::from_u128(2));
        let CommandOutcome::Succeeded { output } = take_result(&mut app).outcome else {
            panic!("upsert should succeed");
        };
        assert_eq!(
            output.map(|output| output.value),
            Some(serde_json::json!({ "replaced": [uuid::Uuid::from_u128(1)] }))
        );
    }

    /// Verifies bindings to unknown actions are rejected before they are stored.
    #[test]
    fn upsert_rejects_unregistered_action() {
        let mut app = midi_command_app();
        let mut mapping = note_mapping(1, 60);
        mapping.action =
            nightfall_actions::ActionReference::new("test.missing", serde_json::json!({}));

        submit_command(&mut app, MidiCommand::UpsertMapping(mapping));
        app.update();

        assert!(app.world().resource::<MidiMappings>().mappings().is_empty());
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "action.not_registered"
        ));
    }

    /// Verifies a level-reporting controller fires a trigger action once per press.
    #[test]
    fn controller_button_fires_trigger_once_per_press() {
        let mut app = midi_command_app();
        app.add_message::<MidiInput>();
        app.add_message::<ActionInvocation>();
        app.add_systems(Update, handle_midi_events);
        let mapping = MidiMapping {
            source: MidiSource::ControlChange {
                channel: 0,
                controller: 20,
            },
            ..note_mapping(1, 0)
        };
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .upsert(mapping.clone());

        for value in [127, 127, 0, 127] {
            let (source, signal) =
                MidiSource::classify(0xB0, 20, value).expect("CC should classify");
            app.world_mut().write_message(MidiInput {
                device: "Pad".to_string(),
                source,
                signal,
            });
        }
        app.update();

        let inputs = app
            .world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .map(|invocation| invocation.input)
            .collect::<Vec<_>>();
        assert_eq!(
            inputs,
            vec![ActionInput::Press, ActionInput::Release, ActionInput::Press]
        );
    }

    /// Verifies deleting an unknown MIDI mapping returns a stable failure.
    #[test]
    fn delete_unknown_mapping_returns_failure() {
        let mut app = midi_command_app();
        submit_command(
            &mut app,
            MidiCommand::DeleteMapping(uuid::Uuid::from_u128(4)),
        );
        app.update();
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "midi.mapping_not_found"
        ));
    }
}
