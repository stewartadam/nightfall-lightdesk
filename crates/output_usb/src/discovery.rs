// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Enumerates the USB DMX interfaces the host can see and resolves saved device selectors to
//! them.

use std::collections::HashMap;

use nightfall_io::prelude::{
    DEFAULT_USB_DMX_DEVICE_SELECTOR, UsbDmxDeviceInfo, usb_dmx_device_label,
    usb_dmx_device_selector_matches, usb_dmx_device_selector_with_tiebreaker,
};
use nusb::MaybeFuture;

use crate::driver::UsbDmxFamily;

/// A visible USB device of a supported interface family, with the identity its selector is
/// built from.
pub(crate) struct DiscoveredDevice {
    /// Device as nusb reports it.
    pub(crate) info: nusb::DeviceInfo,
    /// Interface family the device's vendor and product ID belong to.
    pub(crate) family: UsbDmxFamily,
    /// Trimmed USB serial number, when the device reports one.
    pub(crate) serial_number: Option<String>,
    /// Stable physical-location key, when the OS exposes one.
    pub(crate) location_key: Option<String>,
    /// Human-readable physical location, when the OS exposes one.
    pub(crate) location: Option<String>,
    /// OS device ID, used for the selector when neither serial nor location is known.
    pub(crate) fallback_id: String,
    /// Whether another visible device of the same model reports the same serial number, in which
    /// case the selector also names the physical location.
    pub(crate) duplicate_serial: bool,
}

impl DiscoveredDevice {
    /// Returns the selector this device is saved under in output targets.
    pub(crate) fn selector(&self) -> String {
        usb_dmx_device_selector_with_tiebreaker(
            self.info.vendor_id(),
            self.info.product_id(),
            self.serial_number.as_deref(),
            self.location_key.as_deref(),
            &self.fallback_id,
            self.duplicate_serial,
        )
    }

    /// Returns whether a saved selector names this device.
    ///
    /// The automatic selector takes the first uDMX interface only: the FTDI chips used by other
    /// interface families also sit in generic USB serial adapters, so those must be picked
    /// explicitly.
    pub(crate) fn matches_selector(&self, selector: &str) -> bool {
        if selector == DEFAULT_USB_DMX_DEVICE_SELECTOR {
            return self.family == UsbDmxFamily::Udmx;
        }
        usb_dmx_device_selector_matches(
            selector,
            self.info.vendor_id(),
            self.info.product_id(),
            self.serial_number.as_deref(),
            self.location_key.as_deref(),
            &self.fallback_id,
            self.duplicate_serial,
        )
    }

    /// Describes the device for the client device list.
    pub(crate) fn to_device_info(&self) -> UsbDmxDeviceInfo {
        let vendor_id = self.info.vendor_id();
        let product_id = self.info.product_id();
        let manufacturer = trimmed_usb_string(self.info.manufacturer_string());
        let product = trimmed_usb_string(self.info.product_string());
        let label = usb_dmx_device_label(
            vendor_id,
            product_id,
            manufacturer.as_deref(),
            product.as_deref(),
            self.serial_number.as_deref(),
            self.location.as_deref(),
        );
        UsbDmxDeviceInfo {
            id: self.selector(),
            label,
            vendor_id,
            product_id,
            manufacturer,
            product,
            serial_number: self.serial_number.clone(),
            location: self.location.clone(),
        }
    }
}

/// Lists the visible USB devices of every supported interface family, or `None` when the OS
/// device list cannot be read.
pub(crate) fn discover_devices() -> Option<Vec<DiscoveredDevice>> {
    let devices = match nusb::list_devices().wait() {
        Ok(devices) => devices,
        Err(error) => {
            tracing::warn!(?error, "Could not enumerate USB DMX devices");
            return None;
        }
    };

    let mut devices = devices
        .filter_map(|info| {
            let family = UsbDmxFamily::from_usb_id(info.vendor_id(), info.product_id())?;
            let (location_key, location) = usb_device_location(&info);
            Some(DiscoveredDevice {
                family,
                serial_number: trimmed_usb_string(info.serial_number()),
                location_key,
                location,
                fallback_id: format!("{:?}", info.id()),
                duplicate_serial: false,
                info,
            })
        })
        .collect::<Vec<_>>();

    let mut serial_counts = HashMap::<(u16, u16, String), usize>::new();
    for device in &devices {
        if let Some(key) = serial_identity_key(device) {
            *serial_counts.entry(key).or_default() += 1;
        }
    }
    for device in &mut devices {
        device.duplicate_serial = serial_identity_key(device)
            .and_then(|key| serial_counts.get(&key).copied())
            .is_some_and(|count| count > 1);
    }
    Some(devices)
}

/// Returns the model-and-serial key two devices share when they report the same serial number.
fn serial_identity_key(device: &DiscoveredDevice) -> Option<(u16, u16, String)> {
    device.serial_number.clone().map(|serial_number| {
        (
            device.info.vendor_id(),
            device.info.product_id(),
            serial_number,
        )
    })
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
