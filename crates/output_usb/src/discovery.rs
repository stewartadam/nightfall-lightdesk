// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Enumerates the USB DMX interfaces the host can see and resolves saved device selectors to
//! them.

use std::collections::HashSet;

use nightfall_io::prelude::{
    DEFAULT_USB_DMX_DEVICE_SELECTOR, UsbDmxDeviceIdentity, UsbDmxDeviceInfo,
    resolve_usb_dmx_selectors, usb_dmx_device_label,
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
}

impl DiscoveredDevice {
    /// Returns the identity saved selectors are resolved against.
    fn identity(&self) -> UsbDmxDeviceIdentity<'_> {
        UsbDmxDeviceIdentity {
            vendor_id: self.info.vendor_id(),
            product_id: self.info.product_id(),
            serial_number: self.serial_number.as_deref(),
            location_key: self.location_key.as_deref(),
            fallback_id: &self.fallback_id,
        }
    }

    /// Returns the selector this device is saved under in output targets.
    pub(crate) fn selector(&self) -> String {
        self.identity().selector()
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

    let devices = devices
        .filter_map(|info| {
            let family = UsbDmxFamily::from_usb_id(info.vendor_id(), info.product_id())?;
            let (location_key, location) = usb_device_location(&info);
            Some(DiscoveredDevice {
                family,
                serial_number: trimmed_usb_string(info.serial_number()),
                location_key,
                location,
                fallback_id: format!("{:?}", info.id()),
                info,
            })
        })
        .collect::<Vec<_>>();

    Some(devices)
}

/// Resolves saved selectors to `devices`, returning for each selector the index of its device.
/// Each device resolves at most one selector, and devices `available` rejects resolve none.
///
/// Named selectors follow [`resolve_usb_dmx_selectors`]. The automatic selector then takes the
/// first remaining uDMX interface only: the FTDI chips used by other interface families also sit
/// in generic USB serial adapters, so those must be picked explicitly.
pub(crate) fn resolve_selectors(
    selectors: &[String],
    devices: &[DiscoveredDevice],
    available: impl Fn(&DiscoveredDevice) -> bool,
) -> Vec<Option<usize>> {
    let candidates = devices
        .iter()
        .enumerate()
        .filter(|(_, device)| available(device))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let identities = candidates
        .iter()
        .map(|&index| devices[index].identity())
        .collect::<Vec<_>>();
    let selector_refs = selectors.iter().map(String::as_str).collect::<Vec<_>>();
    let mut resolved = resolve_usb_dmx_selectors(&selector_refs, &identities)
        .into_iter()
        .map(|candidate| candidate.map(|candidate| candidates[candidate]))
        .collect::<Vec<_>>();

    let mut claimed = resolved.iter().flatten().copied().collect::<HashSet<_>>();
    for (selector, resolved) in selectors.iter().zip(resolved.iter_mut()) {
        if selector != DEFAULT_USB_DMX_DEVICE_SELECTOR {
            continue;
        }
        *resolved = candidates.iter().copied().find(|&index| {
            devices[index].family == UsbDmxFamily::Udmx && !claimed.contains(&index)
        });
        if let Some(index) = *resolved {
            claimed.insert(index);
        }
    }
    resolved
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
