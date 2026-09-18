// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
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
use sacn::error::errors::SacnError;
use tokio::sync::{
    broadcast::{self, Sender as BroadcastSender},
    mpsc::{self, UnboundedReceiver},
};

/// sACN frame received by the process-lifetime listener.
#[derive(Debug, Clone)]
pub struct SacnInputFrame {
    /// Universe id.
    pub universe_id: u16,
    /// DMX data payload.
    pub data: [u8; MAX_CHANNELS_PER_UNIVERSE],
    /// Source CID of sender.
    pub source_cid: Option<[u8; 16]>,
    /// Timestamp when frame was received.
    pub received_at: Instant,
}

/// sACN input client used inside ECS worlds.
///
/// The process-lifetime worker fan-outs frames over a `broadcast` channel.
/// Each world subscription gets its own `mpsc` receiver bridged from that
/// broadcast stream so ECS systems can poll with `try_recv()` without requiring
/// async runtime integration in system code.
#[derive(Clone, Default)]
pub struct SacnInputClient {
    frame_tx: Arc<Mutex<Option<BroadcastSender<SacnInputFrame>>>>,
}

const BRIDGE_IDLE_SLEEP: Duration = Duration::from_millis(5);

/// Result of applying the requested sACN input listener binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NetworkInputBindStatus {
    /// Network input is disabled by settings.
    Disabled,
    /// The sACN listener is bound and forwarding frames.
    Listening,
    /// The sACN listener failed while binding or configuring its receiver.
    Failed,
}

impl SacnInputClient {
    /// Subscribe to sACN frames as a per-subscriber `mpsc` stream.
    ///
    /// Internally this creates a broadcast receiver and a lightweight bridge thread
    /// that forwards frames into an unbounded `mpsc` queue. This isolates subscriber
    /// lifetime from the process worker and keeps Bevy-side consumption non-blocking.
    /// Lagged broadcast frames are dropped to prioritize latest DMX state.
    pub fn subscribe(&self) -> Option<UnboundedReceiver<SacnInputFrame>> {
        self.subscribe_with_bridge_done_signal(None)
    }

    fn subscribe_with_bridge_done_signal(
        &self,
        bridge_done_tx: Option<std::sync::mpsc::Sender<()>>,
    ) -> Option<UnboundedReceiver<SacnInputFrame>> {
        let frame_tx = self
            .frame_tx
            .lock()
            .ok()
            .and_then(|frame_tx| frame_tx.clone())?;
        let mut broadcast_rx = frame_tx.subscribe();
        let (frame_mpsc_tx, frame_mpsc_rx) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("sacn-input-bridge".to_string())
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
            .expect("failed to spawn sACN input bridge thread");
        Some(frame_mpsc_rx)
    }

    #[cfg(test)]
    fn subscribe_with_exit_notifier(
        &self,
    ) -> Option<(
        UnboundedReceiver<SacnInputFrame>,
        std::sync::mpsc::Receiver<()>,
    )> {
        let (bridge_done_tx, bridge_done_rx) = std::sync::mpsc::channel();
        let frame_mpsc_rx = self.subscribe_with_bridge_done_signal(Some(bridge_done_tx))?;
        Some((frame_mpsc_rx, bridge_done_rx))
    }

    pub(crate) fn set_sender(&self, sender: Option<BroadcastSender<SacnInputFrame>>) {
        if let Ok(mut frame_tx) = self.frame_tx.lock() {
            *frame_tx = sender;
        }
    }
}

const DEFAULT_UNIVERSE_MAX: u16 = 512;

/// Background worker state for receiving and forwarding sACN packets.
pub(crate) struct SacnInputWorker {
    /// Broadcast sender for distributing received sACN frames to subscribers.
    pub(crate) frame_tx: BroadcastSender<SacnInputFrame>,
    stop_signal: Arc<AtomicBool>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl SacnInputWorker {
    pub(crate) fn spawn(binding: SacnInputBinding) -> Result<Option<Self>, ()> {
        if !binding.enabled {
            tracing::info!("sACN input is disabled by effective network input state");
            return Ok(None);
        }

        let Some(bind_ip) = binding.bind_ip else {
            tracing::warn!(
                interface_name = ?binding.interface_name,
                "Could not resolve configured network interface; sACN input disabled"
            );
            return Ok(None);
        };

        let bind_addr = SocketAddr::new(IpAddr::V4(bind_ip), sacn::packet::ACN_SDT_MULTICAST_PORT);
        let mut receiver = match sacn::receive::SacnReceiver::with_ip(bind_addr, None) {
            Ok(receiver) => receiver,
            Err(error) => {
                tracing::warn!(?error, "Could not bind sACN input receiver");
                return Err(());
            }
        };

        let universes: Vec<u16> = (1..=DEFAULT_UNIVERSE_MAX).collect();
        if let Err(error) = receiver.listen_universes(&universes) {
            tracing::warn!(?error, "Could not listen to sACN universes");
            return Err(());
        }

        tracing::info!(?bind_addr, "Starting sACN input listener");

        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop_signal);
        let (frame_tx, _) = broadcast::channel::<SacnInputFrame>(1024);
        let frame_tx_for_thread = frame_tx.clone();

        let join_handle = std::thread::Builder::new()
            .name("sacn-input-service".to_string())
            .spawn(move || {
                let mut receiver = receiver;
                loop {
                    maybe_trigger_debug_worker_panic(DebugPanicTarget::InputSacnListener);

                    if stop_for_thread.load(Ordering::Relaxed) || is_process_shutdown_requested() {
                        break;
                    }

                    match receiver.recv(Some(Duration::from_millis(250))) {
                        Ok(frames) => {
                            for frame in frames {
                                if frame.values.is_empty() || frame.values[0] != 0 {
                                    continue;
                                }

                                let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
                                let payload = &frame.values[1..];
                                let copy_len = payload.len().min(MAX_CHANNELS_PER_UNIVERSE);
                                data[..copy_len].copy_from_slice(&payload[..copy_len]);

                                let _ = frame_tx_for_thread.send(SacnInputFrame {
                                    universe_id: frame.universe,
                                    data,
                                    source_cid: frame.src_cid.map(|cid| *cid.as_bytes()),
                                    received_at: frame.recv_timestamp,
                                });
                            }
                        }
                        Err(SacnError::Io(error))
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                || error.kind() == std::io::ErrorKind::TimedOut =>
                        {
                            continue;
                        }
                        Err(SacnError::SourceDiscovered(_)) => {}
                        Err(error) => {
                            tracing::warn!(?error, "sACN receive failed");
                        }
                    }
                }
                tracing::debug!("sACN input service worker exiting");
            })
            .expect("failed to spawn sACN input service worker");

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

/// Resolved sACN input endpoint that maps a universe range into fixture data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SacnInputBinding {
    enabled: bool,
    bind_ip: Option<Ipv4Addr>,
    interface_name: Option<String>,
}

impl SacnInputBinding {
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

/// Process-lifetime sACN input service host.
pub struct SacnInputService {
    slot: ModeWorkerSlot<SacnInputBinding, SacnInputWorker>,
    client: SacnInputClient,
}

impl SacnInputService {
    fn new() -> Self {
        Self {
            slot: ModeWorkerSlot::new(),
            client: SacnInputClient::default(),
        }
    }

    /// Configure whether sACN input is enabled and ensure the process-lifetime worker is bound.
    pub fn configure_network_input_enabled(&self, enabled: bool) -> NetworkInputBindStatus {
        self.configure_binding(SacnInputBinding::from_enabled(enabled))
    }

    /// Configures sACN input binding from IO settings and the current interface snapshot.
    pub fn sync_with_settings(
        &self,
        settings: &IoRuntimeSettings,
        interface_state: &NetworkInterfaceState,
        transport_policy: &TransportRuntimePolicy,
    ) -> NetworkInputBindStatus {
        self.configure_binding(SacnInputBinding::from_settings(
            settings,
            interface_state,
            transport_policy,
        ))
    }

    fn configure_binding(&self, binding: SacnInputBinding) -> NetworkInputBindStatus {
        let mut status = if binding.enabled {
            NetworkInputBindStatus::Failed
        } else {
            NetworkInputBindStatus::Disabled
        };
        let has_worker = self.slot.rebind(
            binding,
            |binding| match SacnInputWorker::spawn(binding) {
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

    /// Cloneable sACN input client for insertion into ECS worlds.
    pub fn client(&self) -> SacnInputClient {
        self.client.clone()
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_sender(None);
    }
}

impl Drop for SacnInputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide sACN input service.
pub fn process_sacn_input_service() -> &'static SacnInputService {
    static PROCESS_SERVICE: OnceLock<SacnInputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, SacnInputService::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sacn_bridge_thread_exits_after_receiver_drop_on_repeated_subscriptions() {
        let client = SacnInputClient::default();
        let (frame_tx, _) = broadcast::channel::<SacnInputFrame>(16);
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
}
