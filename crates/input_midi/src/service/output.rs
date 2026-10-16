// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI output ports paired with connected input devices, and the thread that writes to them.
//!
//! Feedback is addressed by the input device name a mapping stores, so each output port is
//! paired with the input port of the same device. Only outputs paired with a connected input
//! are opened: Windows grants output ports exclusively, so opening every port would take
//! synthesizers and other apps' ports away from them.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use super::{ConnectedMidiPort, MidiPortDescriptor, refresh_connections};

/// MIDI client and port name of the desk's feedback connections, which input discovery skips.
const FEEDBACK_CLIENT_NAME: &str = "nightfall-feedback";

/// One raw MIDI message to write to the output paired with an input device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MidiOutputMessage {
    /// Input device name the message is addressed to, as stored on mappings.
    pub device: String,
    /// Complete MIDI message, status byte first.
    pub bytes: Vec<u8>,
}

/// Output connections shared by the refreshing worker and the sender thread.
#[derive(Default)]
pub(crate) struct MidiOutputPorts {
    connections: Vec<ConnectedMidiPort<midir::MidiOutputConnection>>,
    /// Incremented whenever the set of open output connections changes.
    generation: u64,
}

impl MidiOutputPorts {
    /// Returns the open output paired with an input device, if any.
    fn paired_mut(
        &mut self,
        device: &str,
    ) -> Option<&mut ConnectedMidiPort<midir::MidiOutputConnection>> {
        let index = paired_index(device, self.connections.iter().map(|port| &*port.name))?;
        self.connections.get_mut(index)
    }

    /// Returns whether an output paired with the input device is open.
    fn has_paired(&self, device: &str) -> bool {
        paired_index(device, self.connections.iter().map(|port| &*port.name)).is_some()
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
    /// Every device counts as having an output, and messages go to a test receiver.
    #[cfg(test)]
    Capture {
        tx: Sender<MidiOutputMessage>,
        generation: Arc<std::sync::atomic::AtomicU64>,
    },
}

/// Cloneable handle that queues MIDI messages for the output paired with an input device.
///
/// Messages are written on a dedicated thread, so a slow device never stalls a frame.
#[derive(Clone, Default)]
pub struct MidiOutputClient {
    backend: Arc<Mutex<Option<OutputBackend>>>,
}

impl MidiOutputClient {
    /// Queues one message for the output paired with `device`.
    ///
    /// Returns `false` when no output worker is running; a device without an open output
    /// drops the message on the sender thread.
    pub fn send(&self, device: &str, bytes: Vec<u8>) -> bool {
        let Some(backend) = self.backend() else {
            return false;
        };
        let message = MidiOutputMessage {
            device: device.to_string(),
            bytes,
        };
        match backend {
            OutputBackend::Ports { tx, .. } => tx.send(message).is_ok(),
            #[cfg(test)]
            OutputBackend::Capture { tx, .. } => tx.send(message).is_ok(),
        }
    }

    /// Returns whether an output paired with the input device is open.
    pub fn has_output(&self, device: &str) -> bool {
        match self.backend() {
            Some(OutputBackend::Ports { ports, .. }) => {
                ports.lock().is_ok_and(|ports| ports.has_paired(device))
            }
            #[cfg(test)]
            Some(OutputBackend::Capture { .. }) => true,
            None => false,
        }
    }

    /// Returns a counter that changes whenever output ports open or close.
    ///
    /// A device that was unplugged and replugged between two device refreshes keeps its
    /// name, so callers compare this counter to know they must resend their full state.
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

    /// Opens outputs paired with `input_names` and closes the rest; returns whether the set
    /// of open outputs changed.
    pub(crate) fn refresh(&mut self, input_names: &[String]) -> bool {
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
        let paired = paired_ports(discover_output_ports(discovery), input_names);
        let Ok(mut ports) = self.ports.lock() else {
            return false;
        };
        let changed = refresh_connections(&mut ports.connections, paired, |port, name| {
            connect_output(&port, &name)
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

/// Writes queued messages to the output paired with each message's device until every
/// sender is dropped. Messages for devices without an open output are dropped.
fn write_messages(rx: &Receiver<MidiOutputMessage>, ports: &Mutex<MidiOutputPorts>) {
    while let Ok(message) = rx.recv() {
        let Ok(mut ports) = ports.lock() else {
            return;
        };
        let Some(port) = ports.paired_mut(&message.device) else {
            continue;
        };
        if let Err(error) = port.connection.send(&message.bytes) {
            tracing::debug!(device = %message.device, %error, "MIDI output send failed");
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

/// Keeps the discovered outputs whose device matches one of the connected inputs.
fn paired_ports<P>(
    outputs: Vec<MidiPortDescriptor<P>>,
    input_names: &[String],
) -> Vec<MidiPortDescriptor<P>> {
    let paired: std::collections::HashSet<usize> = input_names
        .iter()
        .filter_map(|input| paired_index(input, outputs.iter().map(|output| &*output.name)))
        .collect();
    outputs
        .into_iter()
        .enumerate()
        .filter_map(|(index, output)| paired.contains(&index).then_some(output))
        .collect()
}

/// Returns the index of the output port paired with an input port name.
///
/// An output of the same device and instance wins. Otherwise the only output of the same
/// device is used, which covers devices whose input and output get different instance
/// numbers; with several candidates and no instance match the input stays unpaired, so one
/// unit's feedback never lights another identical unit.
fn paired_index<'a>(input: &str, outputs: impl Iterator<Item = &'a str>) -> Option<usize> {
    let (device, instance) = pairing_key(input);
    let mut candidates = outputs
        .enumerate()
        .map(|(index, name)| (index, pairing_key(name)))
        .filter(|(_, (output_device, _))| *output_device == device)
        .collect::<Vec<_>>();
    if let Some(&(index, _)) = candidates
        .iter()
        .find(|(_, (_, output_instance))| *output_instance == instance)
    {
        return Some(index);
    }
    match candidates.len() {
        1 => candidates.pop().map(|(index, _)| index),
        _ => None,
    }
}

/// Opens one output connection, logging failures.
fn connect_output(
    port: &midir::MidiOutputPort,
    device_name: &str,
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
            tracing::error!("Failed to connect to MIDI output port '{device_name}': {error}");
            None
        }
    }
}

/// Reduces a port name to the device it belongs to and that device's instance, so an
/// input and output of one device compare equal while two identical devices stay apart.
///
/// - Windows numbers duplicate devices as `MIDIIN2 (APC MINI)` / `MIDIOUT2 (APC MINI)`; the
///   first unit's ports carry the plain name. The number is the instance.
/// - ALSA appends the `client:port` address, as in `APC MINI:APC MINI MIDI 1 20:0`. A
///   device's input and output share its client but can sit on different ports, so the
///   client number is the instance.
///
/// CoreMIDI names a device's source and destination identically, so they need no change.
fn pairing_key(name: &str) -> (&str, &str) {
    let name = name.trim();
    split_windows_wrapper(name)
        .or_else(|| split_alsa_address(name))
        .unwrap_or((name, ""))
}

/// Returns the device name and instance number inside a Windows `MIDIIN<n> (...)` or
/// `MIDIOUT<n> (...)` wrapper.
fn split_windows_wrapper(name: &str) -> Option<(&str, &str)> {
    let rest = name
        .strip_prefix("MIDIIN")
        .or_else(|| name.strip_prefix("MIDIOUT"))?;
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let (index, rest) = rest.split_at(digits);
    let device = rest.strip_prefix(" (")?.strip_suffix(')')?;
    Some((device, index))
}

/// Returns the name without a trailing ALSA ` <client>:<port>` address, plus the client.
fn split_alsa_address(name: &str) -> Option<(&str, &str)> {
    let (head, address) = name.rsplit_once(' ')?;
    let (client, port) = address.split_once(':')?;
    let numeric = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
    (numeric(client) && numeric(port)).then_some((head, client))
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

    /// Verifies port names reduce to their device and instance on each platform's naming
    /// scheme, while distinct devices stay distinct.
    #[test]
    fn pairing_key_splits_device_and_instance() {
        assert_eq!(pairing_key("APC mini mk2"), ("APC mini mk2", ""));
        assert_eq!(pairing_key("MIDIIN2 (APC MINI)"), ("APC MINI", "2"));
        assert_eq!(
            pairing_key("MIDIIN2 (APC MINI)"),
            pairing_key("MIDIOUT2 (APC MINI)")
        );
        assert_eq!(pairing_key("MIDIOUT (X-Touch)"), ("X-Touch", ""));
        assert_eq!(
            pairing_key("APC mini mk2:APC mini mk2 MIDI 1 20:0"),
            ("APC mini mk2:APC mini mk2 MIDI 1", "20")
        );
        assert_ne!(pairing_key("E2E Pad").0, pairing_key("E2E Pad 2").0);
        assert_eq!(pairing_key("Pad 1:2b"), ("Pad 1:2b", ""));
    }

    /// Verifies two identical units each pair with their own output, and a lone device
    /// pairs even when its input and output carry different instance numbers.
    #[test]
    fn paired_index_keeps_identical_units_apart() {
        let windows = ["MIDIOUT2 (APC MINI)", "APC MINI"];
        assert_eq!(paired_index("APC MINI", windows.into_iter()), Some(1));
        assert_eq!(
            paired_index("MIDIIN2 (APC MINI)", windows.into_iter()),
            Some(0)
        );
        assert_eq!(
            paired_index("MIDIIN3 (APC MINI)", windows.into_iter()),
            None
        );

        let alsa = [
            "APC MINI:APC MINI MIDI 1 24:0",
            "APC MINI:APC MINI MIDI 1 20:0",
        ];
        assert_eq!(
            paired_index("APC MINI:APC MINI MIDI 1 20:0", alsa.into_iter()),
            Some(1)
        );

        let virtual_pad = ["nightfall-virtual-controller:E2E Pad 129:0"];
        assert_eq!(
            paired_index(
                "nightfall-virtual-controller:E2E Pad 128:0",
                virtual_pad.into_iter()
            ),
            Some(0)
        );
        assert_eq!(paired_index("E2E Pad 2", ["E2E Pad"].into_iter()), None);
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

    /// Verifies only outputs whose device has a connected input are kept for opening.
    #[test]
    fn paired_ports_keeps_outputs_of_connected_inputs() {
        let outputs = [
            "MIDIOUT2 (APC MINI)",
            "Microsoft GS Wavetable Synth",
            "X-Touch",
        ]
        .into_iter()
        .map(|name| MidiPortDescriptor {
            port: name,
            id: name.to_string(),
            name: name.to_string(),
        })
        .collect();
        let inputs = vec!["MIDIIN2 (APC MINI)".to_string(), "X-Touch".to_string()];

        let paired: Vec<_> = paired_ports(outputs, &inputs)
            .into_iter()
            .map(|output| output.port)
            .collect();

        assert_eq!(paired, vec!["MIDIOUT2 (APC MINI)", "X-Touch"]);
    }

    /// Verifies a capturing client reports every device as connected and forwards messages.
    #[test]
    fn capturing_client_forwards_messages() {
        let (client, rx, _) = MidiOutputClient::capturing();

        assert!(client.has_output("Any"));
        assert!(client.send("Any", vec![0x90, 60, 127]));
        assert_eq!(
            rx.try_recv().expect("message should be captured"),
            MidiOutputMessage {
                device: "Any".to_string(),
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
