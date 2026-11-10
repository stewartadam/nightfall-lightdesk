// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Process-lifetime USB DMX output worker and the hotplug watcher that feeds it.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::ops::ControlFlow;
use std::sync::mpsc::{Receiver as StdReceiver, Sender as StdSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use bevy_ecs::prelude::Resource;
use futures_util::StreamExt;
use nightfall_engine::prelude::{
    DebugPanicTarget, is_process_shutdown_requested, maybe_trigger_debug_worker_panic,
};
use nightfall_io::prelude::{DEFAULT_USB_DMX_DEVICE_SELECTOR, IoRuntimeSettings};
use nightfall_service_host::prelude::{
    FixedRatePeriod, FixedRateWorker, WorkerSlot, process_singleton,
};

use crate::discovery::discover_devices;
use crate::driver::{OpenError, Universe, UsbDmxConnection, UsbDmxFamily, WriteOutcome};

/// One universe the worker writes to its USB device on every tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbDmxFrame {
    /// Selected USB device selector.
    pub device: String,
    /// Channel values.
    pub data: Universe,
}

/// USB DMX output client used inside ECS worlds.
///
/// Engine frames publish the latest composed universes here; the output worker writes
/// whatever was published last on the shared tick grid at the configured output rate.
#[derive(Clone, Default, Resource)]
pub struct UsbDmxOutputClient {
    frames: Arc<Mutex<Arc<Vec<UsbDmxFrame>>>>,
}

impl UsbDmxOutputClient {
    /// Replaces the frames the worker writes from its next tick onwards.
    pub fn publish(&self, frames: Vec<UsbDmxFrame>) {
        if let Ok(mut published) = self.frames.lock() {
            *published = Arc::new(frames);
        }
    }

    /// Returns the frames the worker writes on its next tick.
    pub(crate) fn published(&self) -> Arc<Vec<UsbDmxFrame>> {
        self.frames
            .lock()
            .map(|frames| Arc::clone(&frames))
            .unwrap_or_default()
    }
}

/// Wait before trying again to open a device that was missing or failed to open.
const OPEN_RETRY_INTERVAL: Duration = Duration::from_millis(500);

/// Device-presence changes observed by the USB hotplug listener.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UsbHotplugEvent<DeviceId = nusb::DeviceId> {
    TargetConnected,
    DeviceDisconnected(DeviceId),
}

/// An open USB DMX device and the OS device ID hotplug events name it by.
struct OpenedDevice<DeviceId = nusb::DeviceId, Connection = UsbDmxConnection> {
    id: DeviceId,
    connection: Connection,
}

type UsbHotplugSubscribers = Arc<Mutex<Vec<StdSender<()>>>>;

/// Thread handle and shutdown signal for the USB hotplug watcher.
struct UsbHotplugListener {
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl UsbHotplugListener {
    /// Signals the watcher to stop and waits for its thread to exit.
    fn shutdown(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }
}

/// Worker that writes the latest published USB DMX frames on the shared tick grid, plus the
/// hotplug watcher that reports device changes to it.
pub(crate) struct UsbDmxWorker {
    worker: FixedRateWorker,
    hotplug_listener: Option<UsbHotplugListener>,
}

impl UsbDmxWorker {
    /// Starts the hotplug watcher and a worker that writes `client`'s published frames on
    /// every tick of `period`.
    pub(crate) fn spawn(
        hotplug_subscribers: UsbHotplugSubscribers,
        client: UsbDmxOutputClient,
        period: FixedRatePeriod,
    ) -> Option<Self> {
        let (hotplug_event_rx, hotplug_listener) = spawn_hotplug_listener(hotplug_subscribers);
        let mut devices = UsbDmxDevices::new(hotplug_event_rx);
        let spawned = FixedRateWorker::spawn("usb-dmx-service", period, move || {
            maybe_trigger_debug_worker_panic(DebugPanicTarget::OutputUsbThread);
            if is_process_shutdown_requested() {
                return ControlFlow::Break(());
            }
            devices.write(&client.published());
            ControlFlow::Continue(())
        });
        match spawned {
            Ok(worker) => {
                tracing::debug!("USB DMX service worker started");
                Some(Self {
                    worker,
                    hotplug_listener,
                })
            }
            Err(error) => {
                tracing::warn!(?error, "Could not start USB DMX output worker");
                let mut hotplug_listener = hotplug_listener;
                if let Some(listener) = hotplug_listener.as_mut() {
                    listener.shutdown();
                }
                None
            }
        }
    }

    /// Stops the output worker and the hotplug watcher and waits for both to exit.
    pub(crate) fn shutdown(&mut self) {
        self.worker.shutdown();
        if let Some(hotplug_listener) = self.hotplug_listener.as_mut() {
            hotplug_listener.shutdown();
        }
        tracing::debug!("USB DMX service worker exited");
    }

    /// Returns whether the output worker is still running.
    pub(crate) fn is_alive(&self) -> bool {
        self.worker.is_alive()
    }
}

/// Open USB DMX devices and what was last written to each, owned by the output worker thread.
struct UsbDmxDevices {
    /// Devices currently open, by normalized selector.
    open: HashMap<String, OpenedDevice>,
    /// Earliest time a device that failed to open is tried again, by normalized selector.
    next_retry_at: HashMap<String, Instant>,
    /// Channel values each open device is known to hold, by normalized selector. Missing
    /// after a device opens or a write fails, so the next write sends every channel.
    written: HashMap<String, Universe>,
    /// Attached devices that answered as no supported protocol, skipped until unplugged.
    unsupported: HashSet<nusb::DeviceId>,
    /// Selectors whose device was found but could not be opened, already reported once.
    unavailable_reported: HashSet<String>,
    /// Device attach and detach notifications from the hotplug watcher.
    hotplug_event_rx: Option<StdReceiver<UsbHotplugEvent>>,
}

impl UsbDmxDevices {
    /// Creates an empty device set fed by `hotplug_event_rx`.
    fn new(hotplug_event_rx: Option<StdReceiver<UsbHotplugEvent>>) -> Self {
        Self {
            open: HashMap::new(),
            next_retry_at: HashMap::new(),
            written: HashMap::new(),
            unsupported: HashSet::new(),
            unavailable_reported: HashSet::new(),
            hotplug_event_rx,
        }
    }

    /// Writes one tick's frames, opening devices as needed and leaving to each protocol what
    /// it must send for the device to show the frame.
    ///
    /// Devices no frame names any more, because their target was removed or USB output was
    /// turned off, are closed so other programs can use them. A write that runs past the next
    /// tick makes the worker skip that tick instead of queueing frames.
    fn write(&mut self, frames: &[UsbDmxFrame]) {
        if handle_hotplug_events(
            &mut self.open,
            &mut self.unsupported,
            &self.hotplug_event_rx,
        ) {
            self.next_retry_at.clear();
        }
        let selectors = frames
            .iter()
            .map(|frame| normalize_device_selector(&frame.device))
            .collect::<Vec<_>>();
        self.open.retain(|selector, _| selectors.contains(selector));
        self.written
            .retain(|selector, _| self.open.contains_key(selector));
        self.open_due(&selectors);

        for (frame, selector) in frames.iter().zip(selectors) {
            let Some(device) = self.open.get_mut(&selector) else {
                continue;
            };
            let written = self.written.get(&selector);
            if written == Some(&frame.data) {
                continue;
            }
            match device.connection.write(written, &frame.data) {
                WriteOutcome::Written => {
                    self.written.insert(selector, frame.data);
                }
                WriteOutcome::Failed => {
                    self.written.remove(&selector);
                }
                WriteOutcome::Disconnected => {
                    tracing::warn!(
                        selector,
                        "USB DMX device disconnected; waiting for reconnect"
                    );
                    self.open.remove(&selector);
                    self.next_retry_at.remove(&selector);
                    self.written.remove(&selector);
                }
            }
        }
    }

    /// Opens the devices for every selector that is not open and whose retry time has come,
    /// enumerating USB devices once for all of them.
    ///
    /// A device that answered as no supported protocol is skipped until it is unplugged, since
    /// probing it again would write to it and block the worker for the probe timeout.
    fn open_due(&mut self, selectors: &[String]) {
        let now = Instant::now();
        let due = selectors
            .iter()
            .filter(|selector| {
                !self.open.contains_key(*selector)
                    && self
                        .next_retry_at
                        .get(*selector)
                        .is_none_or(|retry_at| now >= *retry_at)
            })
            .cloned()
            .collect::<Vec<_>>();
        if due.is_empty() {
            return;
        }
        for selector in &due {
            self.next_retry_at
                .insert(selector.clone(), now + OPEN_RETRY_INTERVAL);
        }

        let Some(devices) = discover_devices() else {
            return;
        };
        for selector in due {
            let Some(device) = devices.iter().find(|device| {
                let id = device.info.id();
                device.matches_selector(&selector)
                    && !self.unsupported.contains(&id)
                    && !self.open.values().any(|opened| opened.id == id)
            }) else {
                continue;
            };
            match UsbDmxConnection::open(device) {
                Ok(connection) => {
                    tracing::info!(
                        selector,
                        protocol = connection.protocol_name(),
                        "USB DMX device connected"
                    );
                    self.unavailable_reported.remove(&selector);
                    self.open.insert(
                        selector,
                        OpenedDevice {
                            id: device.info.id(),
                            connection,
                        },
                    );
                }
                Err(OpenError::Unsupported) => {
                    self.unsupported.insert(device.info.id());
                }
                Err(OpenError::Unavailable) => {
                    if self.unavailable_reported.insert(selector.clone()) {
                        tracing::warn!(
                            selector,
                            "USB DMX device is present but could not be opened; retrying"
                        );
                    }
                }
            }
        }
    }
}

/// Starts the nusb hotplug listener used by output reconnects and UI discovery refresh.
fn spawn_hotplug_listener(
    hotplug_subscribers: UsbHotplugSubscribers,
) -> (
    Option<std::sync::mpsc::Receiver<UsbHotplugEvent>>,
    Option<UsbHotplugListener>,
) {
    let watch = match nusb::watch_devices() {
        Ok(watch) => watch,
        Err(error) => {
            tracing::warn!("failed to start USB hotplug listener: {}", error);
            return (None, None);
        }
    };

    let (event_tx, event_rx) = std::sync::mpsc::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let join_handle = thread::Builder::new()
        .name("nightfall-usb-hotplug-listener".to_string())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build USB hotplug listener");
            runtime.block_on(async move {
                let mut watch = watch;
                let mut stop_rx = stop_rx;
                loop {
                    tokio::select! {
                        _ = &mut stop_rx => break,
                        maybe_event = watch.next() => {
                            let Some(event) = maybe_event else {
                                break;
                            };

                            let relay_result = match event {
                                nusb::hotplug::HotplugEvent::Connected(device)
                                    if UsbDmxFamily::from_usb_id(
                                        device.vendor_id(),
                                        device.product_id(),
                                    )
                                    .is_some() =>
                                {
                                    notify_hotplug_subscribers(&hotplug_subscribers);
                                    event_tx.send(UsbHotplugEvent::TargetConnected)
                                }
                                nusb::hotplug::HotplugEvent::Disconnected(device_id) => {
                                    notify_hotplug_subscribers(&hotplug_subscribers);
                                    event_tx.send(UsbHotplugEvent::DeviceDisconnected(device_id))
                                }
                                _ => continue,
                            };

                            if relay_result.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            tracing::debug!("USB hotplug listener exiting");
        })
        .expect("failed to spawn USB hotplug listener");

    (
        Some(event_rx),
        Some(UsbHotplugListener {
            stop_tx: Some(stop_tx),
            join_handle: Some(join_handle),
        }),
    )
}

/// Notifies all active USB hotplug subscribers and drops disconnected receivers.
fn notify_hotplug_subscribers(hotplug_subscribers: &UsbHotplugSubscribers) {
    let Ok(mut hotplug_subscribers) = hotplug_subscribers.lock() else {
        return;
    };
    hotplug_subscribers.retain(|subscriber| subscriber.send(()).is_ok());
}

/// Applies pending hotplug events to the open devices, closing any that were unplugged and
/// forgetting that an unplugged device failed its probe.
///
/// Returns whether a supported device appeared or an open one went away, in which case pending
/// open retries should run right away.
fn handle_hotplug_events<DeviceId: Eq + Hash, Connection>(
    devices: &mut HashMap<String, OpenedDevice<DeviceId, Connection>>,
    unsupported: &mut HashSet<DeviceId>,
    hotplug_event_rx: &Option<std::sync::mpsc::Receiver<UsbHotplugEvent<DeviceId>>>,
) -> bool {
    let Some(hotplug_event_rx) = hotplug_event_rx.as_ref() else {
        return false;
    };

    let mut changed = false;
    while let Ok(event) = hotplug_event_rx.try_recv() {
        match event {
            UsbHotplugEvent::TargetConnected => {
                changed = true;
            }
            UsbHotplugEvent::DeviceDisconnected(device_id) => {
                unsupported.remove(&device_id);
                let removed_selectors = devices
                    .iter()
                    .filter(|(_, current_device)| current_device.id == device_id)
                    .map(|(selector, _)| selector.clone())
                    .collect::<Vec<_>>();
                for selector in removed_selectors {
                    tracing::warn!(
                        selector,
                        "USB DMX device disconnected; waiting for reconnect"
                    );
                    devices.remove(&selector);
                    changed = true;
                }
            }
        }
    }

    changed
}

/// Normalizes empty USB device selectors to the default selector.
fn normalize_device_selector(device: &str) -> String {
    let device = device.trim();
    if device.is_empty() {
        DEFAULT_USB_DMX_DEVICE_SELECTOR.to_string()
    } else {
        device.to_string()
    }
}

/// Process-lifetime USB DMX output service host.
pub struct UsbDmxOutputService {
    slot: WorkerSlot<UsbDmxWorker>,
    client: UsbDmxOutputClient,
    hotplug_subscribers: UsbHotplugSubscribers,
    period: FixedRatePeriod,
}

impl UsbDmxOutputService {
    /// Creates a service whose worker writes at the default DMX output rate until settings
    /// arrive.
    fn new() -> Self {
        Self {
            slot: WorkerSlot::new(),
            client: UsbDmxOutputClient::default(),
            hotplug_subscribers: Arc::new(Mutex::new(Vec::new())),
            period: FixedRatePeriod::new(IoRuntimeSettings::default().dmx_output_interval()),
        }
    }

    /// Ensure a process-lifetime USB DMX worker is running.
    pub fn ensure_started(&self) -> bool {
        let hotplug_subscribers = self.hotplug_subscribers.clone();
        let client = self.client.clone();
        let period = self.period.clone();
        self.slot.ensure(
            move || {
                UsbDmxWorker::spawn(hotplug_subscribers.clone(), client.clone(), period.clone())
            },
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        )
    }

    /// Writes on the DMX output rate from `settings`, retiming a running worker in place.
    pub fn sync_with_settings(&self, settings: &IoRuntimeSettings) {
        self.period.set(settings.dmx_output_interval());
    }

    /// Cloneable USB DMX output client for insertion into ECS worlds.
    pub fn client(&self) -> UsbDmxOutputClient {
        self.client.clone()
    }

    /// Subscribe to supported USB DMX attach/detach notifications from the hotplug watcher.
    pub fn subscribe_hotplug_events(&self) -> StdReceiver<()> {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        if let Ok(mut hotplug_subscribers) = self.hotplug_subscribers.lock() {
            hotplug_subscribers.push(event_tx);
        }
        event_rx
    }

    /// Shutdown process-lifetime worker.
    pub fn shutdown(&self) {
        self.slot.shutdown(|worker| worker.shutdown());
        self.client.publish(Vec::new());
    }
}

impl Drop for UsbDmxOutputService {
    /// Stops the worker when the service is dropped.
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide USB DMX output service.
pub fn process_usb_dmx_output_service() -> &'static UsbDmxOutputService {
    static PROCESS_SERVICE: OnceLock<UsbDmxOutputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, UsbDmxOutputService::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies hotplug notifications reach live subscribers and closed receivers are dropped.
    #[test]
    fn notify_hotplug_subscribers_sends_events_and_drops_closed_receivers() {
        let subscribers: UsbHotplugSubscribers = Arc::new(Mutex::new(Vec::new()));
        let (active_tx, active_rx) = std::sync::mpsc::channel();
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();
        drop(closed_rx);
        subscribers.lock().unwrap().push(active_tx);
        subscribers.lock().unwrap().push(closed_tx);

        notify_hotplug_subscribers(&subscribers);

        active_rx
            .try_recv()
            .expect("active subscriber should receive hotplug notification");
        assert_eq!(subscribers.lock().unwrap().len(), 1);
    }

    /// Verifies a supported device appearing is reported so pending opens retry right away.
    #[test]
    fn handle_hotplug_events_reports_target_connection() {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        event_tx
            .send(UsbHotplugEvent::<&'static str>::TargetConnected)
            .unwrap();
        drop(event_tx);

        let mut devices: HashMap<String, OpenedDevice<&'static str, &'static str>> = HashMap::new();
        let changed = handle_hotplug_events(&mut devices, &mut HashSet::new(), &Some(event_rx));

        assert!(changed);
        assert!(devices.is_empty());
    }

    /// Verifies unplugging a device that failed its probe makes it eligible for a new probe,
    /// while other unsupported devices stay skipped.
    #[test]
    fn handle_hotplug_events_forgets_unplugged_unsupported_device() {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        event_tx
            .send(UsbHotplugEvent::DeviceDisconnected("ftdi-1"))
            .unwrap();
        drop(event_tx);

        let mut devices: HashMap<String, OpenedDevice<&'static str, &'static str>> = HashMap::new();
        let mut unsupported = HashSet::from(["ftdi-1", "ftdi-2"]);
        handle_hotplug_events(&mut devices, &mut unsupported, &Some(event_rx));

        assert_eq!(unsupported, HashSet::from(["ftdi-2"]));
    }

    /// Verifies an unplugged device is closed.
    #[test]
    fn handle_hotplug_events_clears_current_device_on_disconnect() {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        event_tx
            .send(UsbHotplugEvent::DeviceDisconnected("usb-1"))
            .unwrap();
        drop(event_tx);

        let mut devices = HashMap::from([(
            "device-a".to_string(),
            OpenedDevice {
                id: "usb-1",
                connection: "iface-a",
            },
        )]);
        let changed = handle_hotplug_events(&mut devices, &mut HashSet::new(), &Some(event_rx));

        assert!(changed);
        assert!(devices.is_empty());
    }

    /// Verifies unplugging one device leaves the others open.
    #[test]
    fn handle_hotplug_events_keeps_other_devices_on_disconnect() {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        event_tx
            .send(UsbHotplugEvent::DeviceDisconnected("usb-1"))
            .unwrap();
        drop(event_tx);

        let mut devices = HashMap::from([
            (
                "device-a".to_string(),
                OpenedDevice {
                    id: "usb-1",
                    connection: "iface-a",
                },
            ),
            (
                "device-b".to_string(),
                OpenedDevice {
                    id: "usb-2",
                    connection: "iface-b",
                },
            ),
        ]);
        let changed = handle_hotplug_events(&mut devices, &mut HashSet::new(), &Some(event_rx));

        assert!(changed);
        assert!(!devices.contains_key("device-a"));
        assert!(devices.contains_key("device-b"));
    }
}
