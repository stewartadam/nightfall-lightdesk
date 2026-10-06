// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::net::{SocketAddrV4, UdpSocket};
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bevy_ecs::prelude::Resource;
use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nightfall_io::ArtNetRecentFramesByUniverse;
use nightfall_io::prelude::{IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy};
use nightfall_service_host::prelude::{
    FixedRatePeriod, FixedRateWorker, ModeWorkerSlot, process_singleton,
};

const ARTNET_PORT: u16 = 6454;

/// Error returned when Art-Net output cannot send a frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtNetSendError {
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

/// One Art-Net universe the worker transmits on every tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtNetFrame {
    /// On-the-wire universe (port address).
    pub universe: u16,
    /// Unicast destination, or `None` to broadcast.
    pub unicast_ip: Option<Ipv4Addr>,
    /// Channel values.
    pub data: [u8; MAX_CHANNELS_PER_UNIVERSE],
}

/// Identifies one Art-Net delivery: a universe and its unicast target, if any.
pub type ArtNetOutputKey = (u16, Option<Ipv4Addr>);

/// Send outcomes the worker accumulated since the ECS last drained them.
#[derive(Debug, Default)]
pub struct ArtNetOutputReport {
    /// Latest send outcome for each delivery.
    pub outcomes: BTreeMap<ArtNetOutputKey, Result<(), ArtNetSendError>>,
    /// Time spent sending and number of universes sent on the most recent tick.
    pub last_tick: Option<(Duration, u32)>,
}

/// State shared between ECS clients and the worker thread.
#[derive(Debug, Default)]
struct ArtNetShared {
    /// Frames transmitted on every tick, replaced by each engine frame.
    frames: Mutex<Arc<Vec<ArtNetFrame>>>,
    /// Outcomes not yet drained by the ECS.
    report: Mutex<ArtNetOutputReport>,
    /// Whether a worker is currently running. Set by the worker when it starts and cleared when
    /// it disables itself, so a self-disabled worker is never reported as available.
    running: AtomicBool,
}

/// Art-Net output client used inside ECS worlds.
///
/// Engine frames publish the latest composed universes here; the output worker transmits
/// whatever was published last on its own clock at the configured output rate.
#[derive(Clone, Default, Resource)]
pub struct ArtNetOutputClient {
    shared: Arc<ArtNetShared>,
}

impl ArtNetOutputClient {
    /// Replaces the frames the worker transmits from its next tick onwards.
    pub fn publish(&self, frames: Vec<ArtNetFrame>) {
        if let Ok(mut published) = self.shared.frames.lock() {
            *published = Arc::new(frames);
        }
    }

    /// Takes the send outcomes accumulated since the previous call.
    pub fn take_report(&self) -> ArtNetOutputReport {
        self.shared
            .report
            .lock()
            .map(|mut report| std::mem::take(&mut *report))
            .unwrap_or_default()
    }

    /// Returns whether an Art-Net worker is running.
    pub fn is_available(&self) -> bool {
        self.shared.running.load(Ordering::Acquire)
    }

    /// Returns the frames the worker transmits on its next tick.
    #[cfg(test)]
    pub(crate) fn published(&self) -> Arc<Vec<ArtNetFrame>> {
        self.shared
            .frames
            .lock()
            .map(|frames| Arc::clone(&frames))
            .unwrap_or_default()
    }

    /// Marks the worker as running or stopped.
    pub(crate) fn set_running(&self, running: bool) {
        self.shared.running.store(running, Ordering::Release);
    }

    /// Records the outcomes of one tick for the ECS to drain.
    pub(crate) fn record_tick(
        &self,
        outcomes: impl IntoIterator<Item = (ArtNetOutputKey, Result<(), ArtNetSendError>)>,
        elapsed: Duration,
        sent_count: u32,
    ) {
        if let Ok(mut report) = self.shared.report.lock() {
            report.outcomes.extend(outcomes);
            report.last_tick = Some((elapsed, sent_count));
        }
    }
}

/// Background worker that transmits the latest published frames at the configured output rate.
pub(crate) struct ArtNetWorker {
    worker: FixedRateWorker,
}

impl ArtNetWorker {
    /// Binds the socket and starts ticking every `period`, or returns `None` when output is
    /// disabled or the socket cannot be opened.
    pub(crate) fn spawn(
        binding: ArtNetOutputBinding,
        client: ArtNetOutputClient,
        recent_frames: ArtNetRecentFramesByUniverse,
        period: FixedRatePeriod,
    ) -> Option<Self> {
        let mut socket = init_socket(binding)?;
        // Never replay frames published before output stopped; wait for the next engine frame.
        client.publish(Vec::new());
        client.set_running(true);
        let tick_client = client.clone();
        let spawned = FixedRateWorker::spawn("artnet-output-service", period, move || {
            let flow = transmit_tick(&mut socket, &tick_client, &recent_frames);
            if flow.is_break() {
                tick_client.set_running(false);
            }
            flow
        });
        match spawned {
            Ok(worker) => Some(Self { worker }),
            Err(error) => {
                client.set_running(false);
                tracing::warn!(?error, "Could not start Art-Net output worker");
                None
            }
        }
    }

    pub(crate) fn shutdown(&mut self) {
        self.worker.shutdown();
        tracing::debug!("Art-Net output service worker exited");
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.worker.is_alive()
    }
}

/// Sends every published frame once and records the outcomes.
///
/// Breaks when the bound address disappears, which disables Art-Net output until the binding is
/// reconfigured.
fn transmit_tick(
    socket: &mut ArtNetSocket,
    client: &ArtNetOutputClient,
    recent_frames: &ArtNetRecentFramesByUniverse,
) -> ControlFlow<()> {
    let frames = client
        .shared
        .frames
        .lock()
        .map(|frames| Arc::clone(&frames))
        .unwrap_or_default();
    let start = Instant::now();
    let mut sent_count = 0u32;
    let mut outcomes = Vec::with_capacity(frames.len());
    let mut flow = ControlFlow::Continue(());

    for frame in frames.iter() {
        let key = (frame.universe, frame.unicast_ip);
        match socket.send_frame(frame.universe, &frame.data, frame.unicast_ip, recent_frames) {
            Ok(()) => {
                sent_count += 1;
                outcomes.push((key, Ok(())));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrNotAvailable => {
                tracing::warn!(
                    ?error,
                    "Address not available for Art-Net socket; disabling Art-Net output"
                );
                outcomes.push((key, Err(ArtNetSendError::AddrNotAvailable)));
                flow = ControlFlow::Break(());
                break;
            }
            Err(error) => {
                tracing::trace!(?error, "Sending Art-Net universe data failed");
                outcomes.push((
                    key,
                    Err(ArtNetSendError::Failed {
                        kind: error.kind(),
                        message: error.to_string(),
                    }),
                ));
            }
        }
    }

    client.record_tick(outcomes, start.elapsed(), sent_count);
    flow
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

    /// Sends one universe, recording its fingerprint in `recent_frames` before it reaches the
    /// wire so loopback input can never arrive ahead of the record.
    fn send_frame(
        &mut self,
        universe: u16,
        data: &[u8; MAX_CHANNELS_PER_UNIVERSE],
        unicast_ip: Option<Ipv4Addr>,
        recent_frames: &ArtNetRecentFramesByUniverse,
    ) -> Result<(), std::io::Error> {
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

        recent_frames.record_recent_frame(
            universe,
            self.sequence,
            data,
            self.socket.local_addr().ok(),
            Instant::now(),
        );
        self.socket.send_to(&bytes, destination)?;
        Ok(())
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
    recent_frames: ArtNetRecentFramesByUniverse,
    period: FixedRatePeriod,
}

impl ArtNetOutputService {
    fn new() -> Self {
        Self {
            slot: ModeWorkerSlot::new(),
            client: ArtNetOutputClient::default(),
            recent_frames: ArtNetRecentFramesByUniverse::new(),
            period: FixedRatePeriod::new(IoRuntimeSettings::default().dmx_output_interval()),
        }
    }

    /// Configure whether Art-Net output is enabled and ensure the process-lifetime worker is bound.
    pub fn configure_network_output_enabled(&self, enabled: bool) -> bool {
        self.configure_binding(ArtNetOutputBinding::from_enabled(enabled))
    }

    /// Configures Art-Net output binding and rate from IO settings and the current interface
    /// snapshot; a rate change retimes the running worker without rebinding it.
    pub fn sync_with_settings(
        &self,
        settings: &IoRuntimeSettings,
        interface_state: &NetworkInterfaceState,
        transport_policy: &TransportRuntimePolicy,
    ) -> bool {
        self.period.set(settings.dmx_output_interval());
        self.configure_binding(ArtNetOutputBinding::from_settings(
            settings,
            interface_state,
            transport_policy,
        ))
    }

    fn configure_binding(&self, binding: ArtNetOutputBinding) -> bool {
        let has_worker = self.slot.rebind(
            binding,
            |binding| {
                ArtNetWorker::spawn(
                    binding,
                    self.client.clone(),
                    self.recent_frames.clone(),
                    self.period.clone(),
                )
            },
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        if !has_worker {
            self.client.set_running(false);
        }
        has_worker
    }

    /// Cloneable Art-Net client for insertion into ECS worlds.
    pub fn client(&self) -> ArtNetOutputClient {
        self.client.clone()
    }

    /// Shared tracker of frames this process transmitted, for Art-Net input loopback filtering.
    pub fn recent_frames(&self) -> ArtNetRecentFramesByUniverse {
        self.recent_frames.clone()
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_running(false);
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
