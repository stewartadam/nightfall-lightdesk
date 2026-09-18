// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::net::SocketAddr;
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::Instant;

use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nightfall_engine::prelude::{
    DebugPanicTarget, is_process_shutdown_requested, maybe_trigger_debug_worker_panic,
};
use nightfall_io::prelude::{IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy};
use nightfall_service_host::prelude::{ModeWorkerSlot, process_singleton};
use socket2::{Domain, Protocol, Socket, Type};

/// Art-Net frame received by the process-lifetime listener.
#[derive(Debug, Clone)]
pub struct ArtNetInputFrame {
    /// Universe id.
    pub universe_id: u16,
    /// Art-Net sequence number.
    pub sequence: u8,
    /// DMX data payload.
    pub data: [u8; MAX_CHANNELS_PER_UNIVERSE],
    /// Source socket address.
    pub source_addr: SocketAddr,
    /// Timestamp when frame was received.
    pub received_at: Instant,
}

/// Art-Net input client used inside ECS worlds.
#[derive(Clone, Default)]
pub struct ArtNetInputClient {
    frame_tx: Arc<Mutex<Option<tokio::sync::broadcast::Sender<ArtNetInputFrame>>>>,
}

const BRIDGE_IDLE_SLEEP: Duration = Duration::from_millis(5);

/// Result of applying the requested Art-Net input listener binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NetworkInputBindStatus {
    /// Network input is disabled by settings.
    Disabled,
    /// The Art-Net listener is bound and forwarding frames.
    Listening,
    /// The Art-Net listener failed while binding or configuring its socket.
    Failed,
}

impl ArtNetInputClient {
    /// Subscribe to Art-Net frames.
    pub fn subscribe(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<ArtNetInputFrame>> {
        self.subscribe_with_bridge_done_signal(None)
    }

    fn subscribe_with_bridge_done_signal(
        &self,
        bridge_done_tx: Option<std::sync::mpsc::Sender<()>>,
    ) -> Option<tokio::sync::mpsc::UnboundedReceiver<ArtNetInputFrame>> {
        let frame_tx = self
            .frame_tx
            .lock()
            .ok()
            .and_then(|frame_tx| frame_tx.clone())?;
        let mut broadcast_rx = frame_tx.subscribe();
        let (frame_mpsc_tx, frame_mpsc_rx) = tokio::sync::mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("artnet-input-bridge".to_string())
            .spawn(move || {
                loop {
                    if frame_mpsc_tx.is_closed() {
                        break;
                    }
                    match broadcast_rx.try_recv() {
                        Ok(frame) => {
                            if frame_mpsc_tx.send(frame).is_err() {
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
            .expect("failed to spawn Art-Net input bridge thread");
        Some(frame_mpsc_rx)
    }

    #[cfg(test)]
    fn subscribe_with_exit_notifier(
        &self,
    ) -> Option<(
        tokio::sync::mpsc::UnboundedReceiver<ArtNetInputFrame>,
        std::sync::mpsc::Receiver<()>,
    )> {
        let (bridge_done_tx, bridge_done_rx) = std::sync::mpsc::channel();
        let frame_mpsc_rx = self.subscribe_with_bridge_done_signal(Some(bridge_done_tx))?;
        Some((frame_mpsc_rx, bridge_done_rx))
    }

    pub(crate) fn set_sender(
        &self,
        sender: Option<tokio::sync::broadcast::Sender<ArtNetInputFrame>>,
    ) {
        if let Ok(mut frame_tx) = self.frame_tx.lock() {
            *frame_tx = sender;
        }
    }
}

/// Background worker state for receiving and forwarding Art-Net packets.
pub(crate) struct ArtNetInputWorker {
    /// Broadcast sender for distributing received Art-Net frames to subscribers.
    pub(crate) frame_tx: tokio::sync::broadcast::Sender<ArtNetInputFrame>,
    stop_signal: Arc<AtomicBool>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl ArtNetInputWorker {
    pub(crate) fn spawn(binding: ArtNetInputBinding) -> Result<Option<Self>, ()> {
        if !binding.enabled {
            tracing::info!("Art-Net input is disabled by effective network input state");
            return Ok(None);
        }

        let Some(bind_ip) = binding.bind_ip else {
            tracing::warn!(
                interface_name = ?binding.interface_name,
                "Could not resolve configured network interface; Art-Net input disabled"
            );
            return Ok(None);
        };
        let bind_addr = SocketAddr::new(bind_ip.into(), 6454);

        let socket = match init_artnet_input_socket(bind_addr) {
            Ok(socket) => socket,
            Err(error) => {
                tracing::warn!(?error, "Could not bind Art-Net input socket");
                return Err(());
            }
        };
        if let Err(error) = socket.set_broadcast(true) {
            tracing::warn!(?error, "Could not enable broadcast on Art-Net input socket");
            return Err(());
        }
        if let Err(error) = socket.set_read_timeout(Some(Duration::from_millis(250))) {
            tracing::warn!(?error, "Could not set read timeout on Art-Net input socket");
            return Err(());
        }

        tracing::info!(?bind_addr, "Starting Art-Net input listener");

        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop_signal);
        let (frame_tx, _) = tokio::sync::broadcast::channel::<ArtNetInputFrame>(1024);
        let frame_tx_for_thread = frame_tx.clone();

        let join_handle = std::thread::Builder::new()
            .name("artnet-input-service".to_string())
            .spawn(move || {
                let mut buffer = [0u8; 1024];
                loop {
                    maybe_trigger_debug_worker_panic(DebugPanicTarget::InputArtnetListener);

                    if stop_for_thread.load(Ordering::Relaxed) || is_process_shutdown_requested() {
                        break;
                    }

                    let (len, source_addr) = match socket.recv_from(&mut buffer) {
                        Ok((len, source_addr)) => (len, source_addr),
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                || error.kind() == std::io::ErrorKind::TimedOut =>
                        {
                            continue;
                        }
                        Err(error) => {
                            tracing::warn!(?error, "Art-Net receive failed");
                            continue;
                        }
                    };

                    let Ok(command) = artnet_protocol::ArtCommand::from_buffer(&buffer[..len])
                    else {
                        continue;
                    };
                    let artnet_protocol::ArtCommand::Output(output) = command else {
                        continue;
                    };

                    let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
                    let payload = output.data.as_ref();
                    let copy_len = payload.len().min(MAX_CHANNELS_PER_UNIVERSE);
                    data[..copy_len].copy_from_slice(&payload[..copy_len]);

                    let _ = frame_tx_for_thread.send(ArtNetInputFrame {
                        universe_id: output.port_address.into(),
                        sequence: output.sequence,
                        data,
                        source_addr,
                        received_at: Instant::now(),
                    });
                }
                tracing::debug!("Art-Net input service worker exiting");
            })
            .expect("failed to spawn Art-Net input service worker");

        Ok(Some(Self {
            frame_tx,
            stop_signal,
            join_handle: Some(join_handle),
        }))
    }

    pub(crate) fn shutdown(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
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

fn init_artnet_input_socket(bind_addr: SocketAddr) -> std::io::Result<UdpSocket> {
    let domain = if bind_addr.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };
    let socket = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP))?;

    #[cfg(unix)]
    socket.set_reuse_port(true)?;

    socket.set_reuse_address(true)?;
    socket.bind(&bind_addr.into())?;

    Ok(socket.into())
}

/// Resolved Art-Net input endpoint that maps a universe range into fixture data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ArtNetInputBinding {
    enabled: bool,
    bind_ip: Option<Ipv4Addr>,
    interface_name: Option<String>,
}

impl ArtNetInputBinding {
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
        if !transport_policy.network_input_enabled(settings) {
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

/// Process-lifetime Art-Net input service host.
pub struct ArtNetInputService {
    slot: ModeWorkerSlot<ArtNetInputBinding, ArtNetInputWorker>,
    client: ArtNetInputClient,
}

impl ArtNetInputService {
    fn new() -> Self {
        Self {
            slot: ModeWorkerSlot::new(),
            client: ArtNetInputClient::default(),
        }
    }

    /// Configure whether Art-Net input is enabled and ensure the process-lifetime worker is bound.
    pub fn configure_network_input_enabled(&self, enabled: bool) -> NetworkInputBindStatus {
        self.configure_binding(ArtNetInputBinding::from_enabled(enabled))
    }

    /// Configures Art-Net input binding from IO settings and the current interface snapshot.
    pub fn sync_with_settings(
        &self,
        settings: &IoRuntimeSettings,
        interface_state: &NetworkInterfaceState,
        transport_policy: &TransportRuntimePolicy,
    ) -> NetworkInputBindStatus {
        self.configure_binding(ArtNetInputBinding::from_settings(
            settings,
            interface_state,
            transport_policy,
        ))
    }

    fn configure_binding(&self, binding: ArtNetInputBinding) -> NetworkInputBindStatus {
        let mut status = if binding.enabled {
            NetworkInputBindStatus::Failed
        } else {
            NetworkInputBindStatus::Disabled
        };
        let has_worker = self.slot.rebind(
            binding,
            |binding| match ArtNetInputWorker::spawn(binding) {
                Ok(worker) => {
                    status = if worker.is_some() {
                        NetworkInputBindStatus::Listening
                    } else {
                        NetworkInputBindStatus::Disabled
                    };
                    worker
                }
                Err(()) => {
                    status = NetworkInputBindStatus::Failed;
                    None
                }
            },
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        if has_worker {
            status = NetworkInputBindStatus::Listening;
        }
        let sender = self
            .slot
            .with_worker(|worker| worker.map(|worker| worker.frame_tx.clone()));
        self.client.set_sender(sender);
        status
    }

    /// Cloneable Art-Net input client for insertion into ECS worlds.
    pub fn client(&self) -> ArtNetInputClient {
        self.client.clone()
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_sender(None);
    }
}

impl Drop for ArtNetInputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide Art-Net input service.
pub fn process_artnet_input_service() -> &'static ArtNetInputService {
    static PROCESS_SERVICE: OnceLock<ArtNetInputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, ArtNetInputService::new)
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
    use std::time::Duration;

    use super::*;

    /// Returns whether the current host cannot route interface broadcast traffic.
    fn broadcast_route_unavailable(error: &io::Error) -> bool {
        matches!(
            error.kind(),
            io::ErrorKind::HostUnreachable | io::ErrorKind::NetworkUnreachable
        )
    }

    #[test]
    fn artnet_bridge_thread_exits_after_receiver_drop_on_repeated_subscriptions() {
        let client = ArtNetInputClient::default();
        let (frame_tx, _) = tokio::sync::broadcast::channel::<ArtNetInputFrame>(16);
        client.set_sender(Some(frame_tx));

        for _ in 0..64 {
            let (frame_rx, bridge_done_rx) = client
                .subscribe_with_exit_notifier()
                .expect("subscription should be created");
            drop(frame_rx);
            bridge_done_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("bridge thread should exit after receiver drop");
        }
    }

    #[test]
    fn artnet_input_socket_allows_rebinding_same_port() {
        let socket = init_artnet_input_socket(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 0))
            .expect("first Art-Net input socket should bind");
        let bind_addr = socket
            .local_addr()
            .expect("first Art-Net input socket should expose local address");

        let _second_socket = init_artnet_input_socket(bind_addr)
            .expect("second Art-Net input socket should rebind the same port");
    }

    #[cfg(unix)]
    #[test]
    fn artnet_input_shared_listeners_receive_broadcast_frames() {
        let receiver1 = init_artnet_input_socket(SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), 0))
            .expect("first Art-Net input socket should bind");
        receiver1
            .set_read_timeout(Some(Duration::from_millis(500)))
            .expect("first receiver should accept read timeout");
        let bind_addr = receiver1
            .local_addr()
            .expect("first Art-Net input socket should expose local address");

        let receiver2 =
            init_artnet_input_socket(bind_addr).expect("second Art-Net input socket should bind");
        receiver2
            .set_read_timeout(Some(Duration::from_millis(500)))
            .expect("second receiver should accept read timeout");

        let sender = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
            .expect("broadcast sender should bind an ephemeral socket");
        sender
            .set_broadcast(true)
            .expect("broadcast sender should enable broadcast");

        let payload = [0u8, 0, 0, 0];
        if let Err(error) = sender.send_to(
            &payload,
            SocketAddr::new(Ipv4Addr::BROADCAST.into(), bind_addr.port()),
        ) {
            if broadcast_route_unavailable(&error) {
                eprintln!("skipping broadcast listener assertion: {error}");
                return;
            }
            panic!("broadcast packet should send: {error}");
        }

        let mut buffer = [0u8; 32];
        let (len1, _) = receiver1
            .recv_from(&mut buffer)
            .expect("first listener should receive broadcast frame");
        assert_eq!(&buffer[..len1], &payload);

        let (len2, _) = receiver2
            .recv_from(&mut buffer)
            .expect("second listener should receive broadcast frame");
        assert_eq!(&buffer[..len2], &payload);
    }

    #[cfg(not(unix))]
    #[test]
    fn artnet_input_shared_listeners_receive_broadcast_frames() {}
}
