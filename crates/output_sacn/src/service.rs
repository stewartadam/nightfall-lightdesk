// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bevy_ecs::prelude::Resource;
use nightfall_io::prelude::{IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy};
use nightfall_service_host::prelude::{ModeWorkerSlot, process_singleton};
use sacn::error::errors::SacnError;
use tokio::sync::mpsc::{self, UnboundedSender};

const EPHEMERAL_SACN_OUTPUT_PORT: u16 = 0;
const SACN_PORT: u16 = sacn::packet::ACN_SDT_MULTICAST_PORT;

/// sACN output send failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SacnSendError {
    /// Output service is not configured or unavailable.
    Unavailable,
    /// Socket address became unavailable and output was disabled.
    AddrNotAvailable,
    /// Frame send failed for another reason.
    Failed {
        /// I/O error kind reported by the OS when available.
        kind: Option<std::io::ErrorKind>,
        /// Human-readable error message.
        message: String,
    },
}

/// sACN output client used inside ECS worlds.
#[derive(Clone, Default, Resource)]
pub struct SacnOutputClient {
    command_tx: Arc<Mutex<Option<UnboundedSender<SacnWorkerCommand>>>>,
    source_cid: Arc<Mutex<Option<[u8; 16]>>>,
}

impl SacnOutputClient {
    /// Send one sACN frame for a universe.
    pub fn send_frame(
        &self,
        universe: u16,
        data: &[u8],
        unicast_ip: Option<Ipv4Addr>,
    ) -> Result<(), SacnSendError> {
        {
            let maybe_sender = self
                .command_tx
                .lock()
                .ok()
                .and_then(|sender| sender.clone());
            let Some(command_tx) = maybe_sender else {
                return Err(SacnSendError::Unavailable);
            };

            let (response_tx, response_rx) = std::sync::mpsc::channel();
            if command_tx
                .send(SacnWorkerCommand::SendFrame {
                    universe,
                    data: data.to_vec(),
                    unicast_ip,
                    response_tx,
                })
                .is_err()
            {
                return Err(SacnSendError::Unavailable);
            }

            response_rx
                .recv_timeout(Duration::from_millis(250))
                .unwrap_or(Err(SacnSendError::Unavailable))
        }
    }

    /// Return the local sACN source CID, if configured.
    pub fn source_cid(&self) -> Option<[u8; 16]> {
        self.source_cid.lock().ok().and_then(|cid| *cid)
    }

    /// Return whether the sACN service currently has a sender connected.
    pub fn is_available(&self) -> bool {
        {
            self.command_tx
                .lock()
                .ok()
                .is_some_and(|sender| sender.is_some())
        }
    }

    pub(crate) fn set_sender_and_cid(
        &self,
        sender: Option<UnboundedSender<SacnWorkerCommand>>,
        source_cid: Option<[u8; 16]>,
    ) {
        if let Ok(mut command_tx) = self.command_tx.lock() {
            *command_tx = sender;
        }
        if let Ok(mut cid) = self.source_cid.lock() {
            *cid = source_cid;
        }
    }
}

/// Commands handled by the sACN output worker thread.
pub(crate) enum SacnWorkerCommand {
    SendFrame {
        universe: u16,
        data: Vec<u8>,
        unicast_ip: Option<Ipv4Addr>,
        response_tx: std::sync::mpsc::Sender<Result<(), SacnSendError>>,
    },
    Shutdown,
}

/// Background worker state for batching and sending sACN frames.
pub(crate) struct SacnWorker {
    /// Command sender used to submit frame-send requests to the worker thread.
    pub(crate) command_tx: UnboundedSender<SacnWorkerCommand>,
    /// Source CID exposed by this worker for loopback filtering and metadata.
    pub(crate) source_cid: Option<[u8; 16]>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl SacnWorker {
    pub(crate) fn spawn(binding: SacnOutputBinding) -> Option<Self> {
        let mut source = init_source(binding)?;
        let source_cid = source.cid().ok().map(|cid| *cid.as_bytes());
        let mut registered_universes = HashSet::<u16>::new();

        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let join_handle = std::thread::Builder::new()
            .name("sacn-output-service".to_string())
            .spawn(move || {
                while let Some(command) = command_rx.blocking_recv() {
                    match command {
                        SacnWorkerCommand::SendFrame {
                            universe,
                            data,
                            unicast_ip,
                            response_tx,
                        } => {
                            if !registered_universes.contains(&universe) {
                                match source.register_universe(universe) {
                                    Ok(()) => {
                                        registered_universes.insert(universe);
                                    }
                                    Err(error) => {
                                        tracing::trace!(
                                            ?error,
                                            universe,
                                            "Could not register sACN universe before send"
                                        );
                                        let _ = response_tx.send(Err(SacnSendError::Failed {
                                            kind: None,
                                            message: error.to_string(),
                                        }));
                                        continue;
                                    }
                                }
                            }

                            let payload = with_start_code(&data);
                            let dst_ip = unicast_ip
                                .map(|ip| SocketAddr::new(ip.into(), SACN_PORT));
                            let mut result = source.send(
                                &[universe],
                                &payload,
                                Some(100),
                                dst_ip,
                                None, // sync_addr
                            );
                            if matches!(
                                result,
                                Err(SacnError::UniverseNotRegistered(_))
                            ) {
                                registered_universes.remove(&universe);
                                match source.register_universe(universe) {
                                    Ok(()) => {
                                        registered_universes.insert(universe);
                                        result = source.send(
                                            &[universe],
                                            &payload,
                                            Some(100),
                                            dst_ip,
                                            None, // sync_addr
                                        );
                                    }
                                    Err(error) => {
                                        tracing::trace!(
                                            ?error,
                                            universe,
                                            "Could not re-register sACN universe after UniverseNotRegistered error"
                                        );
                                        let _ = response_tx.send(Err(SacnSendError::Failed {
                                            kind: None,
                                            message: error.to_string(),
                                        }));
                                        continue;
                                    }
                                }
                            }
                            match result {
                                Ok(()) => {
                                    let _ = response_tx.send(Ok(()));
                                }
                                Err(SacnError::Io(error))
                                    if error.kind() == std::io::ErrorKind::AddrNotAvailable =>
                                {
                                    tracing::warn!(
                                        ?error,
                                        universe,
                                        "Address not available for sACN output; disabling sACN output"
                                    );
                                    let _ = response_tx.send(Err(SacnSendError::AddrNotAvailable));
                                    break;
                                }
                                Err(error) => {
                                    tracing::trace!(?error, universe, "Sending sACN universe failed");
                                    let kind = match &error {
                                        SacnError::Io(io_error) => Some(io_error.kind()),
                                        _ => None,
                                    };
                                    let _ = response_tx.send(Err(SacnSendError::Failed {
                                        kind,
                                        message: error.to_string(),
                                    }));
                                }
                            }
                        }
                        SacnWorkerCommand::Shutdown => break,
                    }
                }
                tracing::debug!("sACN output service worker exiting");
            })
            .expect("failed to spawn sACN output service worker");

        Some(Self {
            command_tx,
            source_cid,
            join_handle: Some(join_handle),
        })
    }

    pub(crate) fn shutdown(&mut self) {
        let _ = self.command_tx.send(SacnWorkerCommand::Shutdown);
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

/// Prefix DMX payload bytes with the required sACN start code byte.
fn with_start_code(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len() + 1);
    result.push(0);
    result.extend_from_slice(data);
    result
}

fn sacn_output_bind_addr(bind_ip: std::net::Ipv4Addr) -> SocketAddr {
    SocketAddr::new(bind_ip.into(), EPHEMERAL_SACN_OUTPUT_PORT)
}

/// Resolved sACN output endpoint used to route console universe data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SacnOutputBinding {
    enabled: bool,
    bind_ip: Option<Ipv4Addr>,
    interface_name: Option<String>,
}

impl SacnOutputBinding {
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

/// Initialize an sACN source bound according to the configured network output mode.
fn init_source(binding: SacnOutputBinding) -> Option<sacn::source::SacnSource> {
    if !binding.enabled {
        tracing::info!("sACN output is disabled by effective network output state");
        return None;
    }

    let Some(bind_ip) = binding.bind_ip else {
        tracing::warn!(
            interface_name = ?binding.interface_name,
            "Could not resolve configured network interface; sACN output disabled"
        );
        return None;
    };

    let socket_addr = sacn_output_bind_addr(bind_ip);
    tracing::info!(
        interface_name = ?binding.interface_name,
        bind_ip = %bind_ip,
        "Starting sACN output"
    );
    let source = sacn::source::SacnSource::with_ip("nightfall", socket_addr);
    if let Err(error) = source {
        tracing::warn!(
            ?error,
            interface_name = ?binding.interface_name,
            bind_ip = %bind_ip,
            "Could not open sACN network controller; sACN output disabled"
        );
        return None;
    }
    source.ok()
}

/// Process-lifetime sACN output service host.
pub struct SacnOutputService {
    slot: ModeWorkerSlot<SacnOutputBinding, SacnWorker>,
    client: SacnOutputClient,
}

impl SacnOutputService {
    fn new() -> Self {
        Self {
            slot: ModeWorkerSlot::new(),
            client: SacnOutputClient::default(),
        }
    }

    /// Configure whether sACN output is enabled and ensure the process-lifetime worker is bound.
    pub fn configure_network_output_enabled(&self, enabled: bool) -> bool {
        self.configure_binding(SacnOutputBinding::from_enabled(enabled))
    }

    /// Configures sACN output binding from IO settings and the current interface snapshot.
    pub fn sync_with_settings(
        &self,
        settings: &IoRuntimeSettings,
        interface_state: &NetworkInterfaceState,
        transport_policy: &TransportRuntimePolicy,
    ) -> bool {
        self.configure_binding(SacnOutputBinding::from_settings(
            settings,
            interface_state,
            transport_policy,
        ))
    }

    fn configure_binding(&self, binding: SacnOutputBinding) -> bool {
        let has_worker = self.slot.rebind(
            binding,
            SacnWorker::spawn,
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        let (sender, source_cid) = self.slot.with_worker(|worker| {
            (
                worker.as_ref().map(|worker| worker.command_tx.clone()),
                worker.as_ref().and_then(|worker| worker.source_cid),
            )
        });
        self.client.set_sender_and_cid(sender, source_cid);
        has_worker
    }

    /// Cloneable sACN client for insertion into ECS worlds.
    pub fn client(&self) -> SacnOutputClient {
        self.client.clone()
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_sender_and_cid(None, None);
    }
}

impl Drop for SacnOutputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide sACN output service.
pub fn process_sacn_output_service() -> &'static SacnOutputService {
    static PROCESS_SERVICE: OnceLock<SacnOutputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, SacnOutputService::new)
}
