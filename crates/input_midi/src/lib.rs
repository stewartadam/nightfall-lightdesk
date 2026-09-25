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
    ActionInvocation, ActionRegistry, ActionSurface, ActionTargetTracking, ActionsPlugin,
    BindingDiagnostic, ControllerMappingMode, InvocationError, SourceEdgeStates, SourceSignal,
    bindings_need_diagnosis, collect_binding_diagnostics,
};
use nightfall_engine::prelude::*;
use tokio::sync::mpsc::UnboundedReceiver;

pub mod command;
pub mod mapping;
mod service;
mod websocket;

use command::{MidiCommand, MidiLastEvent, MidiMapping, MidiSource};
use mapping::MidiMappings;
use service::MidiInputEvent;

type RawMidiEvent = MidiInputEvent;
const MIDI_DEVICE_REFRESH_INTERVAL: Duration = Duration::from_secs(1);

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::command::{MidiCommand, MidiLastEvent, MidiMapping, MidiSource};
    pub use crate::mapping::MidiMappings;
    pub use crate::websocket::MidiDevice;
    pub use crate::{InputMidiPlugin, MidiMappingDiagnostics};
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
        app.init_resource::<MidiControlTouches>();

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
        app.init_resource::<MidiMappingDiagnostics>();

        app.add_systems(
            Update,
            (
                refresh_midi_mapping_diagnostics
                    .run_if(bindings_need_diagnosis::<MidiMappings>)
                    .after(ActionTargetTracking),
                websocket::send_midi_state,
            )
                .chain()
                .in_set(ClientOutput),
        );

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

/// Most controls one frame reports as touched while controller mapping mode is active.
const MAX_TOUCHES_PER_FRAME: usize = 64;

/// Controls touched this frame while controller mapping mode is active.
///
/// Published reliably so a mapping client can arm the touched control even when the
/// droppable last-event telemetry is coalesced or dropped under load. Each control appears
/// once per frame, carrying its most recent message.
#[derive(Resource, Default, Debug)]
pub(crate) struct MidiControlTouches(pub(crate) Vec<MidiLastEvent>);

impl MidiControlTouches {
    /// Records one message from a mappable control, replacing its earlier message this frame.
    fn record(&mut self, event: &MidiLastEvent) {
        if let Some(existing) = self
            .0
            .iter_mut()
            .find(|touch| touch.device == event.device && touch.source == event.source)
        {
            *existing = event.clone();
        } else if self.0.len() < MAX_TOUCHES_PER_FRAME {
            self.0.push(event.clone());
        }
    }
}

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
///
/// While controller mapping mode is active, messages from mappable controls are also
/// recorded as touches for reliable delivery to mapping clients.
fn midi_event_system(
    mut midi_rx: ResMut<MidiEventReceiver>,
    mut last_event: ResMut<LastMidiEvent>,
    mapping_mode: Res<ControllerMappingMode>,
    mut touches: ResMut<MidiControlTouches>,
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

        if mapping_mode.is_active() && midi_last_event.source.is_some() {
            touches.record(&midi_last_event);
        }

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
/// The control's raw signal is adapted to the bound action's input kind and behavior, so a
/// note can fire a trigger and a level-reporting controller button fires once per press.
/// While controller mapping mode is active, input is suppressed as described by
/// [`SourceEdgeStates`]: nothing new fires, but releases completing live presses still do.
fn handle_midi_events(
    mut events: MessageReader<MidiInput>,
    mappings: Res<MidiMappings>,
    registry: Res<ActionRegistry>,
    mapping_mode: Res<ControllerMappingMode>,
    mut edges: ResMut<SourceEdgeStates>,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    let suppressed = mapping_mode.is_active();
    for event in events.read() {
        for mapping in mappings.lookup(&event.device, event.source) {
            tracing::debug!(?event, action = ?mapping.action, "MIDI mapping matched");
            let Some((action, input)) = edges.resolve(
                &registry,
                mapping.id,
                &mapping.action,
                mapping.behavior,
                event.signal,
                suppressed,
            ) else {
                continue;
            };
            invocations.write(
                ActionInvocation::new(action, ActionSurface::Midi, input)
                    .with_source(format!("MIDI {}", event.device)),
            );
        }
    }
}

/// Mappings that cannot currently invoke their action, in mapping order.
///
/// Invalid mappings stay stored; these diagnostics tell the operator which ones will fail.
#[derive(Resource, Default, Debug, PartialEq)]
pub struct MidiMappingDiagnostics(pub Vec<BindingDiagnostic>);

/// Validates one stored MIDI mapping against the registry and the current world.
///
/// Checks the action, its arguments, the mapping's behavior, and that its targets exist.
/// MIDI controls drive every input kind and report releases.
fn diagnose_midi_mapping(
    registry: &ActionRegistry,
    world: &World,
    mapping: &MidiMapping,
) -> Result<(), InvocationError> {
    registry
        .validate_binding(&mapping.action, ActionSurface::Midi, |_| true)
        .and_then(|()| registry.validate_behavior(&mapping.action, mapping.behavior, true))
        .and_then(|()| registry.validate_target(world, &mapping.action))
}

/// Recomputes MIDI mapping diagnostics after mappings, registrations, or targets changed.
///
/// The diagnostics resource is only written when the result differs, so clients are
/// notified only when a mapping becomes invalid or recovers.
fn refresh_midi_mapping_diagnostics(world: &mut World) {
    let diagnostics = {
        let registry = world.resource::<ActionRegistry>();
        collect_binding_diagnostics(
            world
                .resource::<MidiMappings>()
                .mappings()
                .iter()
                .map(|mapping| (mapping.id, diagnose_midi_mapping(registry, world, mapping))),
        )
    };
    world
        .resource_mut::<MidiMappingDiagnostics>()
        .set_if_neq(MidiMappingDiagnostics(diagnostics));
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
                // Every MIDI control can drive every input kind through signal adaptation and
                // reports releases.
                match registry
                    .validate_binding(&mapping.action, ActionSurface::Midi, |_| true)
                    .and_then(|()| {
                        registry.validate_behavior(&mapping.action, mapping.behavior, true)
                    }) {
                    Ok(()) => {
                        edges.forget(mapping.id);
                        let displaced = mappings
                            .upsert(mapping.clone(), |action| registry.input_kind(&action.id));
                        for id in &displaced {
                            edges.forget(*id);
                        }
                        responder.succeed_with_output(
                            event.command_id,
                            &serde_json::json!({ "replaced": displaced }),
                        )
                    }
                    Err(error) => responder.fail(event.command_id, error.into()),
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
    use nightfall_actions::ActionInput;
    use nightfall_actions::ActionInputKind;

    use super::*;
    use crate::command::MidiMapping;

    /// Creates a focused app containing semantic MIDI mapping CRUD.
    fn midi_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<MidiMappings>();
        app.init_resource::<SourceEdgeStates>();
        app.init_resource::<ControllerMappingMode>();
        app.init_resource::<MidiControlTouches>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<ActionRegistry>();
        for descriptor in [
            nightfall_actions::ActionDescriptor::new("test.trigger", "Test", "Tests"),
            nightfall_actions::ActionDescriptor::new("test.start", "Start", "Tests")
                .with_hold_release("test.stop"),
            nightfall_actions::ActionDescriptor::new("test.stop", "Stop", "Tests"),
        ] {
            app.world_mut()
                .resource_mut::<ActionRegistry>()
                .register::<serde::de::IgnoredAny, _>(
                    descriptor,
                    |_world, _arguments, _invocation| {
                        Ok(nightfall_actions::InvocationDispatch::succeeded())
                    },
                );
        }
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
            behavior: nightfall_actions::ControlBehavior::Press,
            action: nightfall_actions::ActionReference::new("test.trigger", serde_json::json!({})),
        }
    }

    /// Clip UIDs known to the diagnostics test, standing in for the clip domain.
    #[derive(Resource, Default)]
    struct KnownClips(Vec<uuid::Uuid>);

    /// Extends the MIDI command app with a clip action, its target validator, and diagnostics.
    fn midi_diagnostics_app() -> App {
        use nightfall_actions::{
            ActionAppExt, ActionDescriptor, ActionParameter, ActionParameterKind, ActionTargets,
        };

        let mut app = midi_command_app();
        app.init_resource::<ActionTargets>();
        app.init_resource::<KnownClips>();
        app.init_resource::<MidiMappingDiagnostics>();
        app.register_action::<serde::de::IgnoredAny, _>(
            ActionDescriptor::new("test.clip", "Test clip", "Tests").with_parameter(
                ActionParameter::required("clip", "Clip", ActionParameterKind::Clip),
            ),
            |_world, _arguments, _invocation| {
                Ok(nightfall_actions::InvocationDispatch::succeeded())
            },
        )
        .register_action_target_validator::<uuid::Uuid, _>(
            ActionParameterKind::Clip,
            |world, uid| {
                if world.resource::<KnownClips>().0.contains(&uid) {
                    Ok(())
                } else {
                    Err(InvocationError::new("clip.not_found", "Clip does not exist"))
                }
            },
        )
        .invalidate_action_targets_when(resource_changed::<KnownClips>);
        app.add_systems(
            Update,
            refresh_midi_mapping_diagnostics
                .run_if(bindings_need_diagnosis::<MidiMappings>)
                .after(ActionTargetTracking)
                .after(handle_midi_crud),
        );
        app
    }

    /// Verifies a mapping to a missing target is stored, diagnosed, and recovers with its target.
    #[test]
    fn mapping_to_missing_target_is_kept_and_diagnosed() {
        let mut app = midi_diagnostics_app();
        let clip = uuid::Uuid::from_u128(5);
        let mapping = MidiMapping {
            action: nightfall_actions::ActionReference::new(
                "test.clip",
                serde_json::json!({ "clip": clip }),
            ),
            ..note_mapping(1, 60)
        };
        submit_command(&mut app, MidiCommand::UpsertMapping(mapping));
        app.update();

        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Succeeded { .. }
        ));
        assert_eq!(app.world().resource::<MidiMappings>().mappings().len(), 1);
        let diagnostics = &app.world().resource::<MidiMappingDiagnostics>().0;
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].binding_id, uuid::Uuid::from_u128(1));
        assert_eq!(diagnostics[0].error.code, "clip.not_found");

        app.world_mut().resource_mut::<KnownClips>().0.push(clip);
        app.update();

        assert!(
            app.world()
                .resource::<MidiMappingDiagnostics>()
                .0
                .is_empty()
        );
    }

    /// Verifies a mapping whose action was never registered is diagnosed rather than dropped.
    #[test]
    fn loaded_mapping_to_unregistered_action_is_diagnosed() {
        let mut app = midi_diagnostics_app();
        let mapping = MidiMapping {
            action: nightfall_actions::ActionReference::new("gone.action", serde_json::json!({})),
            ..note_mapping(2, 61)
        };
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(vec![mapping]);
        app.update();

        let diagnostics = &app.world().resource::<MidiMappingDiagnostics>().0;
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].error.code, "action.not_registered");
        assert_eq!(app.world().resource::<MidiMappings>().mappings().len(), 1);
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
            .upsert(mapping.clone(), |_| Some(ActionInputKind::Trigger));

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

    /// Verifies a pad can start one action on press and fire another on release.
    ///
    /// The press binding also passes releases on; the registry ignores them for triggers.
    #[test]
    fn pad_fires_press_and_release_bindings_on_their_edges() {
        let mut app = midi_command_app();
        app.add_message::<MidiInput>();
        app.add_message::<ActionInvocation>();
        app.add_systems(Update, handle_midi_events);
        let release = MidiMapping {
            behavior: nightfall_actions::ControlBehavior::Release,
            action: nightfall_actions::ActionReference::new("test.release", serde_json::json!({})),
            ..note_mapping(2, 60)
        };
        let mut mappings = app.world_mut().resource_mut::<MidiMappings>();
        mappings.upsert(note_mapping(1, 60), |_| Some(ActionInputKind::Trigger));
        mappings.upsert(release, |_| Some(ActionInputKind::Trigger));

        for (status, velocity) in [(0x90, 100), (0x80, 0), (0x90, 90), (0x90, 0)] {
            let (source, signal) =
                MidiSource::classify(status, 60, velocity).expect("note should classify");
            app.world_mut().write_message(MidiInput {
                device: "Pad".to_string(),
                source,
                signal,
            });
        }
        app.update();

        let fired = app
            .world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .map(|invocation| (invocation.action.id.as_str().to_string(), invocation.input))
            .collect::<Vec<_>>();
        let expected = [
            ("test.trigger", ActionInput::Press),
            ("test.trigger", ActionInput::Release),
            ("test.release", ActionInput::Trigger),
            ("test.trigger", ActionInput::Press),
            ("test.trigger", ActionInput::Release),
            ("test.release", ActionInput::Trigger),
        ]
        .map(|(id, input)| (id.to_string(), input));
        assert_eq!(fired, expected);
    }

    /// Verifies a Hold binding invokes its action on press and the counterpart on release.
    #[test]
    fn hold_binding_invokes_counterpart_on_release() {
        let mut app = midi_command_app();
        app.add_message::<MidiInput>();
        app.add_message::<ActionInvocation>();
        app.add_systems(Update, handle_midi_events);
        let mapping = MidiMapping {
            behavior: nightfall_actions::ControlBehavior::Hold,
            action: nightfall_actions::ActionReference::new("test.start", serde_json::json!({})),
            ..note_mapping(1, 60)
        };
        submit_command(&mut app, MidiCommand::UpsertMapping(mapping));
        app.update();
        take_result(&mut app);

        for (status, velocity) in [(0x90, 100), (0x80, 0)] {
            let (source, signal) =
                MidiSource::classify(status, 60, velocity).expect("note should classify");
            app.world_mut().write_message(MidiInput {
                device: "Pad".to_string(),
                source,
                signal,
            });
        }
        app.update();

        let fired = app
            .world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .map(|invocation| (invocation.action.id.as_str().to_string(), invocation.input))
            .collect::<Vec<_>>();
        assert_eq!(
            fired,
            vec![
                ("test.start".to_string(), ActionInput::Trigger),
                ("test.stop".to_string(), ActionInput::Trigger),
            ]
        );
    }

    /// Extends the MIDI command app with event dispatch and mappings on note 60.
    fn midi_dispatch_app(mappings: Vec<MidiMapping>) -> App {
        let mut app = midi_command_app();
        app.add_message::<MidiInput>();
        app.add_message::<ActionInvocation>();
        app.add_systems(Update, handle_midi_events);
        let mut stored = app.world_mut().resource_mut::<MidiMappings>();
        for mapping in mappings {
            stored.upsert(mapping, |_| Some(ActionInputKind::Trigger));
        }
        app
    }

    /// Sends note messages on note 60 and returns the actions they invoked, in order.
    fn play_notes(app: &mut App, messages: &[(u8, u8)]) -> Vec<(String, ActionInput)> {
        for &(status, velocity) in messages {
            let (source, signal) =
                MidiSource::classify(status, 60, velocity).expect("note should classify");
            app.world_mut().write_message(MidiInput {
                device: "Pad".to_string(),
                source,
                signal,
            });
        }
        app.update();
        app.world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .map(|invocation| (invocation.action.id.as_str().to_string(), invocation.input))
            .collect()
    }

    /// Sets whether one client holds controller mapping mode.
    fn set_mapping_mode(app: &mut App, active: bool) {
        let mut mode = app.world_mut().resource_mut::<ControllerMappingMode>();
        let client = ClientConnectionId(1);
        if active {
            mode.enter(client);
        } else {
            mode.leave(client);
        }
    }

    /// Builds a Release-behavior mapping on note 60 bound to the test release action.
    fn release_mapping(id: u128) -> MidiMapping {
        MidiMapping {
            behavior: nightfall_actions::ControlBehavior::Release,
            action: nightfall_actions::ActionReference::new("test.trigger", serde_json::json!({})),
            ..note_mapping(id, 60)
        }
    }

    /// Verifies mapped notes fire nothing while controller mapping mode is active.
    #[test]
    fn mapping_mode_suppresses_midi_actions() {
        let mut app = midi_dispatch_app(vec![note_mapping(1, 60)]);
        set_mapping_mode(&mut app, true);

        assert!(play_notes(&mut app, &[(0x90, 100), (0x80, 0)]).is_empty());

        set_mapping_mode(&mut app, false);
        assert_eq!(
            play_notes(&mut app, &[(0x90, 100)]),
            vec![("test.trigger".to_string(), ActionInput::Press)]
        );
    }

    /// Verifies a release after leaving mapping mode is swallowed when its press was mapped.
    #[test]
    fn release_after_mapping_mode_does_not_fire_release_binding() {
        let mut app = midi_dispatch_app(vec![release_mapping(2)]);
        set_mapping_mode(&mut app, true);
        assert!(play_notes(&mut app, &[(0x90, 100)]).is_empty());

        set_mapping_mode(&mut app, false);
        assert!(play_notes(&mut app, &[(0x80, 0)]).is_empty());
        assert_eq!(
            play_notes(&mut app, &[(0x90, 100), (0x80, 0)]),
            vec![("test.trigger".to_string(), ActionInput::Trigger)]
        );
    }

    /// Verifies a Hold pressed before mapping mode still runs its counterpart on release.
    #[test]
    fn hold_pressed_before_mapping_mode_releases_during_it() {
        let mut app = midi_dispatch_app(vec![MidiMapping {
            behavior: nightfall_actions::ControlBehavior::Hold,
            action: nightfall_actions::ActionReference::new("test.start", serde_json::json!({})),
            ..note_mapping(3, 60)
        }]);
        assert_eq!(
            play_notes(&mut app, &[(0x90, 100)]),
            vec![("test.start".to_string(), ActionInput::Trigger)]
        );

        set_mapping_mode(&mut app, true);
        assert_eq!(
            play_notes(&mut app, &[(0x80, 0)]),
            vec![("test.stop".to_string(), ActionInput::Trigger)]
        );
    }

    /// Verifies touches are recorded only while mapping mode is active, once per control.
    #[test]
    fn touches_are_recorded_only_in_mapping_mode() {
        let mut app = midi_command_app();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        app.insert_resource(MidiEventReceiver(rx));
        app.init_resource::<LastMidiEvent>();
        app.add_message::<MidiInput>();
        app.add_systems(Update, midi_event_system);
        let note = |velocity| MidiInputEvent {
            device: "Pad".to_string(),
            channel: 0x90,
            note: 60,
            velocity,
        };

        tx.send(note(100)).unwrap();
        app.update();
        assert!(app.world().resource::<MidiControlTouches>().0.is_empty());

        set_mapping_mode(&mut app, true);
        tx.send(note(100)).unwrap();
        tx.send(note(0)).unwrap();
        app.update();
        let touches = &app.world().resource::<MidiControlTouches>().0;
        assert_eq!(touches.len(), 1);
        assert_eq!(touches[0].velocity, 0);
    }

    /// Verifies Hold bindings are rejected for actions without a release counterpart.
    #[test]
    fn hold_binding_rejects_action_without_counterpart() {
        let mut app = midi_command_app();
        let mapping = MidiMapping {
            behavior: nightfall_actions::ControlBehavior::Hold,
            ..note_mapping(1, 60)
        };

        submit_command(&mut app, MidiCommand::UpsertMapping(mapping));
        app.update();

        assert!(app.world().resource::<MidiMappings>().mappings().is_empty());
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "action.behavior_unsupported"
        ));
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
