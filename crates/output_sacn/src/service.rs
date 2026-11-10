// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bevy_ecs::prelude::Resource;
use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nightfall_io::prelude::{IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy};
use nightfall_service_host::prelude::{
    FixedRatePeriod, FixedRateWorker, ModeWorkerSlot, process_singleton,
};
use sacn::error::errors::SacnError;
use sacn::source::SacnSource;

const EPHEMERAL_SACN_OUTPUT_PORT: u16 = 0;
const SACN_PORT: u16 = sacn::packet::ACN_SDT_MULTICAST_PORT;
/// Start code of null-start-code (level) DMX data.
const DMX_START_CODE: u8 = 0;

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
    /// Universe the worker synchronizes on, or 0 for no synchronization, the value E1.31 uses
    /// in data packets for the same meaning.
    sync_universe: AtomicU16,
}

/// sACN output client used inside ECS worlds.
///
/// Engine frames publish the latest composed universes here; the output worker transmits
/// whatever was published last on its own clock at the configured output rate.
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

    /// Sets the universe the worker synchronizes on, or `None` to send unsynchronized data.
    pub(crate) fn set_sync_universe(&self, universe: Option<u16>) {
        self.shared
            .sync_universe
            .store(universe.unwrap_or(0), Ordering::Release);
    }

    /// Returns the universe the worker synchronizes on, if any.
    fn sync_universe(&self) -> Option<u16> {
        Some(self.shared.sync_universe.load(Ordering::Acquire)).filter(|&universe| universe != 0)
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

/// Background worker that transmits the latest published frames at the configured output rate.
pub(crate) struct SacnWorker {
    /// Source CID exposed by this worker for loopback filtering and metadata.
    pub(crate) source_cid: Option<[u8; 16]>,
    worker: FixedRateWorker,
}

impl SacnWorker {
    /// Opens the sACN source and starts ticking every `period`, or returns `None` when output is
    /// disabled or the source cannot be opened.
    pub(crate) fn spawn(
        binding: SacnOutputBinding,
        client: SacnOutputClient,
        period: FixedRatePeriod,
    ) -> Option<Self> {
        let mut source = init_source(binding)?;
        let source_cid = source.cid().ok().map(|cid| *cid.as_bytes());
        let mut registered_universes = HashSet::<u16>::new();
        // Never replay frames published before output stopped; wait for the next engine frame.
        client.publish(Vec::new());
        client.set_running(true);
        let tick_client = client.clone();
        let spawned = FixedRateWorker::spawn("sacn-output-service", period, move || {
            let flow = transmit_tick(
                &mut source,
                &mut registered_universes,
                &tick_client,
                SACN_PORT,
            );
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

/// Sends every published frame once, unicast frames to `unicast_port`, and records the
/// outcomes.
///
/// Breaks when the bound address disappears, which disables sACN output until the binding is
/// reconfigured.
fn transmit_tick(
    source: &mut SacnSource,
    registered_universes: &mut HashSet<u16>,
    client: &SacnOutputClient,
    unicast_port: u16,
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
    // The source refuses data that names an unregistered sync universe, so fall back to
    // unsynchronized data when it cannot be registered.
    let sync_universe = client
        .sync_universe()
        .filter(|&universe| ensure_registered(source, registered_universes, universe).is_ok());

    for frame in frames.iter() {
        let key = (frame.universe, frame.unicast_ip);
        match send_universe(
            source,
            registered_universes,
            frame,
            sync_universe,
            unicast_port,
        ) {
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

    if flow.is_continue() {
        if let Some(sync_universe) = sync_universe
            && sent_count > 0
        {
            send_sync_packets(source, sync_universe, &frames, unicast_port);
        }
        terminate_unpublished_universes(source, registered_universes, &frames, sync_universe);
    }
    client.record_tick(outcomes, start.elapsed(), sent_count);
    flow
}

/// Ends a universe's stream on an sACN source.
///
/// Separates [`terminate_unpublished_universes`] from the network so its bookkeeping can be
/// tested without sending packets.
trait StreamTerminator {
    /// Sends the Stream_Terminated packets for `universe` and deregisters it from the source.
    fn terminate_stream(&mut self, universe: u16, start_code: u8) -> Result<(), SacnError>;
}

impl StreamTerminator for SacnSource {
    fn terminate_stream(&mut self, universe: u16, start_code: u8) -> Result<(), SacnError> {
        SacnSource::terminate_stream(self, universe, start_code)
    }
}

/// Sends one synchronization packet to every destination of this tick's data, so receivers
/// apply all the universes they buffered for `sync_universe` at once.
///
/// Multicast receivers get the packet on the sync universe's multicast group, which receivers
/// join on their own once data names it. Unicast receivers never see multicast traffic for
/// their data, so each unicast destination also gets its own copy on `unicast_port`.
fn send_sync_packets(
    source: &mut SacnSource,
    sync_universe: u16,
    frames: &[SacnFrame],
    unicast_port: u16,
) {
    let destinations: BTreeSet<Option<Ipv4Addr>> =
        frames.iter().map(|frame| frame.unicast_ip).collect();
    for destination in destinations {
        let dst_ip = destination.map(|ip| SocketAddr::new(ip.into(), unicast_port));
        if let Err(error) = source.send_sync_packet(sync_universe, dst_ip) {
            tracing::trace!(
                ?error,
                sync_universe,
                ?destination,
                "Sending sACN sync packet failed"
            );
        }
    }
}

/// Ends the stream of every registered universe that is neither published nor the sync
/// universe.
///
/// E1.31 asks a source that stops sending a universe to say so with three Stream_Terminated
/// packets, so receivers release it at once instead of holding the last look until their
/// 2.5 s data-loss timeout. Terminating also deregisters the universe, which drops it from the
/// source's universe discovery adverts.
///
/// The source only deregisters a universe once all of its termination packets were sent, so a
/// universe whose termination fails stays registered on both sides and is retried next tick.
/// A universe the source no longer knows about is simply forgotten.
fn terminate_unpublished_universes(
    source: &mut impl StreamTerminator,
    registered_universes: &mut HashSet<u16>,
    frames: &[SacnFrame],
    sync_universe: Option<u16>,
) {
    let published: HashSet<u16> = frames.iter().map(|frame| frame.universe).collect();
    registered_universes.retain(|&universe| {
        if published.contains(&universe) || sync_universe == Some(universe) {
            return true;
        }
        match source.terminate_stream(universe, DMX_START_CODE) {
            Ok(()) | Err(SacnError::UniverseNotRegistered(_)) => false,
            Err(error) => {
                tracing::debug!(
                    ?error,
                    universe,
                    "Could not terminate sACN universe stream; retrying next tick"
                );
                true
            }
        }
    });
}

/// Registers `universe` with the source unless it is already registered.
fn ensure_registered(
    source: &mut SacnSource,
    registered_universes: &mut HashSet<u16>,
    universe: u16,
) -> Result<(), SacnError> {
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
    Ok(())
}

/// Sends one universe, registering it with the source first and once more if the source
/// reports it was dropped. Data names `sync_universe` as its synchronization address, so
/// receivers that support sync hold it until the matching sync packet arrives. A unicast frame
/// goes to `unicast_port` on its destination.
fn send_universe(
    source: &mut SacnSource,
    registered_universes: &mut HashSet<u16>,
    frame: &SacnFrame,
    sync_universe: Option<u16>,
    unicast_port: u16,
) -> Result<(), SacnError> {
    let universe = frame.universe;
    ensure_registered(source, registered_universes, universe)?;

    let payload = with_start_code(&frame.data);
    let dst_ip = frame
        .unicast_ip
        .map(|ip| SocketAddr::new(ip.into(), unicast_port));
    let result = source.send(&[universe], &payload, Some(100), dst_ip, sync_universe);
    // The source reports a dropped data universe as UniverseNotRegistered and a dropped sync
    // universe as IllegalSyncUniverse; register whichever it lost again and retry once.
    let dropped = match result {
        Err(SacnError::UniverseNotRegistered(_)) => universe,
        Err(SacnError::IllegalSyncUniverse(sync)) => sync,
        result => return result,
    };

    registered_universes.remove(&dropped);
    ensure_registered(source, registered_universes, dropped).inspect_err(|error| {
        tracing::trace!(
            ?error,
            universe = dropped,
            "Could not re-register sACN universe after the source dropped it"
        );
    })?;
    source.send(&[universe], &payload, Some(100), dst_ip, sync_universe)
}

/// Prefix DMX payload bytes with the required sACN start code byte.
fn with_start_code(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len() + 1);
    result.push(DMX_START_CODE);
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
    period: FixedRatePeriod,
}

impl SacnOutputService {
    fn new() -> Self {
        Self {
            slot: ModeWorkerSlot::new(),
            client: SacnOutputClient::default(),
            period: FixedRatePeriod::new(IoRuntimeSettings::default().dmx_output_interval()),
        }
    }

    /// Configure whether sACN output is enabled and ensure the process-lifetime worker is bound.
    pub fn configure_network_output_enabled(&self, enabled: bool) -> bool {
        self.configure_binding(SacnOutputBinding::from_enabled(enabled))
    }

    /// Configures sACN output binding and rate from IO settings and the current interface
    /// snapshot; a rate or sync change applies to the running worker without rebinding it.
    pub fn sync_with_settings(
        &self,
        settings: &IoRuntimeSettings,
        interface_state: &NetworkInterfaceState,
        transport_policy: &TransportRuntimePolicy,
    ) -> bool {
        self.period.set(settings.dmx_output_interval());
        self.client.set_sync_universe(settings.sacn_sync_address());
        self.configure_binding(SacnOutputBinding::from_settings(
            settings,
            interface_state,
            transport_policy,
        ))
    }

    fn configure_binding(&self, binding: SacnOutputBinding) -> bool {
        let has_worker = self.slot.rebind(
            binding,
            |binding| SacnWorker::spawn(binding, self.client.clone(), self.period.clone()),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a frame for `universe` multicast with all channels at zero.
    fn frame(universe: u16) -> SacnFrame {
        SacnFrame {
            universe,
            unicast_ip: None,
            data: [0; MAX_CHANNELS_PER_UNIVERSE],
        }
    }

    /// In-memory stand-in for an sACN source that records terminations and can fail them.
    #[derive(Default)]
    struct FakeTerminator {
        /// Universes the fake source still has registered.
        universes: HashSet<u16>,
        /// When set, every termination fails with this I/O error kind before deregistering,
        /// as the real source does when a termination packet cannot be sent.
        send_error: Option<std::io::ErrorKind>,
        /// Universes passed to `terminate_stream`, in call order.
        terminated: Vec<u16>,
    }

    impl FakeTerminator {
        /// Builds a fake source with `universes` registered.
        fn with_universes(universes: &[u16]) -> Self {
            Self {
                universes: universes.iter().copied().collect(),
                ..Self::default()
            }
        }
    }

    impl StreamTerminator for FakeTerminator {
        /// Mirrors `SacnSource::terminate_stream`: rejects unknown universes, fails on a send
        /// error without deregistering, and otherwise deregisters the universe.
        fn terminate_stream(&mut self, universe: u16, _start_code: u8) -> Result<(), SacnError> {
            self.terminated.push(universe);
            if !self.universes.contains(&universe) {
                return Err(SacnError::UniverseNotRegistered(universe));
            }
            if let Some(kind) = self.send_error {
                return Err(SacnError::Io(std::io::Error::from(kind)));
            }
            self.universes.remove(&universe);
            Ok(())
        }
    }

    /// A universe that stops being published is terminated and dropped from the source, while
    /// universes still published are neither terminated nor forgotten.
    #[test]
    fn unpublished_universes_are_terminated() {
        let mut source = FakeTerminator::with_universes(&[1, 2]);
        let mut registered = HashSet::from([1, 2]);

        terminate_unpublished_universes(&mut source, &mut registered, &[frame(1)], None);

        assert_eq!(registered, HashSet::from([1]));
        assert_eq!(source.universes, HashSet::from([1]));
        assert_eq!(source.terminated, vec![2]);
    }

    /// A termination that cannot be sent leaves the universe registered so the next tick retries
    /// it, keeping the worker's bookkeeping in step with the source's discovery list.
    #[test]
    fn failed_termination_is_retried() {
        let mut source = FakeTerminator::with_universes(&[2]);
        source.send_error = Some(std::io::ErrorKind::NetworkUnreachable);
        let mut registered = HashSet::from([2]);

        terminate_unpublished_universes(&mut source, &mut registered, &[], None);
        assert_eq!(registered, HashSet::from([2]));

        source.send_error = None;
        terminate_unpublished_universes(&mut source, &mut registered, &[], None);

        assert!(registered.is_empty());
        assert!(source.universes.is_empty());
        assert_eq!(source.terminated, vec![2, 2]);
    }

    /// A universe the source already dropped is forgotten instead of being retried forever.
    #[test]
    fn universe_unknown_to_source_is_forgotten() {
        let mut source = FakeTerminator::default();
        let mut registered = HashSet::from([3]);

        terminate_unpublished_universes(&mut source, &mut registered, &[], None);

        assert!(registered.is_empty());
        assert_eq!(source.terminated, vec![3]);
    }

    /// The sync universe stays registered while sync uses it even though no data is published
    /// on it, and is terminated once sync stops using it.
    #[test]
    fn sync_universe_stays_registered_while_in_use() {
        let mut source = FakeTerminator::with_universes(&[1, 900]);
        let mut registered = HashSet::from([1, 900]);

        terminate_unpublished_universes(&mut source, &mut registered, &[frame(1)], Some(900));
        assert_eq!(registered, HashSet::from([1, 900]));
        assert!(source.terminated.is_empty());

        terminate_unpublished_universes(&mut source, &mut registered, &[frame(1)], None);
        assert_eq!(registered, HashSet::from([1]));
        assert_eq!(source.universes, HashSet::from([1]));
        assert_eq!(source.terminated, vec![900]);
    }

    /// With sync on, every data packet names the sync universe and the tick ends with one sync
    /// packet per destination; with sync off, data names no sync universe and no sync packet
    /// follows.
    #[test]
    fn sync_tick_marks_data_and_sends_sync_packet() {
        use sacn::packet::{AcnRootLayerProtocol, E131RootLayerData};

        let receiver = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind receiver");
        let port = receiver.local_addr().expect("receiver address").port();
        receiver
            .set_read_timeout(Some(Duration::from_millis(200)))
            .expect("set timeout");
        let mut source = SacnSource::with_ip("test", sacn_output_bind_addr(Ipv4Addr::LOCALHOST))
            .expect("open sACN source");
        source.set_is_sending_discovery(false);
        let mut registered = HashSet::new();
        let client = SacnOutputClient::default();
        client.publish(
            [1, 2]
                .map(|universe| SacnFrame {
                    unicast_ip: Some(Ipv4Addr::LOCALHOST),
                    ..frame(universe)
                })
                .to_vec(),
        );

        /// Receives every packet sent within the read timeout, as (is_sync, sync address).
        fn packets(receiver: &std::net::UdpSocket) -> Vec<(bool, u16)> {
            let mut buffer = [0u8; 1144];
            let mut packets = Vec::new();
            while let Ok(length) = receiver.recv(&mut buffer) {
                let packet = AcnRootLayerProtocol::parse(&buffer[..length]).expect("parse sACN");
                packets.push(match packet.pdu.data {
                    E131RootLayerData::DataPacket(data) => (false, data.synchronization_address),
                    E131RootLayerData::SynchronizationPacket(sync) => {
                        (true, sync.synchronization_address)
                    }
                    E131RootLayerData::UniverseDiscoveryPacket(_) => continue,
                });
            }
            packets
        }

        let _ = transmit_tick(&mut source, &mut registered, &client, port);
        assert_eq!(packets(&receiver), vec![(false, 0), (false, 0)]);

        client.set_sync_universe(Some(900));
        let _ = transmit_tick(&mut source, &mut registered, &client, port);
        assert_eq!(
            packets(&receiver),
            vec![(false, 900), (false, 900), (true, 900)]
        );
        assert!(registered.contains(&900));
    }
}
