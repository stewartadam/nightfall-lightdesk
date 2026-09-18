// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use nightfall_service_host::prelude::{WorkerSlot, process_singleton};

/// Raw MIDI event emitted by the process-lifetime MIDI service.
#[derive(Debug, Clone)]
pub struct MidiInputEvent {
    /// Device name that generated the event.
    pub device: String,
    /// MIDI status byte (channel + message type).
    pub channel: u8,
    /// Note or control number.
    pub note: u8,
    /// Velocity or control value.
    pub velocity: u8,
}

/// MIDI input client used inside ECS worlds.
#[derive(Clone, Default)]
pub struct MidiInputClient {
    event_tx: Arc<Mutex<Option<tokio::sync::broadcast::Sender<MidiInputEvent>>>>,
    device_names: Arc<Mutex<Vec<String>>>,
}

const BRIDGE_IDLE_SLEEP: Duration = Duration::from_millis(5);

impl MidiInputClient {
    /// Subscribe to MIDI input events.
    pub fn subscribe(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<MidiInputEvent>> {
        self.subscribe_with_bridge_done_signal(None)
    }

    fn subscribe_with_bridge_done_signal(
        &self,
        bridge_done_tx: Option<std::sync::mpsc::Sender<()>>,
    ) -> Option<tokio::sync::mpsc::UnboundedReceiver<MidiInputEvent>> {
        let event_tx = self
            .event_tx
            .lock()
            .ok()
            .and_then(|event_tx| event_tx.clone())?;
        let mut broadcast_rx = event_tx.subscribe();
        let (event_mpsc_tx, event_mpsc_rx) = tokio::sync::mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("midi-input-bridge".to_string())
            .spawn(move || {
                loop {
                    if event_mpsc_tx.is_closed() {
                        break;
                    }
                    match broadcast_rx.try_recv() {
                        Ok(event) => {
                            if event_mpsc_tx.send(event).is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                            std::thread::sleep(BRIDGE_IDLE_SLEEP);
                        }
                    }
                }
                if let Some(bridge_done_tx) = bridge_done_tx {
                    let _ = bridge_done_tx.send(());
                }
            })
            .expect("failed to spawn MIDI input bridge thread");
        Some(event_mpsc_rx)
    }

    #[cfg(test)]
    fn subscribe_with_exit_notifier(
        &self,
    ) -> Option<(
        tokio::sync::mpsc::UnboundedReceiver<MidiInputEvent>,
        std::sync::mpsc::Receiver<()>,
    )> {
        let (bridge_done_tx, bridge_done_rx) = std::sync::mpsc::channel();
        let event_mpsc_rx = self.subscribe_with_bridge_done_signal(Some(bridge_done_tx))?;
        Some((event_mpsc_rx, bridge_done_rx))
    }

    /// Return currently connected MIDI device names.
    pub fn device_names(&self) -> Vec<String> {
        self.device_names
            .lock()
            .map(|devices| devices.clone())
            .unwrap_or_default()
    }

    pub(crate) fn set_state(
        &self,
        event_tx: Option<tokio::sync::broadcast::Sender<MidiInputEvent>>,
        device_names: Vec<String>,
    ) {
        if let Ok(mut sender_slot) = self.event_tx.lock() {
            *sender_slot = event_tx;
        }
        if let Ok(mut devices) = self.device_names.lock() {
            *devices = device_names;
        }
    }
}

/// MIDI input port identity shown to users and used for connection matching.
struct MidiPortDescriptor<P> {
    port: P,
    id: String,
    name: String,
}

type MidiDeviceInfo = MidiPortDescriptor<midir::MidiInputPort>;

/// Live MIDI connection state keyed by stable device id.
///
/// The generic connection type keeps refresh logic testable without opening real MIDI ports.
struct ConnectedMidiInput<C> {
    id: String,
    name: String,
    _connection: C,
}

impl<C> ConnectedMidiInput<C> {
    fn new(id: String, name: String, connection: C) -> Self {
        Self {
            id,
            name,
            _connection: connection,
        }
    }
}

/// Refresh-driven MIDI worker state.
///
/// This worker does not own a dedicated listener thread; callers drive discovery by invoking
/// `refresh`, which reconciles the current connection set against the latest discovery snapshot.
pub(crate) struct MidiInputWorker {
    /// Broadcast sender for distributing MIDI events into ECS subscribers.
    pub(crate) event_tx: tokio::sync::broadcast::Sender<MidiInputEvent>,
    /// Device names connected when this worker was initialized.
    pub(crate) device_names: Vec<String>,
    discovery_input: Option<midir::MidiInput>,
    topology_change_rx: Option<std::sync::mpsc::Receiver<()>>,
    last_discovery_error: Option<String>,
    connections: Vec<ConnectedMidiInput<midir::MidiInputConnection<()>>>,
}

impl MidiInputWorker {
    pub(crate) fn spawn() -> Option<Self> {
        let (event_tx, _) = tokio::sync::broadcast::channel(1024);
        let mut worker = Self {
            event_tx,
            device_names: Vec::new(),
            discovery_input: None,
            topology_change_rx: nightfall_coremidi_hotplug::spawn_device_update_listener(),
            last_discovery_error: None,
            connections: Vec::new(),
        };
        worker.refresh();
        tracing::info!("Connected to {} MIDI device(s)", worker.connections.len());
        Some(worker)
    }

    pub(crate) fn shutdown(&mut self) {
        self.connections.clear();
    }

    pub(crate) fn is_alive(&self) -> bool {
        true
    }

    pub(crate) fn refresh(&mut self) -> bool {
        if topology_changed(&self.topology_change_rx) {
            self.discovery_input = None;
        }

        if self.discovery_input.is_none() {
            match create_discovery_input() {
                Ok(midi_input) => {
                    self.discovery_input = Some(midi_input);
                    if let Some(previous_error) = self.last_discovery_error.take() {
                        tracing::info!("MIDI discovery recovered after error: {}", previous_error);
                    }
                }
                Err(error) => {
                    if self.last_discovery_error.as_deref() != Some(error.as_str()) {
                        tracing::error!("Failed to create MIDI input for discovery: {}", error);
                        self.last_discovery_error = Some(error);
                    }

                    let had_devices = !self.device_names.is_empty() || !self.connections.is_empty();
                    self.shutdown();
                    self.device_names.clear();
                    return had_devices;
                }
            }
        } else if let Some(previous_error) = self.last_discovery_error.take() {
            tracing::info!("MIDI discovery recovered after error: {}", previous_error);
        }

        let discovered_ports = self
            .discovery_input
            .as_ref()
            .map(discover_ports)
            .unwrap_or_default();
        let event_tx = self.event_tx.clone();
        let changed = refresh_connections(&mut self.connections, discovered_ports, |port, name| {
            connect_to_port(&port, name, &event_tx)
        });
        let device_names = connected_device_names(&self.connections);
        if self.device_names != device_names {
            tracing::info!(
                previous_devices = ?self.device_names,
                current_devices = ?device_names,
                "MIDI device list changed"
            );
            self.device_names = device_names;
            return true;
        }
        changed
    }
}

/// Enumerate available MIDI input ports with user-facing port names.
fn create_discovery_input() -> Result<midir::MidiInput, String> {
    midir::MidiInput::new("nightfall-discovery").map_err(|error| error.to_string())
}

fn topology_changed(topology_change_rx: &Option<std::sync::mpsc::Receiver<()>>) -> bool {
    topology_change_rx.as_ref().is_some_and(|receiver| {
        let mut changed = false;
        while receiver.try_recv().is_ok() {
            changed = true;
        }
        changed
    })
}

fn discover_ports(midi_in: &midir::MidiInput) -> Vec<MidiDeviceInfo> {
    midi_in
        .ports()
        .into_iter()
        .filter_map(|port| {
            let id = port.id();
            midi_in
                .port_name(&port)
                .ok()
                .map(|name| MidiDeviceInfo { port, id, name })
        })
        .collect()
}

/// Reconcile the retained connection set against the latest discovered ports.
///
/// Connections stay in a `Vec` so the worker can preserve discovery order and duplicate device
/// names while still keying reconciliation by the stable port id.
fn refresh_connections<P, C>(
    connections: &mut Vec<ConnectedMidiInput<C>>,
    discovered_ports: Vec<MidiPortDescriptor<P>>,
    mut connect: impl FnMut(P, String) -> Option<C>,
) -> bool {
    let discovered_order: HashMap<String, usize> = discovered_ports
        .iter()
        .enumerate()
        .map(|(index, device)| (device.id.clone(), index))
        .collect();
    let discovered_ids: HashSet<&str> = discovered_ports
        .iter()
        .map(|device| device.id.as_str())
        .collect();

    let previous_connection_count = connections.len();
    connections.retain(|connection| discovered_ids.contains(connection.id.as_str()));

    let mut existing_ids: HashSet<String> = connections
        .iter()
        .map(|connection| connection.id.clone())
        .collect();
    let mut added_connection = false;

    for device in discovered_ports {
        if existing_ids.contains(device.id.as_str()) {
            continue;
        }

        let device_id = device.id;
        let device_name = device.name;
        if let Some(connection) = connect(device.port, device_name.clone()) {
            connections.push(ConnectedMidiInput::new(
                device_id.clone(),
                device_name,
                connection,
            ));
            existing_ids.insert(device_id);
            added_connection = true;
        }
    }

    connections.sort_by_key(|connection| {
        discovered_order
            .get(connection.id.as_str())
            .copied()
            .unwrap_or(usize::MAX)
    });

    previous_connection_count != connections.len() || added_connection
}

fn connected_device_names<C>(connections: &[ConnectedMidiInput<C>]) -> Vec<String> {
    connections
        .iter()
        .map(|connection| connection.name.clone())
        .collect()
}

/// Open one MIDI input connection and forward incoming messages onto `event_tx`.
fn connect_to_port(
    port: &midir::MidiInputPort,
    device_name: String,
    event_tx: &tokio::sync::broadcast::Sender<MidiInputEvent>,
) -> Option<midir::MidiInputConnection<()>> {
    let mut midi_in = match midir::MidiInput::new("nightfall") {
        Ok(midi_in) => midi_in,
        Err(error) => {
            tracing::error!("Failed to create MIDI input: {}", error);
            return None;
        }
    };
    midi_in.ignore(midir::Ignore::None);

    let device_name_for_callback = device_name.clone();
    let event_tx = event_tx.clone();
    let connection = midi_in.connect(
        port,
        "nightfall-input",
        move |_timestamp, message, _| {
            if message.len() >= 3 {
                let _ = event_tx.send(MidiInputEvent {
                    device: device_name_for_callback.clone(),
                    channel: message[0],
                    note: message[1],
                    velocity: message[2],
                });
            } else if message.len() >= 2 {
                let _ = event_tx.send(MidiInputEvent {
                    device: device_name_for_callback.clone(),
                    channel: message[0],
                    note: message[1],
                    velocity: 0,
                });
            }
        },
        (),
    );

    match connection {
        Ok(connection) => Some(connection),
        Err(error) => {
            tracing::error!(
                "Failed to connect to MIDI port '{}': {}",
                device_name,
                error
            );
            None
        }
    }
}

/// Process-lifetime MIDI input service host.
pub struct MidiInputService {
    slot: WorkerSlot<MidiInputWorker>,
    client: MidiInputClient,
}

impl MidiInputService {
    fn new() -> Self {
        Self {
            slot: WorkerSlot::new(),
            client: MidiInputClient::default(),
        }
    }

    /// Ensure a process-lifetime MIDI worker is running.
    pub fn ensure_started(&self) -> bool {
        let has_worker = self.slot.ensure(
            MidiInputWorker::spawn,
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        let (sender, devices) = self.slot.with_worker(|worker| {
            if let Some(worker) = worker {
                (Some(worker.event_tx.clone()), worker.device_names.clone())
            } else {
                (None, Vec::new())
            }
        });
        self.client.set_state(sender, devices);
        has_worker
    }

    /// Cloneable MIDI input client for insertion into ECS worlds.
    pub fn client(&self) -> MidiInputClient {
        self.client.clone()
    }

    /// Refresh connected devices for the running worker and publish updated state.
    pub fn refresh(&self) -> bool {
        let has_worker = self.ensure_started();
        if !has_worker {
            self.client.set_state(None, Vec::new());
            return false;
        }

        let (sender, devices, changed) = self.slot.with_worker(|worker| {
            let worker = worker.expect("MIDI worker should be present after ensure_started");
            let changed = worker.refresh();
            (
                Some(worker.event_tx.clone()),
                worker.device_names.clone(),
                changed,
            )
        });
        self.client.set_state(sender, devices);
        changed
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_state(None, Vec::new());
    }
}

impl Drop for MidiInputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide MIDI input service.
pub fn process_midi_input_service() -> &'static MidiInputService {
    static PROCESS_SERVICE: OnceLock<MidiInputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, MidiInputService::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test MIDI connection handle that records whether it has been closed.
    #[derive(Debug, PartialEq, Eq)]
    struct TestConnection(&'static str);

    #[test]
    fn midi_bridge_thread_exits_after_receiver_drop_on_repeated_subscriptions() {
        let client = MidiInputClient::default();
        let (event_tx, _) = tokio::sync::broadcast::channel::<MidiInputEvent>(16);
        client.set_state(Some(event_tx), Vec::new());

        for _ in 0..64 {
            let (event_rx, bridge_done_rx) = client
                .subscribe_with_exit_notifier()
                .expect("subscription should be created");
            drop(event_rx);
            bridge_done_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("bridge thread should exit after receiver drop");
        }
    }

    #[test]
    fn refresh_connections_adds_and_removes_devices() {
        let mut connections = vec![
            ConnectedMidiInput::new(
                "port-a".to_string(),
                "controller-a".to_string(),
                TestConnection("existing"),
            ),
            ConnectedMidiInput::new(
                "stale-port".to_string(),
                "stale-device".to_string(),
                TestConnection("stale"),
            ),
        ];

        let changed = refresh_connections(
            &mut connections,
            vec![
                MidiPortDescriptor {
                    port: "port-a",
                    id: "port-a".to_string(),
                    name: "controller-a".to_string(),
                },
                MidiPortDescriptor {
                    port: "port-b",
                    id: "port-b".to_string(),
                    name: "controller-b".to_string(),
                },
            ],
            |port, _name| Some(TestConnection(port)),
        );

        assert!(changed);
        assert_eq!(
            connected_device_names(&connections),
            vec!["controller-a", "controller-b"]
        );
        assert_eq!(connections[0]._connection, TestConnection("existing"));
        assert_eq!(connections[1]._connection, TestConnection("port-b"));
    }

    #[test]
    fn refresh_connections_skips_reconnecting_existing_devices() {
        let mut connections = vec![ConnectedMidiInput::new(
            "port-a".to_string(),
            "controller-a".to_string(),
            TestConnection("existing"),
        )];
        let mut connection_attempts = 0;

        let changed = refresh_connections(
            &mut connections,
            vec![MidiPortDescriptor {
                port: "port-a",
                id: "port-a".to_string(),
                name: "controller-a".to_string(),
            }],
            |_port, _name| {
                connection_attempts += 1;
                Some(TestConnection("new"))
            },
        );

        assert!(!changed);
        assert_eq!(connection_attempts, 0);
        assert_eq!(connections[0]._connection, TestConnection("existing"));
    }

    #[test]
    fn refresh_connections_keeps_distinct_ports_with_same_name() {
        let mut connections = vec![ConnectedMidiInput::new(
            "port-a".to_string(),
            "controller".to_string(),
            TestConnection("existing-a"),
        )];

        let changed = refresh_connections(
            &mut connections,
            vec![
                MidiPortDescriptor {
                    port: "port-a",
                    id: "port-a".to_string(),
                    name: "controller".to_string(),
                },
                MidiPortDescriptor {
                    port: "port-b",
                    id: "port-b".to_string(),
                    name: "controller".to_string(),
                },
            ],
            |port, _name| Some(TestConnection(port)),
        );

        assert!(changed);
        assert_eq!(
            connected_device_names(&connections),
            vec!["controller", "controller"]
        );
        assert_eq!(connections[0]._connection, TestConnection("existing-a"));
        assert_eq!(connections[1]._connection, TestConnection("port-b"));
    }

    #[test]
    fn refresh_connections_replaces_stale_port_when_name_is_reused() {
        let mut connections = vec![ConnectedMidiInput::new(
            "stale-port".to_string(),
            "controller".to_string(),
            TestConnection("stale"),
        )];
        let mut connection_attempts = 0;

        let changed = refresh_connections(
            &mut connections,
            vec![MidiPortDescriptor {
                port: "fresh-port",
                id: "fresh-port".to_string(),
                name: "controller".to_string(),
            }],
            |port, _name| {
                connection_attempts += 1;
                Some(TestConnection(port))
            },
        );

        assert!(changed);
        assert_eq!(connection_attempts, 1);
        assert_eq!(connected_device_names(&connections), vec!["controller"]);
        assert_eq!(connections[0].id, "fresh-port");
        assert_eq!(connections[0]._connection, TestConnection("fresh-port"));
    }
}
