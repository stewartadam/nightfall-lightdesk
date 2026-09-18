// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::net::{Ipv4Addr, SocketAddr};
use std::net::{SocketAddrV4, UdpSocket};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bevy_ecs::prelude::Resource;
use nightfall_io::prelude::{IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy};
use nightfall_service_host::prelude::{ModeWorkerSlot, process_singleton};

/// Default frame interval (~44 FPS) matching DMX512 timing for 512 channels.
pub const DEFAULT_ARTNET_FRAME_INTERVAL: Duration = Duration::from_millis(23);
const ARTNET_PORT: u16 = 6454;

/// Metadata returned when an Art-Net frame is sent.
#[derive(Debug, Clone, Copy)]
pub struct ArtNetSendMeta {
    /// Art-Net sequence number for the sent frame.
    pub sequence: u8,
    /// Local source socket address used for the frame.
    pub local_source_addr: Option<SocketAddr>,
}

/// Error returned when Art-Net output cannot send a frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtNetSendError {
    /// Output service is not configured or unavailable.
    Unavailable,
    /// Socket address became unavailable and output was disabled.
    AddrNotAvailable,
    /// Frame send failed for another I/O reason.
    Failed {
        /// I/O error kind reported by the OS.
        kind: std::io::ErrorKind,
        /// Human-readable I/O error message.
        message: String,
    },
}

/// Art-Net output client used inside ECS worlds.
#[derive(Clone, Default, Resource)]
pub struct ArtNetOutputClient {
    command_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<ArtNetWorkerCommand>>>>,
}

impl ArtNetOutputClient {
    /// Send one Art-Net DMX frame.
    pub fn send_frame(
        &self,
        universe: u16,
        data: &[u8],
        unicast_ip: Option<Ipv4Addr>,
    ) -> Result<ArtNetSendMeta, ArtNetSendError> {
        {
            let maybe_sender = self
                .command_tx
                .lock()
                .ok()
                .and_then(|sender| sender.clone());
            let Some(command_tx) = maybe_sender else {
                return Err(ArtNetSendError::Unavailable);
            };

            let (response_tx, response_rx) = std::sync::mpsc::channel();
            if command_tx
                .send(ArtNetWorkerCommand::SendFrame {
                    universe,
                    data: data.to_vec(),
                    unicast_ip,
                    response_tx,
                })
                .is_err()
            {
                return Err(ArtNetSendError::Unavailable);
            }

            response_rx
                .recv_timeout(Duration::from_millis(250))
                .unwrap_or(Err(ArtNetSendError::Unavailable))
        }
    }

    /// Return whether the Art-Net service currently has a sender connected.
    pub fn is_available(&self) -> bool {
        {
            self.command_tx
                .lock()
                .ok()
                .is_some_and(|sender| sender.is_some())
        }
    }

    pub(crate) fn set_sender(
        &self,
        sender: Option<tokio::sync::mpsc::UnboundedSender<ArtNetWorkerCommand>>,
    ) {
        if let Ok(mut command_tx) = self.command_tx.lock() {
            *command_tx = sender;
        }
    }
}

/// Commands handled by the Art-Net output worker thread.
pub(crate) enum ArtNetWorkerCommand {
    SendFrame {
        universe: u16,
        data: Vec<u8>,
        unicast_ip: Option<Ipv4Addr>,
        response_tx: std::sync::mpsc::Sender<Result<ArtNetSendMeta, ArtNetSendError>>,
    },
    Shutdown,
}

/// Background worker state for batching and sending Art-Net frames.
pub(crate) struct ArtNetWorker {
    /// Command sender used to submit frame-send requests to the worker thread.
    pub(crate) command_tx: tokio::sync::mpsc::UnboundedSender<ArtNetWorkerCommand>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl ArtNetWorker {
    pub(crate) fn spawn(binding: ArtNetOutputBinding) -> Option<Self> {
        let mut socket = init_socket(binding)?;
        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let join_handle = std::thread::Builder::new()
            .name("artnet-output-service".to_string())
            .spawn(move || {
                while let Some(command) = command_rx.blocking_recv() {
                    match command {
                        ArtNetWorkerCommand::SendFrame {
                            universe,
                            data,
                            unicast_ip,
                            response_tx,
                        } => match socket.send_frame(universe, &data, unicast_ip) {
                            Ok(sequence) => {
                                let _ = response_tx.send(Ok(ArtNetSendMeta {
                                    sequence,
                                    local_source_addr: socket.local_addr(),
                                }));
                            }
                            Err(error)
                                if error.kind() == std::io::ErrorKind::AddrNotAvailable =>
                            {
                                let _ = response_tx.send(Err(ArtNetSendError::AddrNotAvailable));
                                tracing::warn!(
                                    ?error,
                                    "Address not available for Art-Net socket; disabling Art-Net output"
                                );
                                break;
                            }
                            Err(error) => {
                                tracing::trace!(?error, "Sending Art-Net universe data failed");
                                let _ = response_tx.send(Err(ArtNetSendError::Failed {
                                    kind: error.kind(),
                                    message: error.to_string(),
                                }));
                            }
                        },
                        ArtNetWorkerCommand::Shutdown => break,
                    }
                }
                tracing::debug!("Art-Net output service worker exiting");
            })
            .expect("failed to spawn Art-Net output service worker");

        Some(Self {
            command_tx,
            join_handle: Some(join_handle),
        })
    }

    pub(crate) fn shutdown(&mut self) {
        let _ = self.command_tx.send(ArtNetWorkerCommand::Shutdown);
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.join_handle
            .as_ref()
            .is_some_and(|join_handle| !join_handle.is_finished())
    }
}

/// UDP socket and broadcast target used by the Art-Net output worker.
struct ArtNetSocket {
    socket: UdpSocket,
    broadcast_dest: SocketAddrV4,
    sequence: u8,
}

impl ArtNetSocket {
    fn new(socket: UdpSocket) -> Self {
        Self {
            socket,
            broadcast_dest: SocketAddrV4::new(Ipv4Addr::BROADCAST, ARTNET_PORT),
            sequence: 0,
        }
    }

    fn send_frame(
        &mut self,
        universe: u16,
        data: &[u8],
        unicast_ip: Option<Ipv4Addr>,
    ) -> Result<u8, std::io::Error> {
        let port_address = artnet_protocol::PortAddress::try_from(universe)
            .unwrap_or_else(|_| artnet_protocol::PortAddress::try_from(0u16).unwrap());

        self.sequence = self.sequence.wrapping_add(1).max(1);
        let output = artnet_protocol::Output {
            sequence: self.sequence,
            port_address,
            data: data.to_vec().into(),
            ..artnet_protocol::Output::default()
        };

        let command = artnet_protocol::ArtCommand::Output(output);
        let bytes = command
            .write_to_buffer()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;

        let destination = match unicast_ip {
            Some(ip) => SocketAddrV4::new(ip, ARTNET_PORT),
            None => self.broadcast_dest,
        };

        self.socket.send_to(&bytes, destination)?;
        Ok(self.sequence)
    }

    fn local_addr(&self) -> Option<SocketAddr> {
        self.socket.local_addr().ok()
    }
}

/// Resolved Art-Net output endpoint used to route console universe data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ArtNetOutputBinding {
    enabled: bool,
    bind_ip: Option<Ipv4Addr>,
    interface_name: Option<String>,
}

impl ArtNetOutputBinding {
    fn from_enabled(enabled: bool) -> Self {
        if !enabled {
            return Self {
                enabled,
                bind_ip: None,
                interface_name: None,
            };
        }

        let interface = nightfall_io::get_default_interface();
        let bind_ip = interface
            .as_ref()
            .and_then(|iface| iface.addresses.first())
            .and_then(|address| address.parse().ok());
        let interface_name = interface.map(|iface| iface.name);
        Self {
            enabled,
            bind_ip,
            interface_name,
        }
    }

    fn from_settings(
        settings: &IoRuntimeSettings,
        interface_state: &NetworkInterfaceState,
        transport_policy: &TransportRuntimePolicy,
    ) -> Self {
        if !transport_policy.network_output_enabled(settings) {
            return Self {
                enabled: false,
                bind_ip: None,
                interface_name: None,
            };
        }

        let interface =
            nightfall_io::resolve_configured_network_interface(settings, interface_state);
        let bind_ip = interface
            .as_ref()
            .and_then(|iface| iface.addresses.first())
            .and_then(|address| address.parse().ok());
        let interface_name = interface
            .as_ref()
            .map(|iface| iface.name.clone())
            .or_else(|| settings.network_interface.clone());
        Self {
            enabled: true,
            bind_ip,
            interface_name,
        }
    }
}

/// Initialize an Art-Net UDP socket according to the configured network output mode.
fn init_socket(binding: ArtNetOutputBinding) -> Option<ArtNetSocket> {
    if !binding.enabled {
        tracing::info!("Art-Net output is disabled by effective network output state");
        return None;
    }

    let Some(bind_ip) = binding.bind_ip else {
        tracing::warn!(
            interface_name = ?binding.interface_name,
            "Could not resolve configured network interface; Art-Net output disabled"
        );
        return None;
    };
    let bind_addr = SocketAddr::new(bind_ip.into(), 0);

    let socket = match UdpSocket::bind(bind_addr) {
        Ok(socket) => socket,
        Err(error) => {
            tracing::warn!(
                ?error,
                interface_name = ?binding.interface_name,
                bind_ip = %bind_ip,
                "Could not bind Art-Net socket; Art-Net output disabled"
            );
            return None;
        }
    };

    if let Err(error) = socket.set_broadcast(true) {
        tracing::warn!(
            ?error,
            "Could not enable broadcast on Art-Net socket; Art-Net output disabled"
        );
        return None;
    }

    tracing::info!(
        interface_name = ?binding.interface_name,
        bind_ip = %bind_ip,
        "Starting Art-Net output"
    );

    Some(ArtNetSocket::new(socket))
}

/// Process-lifetime Art-Net output service host.
pub struct ArtNetOutputService {
    slot: ModeWorkerSlot<ArtNetOutputBinding, ArtNetWorker>,
    client: ArtNetOutputClient,
}

impl ArtNetOutputService {
    fn new() -> Self {
        Self {
            slot: ModeWorkerSlot::new(),
            client: ArtNetOutputClient::default(),
        }
    }

    /// Configure whether Art-Net output is enabled and ensure the process-lifetime worker is bound.
    pub fn configure_network_output_enabled(&self, enabled: bool) -> bool {
        self.configure_binding(ArtNetOutputBinding::from_enabled(enabled))
    }

    /// Configures Art-Net output binding from IO settings and the current interface snapshot.
    pub fn sync_with_settings(
        &self,
        settings: &IoRuntimeSettings,
        interface_state: &NetworkInterfaceState,
        transport_policy: &TransportRuntimePolicy,
    ) -> bool {
        self.configure_binding(ArtNetOutputBinding::from_settings(
            settings,
            interface_state,
            transport_policy,
        ))
    }

    fn configure_binding(&self, binding: ArtNetOutputBinding) -> bool {
        let has_worker = self.slot.rebind(
            binding,
            ArtNetWorker::spawn,
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        let sender = self
            .slot
            .with_worker(|worker| worker.map(|worker| worker.command_tx.clone()));
        self.client.set_sender(sender);
        has_worker
    }

    /// Cloneable Art-Net client for insertion into ECS worlds.
    pub fn client(&self) -> ArtNetOutputClient {
        self.client.clone()
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_sender(None);
    }
}

impl Drop for ArtNetOutputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide Art-Net output service.
pub fn process_artnet_output_service() -> &'static ArtNetOutputService {
    static PROCESS_SERVICE: OnceLock<ArtNetOutputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, ArtNetOutputService::new)
}
