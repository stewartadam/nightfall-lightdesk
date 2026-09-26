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
mod undo;
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
        undo::install(app);

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
struct MidiInput(MidiLastEvent, web_time::Instant);

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

        event_writer.write(MidiInput(midi_last_event, raw_event.received_at));
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
    mut learning: ResMut<nightfall_engine::controller_learning::ControllerLearning>,
    mappings: Res<MidiMappings>,
    registry: Res<nightfall_actions::ActionRegistry>,
    mut eligibility: Local<Option<Vec<bool>>>,
    mut pressed: Local<nightfall_engine::controller_input::ControllerEdgeHistory<(String, u8, u8)>>,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    if eligibility.is_none() || mappings.is_changed() || registry.is_changed() {
        *eligibility = Some(
            mappings
                .validation_errors(&registry)
                .iter()
                .map(Option::is_none)
                .collect(),
        );
    }
    for event in events.read() {
        let midi_event = &event.0;
        let Some(mut source) = learned_source(midi_event) else {
            learning.reject_unsupported_input(
                ActionSurface::Midi,
                &serde_json::json!({ "device_name": midi_event.device, "channel": midi_event.channel, "note": midi_event.note }),
                event.1,
                "This MIDI message cannot be learned. Use a note button or an absolute CC fader.",
            );
            continue;
        };
        let status = if midi_event.channel & 0xf0 == 0x80 {
            0x90 | (midi_event.channel & 0x0f)
        } else {
            midi_event.channel
        };
        let value = if midi_event.channel & 0xf0 == 0x80 {
            0
        } else {
            midi_event.velocity
        };
        let active = value > 0;
        let previous =
            pressed.observe((midi_event.device.clone(), status, midi_event.note), active);
        if previous == Some(true) && !active {
            source.gesture = nightfall_engine::controller_learning::LearnedGesture::Release;
        }
        use nightfall_engine::controller_learning::ControllerInputRoute;
        let route = learning.route_received_input(
            source,
            event.1,
            (status & 0xf0 == 0xb0).then_some(active),
        );
        if route == ControllerInputRoute::SuppressAll {
            continue;
        }
        for (_, mapping) in mappings
            .mappings()
            .iter()
            .enumerate()
            .filter(|(index, mapping)| {
                eligibility
                    .as_ref()
                    .is_some_and(|eligible| eligible[*index])
                    && mapping.device_name == midi_event.device
                    && mapping.channel == status
                    && mapping.note == midi_event.note
                    && mapping.velocity.is_none_or(|filter| filter == value)
            })
        {
            if route == ControllerInputRoute::SuppressTriggers
                && mapping.input != command::MidiBindingInput::Continuous
            {
                continue;
            }
            let invocation = match mapping.input {
                command::MidiBindingInput::Press if active && previous != Some(true) => {
                    ActionInvocation::trigger(mapping.action.clone(), ActionSurface::Midi)
                }
                command::MidiBindingInput::Release if !active && previous != Some(false) => {
                    ActionInvocation::trigger(mapping.action.clone(), ActionSurface::Midi)
                }
                command::MidiBindingInput::Continuous => ActionInvocation::scalar(
                    mapping.action.clone(),
                    ActionSurface::Midi,
                    normalized_midi_value(value),
                ),
                _ => continue,
            };
            invocations.write(invocation);
        }
    }
}

/// Identifies a physical MIDI control independently of its current value or note edge.
fn learned_source(
    event: &MidiLastEvent,
) -> Option<nightfall_engine::controller_learning::LearnedControllerSource> {
    use nightfall_engine::controller_learning::{LearnedControllerSource, LearnedGesture};
    let kind = event.channel & 0xf0;
    let gesture = match kind {
        0x80 => LearnedGesture::Release,
        0x90 if event.velocity == 0 => LearnedGesture::Release,
        0x90 => LearnedGesture::Press,
        0xb0 => LearnedGesture::Continuous,
        _ => return None,
    };
    let status = if kind == 0x80 {
        0x90 | (event.channel & 0x0f)
    } else {
        event.channel
    };
    Some(LearnedControllerSource {
        surface: ActionSurface::Midi,
        selector: serde_json::json!({ "device_name": event.device, "channel": status, "note": event.note }),
        label: format!(
            "{} · channel {} · {} {}",
            event.device,
            (event.channel & 0x0f) + 1,
            if kind == 0xb0 { "CC" } else { "note" },
            event.note
        ),
        gesture,
    })
}

/// Converts a MIDI byte to the normalized scalar used by registered invokers.
fn normalized_midi_value(value: u8) -> f32 {
    f32::from(value) / 127.0
}

/// System that handles MIDI CRUD commands (StoreMappings, DeleteMapping)
#[derive(bevy_ecs::system::SystemParam)]
struct MidiMappingCommands<'w, 's> {
    events: MessageReader<'w, 's, CommandEnvelope<MidiCommand>>,
    mappings: ResMut<'w, MidiMappings>,
    learning: ResMut<'w, nightfall_engine::controller_learning::ControllerLearning>,
    registry: Res<'w, nightfall_actions::ActionRegistry>,
    responder: CommandResponder<'w>,
    undo_manager: Option<ResMut<'w, nightfall_undo::prelude::UndoManager>>,
}

/// Validates domain targets against read-only world state before committing mapping changes.
fn handle_midi_crud(mut state: ParamSet<(&World, MidiMappingCommands)>) {
    let events: Vec<_> = state.p1().events.read().cloned().collect();
    for event in &events {
        let validation = {
            let world = state.p0();
            let registry = world.resource::<nightfall_actions::ActionRegistry>();
            match &event.command {
                MidiCommand::StoreMapping { mapping, .. } => {
                    registry.validate_target(world, &mapping.action)
                }
                MidiCommand::BindLearned { action, .. } => registry.validate_target(world, action),
                MidiCommand::StoreMappings(mappings) => mappings
                    .iter()
                    .try_for_each(|mapping| registry.validate_target(world, &mapping.action)),
                _ => Ok(()),
            }
        };
        let MidiMappingCommands {
            mut mappings,
            mut learning,
            registry,
            mut responder,
            mut undo_manager,
            ..
        } = state.p1();
        if let Err(error) = validation {
            if let Err(error) = responder.fail(
                event.command_id,
                CommandError::new(error.code, error.message),
            ) {
                tracing::error!(command_id = %event.command_id, %error, "mapping_validation_completion_failed");
            }
            continue;
        }
        let result = match &event.command {
            MidiCommand::StoreMapping { expected, mapping } => {
                match mappings.store_mapping(expected.as_ref(), mapping.clone(), &registry) {
                    Ok(()) => {
                        if let Some(manager) = undo_manager.as_deref_mut() {
                            undo::record(
                                manager,
                                event.command_id,
                                event.undo_id,
                                expected.clone(),
                                Some(mapping.clone()),
                            );
                        }
                        responder.succeed(event.command_id)
                    }
                    Err(error) => responder.fail(event.command_id, error),
                }
            }
            MidiCommand::BindLearned {
                session_id,
                action,
                replace,
            } => {
                let connection = responder.client_connection(event.command_id);
                match learning
                    .authorize_client(connection.as_ref())
                    .and_then(|()| {
                        learning.complete_with_binding(*session_id, ActionSurface::Midi, |source| {
                            mappings.bind_learned(
                                source,
                                action.clone(),
                                replace.as_ref(),
                                &registry,
                            )
                        })
                    }) {
                    Ok(mapping) => {
                        if let Some(manager) = undo_manager.as_deref_mut() {
                            undo::record(
                                manager,
                                event.command_id,
                                event.undo_id,
                                replace.clone(),
                                Some(mapping.clone()),
                            );
                        }
                        responder.succeed_with_output(event.command_id, mapping)
                    }
                    Err(error) => responder.fail(event.command_id, error),
                }
            }
            MidiCommand::RemoveMapping { expected } => match mappings.remove_expected(expected) {
                Ok(()) => {
                    if let Some(manager) = undo_manager.as_deref_mut() {
                        undo::record(
                            manager,
                            event.command_id,
                            event.undo_id,
                            Some(expected.clone()),
                            None,
                        );
                    }
                    responder.succeed(event.command_id)
                }
                Err(error) => responder.fail(event.command_id, error),
            },
            MidiCommand::StoreMappings(new_mappings) => {
                match MidiMappings::validate_all(new_mappings, &registry) {
                    Ok(()) => {
                        mappings.set_mappings(new_mappings.clone());
                        responder.succeed(event.command_id)
                    }
                    Err(error) => responder.fail(event.command_id, error),
                }
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

    /// Supplies independent action contracts for transport-only input tests.
    fn register_input_test_actions(app: &mut App) {
        use nightfall_actions::{
            ActionDescriptor, ActionInputKind, ActionRegistry, InvocationDispatch,
        };
        let mappings = app.world().resource::<MidiMappings>().mappings().to_vec();
        app.init_resource::<ActionRegistry>();
        for mapping in mappings {
            let kind = if matches!(mapping.input, command::MidiBindingInput::Continuous) {
                ActionInputKind::Scalar
            } else {
                ActionInputKind::Trigger
            };
            if app
                .world()
                .resource::<ActionRegistry>()
                .get(&mapping.action.id)
                .is_none()
            {
                app.world_mut()
                    .resource_mut::<ActionRegistry>()
                    .register::<serde_json::Value, _>(
                        ActionDescriptor {
                            id: mapping.action.id,
                            label: "Input test".into(),
                            capabilities: vec![],
                            allowed_surfaces: vec![ActionSurface::Midi],
                            input_kind: kind,
                            argument_schema: serde_json::json!({}),
                        },
                        |_, _, _| Ok(InvocationDispatch::succeeded()),
                    );
            }
        }
    }

    /// Loaded invalid bindings remain repairable and cannot prevent unrelated valid input from running.
    #[test]
    fn loaded_invalid_bindings_are_retained_but_ineligible() {
        let mut app = App::new();
        app.init_resource::<nightfall_engine::controller_learning::ControllerLearning>();
        let valid = command::MidiMapping {
            id: uuid::Uuid::new_v4(),
            device_name: "Keys".into(),
            channel: 0x90,
            note: 42,
            velocity: None,
            input: command::MidiBindingInput::Press,
            action: nightfall_actions::ActionReference::new("test.go", serde_json::json!({})),
        };
        let mut mappings = MidiMappings::new();
        mappings.set_mappings(vec![valid.clone()]);
        app.insert_resource(mappings);
        register_input_test_actions(&mut app);
        let mut unknown = valid.clone();
        unknown.id = uuid::Uuid::new_v4();
        unknown.action.id = nightfall_actions::ActionId::new("missing.action");
        let mut duplicate = valid.clone();
        duplicate.id = uuid::Uuid::new_v4();
        unknown.note = 43;
        duplicate.note = 44;
        let mut duplicate_two = duplicate.clone();
        duplicate_two.id = uuid::Uuid::new_v4();
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(vec![valid, unknown, duplicate, duplicate_two]);
        let errors = app
            .world()
            .resource::<MidiMappings>()
            .validation_errors(app.world().resource::<nightfall_actions::ActionRegistry>());
        assert!(errors[0].is_none());
        assert_eq!(errors[1].as_ref().unwrap().code, "action.not_registered");
        assert_eq!(errors[2].as_ref().unwrap().code, "midi.mapping_conflict");
        assert_eq!(errors[3].as_ref().unwrap().code, "midi.mapping_conflict");
        app.add_message::<MidiInput>();
        app.add_message::<ActionInvocation>();
        app.add_systems(Update, handle_midi_events);
        for note in [42, 43, 44] {
            app.world_mut().write_message(MidiInput(
                MidiLastEvent {
                    device: "Keys".into(),
                    channel: 0x90,
                    note,
                    velocity: 127,
                },
                web_time::Instant::now(),
            ));
        }
        app.update();
        let invocations: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .collect();
        assert_eq!(invocations.len(), 1);
        assert_eq!(app.world().resource::<MidiMappings>().mappings().len(), 4);
        app.world_mut()
            .resource_scope(|world, mut mappings: Mut<MidiMappings>| {
                let expected = mappings.mappings()[1].clone();
                let mut repaired = expected.clone();
                repaired.action = mappings.mappings()[0].action.clone();
                mappings
                    .store_mapping(
                        Some(&expected),
                        repaired,
                        world.resource::<nightfall_actions::ActionRegistry>(),
                    )
                    .unwrap();
            });
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .delete_mapping(3);
        let errors = app
            .world()
            .resource::<MidiMappings>()
            .validation_errors(app.world().resource::<nightfall_actions::ActionRegistry>());
        assert!(errors[2].is_none());
    }

    /// A queued pre-arm press updates edge state but only its fresh release is learned.
    #[test]
    fn raw_queue_preserves_learning_start_boundary() {
        use nightfall_engine::controller_learning::{
            ControllerLearning, ControllerLearningCommand, LearnedGesture,
        };
        let mut app = App::new();
        app.add_plugins(EnginePlugin);
        app.init_resource::<PendingCommandBuffer>();
        app.add_plugins(ClientBridgePlugin);
        app.init_resource::<MidiMappings>();
        app.init_resource::<LastMidiEvent>();
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        app.insert_resource(MidiEventReceiver(receiver));
        app.add_message::<MidiInput>();
        app.add_message::<ActionInvocation>();
        register_input_test_actions(&mut app);
        app.add_systems(
            Update,
            (midi_event_system, handle_midi_events)
                .chain()
                .in_set(InputHandling),
        );
        sender
            .send(RawMidiEvent {
                received_at: web_time::Instant::now() - Duration::from_secs(1),
                device: "Keys".into(),
                channel: 0xb0,
                note: 7,
                velocity: 127,
            })
            .unwrap();
        let session_id = uuid::Uuid::new_v4();
        let begin = CommandEnvelope::new(
            ControllerLearningCommand::Begin {
                session_id,
                surface: ActionSurface::Midi,
            },
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        );
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&begin)
            .unwrap();
        app.world_mut().write_message(begin);
        app.update();
        assert_eq!(
            app.world_mut()
                .resource_mut::<ControllerLearning>()
                .captured(session_id, ActionSurface::Midi)
                .unwrap_err()
                .code,
            "mapping.source_required"
        );
        sender
            .send(RawMidiEvent {
                received_at: web_time::Instant::now(),
                device: "Keys".into(),
                channel: 0xb0,
                note: 7,
                velocity: 0,
            })
            .unwrap();
        app.update();
        assert_eq!(
            app.world_mut()
                .resource_mut::<ControllerLearning>()
                .captured(session_id, ActionSurface::Midi)
                .unwrap()
                .gesture,
            LearnedGesture::Release
        );
    }

    /// Holding a CC button before arming learns its release, while later slider samples keep their first source.
    #[test]
    fn cc_learning_preserves_release_intent_and_first_slider_sample() {
        use nightfall_engine::controller_learning::{
            ControllerLearning, ControllerLearningCommand, LearnedGesture,
        };
        for (before, after, expected) in [
            (Some(127), vec![0], LearnedGesture::Release),
            (None, vec![40, 60, 0], LearnedGesture::Continuous),
            (None, vec![127], LearnedGesture::Continuous),
        ] {
            let mut app = App::new();
            app.add_plugins(EnginePlugin);
            app.init_resource::<PendingCommandBuffer>();
            app.add_plugins(ClientBridgePlugin);
            app.init_resource::<MidiMappings>();
            app.world_mut()
                .resource_mut::<MidiMappings>()
                .set_mappings(vec![command::MidiMapping {
                    id: uuid::Uuid::new_v4(),
                    input: command::MidiBindingInput::Release,
                    device_name: "CC controller".into(),
                    channel: 0xb0,
                    note: 7,
                    velocity: None,
                    action: nightfall_actions::ActionReference::new(
                        "test.release",
                        serde_json::json!({}),
                    ),
                }]);
            app.add_message::<MidiInput>();
            app.add_message::<ActionInvocation>();
            register_input_test_actions(&mut app);
            app.add_systems(Update, handle_midi_events);
            if let Some(velocity) = before {
                app.world_mut().write_message(MidiInput(
                    MidiLastEvent {
                        device: "CC controller".into(),
                        channel: 0xb0,
                        note: 7,
                        velocity,
                    },
                    web_time::Instant::now(),
                ));
                app.update();
            }
            let session_id = uuid::Uuid::new_v4();
            let begin = CommandEnvelope::new(
                ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi,
                },
                CommandOrigin::WebUi,
                ReplyTarget::Detached,
            );
            app.world_mut()
                .resource_mut::<CommandTracker>()
                .register(&begin)
                .unwrap();
            app.world_mut().write_message(begin);
            app.update();
            let release_pending = after.last() != Some(&0);
            for velocity in after {
                app.world_mut().write_message(MidiInput(
                    MidiLastEvent {
                        device: "CC controller".into(),
                        channel: 0xb0,
                        note: 7,
                        velocity,
                    },
                    web_time::Instant::now(),
                ));
            }
            app.update();
            let captured = app
                .world_mut()
                .resource_mut::<ControllerLearning>()
                .captured(session_id, ActionSurface::Midi)
                .unwrap();
            assert_eq!(captured.gesture, expected);
            assert_eq!(captured.selector["note"], 7);
            assert!(
                app.world_mut()
                    .resource_mut::<Messages<ActionInvocation>>()
                    .drain()
                    .next()
                    .is_none()
            );
            if release_pending {
                app.world_mut()
                    .resource_mut::<ControllerLearning>()
                    .complete_with_binding(session_id, ActionSurface::Midi, |_| Ok(()))
                    .unwrap();
                for (velocity, expected_count) in [(0, 0), (127, 0), (0, 1)] {
                    app.world_mut().write_message(MidiInput(
                        MidiLastEvent {
                            device: "CC controller".into(),
                            channel: 0xb0,
                            note: 7,
                            velocity,
                        },
                        web_time::Instant::now(),
                    ));
                    app.update();
                    assert_eq!(
                        app.world_mut()
                            .resource_mut::<Messages<ActionInvocation>>()
                            .drain()
                            .count(),
                        expected_count
                    );
                }
            }
        }
    }

    /// A press/release burst invokes only the selected edge, including zero-velocity releases.
    #[test]
    fn button_mapping_dispatches_one_selected_edge_per_cycle() {
        for input in [
            command::MidiBindingInput::Press,
            command::MidiBindingInput::Release,
        ] {
            let mut app = App::new();
            app.init_resource::<nightfall_engine::controller_learning::ControllerLearning>();
            let mut mappings = MidiMappings::default();
            mappings.set_mappings(vec![command::MidiMapping {
                id: uuid::Uuid::new_v4(),
                input,
                device_name: "Keys".into(),
                channel: 0x90,
                note: 42,
                velocity: None,
                action: nightfall_actions::ActionReference::new("test.go", serde_json::json!({})),
            }]);
            app.insert_resource(mappings);
            app.add_message::<MidiInput>();
            app.add_message::<ActionInvocation>();
            register_input_test_actions(&mut app);
            app.add_systems(Update, handle_midi_events);
            for (channel, velocity) in [(0x90, 100), (0x90, 127), (0x90, 0), (0x80, 64)] {
                app.world_mut().write_message(MidiInput(
                    MidiLastEvent {
                        device: "Keys".into(),
                        channel,
                        note: 42,
                        velocity,
                    },
                    web_time::Instant::now(),
                ));
            }
            app.update();
            let invocations = app
                .world_mut()
                .resource_mut::<Messages<ActionInvocation>>()
                .drain()
                .collect::<Vec<_>>();
            assert_eq!(invocations.len(), 1, "{input:?} must fire once");
            assert_eq!(
                invocations[0].input,
                nightfall_actions::ActionInput::Trigger
            );
        }
    }

    /// Both MIDI release encodings identify the same physical note as its initial press.
    #[test]
    fn learning_normalizes_note_off_and_zero_velocity() {
        use nightfall_engine::controller_learning::LearnedGesture;
        let mut event = MidiLastEvent {
            device: "Keyboard".into(),
            channel: 0x92,
            note: 42,
            velocity: 100,
        };
        let press = learned_source(&event).unwrap();
        event.velocity = 0;
        let zero_release = learned_source(&event).unwrap();
        event.channel = 0x82;
        event.velocity = 64;
        let note_off = learned_source(&event).unwrap();
        assert_eq!(press.selector, zero_release.selector);
        assert_eq!(press.selector, note_off.selector);
        assert_eq!(press.gesture, LearnedGesture::Press);
        assert_eq!(zero_release.gesture, LearnedGesture::Release);
        assert_eq!(note_off.gesture, LearnedGesture::Release);
    }

    /// Creates a focused app containing semantic MIDI mapping CRUD.
    fn midi_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<MidiMappings>();
        app.init_resource::<nightfall_actions::ActionRegistry>();
        app.init_resource::<nightfall_engine::controller_learning::ControllerLearning>();
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

    /// A deleted domain target rejects edits atomically but does not prevent removing the binding.
    #[test]
    fn unavailable_domain_target_rejects_save_without_changing_mapping() {
        let mut app = midi_command_app();
        let original = command::MidiMapping {
            id: uuid::Uuid::new_v4(),
            input: command::MidiBindingInput::Press,
            device_name: "Keys".into(),
            channel: 0x90,
            note: 42,
            velocity: None,
            action: nightfall_actions::ActionReference::new("test.go", serde_json::json!({})),
        };
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(vec![original.clone()]);
        register_input_test_actions(&mut app);
        app.world_mut()
            .resource_mut::<nightfall_actions::ActionRegistry>()
            .register_target_validator::<serde_json::Value, _>("test.go", |_, _| {
                Err(nightfall_actions::InvocationError::new(
                    "test.target_missing",
                    "Target was deleted",
                ))
            });
        let mut edited = original.clone();
        edited.note = 43;
        submit_command(
            &mut app,
            MidiCommand::StoreMapping {
                expected: Some(original.clone()),
                mapping: edited,
            },
        );
        app.update();
        assert!(matches!(take_result(&mut app).outcome,
            CommandOutcome::Failed(error) if error.code == "test.target_missing"));
        assert_eq!(
            app.world().resource::<MidiMappings>().mappings(),
            &[original.clone()]
        );
        submit_command(&mut app, MidiCommand::RemoveMapping { expected: original });
        app.update();
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
        assert!(app.world().resource::<MidiMappings>().mappings().is_empty());
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
