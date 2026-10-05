// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{BTreeMap, HashSet};
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bevy_ecs::prelude::Resource;
use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nightfall_io::prelude::{
    DMX_REFRESH_INTERVAL, IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy,
};
use nightfall_service_host::prelude::{FixedRateWorker, ModeWorkerSlot, process_singleton};
use sacn::error::errors::SacnError;
use sacn::source::SacnSource;

const EPHEMERAL_SACN_OUTPUT_PORT: u16 = 0;
const SACN_PORT: u16 = sacn::packet::ACN_SDT_MULTICAST_PORT;

/// sACN output send failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SacnSendError {
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

/// One sACN universe the worker transmits on every tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SacnFrame {
    /// On-the-wire universe.
    pub universe: u16,
    /// Unicast destination, or `None` to multicast.
    pub unicast_ip: Option<Ipv4Addr>,
    /// Channel values, without the start code.
    pub data: [u8; MAX_CHANNELS_PER_UNIVERSE],
}

/// Identifies one sACN delivery: a universe and its unicast target, if any.
pub type SacnOutputKey = (u16, Option<Ipv4Addr>);

/// Send outcomes the worker accumulated since the ECS last drained them.
#[derive(Debug, Default)]
pub struct SacnOutputReport {
    /// Latest send outcome for each delivery.
    pub outcomes: BTreeMap<SacnOutputKey, Result<(), SacnSendError>>,
    /// Time spent sending and number of universes sent on the most recent tick.
    pub last_tick: Option<(Duration, u32)>,
}

/// State shared between ECS clients and the worker thread.
#[derive(Debug, Default)]
struct SacnShared {
    /// Frames transmitted on every tick, replaced by each engine frame.
    frames: Mutex<Arc<Vec<SacnFrame>>>,
    /// Outcomes not yet drained by the ECS.
    report: Mutex<SacnOutputReport>,
    /// Whether a worker is currently running. Set by the worker when it starts and cleared when
    /// it disables itself, so a self-disabled worker is never reported as available.
    running: AtomicBool,
    /// CID of the running worker's sACN source.
    source_cid: Mutex<Option<[u8; 16]>>,
}

/// sACN output client used inside ECS worlds.
///
/// Engine frames publish the latest composed universes here; the output worker transmits
/// whatever was published last on its own fixed 44 Hz clock.
#[derive(Clone, Default, Resource)]
pub struct SacnOutputClient {
    shared: Arc<SacnShared>,
}

impl SacnOutputClient {
    /// Replaces the frames the worker transmits from its next tick onwards.
    pub fn publish(&self, frames: Vec<SacnFrame>) {
        if let Ok(mut published) = self.shared.frames.lock() {
            *published = Arc::new(frames);
        }
    }

    /// Takes the send outcomes accumulated since the previous call.
    pub fn take_report(&self) -> SacnOutputReport {
        self.shared
            .report
            .lock()
            .map(|mut report| std::mem::take(&mut *report))
            .unwrap_or_default()
    }

    /// Return the local sACN source CID, if configured.
    pub fn source_cid(&self) -> Option<[u8; 16]> {
        self.shared.source_cid.lock().ok().and_then(|cid| *cid)
    }

    /// Returns whether an sACN worker is running.
    pub fn is_available(&self) -> bool {
        self.shared.running.load(Ordering::Acquire)
    }

    /// Returns the frames the worker transmits on its next tick.
    #[cfg(test)]
    pub(crate) fn published(&self) -> Arc<Vec<SacnFrame>> {
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

    /// Records the running worker's source CID.
    pub(crate) fn set_source_cid(&self, source_cid: Option<[u8; 16]>) {
        if let Ok(mut cid) = self.shared.source_cid.lock() {
            *cid = source_cid;
        }
    }

    /// Records the outcomes of one tick for the ECS to drain.
    pub(crate) fn record_tick(
        &self,
        outcomes: impl IntoIterator<Item = (SacnOutputKey, Result<(), SacnSendError>)>,
        elapsed: Duration,
        sent_count: u32,
    ) {
        if let Ok(mut report) = self.shared.report.lock() {
            report.outcomes.extend(outcomes);
            report.last_tick = Some((elapsed, sent_count));
        }
    }
}

/// Background worker that transmits the latest published frames on the shared 44 Hz grid.
pub(crate) struct SacnWorker {
    /// Source CID exposed by this worker for loopback filtering and metadata.
    pub(crate) source_cid: Option<[u8; 16]>,
    worker: FixedRateWorker,
}

impl SacnWorker {
    /// Opens the sACN source and starts ticking, or returns `None` when output is disabled or
    /// the source cannot be opened.
    pub(crate) fn spawn(binding: SacnOutputBinding, client: SacnOutputClient) -> Option<Self> {
        let mut source = init_source(binding)?;
        let source_cid = source.cid().ok().map(|cid| *cid.as_bytes());
        let mut registered_universes = HashSet::<u16>::new();
        // Never replay frames published before output stopped; wait for the next engine frame.
        client.publish(Vec::new());
        client.set_running(true);
        let tick_client = client.clone();
        let spawned =
            FixedRateWorker::spawn("sacn-output-service", DMX_REFRESH_INTERVAL, move || {
                let flow = transmit_tick(&mut source, &mut registered_universes, &tick_client);
                if flow.is_break() {
                    tick_client.set_running(false);
                }
                flow
            });
        match spawned {
            Ok(worker) => Some(Self { source_cid, worker }),
            Err(error) => {
                client.set_running(false);
                tracing::warn!(?error, "Could not start sACN output worker");
                None
            }
        }
    }

    pub(crate) fn shutdown(&mut self) {
        self.worker.shutdown();
        tracing::debug!("sACN output service worker exited");
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.worker.is_alive()
    }
}

/// Sends every published frame once and records the outcomes.
///
/// Breaks when the bound address disappears, which disables sACN output until the binding is
/// reconfigured.
fn transmit_tick(
    source: &mut SacnSource,
    registered_universes: &mut HashSet<u16>,
    client: &SacnOutputClient,
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
        match send_universe(source, registered_universes, frame) {
            Ok(()) => {
                sent_count += 1;
                outcomes.push((key, Ok(())));
            }
            Err(SacnError::Io(error)) if error.kind() == std::io::ErrorKind::AddrNotAvailable => {
                tracing::warn!(
                    ?error,
                    universe = frame.universe,
                    "Address not available for sACN output; disabling sACN output"
                );
                outcomes.push((key, Err(SacnSendError::AddrNotAvailable)));
                flow = ControlFlow::Break(());
                break;
            }
            Err(error) => {
                tracing::trace!(
                    ?error,
                    universe = frame.universe,
                    "Sending sACN universe failed"
                );
                let kind = match &error {
                    SacnError::Io(io_error) => Some(io_error.kind()),
                    _ => None,
                };
                outcomes.push((
                    key,
                    Err(SacnSendError::Failed {
                        kind,
                        message: error.to_string(),
                    }),
                ));
            }
        }
    }

    client.record_tick(outcomes, start.elapsed(), sent_count);
    flow
}

/// Sends one universe, registering it with the source first and once more if the source
/// reports it was dropped.
fn send_universe(
    source: &mut SacnSource,
    registered_universes: &mut HashSet<u16>,
    frame: &SacnFrame,
) -> Result<(), SacnError> {
    let universe = frame.universe;
    if !registered_universes.contains(&universe) {
        source.register_universe(universe).inspect_err(|error| {
            tracing::trace!(
                ?error,
                universe,
                "Could not register sACN universe before send"
            );
        })?;
        registered_universes.insert(universe);
    }

    let payload = with_start_code(&frame.data);
    let dst_ip = frame
        .unicast_ip
        .map(|ip| SocketAddr::new(ip.into(), SACN_PORT));
    let result = source.send(&[universe], &payload, Some(100), dst_ip, None);
    if !matches!(result, Err(SacnError::UniverseNotRegistered(_))) {
        return result;
    }

    registered_universes.remove(&universe);
    source.register_universe(universe).inspect_err(|error| {
        tracing::trace!(
            ?error,
            universe,
            "Could not re-register sACN universe after UniverseNotRegistered error"
        );
    })?;
    registered_universes.insert(universe);
    source.send(&[universe], &payload, Some(100), dst_ip, None)
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
fn init_source(binding: SacnOutputBinding) -> Option<SacnSource> {
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
    let source = SacnSource::with_ip("nightfall", socket_addr);
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
            |binding| SacnWorker::spawn(binding, self.client.clone()),
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        let source_cid = self
            .slot
            .with_worker(|worker| worker.and_then(|worker| worker.source_cid));
        self.client.set_source_cid(source_cid);
        if !has_worker {
            self.client.set_running(false);
        }
        has_worker
    }

    /// Cloneable sACN client for insertion into ECS worlds.
    pub fn client(&self) -> SacnOutputClient {
        self.client.clone()
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.set_running(false);
        self.client.set_source_cid(None);
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
