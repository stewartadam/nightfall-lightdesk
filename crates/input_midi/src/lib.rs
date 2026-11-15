// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI controllers: input, mappings to actions, LED feedback, and MIDI timecode.
//!
//! [`InputMidiPlugin`] discovers MIDI devices and reads their input on a service thread. Each
//! mapping binds a control to a registered action, so a pad or fader can start clips, move
//! masters, or run any other bindable action. Feedback sends each mapped control the state of
//! its action's target, with bundled controller profiles for known hardware. Incoming MIDI
//! timecode (MTC) feeds the timecodes that follow MIDI.

#![warn(missing_docs)]

use std::ops::DerefMut;
use std::time::{Duration, Instant};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_actions::{
    ActionInvocation, ActionRegistry, ActionSurface, ActionsPlugin, BindingDiagnostic,
    ControllerMappingMode, InvocationError, SourceEdgeStates, SourceSignal,
    bindings_need_diagnosis, collect_binding_diagnostics, register_binding_undo,
};
use nightfall_engine::prelude::*;
use nightfall_timecode::prelude::{ExternalTimecodeFeeds, TimecodeSource};
use tokio::sync::mpsc::UnboundedReceiver;

pub mod command;
mod detected;
mod devices;
mod feedback;
pub mod mapping;
mod mtc;
mod profile;
mod service;
mod undo;
mod websocket;

use command::{MidiCommand, MidiLastEvent, MidiMapping, MidiMappingUpserted, MidiSource};
use detected::DetectedMidiDevices;
pub use devices::MidiDevices;
use devices::{DiscoveredPort, resolve};
use feedback::{MidiFeedbackCache, MidiOutput, send_midi_feedback};
use mapping::MidiMappings;
use service::MidiInputEvent;
use uuid::Uuid;

type RawMidiEvent = MidiInputEvent;
const MIDI_DEVICE_REFRESH_INTERVAL: Duration = Duration::from_secs(1);

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::command::{
        MidiCommand, MidiLastEvent, MidiLedValues, MidiMapping, MidiMappingUpserted, MidiSource,
    };
    pub use crate::devices::{MidiDeviceRegistry, MidiDeviceSetting};
    pub use crate::mapping::MidiMappings;
    pub use crate::profile::{MidiDeviceProfile, MidiLedColor};
    pub use crate::websocket::MidiDevice;
    pub use crate::{InputMidiPlugin, MidiMappingDiagnostics};
}

/// Plugin for handling MIDI input
#[derive(Default)]
pub struct InputMidiPlugin {
    /// Name of the only MIDI input port to connect to, or `None` to connect to every port.
    ///
    /// The MIDI service is process-wide, so the most recently built plugin decides for every
    /// world in the process.
    pub input_port: Option<String>,
}

impl Plugin for InputMidiPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering InputMidiPlugin");
        assert!(
            app.is_plugin_added::<ActionsPlugin>(),
            "InputMidiPlugin requires ActionsPlugin (provides registered action invocation)"
        );
        let midi_service = service::process_midi_input_service();
        midi_service.set_input_port(self.input_port.clone());
        let _ = midi_service.ensure_started();
        let midi_client = midi_service.client();
        let waker = app.world().get_resource::<FrameWaker>().cloned();
        let midi_rx = midi_client.subscribe(waker).unwrap_or_else(|| {
            let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawMidiEvent>();
            rx
        });

        app.world_mut()
            .get_resource_or_init::<ExternalTimecodeFeeds>()
            .register(TimecodeSource::MidiMtc, midi_service.timecode_feed());
        let ports = read_ports(&midi_client, &midi_service.output_client());
        let (devices, _) = resolve(
            &ports,
            &devices::MidiDeviceRegistry::default(),
            &MidiDevices::default(),
        );
        app.insert_resource(DetectedMidiDevices::new(&devices));
        app.insert_resource(devices);
        app.insert_resource(MidiEventReceiver(midi_rx));
        app.insert_resource(MidiOutput(midi_service.output_client()));
        app.init_resource::<MidiMappings>();
        app.init_resource::<MidiFeedbackCache>();
        app.init_resource::<LastMidiEvent>();
        app.init_resource::<MidiControlTouches>();

        // Register command type and deserializer
        register_client_command::<MidiCommand>(app, Undo::Captured);
        app.add_message::<MidiInput>();
        register_binding_undo::<MidiMappings, MidiCommand>(app);

        // Add systems
        // Poll raw input and resolve mappings before registered actions are dispatched.
        app.add_systems(
            Update,
            (refresh_midi_devices, midi_event_system, handle_midi_events)
                .chain()
                .in_set(InputHandling),
        );

        app.add_systems(ApplyCommands, handle_midi_crud.in_set(EventHandling));
        app.init_resource::<MidiMappingDiagnostics>();

        app.add_systems(
            Render,
            (
                refresh_midi_mapping_diagnostics.run_if(bindings_need_diagnosis::<MidiMappings>),
                websocket::send_midi_announcements,
                send_midi_feedback,
            )
                .chain()
                .in_set(ClientOutput),
        );
        app.add_client_feed::<websocket::MidiDevicesFeed>()
            .on_change(
                resource_changed::<MidiDevices>.or_eager(resource_changed::<mapping::MidiMappings>),
            );
        app.add_client_feed::<websocket::MidiDeviceProfilesFeed>()
            .on_change(websocket::profiled_devices_changed);
        app.add_resource_feed::<mapping::MidiMappings>();
        app.add_resource_feed::<MidiMappingDiagnostics>();
        app.add_resource_feed::<LastMidiEvent>();
    }
}

/// Reads the connected input ports and whether each has a paired output from the MIDI
/// service clients.
fn read_ports(
    input: &service::MidiInputClient,
    output: &service::MidiOutputClient,
) -> Vec<DiscoveredPort> {
    input
        .ports()
        .into_iter()
        .map(|port| {
            let has_output = output.has_output(&port.port);
            (port, has_output)
        })
        .collect()
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
/// once per frame, carrying its most recent message. Channel messages that cannot drive
/// actions, such as program changes, appear without a source so the client can explain
/// why touching that control did nothing.
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
    device: Uuid,
    /// Control that sent the message.
    source: MidiSource,
    /// Button edge or level carried by the message.
    signal: SourceSignal,
    /// When the input callback received the message.
    received_at: Instant,
}

/// Returns whether a status byte is a channel message (note, controller, program change,
/// pressure, or pitch bend) rather than a system message such as clock or SysEx.
fn is_channel_message(status: u8) -> bool {
    (0x80..0xF0).contains(&status)
}

/// System that polls the MIDI event channel and writes events to the ECS event stream
///
/// Each message is attributed to the device connected through the port that received it.
/// Messages from a port no longer listed are dropped: its device's mappings were already
/// released when it vanished, and a late note on would hold them again with no note off left
/// to come.
///
/// While controller mapping mode is active, channel messages received after it began are
/// also recorded as touches for reliable delivery to mapping clients. System messages such
/// as clock are never touches, since they stream continuously.
fn midi_event_system(
    mut midi_rx: ResMut<MidiEventReceiver>,
    devices: Res<MidiDevices>,
    mut last_event: ResMut<LastMidiEvent>,
    mapping_mode: Res<ControllerMappingMode>,
    mut touches: ResMut<MidiControlTouches>,
    mut event_writer: MessageWriter<MidiInput>,
) {
    while let Ok(raw_event) = midi_rx.0.try_recv() {
        tracing::trace!(
            "Received MIDI event: port={}, channel={}, note={}, velocity={}",
            raw_event.port,
            raw_event.channel,
            raw_event.note,
            raw_event.velocity
        );

        let Some(connected) = devices.by_port(&raw_event.port) else {
            tracing::debug!(port = %raw_event.port, "MIDI message from a disconnected port dropped");
            continue;
        };
        let classified =
            MidiSource::classify(raw_event.channel, raw_event.note, raw_event.velocity);
        let midi_last_event = MidiLastEvent {
            device: connected.device,
            device_name: connected.name.clone(),
            channel: raw_event.channel,
            note: raw_event.note,
            velocity: raw_event.velocity,
            source: classified.map(|(source, _)| source),
        };

        if is_channel_message(raw_event.channel)
            && mapping_mode.records_touch(raw_event.received_at)
        {
            touches.record(&midi_last_event);
        }

        // Update the last event resource for UI display
        last_event.0 = Some(midi_last_event.clone());

        if let Some((source, signal)) = classified {
            event_writer.write(MidiInput {
                device: midi_last_event.device,
                source,
                signal,
                received_at: raw_event.received_at,
            });
        }
    }
}

/// Polls the process-wide MIDI service and assigns the connected ports to devices; a changed
/// assignment publishes the device list to websocket clients, and units never seen before are
/// queued for announcement.
///
/// Ports are reassigned when the connected ports or the show's devices change, as after
/// loading a show or mapping a new unit. Unit keys a saved device learns are saved with it.
/// A device that disappears never sends the note offs for pads held on it, so its mappings'
/// press state is forgotten, which releases any Hold or Flash those pads were holding.
fn refresh_midi_devices(
    mut next_refresh_deadline: Local<Option<Instant>>,
    mut ports: Local<Option<Vec<DiscoveredPort>>>,
    mut devices: ResMut<MidiDevices>,
    mut detected: ResMut<DetectedMidiDevices>,
    mut mappings: ResMut<MidiMappings>,
    mut edges: ResMut<SourceEdgeStates>,
) {
    let now = Instant::now();
    let mut ports_changed = false;
    if next_refresh_deadline.is_none_or(|deadline| now >= deadline) {
        *next_refresh_deadline = Some(now + MIDI_DEVICE_REFRESH_INTERVAL);
        let midi_service = service::process_midi_input_service();
        let _ = midi_service.refresh();
        let current = read_ports(&midi_service.client(), &midi_service.output_client());
        if ports.as_ref() != Some(&current) {
            *ports = Some(current);
            ports_changed = true;
        }
    }
    if !ports_changed && !mappings.is_changed() {
        return;
    }
    let Some(ports) = ports.as_ref() else {
        return;
    };
    let (current, learned) = resolve(ports, mappings.devices(), &devices);
    if !learned.is_empty() {
        let registry = mappings.devices_mut();
        for (device, unit) in learned {
            registry.learn_unit(device, &unit);
        }
    }
    forget_vanished_device_mappings(&devices, &current, &mappings, &mut edges);
    if devices.set_if_neq(current) {
        detected.observe(&devices);
    }
}

/// Forgets press state for every mapping on a device connected in `previous` that is not
/// connected in `current`.
///
/// `edges` is only borrowed mutably when a device vanished, so a quiet poll leaves the press
/// state unchanged for change detection.
fn forget_vanished_device_mappings(
    previous: &MidiDevices,
    current: &MidiDevices,
    mappings: &MidiMappings,
    edges: &mut impl DerefMut<Target = SourceEdgeStates>,
) {
    let vanished: Vec<Uuid> = previous
        .iter()
        .map(|connected| connected.device)
        .filter(|device| !current.is_connected(*device))
        .collect();
    if vanished.is_empty() {
        return;
    }
    for mapping in mappings.mappings() {
        if vanished.contains(&mapping.device) {
            edges.forget(mapping.id);
        }
    }
}

/// System that invokes the action bound to each MIDI control that sends a message.
///
/// The control's raw signal is adapted to the bound action's input kind and behavior, so a
/// note can fire a trigger and a level-reporting controller button fires once per press.
/// While controller mapping mode is active, input is suppressed as described by
/// [`SourceEdgeStates`]: nothing new fires, but releases completing live presses still do.
///
/// Messages from a device that is no longer connected are dropped, for the reason given on
/// [`midi_event_system`].
fn handle_midi_events(
    mut events: MessageReader<MidiInput>,
    mappings: Res<MidiMappings>,
    devices: Res<MidiDevices>,
    registry: Res<ActionRegistry>,
    mapping_mode: Res<ControllerMappingMode>,
    mut edges: ResMut<SourceEdgeStates>,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    let suppressed = mapping_mode.is_active();
    for event in events.read() {
        let Some(connected) = devices.by_device(event.device) else {
            tracing::debug!(?event, "MIDI message from a disconnected device dropped");
            continue;
        };
        for mapping in mappings.lookup(event.device, event.source) {
            tracing::debug!(?event, action = ?mapping.action, "MIDI mapping matched");
            let Some((action, input)) = edges.resolve(
                &registry,
                mapping.id,
                ActionSurface::Midi,
                &mapping.action,
                mapping.behavior,
                event.signal,
                suppressed,
            ) else {
                continue;
            };
            invocations.write(
                ActionInvocation::new(action, ActionSurface::Midi, input)
                    .with_source(format!("MIDI {}", connected.name))
                    .with_received_at(event.received_at),
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

/// Makes sure device `id` is saved, saving a connected new unit under it; fails for a device
/// that is neither saved nor connected.
fn save_device(
    id: Uuid,
    mappings: &mut MidiMappings,
    devices: &MidiDevices,
) -> Result<(), CommandError> {
    if mappings.devices().get(id).is_some() {
        return Ok(());
    }
    let setting = devices
        .by_device(id)
        .and_then(devices::ConnectedDevice::unsaved_setting)
        .ok_or_else(|| {
            CommandError::new(
                "midi.device_not_found",
                format!("MIDI device {id} is neither saved nor connected"),
            )
        })?;
    mappings.devices_mut().insert(setting);
    Ok(())
}

/// Recognizes connected new unit `unit` as saved device `device`, which must be of the same
/// model and not plugged in, by teaching the device the unit's key.
fn assign_device(
    unit: Uuid,
    device: Uuid,
    mappings: &mut MidiMappings,
    devices: &MidiDevices,
) -> Result<(), CommandError> {
    let connected = devices
        .by_device(unit)
        .filter(|connected| connected.unsaved_number.is_some())
        .ok_or_else(|| {
            CommandError::new(
                "midi.unit_not_found",
                format!("No new MIDI unit {unit} is connected"),
            )
        })?;
    let saved = mappings.devices().get(device).ok_or_else(|| {
        CommandError::new(
            "midi.device_not_found",
            format!("MIDI device {device} is not saved"),
        )
    })?;
    if saved.model != connected.model {
        return Err(CommandError::new(
            "midi.device_model_mismatch",
            format!(
                "{} is a {}, not a {}",
                saved.display_name(),
                saved.model,
                connected.model
            ),
        ));
    }
    if devices.is_connected(device) {
        return Err(CommandError::new(
            "midi.device_connected",
            format!("{} is already connected", saved.display_name()),
        ));
    }
    let unit_key = connected.unit.clone();
    mappings.devices_mut().learn_unit(device, &unit_key);
    Ok(())
}

/// System that applies MIDI mapping and device edits and reports their terminal outcomes.
///
/// Mapping a connected new unit or changing its feedback saves it as a device.
fn handle_midi_crud(
    mut events: MessageReader<CommandEnvelope<MidiCommand>>,
    mut mappings: ResMut<MidiMappings>,
    devices: Res<MidiDevices>,
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
                    })
                    .map_err(CommandError::from)
                    .and_then(|()| save_device(mapping.device, &mut mappings, &devices))
                {
                    Ok(()) => {
                        edges.forget(mapping.id);
                        let replaced = mappings
                            .upsert(mapping.clone(), |action| registry.input_kind(&action.id));
                        for displaced in &replaced {
                            edges.forget(displaced.id);
                        }
                        responder.succeed_with_output(
                            event.command_id,
                            &MidiMappingUpserted { replaced },
                        )
                    }
                    Err(error) => responder.fail(event.command_id, error),
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
            MidiCommand::SetDeviceFeedback { device, enabled } => {
                let changes = mappings.devices().feedback_enabled(*device) != *enabled
                    || mappings.devices().get(*device).is_none();
                let saved = if changes {
                    save_device(*device, &mut mappings, &devices).map(|()| {
                        mappings.devices_mut().set_feedback(*device, *enabled);
                    })
                } else {
                    Ok(())
                };
                match saved {
                    Ok(()) => responder.succeed(event.command_id),
                    Err(error) => responder.fail(event.command_id, error),
                }
            }
            MidiCommand::AssignDevice { unit, device } => {
                match assign_device(*unit, *device, &mut mappings, &devices) {
                    Ok(()) => responder.succeed(event.command_id),
                    Err(error) => responder.fail(event.command_id, error),
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
    use nightfall_actions::ActionInputKind;
    use nightfall_actions::{ActionInput, ActionTargetTracking};

    use super::*;
    use crate::command::MidiMapping;
    use crate::devices::{ConnectedDevice, MidiDeviceRegistry, MidiDeviceSetting};

    /// ID of the saved pad device most tests map.
    const PAD: Uuid = Uuid::from_u128(0xFAD);

    /// Builds a connected port `port` of model `model` assigned to device `device`, saved
    /// unless `unsaved_number` numbers it as a new unit.
    fn connected(
        device: Uuid,
        port: &str,
        model: &str,
        unsaved_number: Option<u32>,
    ) -> ConnectedDevice {
        ConnectedDevice {
            port: port.to_string(),
            model: model.to_string(),
            unit: format!("unit-{port}"),
            has_output: false,
            device,
            name: devices::display_name(model, unsaved_number.unwrap_or(1)),
            unsaved_number,
        }
    }

    /// Builds a saved device setting with no unit keys.
    fn saved(id: Uuid, model: &str, number: u32) -> MidiDeviceSetting {
        MidiDeviceSetting {
            id,
            model: model.to_string(),
            number,
            units: Vec::new(),
            feedback: None,
        }
    }

    /// Creates a focused app containing semantic MIDI mapping CRUD.
    fn midi_command_app() -> App {
        let mut app = App::new();
        let mut mappings = MidiMappings::default();
        mappings.set_devices(MidiDeviceRegistry::new([saved(PAD, "Pad", 1)]));
        app.insert_resource(mappings);
        app.init_resource::<SourceEdgeStates>();
        app.init_resource::<ControllerMappingMode>();
        app.init_resource::<MidiControlTouches>();
        app.insert_resource(MidiDevices::new(vec![connected(
            PAD, "port-pad", "Pad", None,
        )]));
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
            device: PAD,
            source: MidiSource::Note { channel: 0, note },
            behavior: nightfall_actions::ControlBehavior::Press,
            led: Default::default(),
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
            Some(serde_json::json!({ "replaced": [note_mapping(1, 60)] }))
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
                device: PAD,
                source,
                signal,
                received_at: Instant::now(),
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
            led: Default::default(),
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
                device: PAD,
                source,
                signal,
                received_at: Instant::now(),
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
            led: Default::default(),
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
                device: PAD,
                source,
                signal,
                received_at: Instant::now(),
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
                device: PAD,
                source,
                signal,
                received_at: Instant::now(),
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
        let client = ClientId(1);
        if active {
            mode.enter(client, std::time::Instant::now());
        } else {
            mode.leave(client);
        }
    }

    /// Builds a Release-behavior mapping on note 60 bound to the test release action.
    fn release_mapping(id: u128) -> MidiMapping {
        MidiMapping {
            behavior: nightfall_actions::ControlBehavior::Release,
            led: Default::default(),
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
            led: Default::default(),
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

    /// Builds a Hold mapping on note 60 that starts `test.start` and stops it on release.
    fn hold_mapping(id: u128) -> MidiMapping {
        MidiMapping {
            behavior: nightfall_actions::ControlBehavior::Hold,
            led: Default::default(),
            action: nightfall_actions::ActionReference::new("test.start", serde_json::json!({})),
            ..note_mapping(id, 60)
        }
    }

    /// Adds the forgotten-release dispatch, runs one frame, and returns the actions invoked
    /// in it. Call it once per app, since each call adds the dispatch system again.
    fn dispatched_releases(app: &mut App) -> Vec<(String, ActionInput)> {
        app.add_systems(Update, nightfall_actions::dispatch_forgotten_releases);
        app.update();
        app.world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .map(|invocation| (invocation.action.id.as_str().to_string(), invocation.input))
            .collect()
    }

    /// Verifies editing a held pad's mapping, such as its LED colour, runs the release
    /// counterpart at once instead of leaving the hold latched, and the later note off then
    /// fires nothing.
    #[test]
    fn editing_a_held_mapping_releases_it() {
        let mut app = midi_dispatch_app(vec![hold_mapping(4)]);
        play_notes(&mut app, &[(0x90, 100)]);

        submit_command(
            &mut app,
            MidiCommand::UpsertMapping(MidiMapping {
                led: crate::command::MidiLedValues {
                    on: Some(5),
                    ..Default::default()
                },
                ..hold_mapping(4)
            }),
        );
        app.update();
        take_result(&mut app);

        assert_eq!(
            dispatched_releases(&mut app),
            vec![("test.stop".to_string(), ActionInput::Trigger)]
        );
        assert!(play_notes(&mut app, &[(0x80, 0)]).is_empty());
    }

    /// Verifies unplugging a device while a pad on it is held runs the release counterpart,
    /// since the device can no longer send the note off.
    #[test]
    fn unplugging_a_device_releases_its_held_pads() {
        let mut app = midi_dispatch_app(vec![hold_mapping(4)]);
        play_notes(&mut app, &[(0x90, 100)]);

        let world = app.world_mut();
        world.resource_scope(|world, mut edges: Mut<SourceEdgeStates>| {
            let keys = connected(Uuid::from_u128(0xEE), "port-keys", "Keys", None);
            forget_vanished_device_mappings(
                &MidiDevices::new(vec![connected(PAD, "port-pad", "Pad", None), keys.clone()]),
                &MidiDevices::new(vec![keys]),
                world.resource::<MidiMappings>(),
                &mut edges,
            );
        });

        assert_eq!(
            dispatched_releases(&mut app),
            vec![("test.stop".to_string(), ActionInput::Trigger)]
        );
    }

    /// Verifies a note on still queued from a device that has disconnected fires nothing, so
    /// it cannot start a hold whose note off will never come.
    #[test]
    fn messages_from_a_disconnected_device_are_dropped() {
        let mut app = midi_dispatch_app(vec![hold_mapping(4)]);
        app.insert_resource(MidiDevices::default());

        assert!(play_notes(&mut app, &[(0x90, 100)]).is_empty());
    }

    /// Verifies a second note on without a note off between them starts a Hold only once, so
    /// the single note off ends it.
    #[test]
    fn repeated_note_on_starts_a_hold_once() {
        let mut app = midi_dispatch_app(vec![hold_mapping(4)]);

        assert_eq!(
            play_notes(&mut app, &[(0x90, 100), (0x90, 100), (0x80, 0)]),
            vec![
                ("test.start".to_string(), ActionInput::Trigger),
                ("test.stop".to_string(), ActionInput::Trigger),
            ]
        );
    }

    /// Creates an app that reads raw MIDI messages from the returned sender.
    fn midi_touch_app() -> (App, tokio::sync::mpsc::UnboundedSender<MidiInputEvent>) {
        let mut app = midi_command_app();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        app.insert_resource(MidiEventReceiver(rx));
        app.init_resource::<LastMidiEvent>();
        app.add_message::<MidiInput>();
        app.add_systems(Update, midi_event_system);
        (app, tx)
    }

    /// Builds a raw message from the test pad received now.
    fn raw_message(status: u8, data1: u8, data2: u8) -> MidiInputEvent {
        MidiInputEvent {
            port: "port-pad".to_string(),
            channel: status,
            note: data1,
            velocity: data2,
            received_at: std::time::Instant::now(),
        }
    }

    /// Verifies touches are recorded only while mapping mode is active, once per control.
    #[test]
    fn touches_are_recorded_only_in_mapping_mode() {
        let (mut app, tx) = midi_touch_app();

        tx.send(raw_message(0x90, 60, 100)).unwrap();
        app.update();
        assert!(app.world().resource::<MidiControlTouches>().0.is_empty());

        set_mapping_mode(&mut app, true);
        tx.send(raw_message(0x90, 60, 100)).unwrap();
        tx.send(raw_message(0x90, 60, 0)).unwrap();
        app.update();
        let touches = &app.world().resource::<MidiControlTouches>().0;
        assert_eq!(touches.len(), 1);
        assert_eq!(touches[0].velocity, 0);
    }

    /// Verifies a message received before mapping mode began is not a touch, even when it
    /// is read after mapping mode began.
    #[test]
    fn input_received_before_mapping_mode_is_not_a_touch() {
        let (mut app, tx) = midi_touch_app();
        let mut stale = raw_message(0xB0, 7, 64);
        stale.received_at -= std::time::Duration::from_millis(5);

        set_mapping_mode(&mut app, true);
        tx.send(stale).unwrap();
        app.update();
        assert!(app.world().resource::<MidiControlTouches>().0.is_empty());
    }

    /// Verifies unmappable channel messages are touches without a source, so the client can
    /// explain them, while system messages such as clock are not touches.
    #[test]
    fn unmappable_channel_messages_are_touches_without_a_source() {
        let (mut app, tx) = midi_touch_app();
        set_mapping_mode(&mut app, true);

        tx.send(raw_message(0xF8, 0, 0)).unwrap();
        tx.send(raw_message(0xC0, 5, 0)).unwrap();
        app.update();
        let touches = &app.world().resource::<MidiControlTouches>().0;
        assert_eq!(touches.len(), 1);
        assert_eq!((touches[0].channel, touches[0].source), (0xC0, None));
    }

    /// Verifies Hold bindings are rejected for actions without a release counterpart.
    #[test]
    fn hold_binding_rejects_action_without_counterpart() {
        let mut app = midi_command_app();
        let mapping = MidiMapping {
            behavior: nightfall_actions::ControlBehavior::Hold,
            led: Default::default(),
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

    /// Second unit of the pad model, connected next to [`PAD`].
    const PAD_2: Uuid = Uuid::from_u128(0xFAD2);

    /// Verifies two identical units each fire only their own mappings on the same control.
    #[test]
    fn identical_units_fire_their_own_mappings() {
        let second = MidiMapping {
            device: PAD_2,
            action: nightfall_actions::ActionReference::new("test.start", serde_json::json!({})),
            ..note_mapping(2, 60)
        };
        let mut app = midi_dispatch_app(vec![note_mapping(1, 60), second]);
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .devices_mut()
            .insert(saved(PAD_2, "Pad", 2));
        app.insert_resource(MidiDevices::new(vec![
            connected(PAD, "port-pad", "Pad", None),
            connected(PAD_2, "port-pad-2", "Pad", None),
        ]));

        app.world_mut().write_message(MidiInput {
            device: PAD_2,
            source: MidiSource::Note {
                channel: 0,
                note: 60,
            },
            signal: SourceSignal::Button(true),
            received_at: Instant::now(),
        });
        app.update();
        let fired: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .map(|invocation| invocation.action.id.as_str().to_string())
            .collect();
        assert_eq!(fired, vec!["test.start".to_string()]);
    }

    /// Verifies raw messages are attributed to the device behind the port that received them,
    /// and messages from an unknown port are dropped.
    #[test]
    fn raw_messages_are_attributed_by_port() {
        let (mut app, tx) = midi_touch_app();
        app.insert_resource(MidiDevices::new(vec![
            connected(PAD, "port-pad", "Pad", None),
            connected(PAD_2, "port-pad-2", "Pad", Some(2)),
        ]));

        let mut second = raw_message(0x90, 60, 100);
        second.port = "port-pad-2".to_string();
        tx.send(second).unwrap();
        app.update();
        let event = app
            .world()
            .resource::<LastMidiEvent>()
            .0
            .clone()
            .expect("message should be recorded");
        assert_eq!(
            (event.device, event.device_name.as_str()),
            (PAD_2, "Pad (2)")
        );

        let mut unknown = raw_message(0x90, 61, 100);
        unknown.port = "port-gone".to_string();
        tx.send(unknown).unwrap();
        app.update();
        assert_eq!(
            app.world()
                .resource::<LastMidiEvent>()
                .0
                .as_ref()
                .map(|event| event.note),
            Some(60)
        );
    }

    /// Verifies mapping a connected new unit saves it under its ID with its number and unit
    /// key, while mapping a device that is neither saved nor connected fails.
    #[test]
    fn mapping_a_new_unit_saves_it() {
        let mut app = midi_command_app();
        app.insert_resource(MidiDevices::new(vec![
            connected(PAD, "port-pad", "Pad", None),
            connected(PAD_2, "port-pad-2", "Pad", Some(2)),
        ]));

        submit_command(
            &mut app,
            MidiCommand::UpsertMapping(MidiMapping {
                device: PAD_2,
                ..note_mapping(1, 60)
            }),
        );
        app.update();
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Succeeded { .. }
        ));
        let saved_device = app
            .world()
            .resource::<MidiMappings>()
            .devices()
            .get(PAD_2)
            .cloned()
            .expect("the new unit should be saved");
        assert_eq!(saved_device.number, 2);
        assert_eq!(saved_device.units, vec!["unit-port-pad-2".to_string()]);

        submit_command(
            &mut app,
            MidiCommand::UpsertMapping(MidiMapping {
                device: Uuid::from_u128(0xDEAD),
                ..note_mapping(2, 61)
            }),
        );
        app.update();
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "midi.device_not_found"
        ));
    }

    /// Verifies a connected new unit can be assigned to a saved device of its model that is
    /// not plugged in, which learns the unit's key, but not to a connected device.
    #[test]
    fn assigning_a_new_unit_teaches_the_device_its_key() {
        let mut app = midi_command_app();
        let unit = Uuid::from_u128(0x0E1);
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .devices_mut()
            .insert(saved(PAD_2, "Pad", 2));
        app.insert_resource(MidiDevices::new(vec![
            connected(PAD, "port-pad", "Pad", None),
            connected(unit, "port-new", "Pad", Some(3)),
        ]));

        submit_command(&mut app, MidiCommand::AssignDevice { unit, device: PAD });
        app.update();
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "midi.device_connected"
        ));

        submit_command(
            &mut app,
            MidiCommand::AssignDevice {
                unit,
                device: PAD_2,
            },
        );
        app.update();
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Succeeded { .. }
        ));
        assert_eq!(
            app.world()
                .resource::<MidiMappings>()
                .devices()
                .get(PAD_2)
                .map(|device| device.units.clone()),
            Some(vec!["unit-port-new".to_string()])
        );
    }
}
