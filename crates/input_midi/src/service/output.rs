// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI output ports paired with connected input devices, and the thread that writes to them.
//!
//! Feedback is addressed by the input port a device is connected through, so each output port
//! is paired with the input port of the same unit. Only outputs paired with a connected input
//! are opened: Windows grants output ports exclusively, so opening every port would take
//! synthesizers and other apps' ports away from them.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use super::identity::port_pairing;
use super::{ConnectedMidiPort, MidiPortDescriptor, refresh_connections};

/// MIDI client and port name of the desk's feedback connections, which input discovery skips.
const FEEDBACK_CLIENT_NAME: &str = "nightfall-feedback";

/// One raw MIDI message to write to the output paired with an input port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MidiOutputMessage {
    /// OS port ID of the input whose unit the message is addressed to.
    pub port: String,
    /// Complete MIDI message, status byte first.
    pub bytes: Vec<u8>,
}

/// Output connections shared by the refreshing worker and the sender thread.
///
/// Each connection's `name` holds the port ID of the input it is paired with.
#[derive(Default)]
pub(crate) struct MidiOutputPorts {
    connections: Vec<ConnectedMidiPort<midir::MidiOutputConnection>>,
    /// Incremented whenever the set of open output connections changes.
    generation: u64,
}

impl MidiOutputPorts {
    /// Returns the open output paired with input port `port`, if any.
    fn paired_mut(
        &mut self,
        port: &str,
    ) -> Option<&mut ConnectedMidiPort<midir::MidiOutputConnection>> {
        self.connections
            .iter_mut()
            .find(|connection| connection.name == port)
    }

    /// Returns whether an output paired with input port `port` is open.
    fn has_paired(&self, port: &str) -> bool {
        self.connections
            .iter()
            .any(|connection| connection.name == port)
    }
}

/// Destination of feedback messages: real output ports, or a capture channel in tests.
#[derive(Clone)]
enum OutputBackend {
    /// Open output ports managed by the process-wide MIDI worker.
    Ports {
        tx: Sender<MidiOutputMessage>,
        ports: Arc<Mutex<MidiOutputPorts>>,
    },
    /// Every port counts as having an output, and messages go to a test receiver.
    #[cfg(test)]
    Capture {
        tx: Sender<MidiOutputMessage>,
        generation: Arc<std::sync::atomic::AtomicU64>,
    },
}

/// Cloneable handle that queues MIDI messages for the output paired with an input port.
///
/// Messages are written on a dedicated thread, so a slow device never stalls a frame.
#[derive(Clone, Default)]
pub struct MidiOutputClient {
    backend: Arc<Mutex<Option<OutputBackend>>>,
}

impl MidiOutputClient {
    /// Queues one message for the output paired with input port `port`.
    ///
    /// Returns `false` when no output worker is running; a port without an open output
    /// drops the message on the sender thread.
    pub fn send(&self, port: &str, bytes: Vec<u8>) -> bool {
        let Some(backend) = self.backend() else {
            return false;
        };
        let message = MidiOutputMessage {
            port: port.to_string(),
            bytes,
        };
        match backend {
            OutputBackend::Ports { tx, .. } => tx.send(message).is_ok(),
            #[cfg(test)]
            OutputBackend::Capture { tx, .. } => tx.send(message).is_ok(),
        }
    }

    /// Returns whether an output paired with input port `port` is open.
    pub fn has_output(&self, port: &str) -> bool {
        match self.backend() {
            Some(OutputBackend::Ports { ports, .. }) => {
                ports.lock().is_ok_and(|ports| ports.has_paired(port))
            }
            #[cfg(test)]
            Some(OutputBackend::Capture { .. }) => true,
            None => false,
        }
    }

    /// Returns a counter that changes whenever output ports open or close.
    ///
    /// A device that was unplugged and replugged between two device refreshes can keep its
    /// port, so callers compare this counter to know they must resend their full state.
    pub fn generation(&self) -> u64 {
        match self.backend() {
            Some(OutputBackend::Ports { ports, .. }) => ports
                .lock()
                .map(|ports| ports.generation)
                .unwrap_or_default(),
            #[cfg(test)]
            Some(OutputBackend::Capture { generation, .. }) => {
                generation.load(std::sync::atomic::Ordering::SeqCst)
            }
            None => 0,
        }
    }

    /// Returns a client whose messages go to the returned receiver and that treats every
    /// device as connected, plus a counter tests bump to simulate a reconnect.
    #[cfg(test)]
    pub(crate) fn capturing() -> (
        Self,
        Receiver<MidiOutputMessage>,
        Arc<std::sync::atomic::AtomicU64>,
    ) {
        let (tx, rx) = mpsc::channel();
        let generation = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let client = Self {
            backend: Arc::new(Mutex::new(Some(OutputBackend::Capture {
                tx,
                generation: generation.clone(),
            }))),
        };
        (client, rx, generation)
    }

    /// Points the client at a running output worker, or at none.
    pub(crate) fn set_worker(&self, worker: Option<&MidiOutputWorker>) {
        if let Ok(mut backend) = self.backend.lock() {
            *backend = worker.map(|worker| OutputBackend::Ports {
                tx: worker.tx.clone(),
                ports: worker.ports.clone(),
            });
        }
    }

    /// Returns a copy of the current backend so no lock is held while sending.
    fn backend(&self) -> Option<OutputBackend> {
        self.backend.lock().ok().and_then(|backend| backend.clone())
    }
}

/// Output side of the MIDI worker: discovers output ports and opens those paired with inputs.
pub(crate) struct MidiOutputWorker {
    discovery: Option<midir::MidiOutput>,
    ports: Arc<Mutex<MidiOutputPorts>>,
    tx: Sender<MidiOutputMessage>,
}

impl MidiOutputWorker {
    /// Creates the worker and starts the thread that writes queued messages to open ports.
    ///
    /// The thread exits once the worker and every client pointing at it are dropped.
    pub(crate) fn spawn() -> Self {
        let ports = Arc::new(Mutex::new(MidiOutputPorts::default()));
        let (tx, rx) = mpsc::channel::<MidiOutputMessage>();
        let thread_ports = ports.clone();
        std::thread::Builder::new()
            .name("midi-output".to_string())
            .spawn(move || write_messages(&rx, &thread_ports))
            .expect("failed to spawn MIDI output thread");
        Self {
            discovery: None,
            ports,
            tx,
        }
    }

    /// Closes every output and recreates the discovery client on the next refresh, after the
    /// OS reported that devices were added or removed.
    ///
    /// CoreMIDI clients otherwise keep a stale port list, and a controller replugged between
    /// two refreshes keeps its port id, so reopening is the only sign that it powered up
    /// with dark LEDs and needs its full state again.
    pub(crate) fn reconnect_all(&mut self) {
        self.discovery = None;
        self.close_all();
    }

    /// Opens outputs paired with `inputs` and closes the rest; returns whether the set of
    /// open outputs changed.
    pub(crate) fn refresh(&mut self, inputs: &[InputPairing]) -> bool {
        if self.discovery.is_none() {
            match midir::MidiOutput::new("nightfall-output-discovery") {
                Ok(discovery) => self.discovery = Some(discovery),
                Err(error) => {
                    tracing::warn!("Failed to create MIDI output for discovery: {error}");
                    return self.close_all();
                }
            }
        }
        let Some(discovery) = self.discovery.as_ref() else {
            return false;
        };
        let outputs = discover_output_ports(discovery)
            .into_iter()
            .map(|output| {
                let key = port_pairing(&output.id, &output.name);
                (output, key)
            })
            .collect();
        let paired = paired_ports(outputs, inputs);
        let Ok(mut ports) = self.ports.lock() else {
            return false;
        };
        let changed = refresh_connections(&mut ports.connections, paired, |port, input| {
            connect_output(&port, &input)
        });
        if changed {
            ports.generation += 1;
            tracing::info!(
                outputs = ?ports.connections.iter().map(|port| &port.name).collect::<Vec<_>>(),
                "MIDI output ports changed"
            );
        }
        changed
    }

    /// Closes every open output; returns whether any was open.
    pub(crate) fn close_all(&mut self) -> bool {
        let Ok(mut ports) = self.ports.lock() else {
            return false;
        };
        if ports.connections.is_empty() {
            return false;
        }
        ports.connections.clear();
        ports.generation += 1;
        true
    }
}

/// Writes queued messages to the output paired with each message's input port until every
/// sender is dropped. Messages for ports without an open output are dropped.
fn write_messages(rx: &Receiver<MidiOutputMessage>, ports: &Mutex<MidiOutputPorts>) {
    while let Ok(message) = rx.recv() {
        let Ok(mut ports) = ports.lock() else {
            return;
        };
        let Some(port) = ports.paired_mut(&message.port) else {
            continue;
        };
        if let Err(error) = port.connection.send(&message.bytes) {
            tracing::debug!(port = %message.port, %error, "MIDI output send failed");
        }
    }
}

/// Enumerates output ports with their user-facing names.
fn discover_output_ports(
    midi_out: &midir::MidiOutput,
) -> Vec<MidiPortDescriptor<midir::MidiOutputPort>> {
    midi_out
        .ports()
        .into_iter()
        .filter_map(|port| {
            let id = port.id();
            midi_out
                .port_name(&port)
                .ok()
                .map(|name| MidiPortDescriptor { port, id, name })
        })
        .collect()
}

/// A connected input port as output pairing sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InputPairing {
    /// OS port ID of the input.
    pub port: String,
    /// Device name without the instance the OS adds.
    pub base: String,
    /// Key the input shares with its own unit's output.
    pub pairing: String,
}

/// Pairs discovered outputs, each with its `(base, pairing)` key, to connected inputs and
/// returns the paired outputs with the input port ID they serve as their name.
///
/// An output with the same device and pairing key wins. Otherwise, when a device has exactly
/// one input and one output, they are paired, which covers devices whose input and output
/// get different instance numbers. Several unmatched units of a device stay unpaired, so one
/// unit's feedback never lights another identical unit.
fn paired_ports<P>(
    outputs: Vec<(MidiPortDescriptor<P>, (String, String))>,
    inputs: &[InputPairing],
) -> Vec<MidiPortDescriptor<P>> {
    let mut assigned: Vec<Option<&str>> = vec![None; outputs.len()];
    for input in inputs {
        let exact = outputs.iter().enumerate().position(|(index, (_, key))| {
            assigned[index].is_none() && key.0 == input.base && key.1 == input.pairing
        });
        if let Some(index) = exact {
            assigned[index] = Some(&input.port);
        }
    }
    for input in inputs {
        if assigned.contains(&Some(input.port.as_str())) {
            continue;
        }
        let same_base_inputs = inputs
            .iter()
            .filter(|other| other.base == input.base)
            .count();
        let same_base_outputs: Vec<usize> = outputs
            .iter()
            .enumerate()
            .filter(|(_, (_, key))| key.0 == input.base)
            .map(|(index, _)| index)
            .collect();
        if let ([index], 1) = (same_base_outputs.as_slice(), same_base_inputs)
            && assigned[*index].is_none()
        {
            assigned[*index] = Some(&input.port);
        }
    }
    outputs
        .into_iter()
        .zip(assigned)
        .filter_map(|((output, _), input)| {
            input.map(|input| MidiPortDescriptor {
                port: output.port,
                id: output.id,
                name: input.to_string(),
            })
        })
        .collect()
}

/// Opens one output connection for the unit behind input port `input`, logging failures.
fn connect_output(
    port: &midir::MidiOutputPort,
    input: &str,
) -> Option<midir::MidiOutputConnection> {
    let midi_out = match midir::MidiOutput::new(FEEDBACK_CLIENT_NAME) {
        Ok(midi_out) => midi_out,
        Err(error) => {
            tracing::error!("Failed to create MIDI output: {error}");
            return None;
        }
    };
    match midi_out.connect(port, FEEDBACK_CLIENT_NAME) {
        Ok(connection) => Some(connection),
        Err(error) => {
            tracing::error!("Failed to connect to MIDI output paired with '{input}': {error}");
            None
        }
    }
}

/// Returns whether a discovered port belongs to the desk's own feedback client.
///
/// ALSA publishes every output connection as a readable port, so input discovery would
/// otherwise connect to it and receive the desk's LED messages as controller input.
pub(crate) fn is_own_feedback_port(name: &str) -> bool {
    name.trim()
        .strip_prefix(FEEDBACK_CLIENT_NAME)
        .is_some_and(|rest| rest.starts_with(':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an input pairing from a port ID, device name and pairing key.
    fn input(port: &str, base: &str, pairing: &str) -> InputPairing {
        InputPairing {
            port: port.to_string(),
            base: base.to_string(),
            pairing: pairing.to_string(),
        }
    }

    /// Builds discovered outputs from port names, keyed the way discovery keys them.
    fn outputs(
        names: &[&'static str],
    ) -> Vec<(MidiPortDescriptor<&'static str>, (String, String))> {
        names
            .iter()
            .map(|name| {
                let key = port_pairing(name, name);
                let descriptor = MidiPortDescriptor {
                    port: *name,
                    id: (*name).to_string(),
                    name: (*name).to_string(),
                };
                (descriptor, key)
            })
            .collect()
    }

    /// Returns which output each input port was paired with.
    fn pairs(
        outputs: Vec<(MidiPortDescriptor<&'static str>, (String, String))>,
        inputs: &[InputPairing],
    ) -> Vec<(&'static str, String)> {
        paired_ports(outputs, inputs)
            .into_iter()
            .map(|output| (output.port, output.name))
            .collect()
    }

    /// Verifies two identical units each pair with their own output, a lone device pairs
    /// even when its input and output carry different instance numbers, and unrelated
    /// outputs stay closed.
    #[test]
    fn paired_ports_keeps_identical_units_apart() {
        let windows = outputs(&[
            "MIDIOUT2 (APC MINI)",
            "APC MINI",
            "Microsoft GS Wavetable Synth",
        ]);
        assert_eq!(
            pairs(
                windows,
                &[
                    input("in-1", "APC MINI", ""),
                    input("in-2", "APC MINI", "2")
                ]
            ),
            vec![
                ("MIDIOUT2 (APC MINI)", "in-2".to_string()),
                ("APC MINI", "in-1".to_string())
            ]
        );

        let unmatched = outputs(&["MIDIOUT2 (APC MINI)", "APC MINI"]);
        assert_eq!(
            pairs(
                unmatched,
                &[
                    input("in-3", "APC MINI", "3"),
                    input("in-4", "APC MINI", "4")
                ]
            ),
            vec![]
        );

        let virtual_pad = outputs(&["nightfall-virtual-controller:E2E Pad 129:0"]);
        assert_eq!(
            pairs(
                virtual_pad,
                &[input(
                    "128:0",
                    "nightfall-virtual-controller:E2E Pad",
                    "128"
                )]
            ),
            vec![(
                "nightfall-virtual-controller:E2E Pad 129:0",
                "128:0".to_string()
            )]
        );

        assert_eq!(
            pairs(outputs(&["E2E Pad"]), &[input("pad-2", "E2E Pad 2", "")]),
            vec![]
        );
    }

    /// Verifies input discovery recognizes the desk's own feedback ports and nothing else.
    #[test]
    fn own_feedback_ports_are_recognized() {
        assert!(is_own_feedback_port(
            "nightfall-feedback:nightfall-feedback 130:0"
        ));
        assert!(!is_own_feedback_port("nightfall-feedback-pad 20:0"));
        assert!(!is_own_feedback_port("APC MINI:APC MINI MIDI 1 20:0"));
    }

    /// Verifies a capturing client reports every port as connected and forwards messages.
    #[test]
    fn capturing_client_forwards_messages() {
        let (client, rx, _) = MidiOutputClient::capturing();

        assert!(client.has_output("Any"));
        assert!(client.send("Any", vec![0x90, 60, 127]));
        assert_eq!(
            rx.try_recv().expect("message should be captured"),
            MidiOutputMessage {
                port: "Any".to_string(),
                bytes: vec![0x90, 60, 127],
            }
        );
    }

    /// Verifies a client without a worker reports no outputs and refuses messages.
    #[test]
    fn client_without_worker_has_no_outputs() {
        let client = MidiOutputClient::default();

        assert!(!client.has_output("Any"));
        assert!(!client.send("Any", vec![0x90, 60, 127]));
        assert_eq!(client.generation(), 0);
    }
}
