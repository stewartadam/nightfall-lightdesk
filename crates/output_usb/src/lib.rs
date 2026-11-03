// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! DMX output through USB DMX interfaces: uDMX and FTDI-based Open DMX dongles.
//!
//! A process-lifetime worker writes the composed frame for each USB output target to its device,
//! picking the driver from the device's USB vendor and product ID.

#![warn(missing_docs)]

use std::sync::mpsc::{Receiver, TryRecvError};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::prelude::{
    AvailableUsbDmxDevices, TransportRuntimePolicy, UsbDmxDeviceInfo, is_usb_dmx_device_id,
    usb_dmx_device_label, usb_dmx_device_selector,
};
use nusb::MaybeFuture;

mod open_dmx;
mod service;
pub mod udmx;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::OutputUdmxUsbPlugin;
}

/// Plugin for adding uDMX USB output to the app
pub struct OutputUdmxUsbPlugin;

/// Receiver for compatible USB DMX hotplug notifications from the output service.
struct UdmxDeviceHotplugNotifications {
    event_rx: Receiver<()>,
    disconnected: bool,
}

/// Trims a USB string descriptor and treats empty descriptors as missing.
fn trimmed_usb_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Returns stable and display physical-location labels for a USB device.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn usb_device_location(device: &nusb::DeviceInfo) -> (Option<String>, Option<String>) {
    let bus_id = device.bus_id();
    if !device.port_chain().is_empty() {
        let port_chain = device
            .port_chain()
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(".");
        return (
            Some(format!("port:{bus_id}:{port_chain}")),
            Some(format!("bus {bus_id} port {port_chain}")),
        );
    }

    (
        Some(format!("addr:{bus_id}:{}", device.device_address())),
        Some(format!("bus {bus_id} address {}", device.device_address())),
    )
}

/// Returns no physical-location labels on platforms where nusb does not expose them.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn usb_device_location(_device: &nusb::DeviceInfo) -> (Option<String>, Option<String>) {
    (None, None)
}

/// Gets the compatible USB DMX devices currently visible to the host OS.
fn get_available_usb_dmx_devices() -> Vec<UsbDmxDeviceInfo> {
    let devices = match nusb::list_devices().wait() {
        Ok(devices) => devices,
        Err(error) => {
            tracing::warn!(?error, "Could not enumerate USB DMX devices");
            return Vec::new();
        }
    };

    let mut devices = devices
        .filter(|device| is_usb_dmx_device_id(device.vendor_id(), device.product_id()))
        .map(|device| {
            let vendor_id = device.vendor_id();
            let product_id = device.product_id();
            let manufacturer = trimmed_usb_string(device.manufacturer_string());
            let product = trimmed_usb_string(device.product_string());
            let serial_number = trimmed_usb_string(device.serial_number());
            let (location_key, location) = usb_device_location(&device);
            let fallback_id = format!("{:?}", device.id());
            let id = usb_dmx_device_selector(
                vendor_id,
                product_id,
                serial_number.as_deref(),
                location_key.as_deref(),
                &fallback_id,
            );
            let label = usb_dmx_device_label(
                vendor_id,
                product_id,
                manufacturer.as_deref(),
                product.as_deref(),
                serial_number.as_deref(),
                location.as_deref(),
            );

            UsbDmxDeviceInfo {
                id,
                label,
                vendor_id,
                product_id,
                manufacturer,
                product,
                serial_number,
                location,
            }
        })
        .collect::<Vec<_>>();
    devices.sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
    devices
}

/// Refreshes the desk-facing USB DMX device list after output-service hotplug events.
fn refresh_available_usb_dmx_devices(
    mut available_usb_dmx_devices: ResMut<AvailableUsbDmxDevices>,
    mut notifications: NonSendMut<UdmxDeviceHotplugNotifications>,
) {
    if notifications.disconnected {
        return;
    }

    let mut saw_event = false;
    loop {
        match notifications.event_rx.try_recv() {
            Ok(()) => saw_event = true,
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                tracing::warn!(
                    "uDMX hotplug notification stream disconnected; USB device list will not auto-refresh"
                );
                notifications.disconnected = true;
                break;
            }
        }
    }

    if !saw_event {
        return;
    }

    let next_devices = get_available_usb_dmx_devices();
    if available_usb_dmx_devices.0 != next_devices {
        tracing::info!(
            previous_count = available_usb_dmx_devices.0.len(),
            current_count = next_devices.len(),
            "USB DMX devices changed"
        );
        available_usb_dmx_devices.0 = next_devices;
    }
}

impl Plugin for OutputUdmxUsbPlugin {
    /// Registers the uDMX output worker and hotplug-driven USB discovery refresh.
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering OutputUdmxUsbPlugin");
        app.init_resource::<TransportRuntimePolicy>();
        let udmx_service = service::process_udmx_output_service();
        let _ = udmx_service.ensure_started();
        app.world_mut().resource_mut::<AvailableUsbDmxDevices>().0 =
            get_available_usb_dmx_devices();
        app.insert_non_send(UdmxDeviceHotplugNotifications {
            event_rx: udmx_service.subscribe_hotplug_events(),
            disconnected: false,
        });
        app.insert_resource(udmx_service.client());
        app.add_systems(
            Update,
            refresh_available_usb_dmx_devices.in_set(EventHandling),
        );
        app.add_systems(
            Render,
            udmx::output
                .after(nightfall_fixtures::output_frames::compose_output_frames)
                .in_set(DmxOutput),
        );
    }
}
