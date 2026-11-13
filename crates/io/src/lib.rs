// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! IO transport configuration, named output target definitions, and the network interface the
//! transports bind to.
//!
//! The default `plugin` feature adds [`IoPlugin`], which owns the transport settings and their
//! command, the network interface feed and its loss alerts, and IO failure toasts. The Bevy ECS
//! derives on the plain types are gated behind the `ecs` feature. Disable default features to
//! use the plain types and constants without pulling Bevy into the dependency tree, as the WASM
//! bridge does.

#![warn(missing_docs)]

/// Shared IO-domain constants.
pub mod constants;
mod input;
#[cfg(feature = "plugin")]
mod network_interfaces;
mod network_stats;
#[cfg(feature = "plugin")]
mod plugin;
mod settings;
#[cfg(feature = "plugin")]
mod settings_command;

use std::{
    collections::{HashMap, HashSet},
    net::Ipv4Addr,
};

pub use input::{
    ARTNET_SOURCE_TIMEOUT, AcceptedDmxFrame, ArtNetRecentFramesByUniverse, DmxInputSet,
    IoRuntimeNotification, RouteTransport, SACN_SOURCE_TIMEOUT, SacnOutputIdentity,
    UniverseSourceMerge, note_sacn_sources_heard, sacn_source_heard_within,
};
pub use network_stats::{NetworkOutputSendFailure, NetworkStats};
#[cfg(feature = "plugin")]
pub use plugin::{IO_SETTINGS_SECTION, IoPlugin, IoStateSync};
use serde::{Deserialize, Serialize};
#[cfg(feature = "plugin")]
pub use settings_command::IoSettingsCommand;

pub use crate::constants::{
    FTDI_FT232R_PRODUCT_ID, FTDI_VENDOR_ID, RESERVED_NETWORK_DMX_TARGET_KEYWORDS,
    RESERVED_USB_DMX_TARGET_KEYWORDS, UDMX_PRODUCT_ID, UDMX_VENDOR_ID,
};

/// Prelude for ergonomic IO transport imports.
pub mod prelude {
    pub use crate::{
        ARTNET_SOURCE_TIMEOUT, AcceptedDmxFrame, ArtNetDelivery, ArtNetRecentFramesByUniverse,
        CurrentNetworkInterfaceMode, DEFAULT_DMX_OUTPUT_RATE_HZ,
        DEFAULT_INPUT_SIGNAL_LOSS_TIMEOUT_MS, DEFAULT_SACN_PRIORITY,
        DEFAULT_USB_DMX_DEVICE_SELECTOR, DmxInputSet, DmxOutputStandby, FTDI_FT232R_PRODUCT_ID,
        FTDI_VENDOR_ID, InputSignalLossPolicy, InputUniverseVisibilityMode, IoRuntimeNotification,
        IoRuntimeSettings, MAX_DMX_OUTPUT_RATE_HZ, MAX_SACN_PRIORITY, MAX_SACN_UNIVERSE,
        MIN_DMX_OUTPUT_RATE_HZ, MIN_SACN_PRIORITY, MIN_SACN_UNIVERSE, NetworkDmxDelivery,
        NetworkDmxOutputTarget, NetworkDmxOutputTargets, NetworkDmxProtocol, NetworkInterfaceInfo,
        NetworkInterfaceState, NetworkInterfaceStatus, NetworkOutputSendFailure, NetworkStats,
        OutputTransport, RESERVED_NETWORK_DMX_TARGET_KEYWORDS, RESERVED_USB_DMX_TARGET_KEYWORDS,
        RouteTransport, SACN_SOURCE_TIMEOUT, SacnDelivery, SacnOutputIdentity,
        TransportRuntimePolicy, UDMX_PRODUCT_ID, UDMX_VENDOR_ID, UniverseSourceMerge,
        UsbDmxDeviceIdentity, UsbDmxDeviceInfo, UsbDmxOutputTarget, UsbDmxOutputTargets,
        dmx_output_interval, effective_sacn_priority, get_available_interfaces,
        get_default_interface, ipv4_directed_broadcast, is_reserved_network_dmx_target_id,
        is_reserved_usb_dmx_target_id, is_valid_network_dmx_target_id,
        output_transport_to_target_id, resolve_configured_network_interface,
        resolve_network_interface_status, resolve_usb_dmx_selectors, sanitize_dmx_output_rate_hz,
        sanitize_input_signal_loss_timeout, sanitize_sacn_priority, sanitize_sacn_sync_universe,
        usb_dmx_device_label, usb_dmx_device_selector,
    };
    #[cfg(feature = "plugin")]
    pub use crate::{IO_SETTINGS_SECTION, IoPlugin, IoSettingsCommand, IoStateSync};
}

pub use settings::{
    CurrentNetworkInterfaceMode, DEFAULT_DMX_OUTPUT_RATE_HZ, DEFAULT_INPUT_SIGNAL_LOSS_TIMEOUT_MS,
    DEFAULT_SACN_PRIORITY, DEFAULT_SACN_SYNC_UNIVERSE, DmxOutputStandby, InputSignalLossPolicy,
    IoRuntimeSettings, MAX_DMX_OUTPUT_RATE_HZ, MAX_SACN_PRIORITY, MAX_SACN_UNIVERSE,
    MIN_DMX_OUTPUT_RATE_HZ, MIN_SACN_PRIORITY, MIN_SACN_UNIVERSE, NetworkInterfaceInfo,
    NetworkInterfaceState, NetworkInterfaceStatus, TransportRuntimePolicy, UsbDmxDeviceInfo,
    default_dmx_output_rate_hz, default_input_signal_loss_timeout, default_network_input_enabled,
    default_network_output_enabled, default_sacn_sync_universe, default_usb_output_enabled,
    dmx_output_interval, effective_sacn_priority, get_available_interfaces, get_default_interface,
    ipv4_directed_broadcast, resolve_configured_network_interface,
    resolve_network_interface_status, sanitize_dmx_output_rate_hz,
    sanitize_input_signal_loss_timeout, sanitize_sacn_priority, sanitize_sacn_sync_universe,
    usb_dmx_device_label,
};

/// Art-Net delivery mode for a universe.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ArtNetDelivery {
    /// Broadcast to all nodes on the network.
    #[default]
    Broadcast,
    /// Unicast to a specific IP address.
    Unicast {
        /// Target IP address.
        ip: Ipv4Addr,
    },
}

/// sACN delivery mode for a universe.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum SacnDelivery {
    /// Use the protocol multicast destination for the universe.
    #[default]
    Multicast,
    /// Unicast to a specific IP address.
    Unicast {
        /// Target IP address.
        ip: Ipv4Addr,
    },
}

/// Network DMX output protocol.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum NetworkDmxProtocol {
    /// Streaming ACN (E1.31).
    #[default]
    Sacn,
    /// Art-Net protocol.
    ArtNet,
}

/// Network DMX output delivery settings.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[derive(Default)]
pub enum NetworkDmxDelivery {
    /// sACN multicast output.
    #[default]
    SacnMulticast,
    /// Art-Net broadcast output.
    ArtNetBroadcast,
    /// Unicast output for sACN or Art-Net.
    Unicast {
        /// Target IP address.
        #[serde(deserialize_with = "deserialize_ipv4_text_or_octets")]
        ip: Ipv4Addr,
    },
}

/// Reads an IPv4 address written either as dotted text (JSON showfiles) or as four octets
/// (CBOR snapshots, which the web UI then hands back through the wasm bridge).
fn deserialize_ipv4_text_or_octets<'de, D>(deserializer: D) -> Result<Ipv4Addr, D::Error>
where
    D: serde::Deserializer<'de>,
{
    /// Accepts the textual and octet forms of an IPv4 address.
    struct Ipv4Visitor;

    impl<'de> serde::de::Visitor<'de> for Ipv4Visitor {
        type Value = Ipv4Addr;

        /// Describes the accepted forms for deserialization errors.
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an IPv4 address as dotted text or four octets")
        }

        /// Parses dotted text such as `10.0.0.5`.
        fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Ipv4Addr, E> {
            value.parse().map_err(E::custom)
        }

        /// Reads four raw bytes, as a byte array from CBOR or a `Uint8Array` from JS.
        fn visit_bytes<E: serde::de::Error>(self, value: &[u8]) -> Result<Ipv4Addr, E> {
            <[u8; 4]>::try_from(value)
                .map(Ipv4Addr::from)
                .map_err(|_| E::invalid_length(value.len(), &self))
        }

        /// Reads a sequence of exactly four octets.
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Ipv4Addr, A::Error> {
            let mut octets = [0u8; 4];
            for (index, octet) in octets.iter_mut().enumerate() {
                *octet = seq
                    .next_element()?
                    .ok_or_else(|| serde::de::Error::invalid_length(index, &self))?;
            }
            if seq.next_element::<u8>()?.is_some() {
                return Err(serde::de::Error::invalid_length(5, &self));
            }
            Ok(Ipv4Addr::from(octets))
        }
    }

    deserializer.deserialize_any(Ipv4Visitor)
}

/// Output transport for a patched universe.
///
/// FIXME: See if we can make this a typetag or dispatched to avoid this enum
/// being coupled to all output types.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum OutputTransport {
    /// No output; fixture is patched but DMX is not sent.
    #[default]
    Disabled,
    /// Streaming ACN (E1.31).
    Sacn {
        /// Delivery mode (multicast or unicast).
        mode: SacnDelivery,
    },
    /// USB DMX interface, driven by the protocol its device speaks.
    Usb {
        /// USB device selector used by the USB DMX output worker.
        device: String,
    },
    /// Art-Net protocol.
    ArtNet {
        /// Delivery mode (broadcast or unicast).
        mode: ArtNetDelivery,
    },
}

/// Default USB DMX device selector for the first uDMX interface found.
pub const DEFAULT_USB_DMX_DEVICE_SELECTOR: &str = "default";

/// One named network DMX output target.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct NetworkDmxOutputTarget {
    /// Command-safe target identifier.
    pub id: String,
    /// Output protocol.
    pub protocol: NetworkDmxProtocol,
    /// Protocol delivery settings.
    pub delivery: NetworkDmxDelivery,
}

impl NetworkDmxOutputTarget {
    /// Returns the target as an output transport if protocol and delivery match.
    pub fn output_transport(&self) -> Option<OutputTransport> {
        match (self.protocol, &self.delivery) {
            (NetworkDmxProtocol::Sacn, NetworkDmxDelivery::SacnMulticast) => {
                Some(OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                })
            }
            (NetworkDmxProtocol::Sacn, NetworkDmxDelivery::Unicast { ip }) => {
                Some(OutputTransport::Sacn {
                    mode: SacnDelivery::Unicast { ip: *ip },
                })
            }
            (NetworkDmxProtocol::ArtNet, NetworkDmxDelivery::ArtNetBroadcast) => {
                Some(OutputTransport::ArtNet {
                    mode: ArtNetDelivery::Broadcast,
                })
            }
            (NetworkDmxProtocol::ArtNet, NetworkDmxDelivery::Unicast { ip }) => {
                Some(OutputTransport::ArtNet {
                    mode: ArtNetDelivery::Unicast { ip: *ip },
                })
            }
            _ => None,
        }
    }
}

/// Showfile-scoped network DMX output target definitions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ecs", derive(bevy_ecs::prelude::Resource))]
#[typeshare::typeshare]
pub struct NetworkDmxOutputTargets {
    /// Configured target list.
    pub targets: Vec<NetworkDmxOutputTarget>,
}

impl Default for NetworkDmxOutputTargets {
    fn default() -> Self {
        Self {
            targets: vec![
                NetworkDmxOutputTarget {
                    id: "sacn".to_string(),
                    protocol: NetworkDmxProtocol::Sacn,
                    delivery: NetworkDmxDelivery::SacnMulticast,
                },
                NetworkDmxOutputTarget {
                    id: "artnet".to_string(),
                    protocol: NetworkDmxProtocol::ArtNet,
                    delivery: NetworkDmxDelivery::ArtNetBroadcast,
                },
            ],
        }
    }
}

impl NetworkDmxOutputTargets {
    /// Returns sanitized target definitions with defaults restored.
    pub fn sanitized(&self) -> Self {
        let mut targets = Self::default().targets;
        let mut seen: HashSet<String> = targets.iter().map(|target| target.id.clone()).collect();
        let mut seen_transports = HashSet::new();

        for target in &self.targets {
            let Some(existing) = targets.iter_mut().find(|existing| {
                existing.id == target.id && (target.id == "sacn" || target.id == "artnet")
            }) else {
                continue;
            };
            let mut candidate = existing.clone();
            candidate.delivery = target.delivery.clone();
            if candidate.output_transport().is_some() {
                existing.delivery = target.delivery.clone();
            }
        }

        for target in &targets {
            if let Some(transport) = target.output_transport() {
                seen_transports.insert(transport);
            }
        }

        for target in &self.targets {
            if !is_valid_network_dmx_target_id(&target.id)
                || is_reserved_network_dmx_target_id(&target.id)
                || target.id == "sacn"
                || target.id == "artnet"
            {
                continue;
            }
            if !seen.insert(target.id.clone()) {
                continue;
            }
            let Some(output_transport) = target.output_transport() else {
                continue;
            };
            if !seen_transports.insert(output_transport) {
                continue;
            }
            targets.push(target.clone());
        }

        Self { targets }
    }

    /// Returns a configured target by ID.
    pub fn get(&self, id: &str) -> Option<&NetworkDmxOutputTarget> {
        self.targets.iter().find(|target| target.id == id)
    }
}

/// One named USB DMX output target.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct UsbDmxOutputTarget {
    /// Command-safe target identifier.
    pub id: String,
    /// USB device identifier selected for this target.
    pub device: String,
    /// Human-friendly USB device label retained when the device is disconnected.
    pub device_label: Option<String>,
}

impl UsbDmxOutputTarget {
    /// Returns the target as the concrete USB output transport.
    pub fn output_transport(&self) -> OutputTransport {
        OutputTransport::Usb {
            device: self.device.clone(),
        }
    }
}

/// Showfile-scoped USB DMX output target definitions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ecs", derive(bevy_ecs::prelude::Resource))]
#[typeshare::typeshare]
pub struct UsbDmxOutputTargets {
    /// Configured target list.
    pub targets: Vec<UsbDmxOutputTarget>,
}

impl Default for UsbDmxOutputTargets {
    fn default() -> Self {
        Self {
            targets: vec![UsbDmxOutputTarget {
                id: "udmx".to_string(),
                device: DEFAULT_USB_DMX_DEVICE_SELECTOR.to_string(),
                device_label: None,
            }],
        }
    }
}

/// Builds the stable vendor/product identity field used by USB selectors.
fn usb_selector_id_field(vendor_id: u16, product_id: u16) -> String {
    format!("id-{vendor_id:04x}:{product_id:04x}")
}

/// Builds a stable selector field for the physical USB location.
fn usb_selector_location_field(location_key: &str) -> String {
    location_key
        .split_once(':')
        .map(|(kind, value)| format!("{kind}-{value}"))
        .unwrap_or_else(|| format!("location-{location_key}"))
}

/// Trims a persisted optional string and treats empty values as missing.
fn trimmed_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Builds the selector saved for a USB DMX device.
///
/// Devices with a serial number are identified by serial and physical location together, so the
/// saved selector does not change when another device with the same serial is attached or
/// removed; [`resolve_usb_dmx_selectors`] still finds a device moved to another port by its
/// serial.
pub fn usb_dmx_device_selector(
    vendor_id: u16,
    product_id: u16,
    serial_number: Option<&str>,
    location_key: Option<&str>,
    fallback_id: &str,
) -> String {
    let id_field = usb_selector_id_field(vendor_id, product_id);
    let serial_number = serial_number
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let location_field = location_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(usb_selector_location_field);
    match (serial_number, location_field) {
        (Some(serial_number), Some(location_field)) => {
            format!("{id_field},serial-{serial_number},{location_field}")
        }
        (Some(serial_number), None) => format!("{id_field},serial-{serial_number}"),
        (None, Some(location_field)) => format!("{id_field},{location_field}"),
        (None, None) => format!("{id_field},device-{fallback_id}"),
    }
}

/// Builds the serial-only selector prefix shared by every selector of a USB device with a serial.
fn usb_dmx_serial_selector(
    vendor_id: u16,
    product_id: u16,
    serial_number: Option<&str>,
) -> Option<String> {
    serial_number
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|serial_number| {
            format!(
                "{},serial-{serial_number}",
                usb_selector_id_field(vendor_id, product_id)
            )
        })
}

/// Identity of an attached USB DMX device, for resolving saved selectors.
#[derive(Debug, Clone, Copy)]
pub struct UsbDmxDeviceIdentity<'a> {
    /// USB vendor ID.
    pub vendor_id: u16,
    /// USB product ID.
    pub product_id: u16,
    /// USB serial number descriptor, when the device reports one.
    pub serial_number: Option<&'a str>,
    /// Stable physical-location key, such as `port:02:1`.
    pub location_key: Option<&'a str>,
    /// Platform device ID used when neither serial nor location is known.
    pub fallback_id: &'a str,
}

impl UsbDmxDeviceIdentity<'_> {
    /// Returns the selector saved for this device.
    pub fn selector(&self) -> String {
        usb_dmx_device_selector(
            self.vendor_id,
            self.product_id,
            self.serial_number,
            self.location_key,
            self.fallback_id,
        )
    }
}

/// Resolves saved USB DMX selectors to attached devices, returning for each selector the index
/// of its device in `devices`. Each device resolves at most one selector.
///
/// A selector first resolves to the device it names exactly, or for a serial-only selector to the
/// only attached device with that serial. Selectors left over then fall back to a device whose
/// serial they name if it is the only attached device with that serial and no other selector
/// already resolved to it, so a device moved to another port keeps its target while clones that
/// share a serial stay on the targets saved for their own ports. The default selector is left
/// to the caller.
pub fn resolve_usb_dmx_selectors(
    selectors: &[&str],
    devices: &[UsbDmxDeviceIdentity<'_>],
) -> Vec<Option<usize>> {
    let device_selectors = devices
        .iter()
        .map(UsbDmxDeviceIdentity::selector)
        .collect::<Vec<_>>();
    let serial_selectors = devices
        .iter()
        .map(|device| {
            usb_dmx_serial_selector(device.vendor_id, device.product_id, device.serial_number)
        })
        .collect::<Vec<_>>();
    let mut serial_counts = HashMap::<&str, usize>::new();
    for serial_selector in serial_selectors.iter().flatten() {
        *serial_counts.entry(serial_selector).or_default() += 1;
    }
    let unique_serial = |index: usize| {
        serial_selectors[index]
            .as_deref()
            .is_some_and(|serial_selector| serial_counts.get(serial_selector) == Some(&1))
    };

    let mut claimed = vec![false; devices.len()];
    let mut resolved = vec![None; selectors.len()];
    for (selector_index, selector) in selectors.iter().enumerate() {
        let selector = selector.trim();
        let exact = (0..devices.len()).find(|&index| {
            !claimed[index]
                && (device_selectors[index] == selector
                    || (serial_selectors[index].as_deref() == Some(selector)
                        && unique_serial(index)))
        });
        if let Some(index) = exact {
            claimed[index] = true;
            resolved[selector_index] = Some(index);
        }
    }
    for (selector_index, selector) in selectors.iter().enumerate() {
        if resolved[selector_index].is_some() {
            continue;
        }
        let selector = selector.trim();
        let fallback = (0..devices.len()).find(|&index| {
            !claimed[index]
                && unique_serial(index)
                && serial_selectors[index]
                    .as_ref()
                    .is_some_and(|serial_selector| {
                        selector
                            .strip_prefix(serial_selector.as_str())
                            .is_some_and(|rest| rest.starts_with(','))
                    })
        });
        if let Some(index) = fallback {
            claimed[index] = true;
            resolved[selector_index] = Some(index);
        }
    }
    resolved
}

impl UsbDmxOutputTargets {
    /// Returns sanitized USB target definitions with the built-in uDMX target restored.
    pub fn sanitized(&self) -> Self {
        let mut targets = Self::default().targets;
        let mut seen: HashSet<String> = targets.iter().map(|target| target.id.clone()).collect();
        let mut seen_devices: HashSet<String> =
            targets.iter().map(|target| target.device.clone()).collect();

        for target in &self.targets {
            let device = target.device.trim();
            if target.id == "udmx" && !device.is_empty() {
                targets[0].device = device.to_string();
                targets[0].device_label = trimmed_string(target.device_label.as_deref());
                seen_devices.clear();
                seen_devices.insert(targets[0].device.clone());
            }
        }

        for target in &self.targets {
            let device = target.device.trim();
            if !is_valid_network_dmx_target_id(&target.id)
                || is_reserved_usb_dmx_target_id(&target.id)
                || target.id == "udmx"
                || device.is_empty()
            {
                continue;
            }
            if !seen.insert(target.id.clone()) {
                continue;
            }
            if !seen_devices.insert(device.to_string()) {
                continue;
            }
            targets.push(UsbDmxOutputTarget {
                id: target.id.clone(),
                device: device.to_string(),
                device_label: trimmed_string(target.device_label.as_deref()),
            });
        }

        Self { targets }
    }

    /// Returns a configured target by ID.
    pub fn get(&self, id: &str) -> Option<&UsbDmxOutputTarget> {
        self.targets.iter().find(|target| target.id == id)
    }
}

/// Resolves a concrete output transport to the configured target ID used by DMX routes.
pub fn output_transport_to_target_id(
    transport: &OutputTransport,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Result<String, String> {
    if let Some(target) = network_outputs
        .targets
        .iter()
        .find(|target| target.output_transport().as_ref() == Some(transport))
    {
        return Ok(target.id.clone());
    }

    if let Some(target) = usb_outputs
        .targets
        .iter()
        .find(|target| target.output_transport() == *transport)
    {
        return Ok(target.id.clone());
    }

    match transport {
        OutputTransport::Sacn { .. } => {
            Err("sACN output transport is not configured as a patch target".to_string())
        }
        OutputTransport::ArtNet { .. } => {
            Err("Art-Net output transport is not configured as a patch target".to_string())
        }
        OutputTransport::Usb { device } => {
            Err(format!("USB output device '{device}' is not configured"))
        }
        OutputTransport::Disabled => Err("Output transport is disabled".to_string()),
    }
}

/// Returns the IDs commands can use to name an output, built-in and custom, network first,
/// after the same sanitizing the engine applies when it loads the targets.
pub fn configured_output_target_ids(
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Vec<String> {
    network_outputs
        .sanitized()
        .targets
        .into_iter()
        .map(|target| target.id)
        .chain(
            usb_outputs
                .sanitized()
                .targets
                .into_iter()
                .map(|target| target.id),
        )
        .collect()
}

/// Returns whether a target ID is command-safe.
pub fn is_valid_network_dmx_target_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

/// Returns whether a target ID is reserved by another endpoint kind.
pub fn is_reserved_network_dmx_target_id(id: &str) -> bool {
    RESERVED_NETWORK_DMX_TARGET_KEYWORDS.contains(&id)
}

/// Returns whether a USB target ID is reserved by another endpoint kind.
pub fn is_reserved_usb_dmx_target_id(id: &str) -> bool {
    RESERVED_USB_DMX_TARGET_KEYWORDS.contains(&id)
}

/// Input universe visibility mode.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Copy)]
#[cfg_attr(feature = "ecs", derive(bevy_ecs::prelude::Resource))]
#[typeshare::typeshare]
pub enum InputUniverseVisibilityMode {
    /// Show only external transport inputs.
    #[default]
    ExternalOnly,
    /// Show all detected transport inputs, including local loopback frames.
    AllDetected,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{UDMX_PRODUCT_ID, UDMX_VENDOR_ID};

    /// Verifies default Network DMX targets include the built-in protocols.
    #[test]
    fn network_dmx_outputs_default_includes_built_ins() {
        let outputs = NetworkDmxOutputTargets::default();
        assert!(outputs.get("sacn").is_some());
        assert!(outputs.get("artnet").is_some());
    }

    /// Verifies default USB DMX targets include the legacy uDMX target.
    #[test]
    fn usb_dmx_outputs_default_includes_udmx() {
        let outputs = UsbDmxOutputTargets::default();
        let target = outputs.get("udmx").expect("uDMX target should exist");

        assert_eq!(target.device, DEFAULT_USB_DMX_DEVICE_SELECTOR);
        assert_eq!(target.device_label, None);
        assert_eq!(
            target.output_transport(),
            OutputTransport::Usb {
                device: DEFAULT_USB_DMX_DEVICE_SELECTOR.to_string()
            }
        );
    }

    /// Builds an attached uDMX identity with serial `0001` on the given port.
    fn udmx_identity(location_key: &str) -> UsbDmxDeviceIdentity<'_> {
        UsbDmxDeviceIdentity {
            vendor_id: UDMX_VENDOR_ID,
            product_id: UDMX_PRODUCT_ID,
            serial_number: Some("0001"),
            location_key: Some(location_key),
            fallback_id: "fallback",
        }
    }

    /// Verifies the saved selector names both serial and physical location.
    #[test]
    fn usb_dmx_device_selector_includes_serial_and_location() {
        assert_eq!(
            udmx_identity("port:20:1.2").selector(),
            "id-16c0:05dc,serial-0001,port-20:1.2"
        );
    }

    /// Verifies a saved device keeps resolving when a clone with the same serial is attached.
    #[test]
    fn resolve_usb_dmx_selectors_keeps_saved_device_when_clone_attaches() {
        let devices = [udmx_identity("port:20:1.3"), udmx_identity("port:20:1.2")];

        assert_eq!(
            resolve_usb_dmx_selectors(&["id-16c0:05dc,serial-0001,port-20:1.2"], &devices),
            vec![Some(1)]
        );
    }

    /// Verifies unplugging one clone leaves the other on its own target instead of letting the
    /// unplugged clone's target take it over.
    #[test]
    fn resolve_usb_dmx_selectors_does_not_steal_remaining_clone() {
        let devices = [udmx_identity("port:20:1.3")];

        assert_eq!(
            resolve_usb_dmx_selectors(
                &[
                    "id-16c0:05dc,serial-0001,port-20:1.2",
                    "id-16c0:05dc,serial-0001,port-20:1.3",
                ],
                &devices,
            ),
            vec![None, Some(0)]
        );
    }

    /// Verifies a device moved to another port still resolves by its unique serial.
    #[test]
    fn resolve_usb_dmx_selectors_follows_unique_serial_to_new_port() {
        let devices = [udmx_identity("port:20:4")];

        assert_eq!(
            resolve_usb_dmx_selectors(&["id-16c0:05dc,serial-0001,port-20:1.2"], &devices),
            vec![Some(0)]
        );
    }

    /// Verifies serial-only selectors resolve while the serial is unique and not when ambiguous.
    #[test]
    fn resolve_usb_dmx_selectors_matches_serial_only_selector_when_unique() {
        let selectors = ["id-16c0:05dc,serial-0001"];

        assert_eq!(
            resolve_usb_dmx_selectors(&selectors, &[udmx_identity("port:20:1.2")]),
            vec![Some(0)]
        );
        assert_eq!(
            resolve_usb_dmx_selectors(
                &selectors,
                &[udmx_identity("port:20:1.2"), udmx_identity("port:20:1.3")],
            ),
            vec![None]
        );
    }

    /// Verifies invalid custom target definitions are removed during sanitization.
    #[test]
    fn network_dmx_outputs_sanitized_removes_invalid_custom_targets() {
        let outputs = NetworkDmxOutputTargets {
            targets: vec![NetworkDmxOutputTarget {
                id: "fixture".to_string(),
                protocol: NetworkDmxProtocol::Sacn,
                delivery: NetworkDmxDelivery::SacnMulticast,
            }],
        }
        .sanitized();

        assert!(outputs.get("fixture").is_none());
        assert!(outputs.get("sacn").is_some());
        assert!(outputs.get("artnet").is_some());
    }

    /// Verifies duplicate physical output targets are removed during sanitization.
    #[test]
    fn network_dmx_outputs_sanitized_removes_duplicate_physical_targets() {
        let outputs = NetworkDmxOutputTargets {
            targets: vec![
                NetworkDmxOutputTarget {
                    id: "sacnnode4".to_string(),
                    protocol: NetworkDmxProtocol::Sacn,
                    delivery: NetworkDmxDelivery::SacnMulticast,
                },
                NetworkDmxOutputTarget {
                    id: "sacnnode5".to_string(),
                    protocol: NetworkDmxProtocol::Sacn,
                    delivery: NetworkDmxDelivery::Unicast {
                        ip: Ipv4Addr::new(10, 0, 0, 5),
                    },
                },
                NetworkDmxOutputTarget {
                    id: "sacnnode5alias".to_string(),
                    protocol: NetworkDmxProtocol::Sacn,
                    delivery: NetworkDmxDelivery::Unicast {
                        ip: Ipv4Addr::new(10, 0, 0, 5),
                    },
                },
            ],
        }
        .sanitized();

        assert!(outputs.get("sacnnode4").is_none());
        assert!(outputs.get("sacnnode5").is_some());
        assert!(outputs.get("sacnnode5alias").is_none());
    }

    /// Verifies built-in targets keep their protocols when sanitized.
    #[test]
    fn network_dmx_outputs_sanitized_keeps_builtin_protocols() {
        let outputs = NetworkDmxOutputTargets {
            targets: vec![NetworkDmxOutputTarget {
                id: "sacn".to_string(),
                protocol: NetworkDmxProtocol::ArtNet,
                delivery: NetworkDmxDelivery::ArtNetBroadcast,
            }],
        }
        .sanitized();

        let sacn = outputs.get("sacn").expect("sACN target should remain");
        assert_eq!(sacn.protocol, NetworkDmxProtocol::Sacn);
        assert_eq!(sacn.delivery, NetworkDmxDelivery::SacnMulticast);
    }

    /// Verifies custom unicast targets convert to concrete output transports.
    #[test]
    fn network_dmx_output_target_converts_unicast_transport() {
        let target = NetworkDmxOutputTarget {
            id: "node4".to_string(),
            protocol: NetworkDmxProtocol::ArtNet,
            delivery: NetworkDmxDelivery::Unicast {
                ip: Ipv4Addr::new(192, 168, 1, 50),
            },
        };

        assert_eq!(
            target.output_transport(),
            Some(OutputTransport::ArtNet {
                mode: ArtNetDelivery::Unicast {
                    ip: Ipv4Addr::new(192, 168, 1, 50),
                }
            })
        );
    }

    /// Verifies built-in output transports resolve to their default patch target IDs.
    #[test]
    fn output_transport_to_target_id_resolves_default_targets() {
        let network_outputs = NetworkDmxOutputTargets::default();
        let usb_outputs = UsbDmxOutputTargets::default();

        assert_eq!(
            output_transport_to_target_id(
                &OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                &network_outputs,
                &usb_outputs,
            ),
            Ok("sacn".to_string())
        );
        assert_eq!(
            output_transport_to_target_id(
                &OutputTransport::ArtNet {
                    mode: ArtNetDelivery::Broadcast,
                },
                &network_outputs,
                &usb_outputs,
            ),
            Ok("artnet".to_string())
        );
        assert_eq!(
            output_transport_to_target_id(
                &OutputTransport::Usb {
                    device: DEFAULT_USB_DMX_DEVICE_SELECTOR.to_string(),
                },
                &network_outputs,
                &usb_outputs,
            ),
            Ok("udmx".to_string())
        );
    }

    /// Verifies configured network target IDs are used for matching concrete transports.
    #[test]
    fn output_transport_to_target_id_resolves_custom_network_targets() {
        let network_outputs = NetworkDmxOutputTargets {
            targets: vec![NetworkDmxOutputTarget {
                id: "node4".to_string(),
                protocol: NetworkDmxProtocol::ArtNet,
                delivery: NetworkDmxDelivery::Unicast {
                    ip: Ipv4Addr::new(192, 168, 1, 50),
                },
            }],
        };
        let usb_outputs = UsbDmxOutputTargets::default();

        assert_eq!(
            output_transport_to_target_id(
                &OutputTransport::ArtNet {
                    mode: ArtNetDelivery::Unicast {
                        ip: Ipv4Addr::new(192, 168, 1, 50),
                    },
                },
                &network_outputs,
                &usb_outputs,
            ),
            Ok("node4".to_string())
        );
    }

    /// Verifies configured USB target IDs are used for matching concrete devices.
    #[test]
    fn output_transport_to_target_id_resolves_custom_usb_targets() {
        let network_outputs = NetworkDmxOutputTargets::default();
        let usb_outputs = UsbDmxOutputTargets {
            targets: vec![UsbDmxOutputTarget {
                id: "booth-usb".to_string(),
                device: "id-16c0:05dc,serial-booth".to_string(),
                device_label: Some("Booth USB".to_string()),
            }],
        };

        assert_eq!(
            output_transport_to_target_id(
                &OutputTransport::Usb {
                    device: "id-16c0:05dc,serial-booth".to_string(),
                },
                &network_outputs,
                &usb_outputs,
            ),
            Ok("booth-usb".to_string())
        );
    }

    /// Verifies transports without configured targets return actionable errors.
    #[test]
    fn output_transport_to_target_id_rejects_unconfigured_transports() {
        let network_outputs = NetworkDmxOutputTargets { targets: vec![] };
        let usb_outputs = UsbDmxOutputTargets { targets: vec![] };

        assert_eq!(
            output_transport_to_target_id(
                &OutputTransport::Usb {
                    device: "missing".to_string(),
                },
                &network_outputs,
                &usb_outputs,
            ),
            Err("USB output device 'missing' is not configured".to_string())
        );
        assert_eq!(
            output_transport_to_target_id(
                &OutputTransport::Disabled,
                &network_outputs,
                &usb_outputs,
            ),
            Err("Output transport is disabled".to_string())
        );
    }

    /// Verifies USB target sanitization preserves a configured uDMX device mapping.
    #[test]
    fn usb_dmx_outputs_sanitized_updates_builtin_device() {
        let outputs = UsbDmxOutputTargets {
            targets: vec![UsbDmxOutputTarget {
                id: "udmx".to_string(),
                device: "usb-serial-1".to_string(),
                device_label: Some(" Anyma uDMX ".to_string()),
            }],
        }
        .sanitized();

        assert_eq!(
            outputs.get("udmx").map(|target| target.device.as_str()),
            Some("usb-serial-1")
        );
        assert_eq!(
            outputs
                .get("udmx")
                .and_then(|target| target.device_label.as_deref()),
            Some("Anyma uDMX")
        );
    }

    /// Verifies USB target sanitization removes invalid IDs and duplicate devices.
    #[test]
    fn usb_dmx_outputs_sanitized_removes_invalid_and_duplicate_targets() {
        let outputs = UsbDmxOutputTargets {
            targets: vec![
                UsbDmxOutputTarget {
                    id: "fixture".to_string(),
                    device: "usb-serial-2".to_string(),
                    device_label: None,
                },
                UsbDmxOutputTarget {
                    id: "front-usb".to_string(),
                    device: "usb-serial-2".to_string(),
                    device_label: Some(" Anyma uDMX ".to_string()),
                },
                UsbDmxOutputTarget {
                    id: "front-usb-alias".to_string(),
                    device: "usb-serial-2".to_string(),
                    device_label: None,
                },
                UsbDmxOutputTarget {
                    id: "empty-usb".to_string(),
                    device: " ".to_string(),
                    device_label: None,
                },
            ],
        }
        .sanitized();

        assert!(outputs.get("fixture").is_none());
        assert!(outputs.get("front-usb").is_some());
        assert_eq!(
            outputs
                .get("front-usb")
                .and_then(|target| target.device_label.as_deref()),
            Some("Anyma uDMX")
        );
        assert!(outputs.get("front-usb-alias").is_none());
        assert!(outputs.get("empty-usb").is_none());
    }

    /// Verifies unicast IPs load from dotted text and from the four-octet form CBOR produces.
    #[test]
    fn network_dmx_delivery_reads_text_and_octet_ips() {
        let expected = NetworkDmxDelivery::Unicast {
            ip: Ipv4Addr::new(10, 0, 0, 5),
        };
        for json in [
            r#"{"type":"Unicast","data":{"ip":"10.0.0.5"}}"#,
            r#"{"type":"Unicast","data":{"ip":[10,0,0,5]}}"#,
        ] {
            let delivery: NetworkDmxDelivery = serde_json::from_str(json).expect(json);
            assert_eq!(delivery, expected, "{json}");
        }
        for json in [
            r#"{"type":"Unicast","data":{"ip":[10,0,0]}}"#,
            r#"{"type":"Unicast","data":{"ip":[10,0,0,5,6]}}"#,
            r#"{"type":"Unicast","data":{"ip":"10.0.0"}}"#,
        ] {
            assert!(
                serde_json::from_str::<NetworkDmxDelivery>(json).is_err(),
                "{json} should be rejected"
            );
        }
    }

    /// Verifies the command-facing output IDs restore built-ins and drop invalid or duplicate
    /// custom targets, listing network targets before USB ones.
    #[test]
    fn configured_output_target_ids_lists_sanitized_targets() {
        let network = NetworkDmxOutputTargets {
            targets: vec![
                NetworkDmxOutputTarget {
                    id: "stage-left".to_string(),
                    protocol: NetworkDmxProtocol::Sacn,
                    delivery: NetworkDmxDelivery::Unicast {
                        ip: Ipv4Addr::new(10, 0, 0, 5),
                    },
                },
                NetworkDmxOutputTarget {
                    id: "Bad Id".to_string(),
                    protocol: NetworkDmxProtocol::Sacn,
                    delivery: NetworkDmxDelivery::Unicast {
                        ip: Ipv4Addr::new(10, 0, 0, 6),
                    },
                },
                NetworkDmxOutputTarget {
                    id: "stage-left-alias".to_string(),
                    protocol: NetworkDmxProtocol::Sacn,
                    delivery: NetworkDmxDelivery::Unicast {
                        ip: Ipv4Addr::new(10, 0, 0, 5),
                    },
                },
            ],
        };
        let usb = UsbDmxOutputTargets {
            targets: vec![UsbDmxOutputTarget {
                id: "front-usb".to_string(),
                device: "usb-serial-2".to_string(),
                device_label: None,
            }],
        };

        assert_eq!(
            configured_output_target_ids(&network, &usb),
            ["sacn", "artnet", "stage-left", "udmx", "front-usb"]
        );
    }
}
