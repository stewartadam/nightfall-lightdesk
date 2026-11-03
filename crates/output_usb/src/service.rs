// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;
use std::sync::mpsc::{Receiver as StdReceiver, Sender as StdSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use bevy_ecs::prelude::Resource;
use futures_util::StreamExt;
use nightfall_engine::prelude::{
    DebugPanicTarget, is_process_shutdown_requested, maybe_trigger_debug_worker_panic,
};
use nightfall_io::prelude::{
    DEFAULT_USB_DMX_DEVICE_SELECTOR, OPEN_DMX_PRODUCT_ID, OPEN_DMX_VENDOR_ID, UDMX_PRODUCT_ID,
    UDMX_VENDOR_ID, is_usb_dmx_device_id, usb_dmx_device_selector_matches,
};
use nightfall_service_host::prelude::{WorkerSlot, process_singleton};
use nusb::MaybeFuture;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::open_dmx::{OpenDmxPort, UsbDeviceIdentity};

/// uDMX output client handle.
#[derive(Clone, Default, Resource)]
pub struct UdmxOutputClient {
    command_tx: Arc<Mutex<Option<UnboundedSender<UdmxCommand>>>>,
}

impl UdmxOutputClient {
    /// Submit a full uDMX frame.
    ///
    /// Returns `false` when the service is unavailable.
    pub fn submit_frame(&self, device: &str, data: &[u8]) -> bool {
        {
            let maybe_sender = self
                .command_tx
                .lock()
                .ok()
                .and_then(|sender| sender.clone());
            let Some(command_tx) = maybe_sender else {
                return false;
            };

            command_tx
                .send(UdmxCommand::SubmitFrame {
                    device: device.to_string(),
                    data: data.to_vec(),
                })
                .is_ok()
        }
    }

    pub(crate) fn set_sender(&self, sender: Option<UnboundedSender<UdmxCommand>>) {
        if let Ok(mut command_tx) = self.command_tx.lock() {
            *command_tx = sender;
        }
    }
}

/// Commands sent to the uDMX worker.
#[derive(Debug)]
pub enum UdmxCommand {
    /// Submit full frame data for output.
    SubmitFrame {
        /// Selected USB device selector.
        device: String,
        /// Full DMX frame data.
        data: Vec<u8>,
    },
    /// Shutdown worker loop.
    Shutdown,
}

const UDMX_WORKER_IDLE_SLEEP: Duration = Duration::from_millis(10);
const UDMX_RETRY_INTERVAL: Duration = Duration::from_millis(500);
const UDMX_RECONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long an Open DMX port may go without frames before it is closed, releasing the serial
/// port once its target is removed or USB output is disabled.
const OPEN_DMX_IDLE_TIMEOUT: Duration = Duration::from_secs(1);

/// Minimum interval between frames sent to a uDMX device (15Hz = ~66.66ms).
/// See: https://www.illutzminator.de/udmx-timing.html?L=1
const UDMX_FRAME_INTERVAL: Duration = Duration::from_micros(66667);

/// Device-presence changes observed by the uDMX hotplug listener.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UdmxHotplugEvent<DeviceId = nusb::DeviceId> {
    TargetConnected,
    DeviceDisconnected(DeviceId),
}

/// Opened USB DMX device connection and device ID used by the output worker.
struct OpenedUdmxDevice<DeviceId = nusb::DeviceId, Connection = UsbDmxConnection> {
    selector: String,
    id: DeviceId,
    connection: Connection,
}

/// Driver-specific handle for an opened USB DMX device.
enum UsbDmxConnection {
    /// uDMX interface claimed over raw USB; the device refreshes the DMX line itself.
    Udmx {
        interface: nusb::Interface,
        /// When the last frame was sent, for rate limiting to [`UDMX_FRAME_INTERVAL`].
        last_sent_at: Option<Instant>,
        /// Latest submitted frame not yet sent.
        pending_frame: Option<Vec<u8>>,
    },
    /// Open DMX serial port whose writer thread refreshes the DMX line.
    OpenDmx {
        port: OpenDmxPort,
        /// When a frame was last submitted, for closing ports nothing outputs to any more.
        last_submitted_at: Instant,
    },
}

impl UsbDmxConnection {
    /// Wraps a claimed uDMX interface with no frame sent yet.
    fn udmx(interface: nusb::Interface) -> Self {
        Self::Udmx {
            interface,
            last_sent_at: None,
            pending_frame: None,
        }
    }

    /// Hands a frame to the driver: uDMX holds it until its next send is due, while Open DMX
    /// makes it the frame its writer thread refreshes.
    fn queue_frame(&mut self, data: &[u8]) {
        match self {
            Self::Udmx { pending_frame, .. } => *pending_frame = Some(data.to_vec()),
            Self::OpenDmx {
                port,
                last_submitted_at,
            } => {
                port.submit(data);
                *last_submitted_at = Instant::now();
            }
        }
    }
}

/// Whether an opened device should stay in the worker's device map.
enum DeviceStatus {
    Active,
    /// The device is gone or its driver stopped; reopen it on a later frame.
    Lost,
    /// No output reaches the device any more; release it.
    Idle,
}

type ConnectedUdmxDevice = OpenedUdmxDevice<nusb::DeviceId, UsbDmxConnection>;
type UdmxHotplugSubscribers = Arc<Mutex<Vec<StdSender<()>>>>;

/// Outcomes from attempting to open a USB DMX device during startup or reconnect.
enum InitDeviceResult<DeviceId = nusb::DeviceId, Connection = UsbDmxConnection> {
    Connected(OpenedUdmxDevice<DeviceId, Connection>),
    NotFound,
    RetryableFailure,
}

/// Thread handle and shutdown signal for the uDMX hotplug watcher.
struct UdmxHotplugListener {
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl UdmxHotplugListener {
    fn shutdown(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }
}

/// Worker handles used to submit uDMX frames and shut down device monitoring.
pub(crate) struct UdmxWorker {
    /// Command sender used to queue frame submissions and shutdown requests.
    pub(crate) command_tx: UnboundedSender<UdmxCommand>,
    join_handle: Option<std::thread::JoinHandle<()>>,
    hotplug_listener: Option<UdmxHotplugListener>,
}

impl UdmxWorker {
    pub(crate) fn spawn(hotplug_subscribers: UdmxHotplugSubscribers) -> Option<Self> {
        let (hotplug_event_rx, hotplug_listener) = spawn_hotplug_listener(hotplug_subscribers);

        let (command_tx, mut command_rx) = unbounded_channel::<UdmxCommand>();
        let join_handle = thread::Builder::new()
            .name("udmx-service".to_string())
            .spawn(move || {
                let mut devices: HashMap<String, ConnectedUdmxDevice> = HashMap::new();
                let mut next_retry_at: HashMap<String, Instant> = HashMap::new();
                loop {
                    maybe_trigger_debug_worker_panic(DebugPanicTarget::OutputUdmxThread);
                    if handle_hotplug_events(&mut devices, &hotplug_event_rx) {
                        next_retry_at.clear();
                    }

                    if is_process_shutdown_requested() {
                        break;
                    }

                    let command = match command_rx.try_recv() {
                        Ok(command) => Some(command),
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty) => None,
                        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
                    };

                    match &command {
                        Some(UdmxCommand::SubmitFrame { device, data }) => {
                            let selector = normalize_device_selector(device);
                            if !devices.contains_key(&selector) {
                                let retry_at = next_retry_at
                                    .get(&selector)
                                    .copied()
                                    .unwrap_or_else(Instant::now);
                                if Instant::now() >= retry_at {
                                    if let Some(opened_device) = init_device(&selector) {
                                        tracing::info!(selector, "USB DMX device connected");
                                        devices.insert(selector.clone(), opened_device);
                                    }
                                    next_retry_at.insert(
                                        selector.clone(),
                                        Instant::now() + UDMX_RETRY_INTERVAL,
                                    );
                                }
                            }
                            if let Some(current_device) = devices.get_mut(&selector) {
                                current_device.connection.queue_frame(data);
                            }
                        }
                        Some(UdmxCommand::Shutdown) => break,
                        None => {}
                    }

                    service_devices(&mut devices, &mut next_retry_at);
                    if command.is_none() {
                        thread::sleep(UDMX_WORKER_IDLE_SLEEP);
                    }
                }
                tracing::debug!("uDMX service worker exiting");
            })
            .expect("failed to spawn uDMX service worker");

        tracing::debug!("uDMX service worker started");
        Some(Self {
            command_tx,
            join_handle: Some(join_handle),
            hotplug_listener,
        })
    }

    pub(crate) fn shutdown(&mut self) {
        let _ = self.command_tx.send(UdmxCommand::Shutdown);
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
        if let Some(hotplug_listener) = self.hotplug_listener.as_mut() {
            hotplug_listener.shutdown();
        }
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.join_handle
            .as_ref()
            .is_some_and(|join_handle| !join_handle.is_finished())
    }
}

/// Starts the nusb hotplug listener used by output reconnects and UI discovery refresh.
fn spawn_hotplug_listener(
    hotplug_subscribers: UdmxHotplugSubscribers,
) -> (
    Option<std::sync::mpsc::Receiver<UdmxHotplugEvent>>,
    Option<UdmxHotplugListener>,
) {
    let watch = match nusb::watch_devices() {
        Ok(watch) => watch,
        Err(error) => {
            tracing::warn!("failed to start uDMX hotplug listener: {}", error);
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
                                    if is_usb_dmx_device_id(device.vendor_id(), device.product_id()) =>
                                {
                                    notify_hotplug_subscribers(&hotplug_subscribers);
                                    event_tx.send(UdmxHotplugEvent::TargetConnected)
                                }
                                nusb::hotplug::HotplugEvent::Disconnected(device_id) => {
                                    notify_hotplug_subscribers(&hotplug_subscribers);
                                    event_tx.send(UdmxHotplugEvent::DeviceDisconnected(device_id))
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
            tracing::debug!("uDMX hotplug listener exiting");
        })
        .expect("failed to spawn uDMX hotplug listener");

    (
        Some(event_rx),
        Some(UdmxHotplugListener {
            stop_tx: Some(stop_tx),
            join_handle: Some(join_handle),
        }),
    )
}

/// Notifies all active USB hotplug subscribers and drops disconnected receivers.
fn notify_hotplug_subscribers(hotplug_subscribers: &UdmxHotplugSubscribers) {
    let Ok(mut hotplug_subscribers) = hotplug_subscribers.lock() else {
        return;
    };
    hotplug_subscribers.retain(|subscriber| subscriber.send(()).is_ok());
}

fn handle_hotplug_events<DeviceId: Eq, Connection>(
    devices: &mut HashMap<String, OpenedUdmxDevice<DeviceId, Connection>>,
    hotplug_event_rx: &Option<std::sync::mpsc::Receiver<UdmxHotplugEvent<DeviceId>>>,
) -> bool {
    let Some(hotplug_event_rx) = hotplug_event_rx.as_ref() else {
        return false;
    };

    let mut changed = false;
    while let Ok(event) = hotplug_event_rx.try_recv() {
        match event {
            UdmxHotplugEvent::TargetConnected => {
                changed = true;
            }
            UdmxHotplugEvent::DeviceDisconnected(device_id) => {
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

/// Sends due frames and drops devices that were lost or no longer receive output.
fn service_devices(
    devices: &mut HashMap<String, ConnectedUdmxDevice>,
    next_retry_at: &mut HashMap<String, Instant>,
) {
    devices.retain(|selector, device| match service_device(device) {
        DeviceStatus::Active => true,
        DeviceStatus::Lost => {
            tracing::error!(
                selector,
                "USB DMX output worker disabling output after disconnect"
            );
            next_retry_at.remove(selector);
            false
        }
        DeviceStatus::Idle => {
            tracing::info!(
                selector,
                "Closing USB DMX device that no longer receives output"
            );
            false
        }
    });
}

/// Sends a uDMX device's pending frame once [`UDMX_FRAME_INTERVAL`] has passed since its last
/// send, and checks an Open DMX port's writer is alive and still receiving frames.
fn service_device(device: &mut ConnectedUdmxDevice) -> DeviceStatus {
    let now = Instant::now();
    match &mut device.connection {
        UsbDmxConnection::Udmx {
            last_sent_at,
            pending_frame,
            ..
        } => {
            if last_sent_at
                .is_some_and(|last_sent_at| now.duration_since(last_sent_at) < UDMX_FRAME_INTERVAL)
            {
                return DeviceStatus::Active;
            }
            let Some(frame) = pending_frame.take() else {
                return DeviceStatus::Active;
            };
            *last_sent_at = Some(now);
            send_udmx_frame(device, &frame)
        }
        UsbDmxConnection::OpenDmx { port, .. } if !port.is_alive() => DeviceStatus::Lost,
        UsbDmxConnection::OpenDmx {
            last_submitted_at, ..
        } if now.duration_since(*last_submitted_at) > OPEN_DMX_IDLE_TIMEOUT => DeviceStatus::Idle,
        UsbDmxConnection::OpenDmx { .. } => DeviceStatus::Active,
    }
}

/// Send a DMX frame to a uDMX device over USB and attempt reconnect when disconnect is
/// detected.
fn send_udmx_frame(device: &mut ConnectedUdmxDevice, data: &[u8]) -> DeviceStatus {
    let UsbDmxConnection::Udmx { interface, .. } = &device.connection else {
        unreachable!("send_udmx_frame called for a non-uDMX device");
    };
    let control_out = nusb::transfer::ControlOut {
        control_type: nusb::transfer::ControlType::Vendor,
        recipient: nusb::transfer::Recipient::Interface,
        request: 2,               // UDMX_SET_CHANNEL_RANGE
        value: data.len() as u16, // number of channels
        index: 0,                 // starting channel
        data,
    };

    match interface
        .control_out(control_out, Duration::from_millis(500))
        .wait()
    {
        Ok(()) => DeviceStatus::Active,
        Err(error) => {
            tracing::warn!("uDMX USB transfer failed: {}", error);
            if error.to_string().contains("device disconnected") {
                tracing::error!("uDMX device disconnected. Attempting reconnect...");
                let selector = device.selector.clone();
                if let Some(new_device) =
                    reconnect_with_timeout(UDMX_RECONNECT_TIMEOUT, UDMX_RETRY_INTERVAL, || {
                        init_device(&selector)
                    })
                {
                    tracing::info!(selector, "uDMX reconnect succeeded");
                    *device = new_device;
                    return DeviceStatus::Active;
                }
                return DeviceStatus::Lost;
            }
            DeviceStatus::Active
        }
    }
}

/// Retry USB device initialization until timeout elapses.
fn reconnect_with_timeout<DeviceId, Connection>(
    timeout: Duration,
    retry_interval: Duration,
    mut init_device: impl FnMut() -> Option<OpenedUdmxDevice<DeviceId, Connection>>,
) -> Option<OpenedUdmxDevice<DeviceId, Connection>> {
    let start_time = Instant::now();
    while start_time.elapsed() < timeout {
        if let Some(device) = init_device() {
            return Some(device);
        }
        thread::sleep(retry_interval);
    }
    None
}

/// Normalizes empty USB device selectors to the default uDMX selector.
fn normalize_device_selector(device: &str) -> String {
    let device = device.trim();
    if device.is_empty() {
        DEFAULT_USB_DMX_DEVICE_SELECTOR.to_string()
    } else {
        device.to_string()
    }
}

/// Returns the stable physical-location selector key for a USB device.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn usb_device_location_key(device: &nusb::DeviceInfo) -> Option<String> {
    let bus_id = device.bus_id();
    if !device.port_chain().is_empty() {
        let port_chain = device
            .port_chain()
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(".");
        return Some(format!("port:{bus_id}:{port_chain}"));
    }
    Some(format!("addr:{bus_id}:{}", device.device_address()))
}

/// Returns no physical-location selector key when nusb does not expose one.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn usb_device_location_key(_device: &nusb::DeviceInfo) -> Option<String> {
    None
}

/// Returns the nusb bus ID of a USB device.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn usb_device_bus_id(device: &nusb::DeviceInfo) -> &str {
    device.bus_id()
}

/// Returns no bus ID on platforms where nusb does not expose one.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn usb_device_bus_id(_device: &nusb::DeviceInfo) -> &str {
    ""
}

/// Returns the hub port chain of a USB device.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn usb_device_port_chain(device: &nusb::DeviceInfo) -> &[u8] {
    device.port_chain()
}

/// Returns no port chain on platforms where nusb does not expose one.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn usb_device_port_chain(_device: &nusb::DeviceInfo) -> &[u8] {
    &[]
}

/// Returns whether a saved selector resolves to a currently visible USB device.
fn selector_matches_device(
    selector: &str,
    device: &nusb::DeviceInfo,
    serial_identity_counts: &HashMap<(u16, u16, String), usize>,
) -> bool {
    let location_key = usb_device_location_key(device);
    let fallback_id = format!("{:?}", device.id());
    let duplicate_serial = usb_serial_identity_key(device)
        .and_then(|identity_key| serial_identity_counts.get(&identity_key).copied())
        .is_some_and(|count| count > 1);
    usb_dmx_device_selector_matches(
        selector,
        device.vendor_id(),
        device.product_id(),
        device.serial_number(),
        location_key.as_deref(),
        &fallback_id,
        duplicate_serial,
    )
}

/// Builds the serial-based identity key used to detect duplicate USB serial descriptors.
fn usb_serial_identity_key(device: &nusb::DeviceInfo) -> Option<(u16, u16, String)> {
    device
        .serial_number()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|serial_number| {
            (
                device.vendor_id(),
                device.product_id(),
                serial_number.to_string(),
            )
        })
}

/// Locate and open the configured uDMX interface.
fn init_device(selector: &str) -> Option<ConnectedUdmxDevice> {
    match try_init_device(selector) {
        InitDeviceResult::Connected(device) => Some(device),
        InitDeviceResult::NotFound | InitDeviceResult::RetryableFailure => None,
    }
}

fn try_init_device(selector: &str) -> InitDeviceResult {
    let selector = normalize_device_selector(selector);
    let devices = match nusb::list_devices().wait() {
        Ok(devices) => devices,
        Err(error) => {
            tracing::warn!("failed to enumerate USB devices: {}", error);
            return InitDeviceResult::RetryableFailure;
        }
    };

    let mut devices = devices
        .filter(|device| is_usb_dmx_device_id(device.vendor_id(), device.product_id()))
        .collect::<Vec<_>>();
    // The default selector only takes uDMX interfaces: the FTDI chips Open DMX dongles use also
    // sit in generic USB serial adapters, so those must be picked explicitly.
    if selector == DEFAULT_USB_DMX_DEVICE_SELECTOR {
        devices.retain(|device| {
            (device.vendor_id(), device.product_id()) == (UDMX_VENDOR_ID, UDMX_PRODUCT_ID)
        });
    }
    let mut serial_identity_counts = HashMap::<(u16, u16, String), usize>::new();
    for device in &devices {
        if let Some(identity_key) = usb_serial_identity_key(device) {
            *serial_identity_counts.entry(identity_key).or_default() += 1;
        }
    }

    let mut selected_device = None;
    for device in devices {
        if selector == DEFAULT_USB_DMX_DEVICE_SELECTOR
            || selector_matches_device(&selector, &device, &serial_identity_counts)
        {
            selected_device = Some(device);
            break;
        }
    }

    let Some(device) = selected_device else {
        return InitDeviceResult::NotFound;
    };

    if (device.vendor_id(), device.product_id()) == (OPEN_DMX_VENDOR_ID, OPEN_DMX_PRODUCT_ID) {
        return match OpenDmxPort::open(&UsbDeviceIdentity {
            vendor_id: device.vendor_id(),
            product_id: device.product_id(),
            serial_number: device.serial_number(),
            bus_id: usb_device_bus_id(&device),
            port_chain: usb_device_port_chain(&device),
        }) {
            Some(port) => InitDeviceResult::Connected(OpenedUdmxDevice {
                selector,
                id: device.id(),
                connection: UsbDmxConnection::OpenDmx {
                    port,
                    last_submitted_at: Instant::now(),
                },
            }),
            None => InitDeviceResult::RetryableFailure,
        };
    }

    let opened = match device.open().wait() {
        Ok(device) => device,
        Err(error) => {
            tracing::error!("failed to open uDMX device: {}", error);
            return InitDeviceResult::RetryableFailure;
        }
    };

    match opened.claim_interface(0).wait() {
        Ok(interface) => InitDeviceResult::Connected(OpenedUdmxDevice {
            selector,
            id: device.id(),
            connection: UsbDmxConnection::udmx(interface),
        }),
        Err(_) => {
            if let Err(error) = opened.set_configuration(1).wait() {
                tracing::error!("failed to set uDMX configuration: {}", error);
                return InitDeviceResult::RetryableFailure;
            }

            match opened.claim_interface(0).wait() {
                Ok(interface) => InitDeviceResult::Connected(OpenedUdmxDevice {
                    selector,
                    id: device.id(),
                    connection: UsbDmxConnection::udmx(interface),
                }),
                Err(error) => {
                    tracing::error!("failed to claim uDMX interface: {}", error);
                    InitDeviceResult::RetryableFailure
                }
            }
        }
    }
}

/// Process-lifetime uDMX output service host.
pub struct UdmxOutputService {
    slot: WorkerSlot<UdmxWorker>,
    client: UdmxOutputClient,
    hotplug_subscribers: UdmxHotplugSubscribers,
}

impl UdmxOutputService {
    fn new() -> Self {
        Self {
            slot: WorkerSlot::new(),
            client: UdmxOutputClient::default(),
            hotplug_subscribers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Ensure a process-lifetime uDMX worker is running.
    pub fn ensure_started(&self) -> bool {
        let hotplug_subscribers = self.hotplug_subscribers.clone();
        let has_worker = self.slot.ensure(
            move || UdmxWorker::spawn(hotplug_subscribers.clone()),
            |worker| worker.shutdown(),
            |worker| worker.is_alive(),
        );
        let sender = self
            .slot
            .with_worker(|worker| worker.map(|worker| worker.command_tx.clone()));
        self.client.set_sender(sender);
        has_worker
    }

    /// Cloneable uDMX output client for insertion into ECS worlds.
    pub fn client(&self) -> UdmxOutputClient {
        self.client.clone()
    }

    /// Subscribe to compatible USB DMX attach/detach notifications from the uDMX hotplug watcher.
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
        self.client.set_sender(None);
    }
}

impl Drop for UdmxOutputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Return the process-wide uDMX output service.
pub fn process_udmx_output_service() -> &'static UdmxOutputService {
    static PROCESS_SERVICE: OnceLock<UdmxOutputService> = OnceLock::new();
    process_singleton(&PROCESS_SERVICE, UdmxOutputService::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_hotplug_subscribers_sends_events_and_drops_closed_receivers() {
        let subscribers: UdmxHotplugSubscribers = Arc::new(Mutex::new(Vec::new()));
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

    #[test]
    fn handle_hotplug_events_reports_target_connection() {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        event_tx
            .send(UdmxHotplugEvent::<&'static str>::TargetConnected)
            .unwrap();
        drop(event_tx);

        let mut devices: HashMap<String, OpenedUdmxDevice<&'static str, &'static str>> =
            HashMap::new();
        let changed = handle_hotplug_events(&mut devices, &Some(event_rx));

        assert!(changed);
        assert!(devices.is_empty());
    }

    #[test]
    fn handle_hotplug_events_clears_current_device_on_disconnect() {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        event_tx
            .send(UdmxHotplugEvent::DeviceDisconnected("udmx-1"))
            .unwrap();
        drop(event_tx);

        let mut devices = HashMap::from([(
            "device-a".to_string(),
            OpenedUdmxDevice {
                selector: "device-a".to_string(),
                id: "udmx-1",
                connection: "iface-a",
            },
        )]);
        let changed = handle_hotplug_events(&mut devices, &Some(event_rx));

        assert!(changed);
        assert!(devices.is_empty());
    }

    #[test]
    fn handle_hotplug_events_keeps_other_devices_on_disconnect() {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        event_tx
            .send(UdmxHotplugEvent::DeviceDisconnected("udmx-1"))
            .unwrap();
        drop(event_tx);

        let mut devices = HashMap::from([
            (
                "device-a".to_string(),
                OpenedUdmxDevice {
                    selector: "device-a".to_string(),
                    id: "udmx-1",
                    connection: "iface-a",
                },
            ),
            (
                "device-b".to_string(),
                OpenedUdmxDevice {
                    selector: "device-b".to_string(),
                    id: "udmx-2",
                    connection: "iface-b",
                },
            ),
        ]);
        let changed = handle_hotplug_events(&mut devices, &Some(event_rx));

        assert!(changed);
        assert!(!devices.contains_key("device-a"));
        assert!(devices.contains_key("device-b"));
    }

    /// Retries a failing device open until it succeeds. The timeout is far above the time three
    /// attempts take so a descheduled test thread cannot run out the clock between attempts.
    #[test]
    fn reconnect_with_timeout_retries_until_device_is_ready() {
        let mut init_attempts = 0;
        let device = reconnect_with_timeout(Duration::from_secs(5), Duration::ZERO, || {
            init_attempts += 1;
            (init_attempts == 3).then_some(OpenedUdmxDevice {
                selector: "device-a".to_string(),
                id: "udmx-1",
                connection: "iface-a",
            })
        });

        assert_eq!(init_attempts, 3);
        assert_eq!(device.as_ref().map(|device| device.id), Some("udmx-1"));
    }
}
