// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::net::SocketAddr;
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nightfall_service_host::prelude::{ModeWorkerSlot, process_singleton};
use tokio::sync::{
    broadcast,
    mpsc::{self, UnboundedReceiver},
};

use crate::command::OscListenerStatus;
use crate::osc::{self, RawOscEvent};

const BRIDGE_IDLE_SLEEP: Duration = Duration::from_millis(5);

/// OSC input client used inside ECS worlds.
#[derive(Clone, Default)]
pub struct OscInputClient {
    event_tx: Arc<Mutex<Option<broadcast::Sender<RawOscEvent>>>>,
}

impl OscInputClient {
    /// Subscribe to OSC frames as a per-subscriber `mpsc` stream.
    pub fn subscribe(&self) -> Option<UnboundedReceiver<RawOscEvent>> {
        self.subscribe_with_bridge_done_signal(None)
    }

    fn subscribe_with_bridge_done_signal(
        &self,
        bridge_done_tx: Option<std::sync::mpsc::Sender<()>>,
    ) -> Option<UnboundedReceiver<RawOscEvent>> {
        let event_tx = self
            .event_tx
            .lock()
            .ok()
            .and_then(|event_tx| event_tx.clone())?;
        let mut broadcast_rx = event_tx.subscribe();
        let (event_mpsc_tx, event_mpsc_rx) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("osc-input-bridge".to_string())
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
            .expect("failed to spawn OSC input bridge thread");
        Some(event_mpsc_rx)
    }

    #[cfg(test)]
    fn subscribe_with_exit_notifier(
        &self,
    ) -> Option<(
        tokio::sync::mpsc::UnboundedReceiver<RawOscEvent>,
        std::sync::mpsc::Receiver<()>,
    )> {
        let (bridge_done_tx, bridge_done_rx) = std::sync::mpsc::channel();
        let event_mpsc_rx = self.subscribe_with_bridge_done_signal(Some(bridge_done_tx))?;
        Some((event_mpsc_rx, bridge_done_rx))
    }

    pub(crate) fn set_sender(&self, sender: Option<broadcast::Sender<RawOscEvent>>) {
        if let Ok(mut event_tx) = self.event_tx.lock() {
            *event_tx = sender;
        }
    }
}

/// Background worker state for receiving and forwarding OSC messages.
pub(crate) struct OscInputWorker {
    pub(crate) event_tx: broadcast::Sender<RawOscEvent>,
    listener: Option<osc::OscListener>,
    bridge_handle: Option<std::thread::JoinHandle<()>>,
}

impl OscInputWorker {
    pub(crate) fn spawn(bind_addr: SocketAddr) -> Option<Self> {
        let (bridge_tx, mut bridge_rx) = mpsc::unbounded_channel::<RawOscEvent>();
        let (listener, status) = osc::start_listener(bind_addr, bridge_tx);
        if !status.is_listening {
            return None;
        }
        let listener = listener?;

        let (event_tx, _) = broadcast::channel::<RawOscEvent>(1024);
        let event_tx_for_thread = event_tx.clone();
        let bridge_handle = std::thread::Builder::new()
            .name("osc-input-service-bridge".to_string())
            .spawn(move || {
                while let Some(event) = bridge_rx.blocking_recv() {
                    let _ = event_tx_for_thread.send(event);
                }
                tracing::debug!("OSC input bridge exiting");
            })
            .expect("failed to spawn OSC input service bridge thread");

        Some(Self {
            event_tx,
            listener: Some(listener),
            bridge_handle: Some(bridge_handle),
        })
    }

    pub(crate) fn shutdown(&mut self) {
        if let Some(listener) = self.listener.take() {
            drop(listener);
        }
        if let Some(bridge_handle) = self.bridge_handle.take() {
            let _ = bridge_handle.join();
        }
    }

    pub(crate) fn is_alive(&self) -> bool {
        let listener_alive = self
            .listener
            .as_ref()
            .is_some_and(osc::OscListener::is_alive);
        let bridge_alive = self
            .bridge_handle
            .as_ref()
            .is_some_and(|bridge_handle| !bridge_handle.is_finished());
        listener_alive && bridge_alive
    }
}

/// Process-lifetime OSC input service host.
pub struct OscInputService {
    slot: ModeWorkerSlot<SocketAddr, OscInputWorker>,
    client: OscInputClient,
}

impl OscInputService {
    fn new() -> Self {
        Self {
            slot: ModeWorkerSlot::new(),
            client: OscInputClient::default(),
        }
    }

    /// Configure OSC bind address and ensure a process-lifetime worker is bound.
    pub fn configure_bind_addr(&self, bind_addr: SocketAddr) -> OscListenerStatus {
        let has_worker = self.slot.rebind(
            bind_addr,
            OscInputWorker::spawn,
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        let sender = self
            .slot
            .with_worker(|worker| worker.map(|worker| worker.event_tx.clone()));
        self.client.set_sender(sender);

        OscListenerStatus {
            is_listening: has_worker,
            bind_address: bind_addr.ip().to_string(),
            port: bind_addr.port(),
        }
    }

    /// Cloneable OSC input client for insertion into ECS worlds.
    pub fn client(&self) -> OscInputClient {
        self.client.clone()
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_sender(None);
    }
}

impl Drop for OscInputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide OSC input service.
pub fn process_osc_input_service() -> &'static OscInputService {
    static PROCESS_SERVICE: OnceLock<OscInputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, OscInputService::new)
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use rosc::{OscMessage, OscPacket, OscType, encoder};
    use tokio::sync::mpsc::UnboundedReceiver;

    use super::*;

    fn test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn reserve_loopback_addr() -> (SocketAddr, UdpSocket) {
        let socket = UdpSocket::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 0))
            .expect("bind test reservation socket");
        let addr = socket.local_addr().expect("reservation socket local addr");
        (addr, socket)
    }

    fn send_test_packet(target: SocketAddr, address: &str) {
        let payload = encoder::encode(&OscPacket::Message(OscMessage {
            addr: address.to_string(),
            args: vec![OscType::Int(42)],
        }))
        .expect("encode OSC packet");
        let sender =
            UdpSocket::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 0)).expect("bind sender");
        sender.send_to(&payload, target).expect("send OSC packet");
    }

    fn recv_event(
        rx: &mut UnboundedReceiver<RawOscEvent>,
        timeout: Duration,
    ) -> Option<RawOscEvent> {
        let deadline = Instant::now() + timeout;
        loop {
            match rx.try_recv() {
                Ok(event) => return Some(event),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    if Instant::now() >= deadline {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => return None,
            }
        }
    }

    #[test]
    fn configure_bind_addr_recovers_after_initial_bind_failure() {
        let _guard = test_lock().lock().expect("test lock");
        let service = process_osc_input_service();
        service.shutdown();

        let (bind_addr, guard_socket) = reserve_loopback_addr();
        let status = service.configure_bind_addr(bind_addr);
        assert!(!status.is_listening);
        assert_eq!(status.port, bind_addr.port());

        drop(guard_socket);

        let status = service.configure_bind_addr(bind_addr);
        assert!(status.is_listening);
        assert_eq!(status.port, bind_addr.port());

        service.shutdown();
    }

    #[test]
    fn configure_bind_addr_keeps_listener_while_multiple_subscribers_exist() {
        let _guard = test_lock().lock().expect("test lock");
        let service = process_osc_input_service();
        service.shutdown();

        let (bind_addr, guard_socket) = reserve_loopback_addr();
        drop(guard_socket);

        let initial_status = service.configure_bind_addr(bind_addr);
        assert!(initial_status.is_listening);

        let mut rx_a = service.client().subscribe().expect("first subscriber");

        let reload_status = service.configure_bind_addr(bind_addr);
        assert!(reload_status.is_listening);

        let mut rx_b = service.client().subscribe().expect("second subscriber");

        send_test_packet(bind_addr, "/reload/test");

        let event_a = recv_event(&mut rx_a, Duration::from_secs(1)).expect("first event");
        let event_b = recv_event(&mut rx_b, Duration::from_secs(1)).expect("second event");
        assert_eq!(event_a.address, "/reload/test");
        assert_eq!(event_b.address, "/reload/test");

        service.shutdown();
    }

    #[test]
    fn osc_bridge_thread_exits_after_receiver_drop_on_repeated_subscriptions() {
        let client = OscInputClient::default();
        let (event_tx, _) = tokio::sync::broadcast::channel::<RawOscEvent>(16);
        client.set_sender(Some(event_tx));

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
}
