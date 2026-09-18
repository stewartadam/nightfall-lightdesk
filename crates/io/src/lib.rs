// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! IO transport configuration and named output target definitions.

#![warn(missing_docs)]

/// Shared IO-domain constants.
pub mod constants;
mod input;
mod settings;

use std::{collections::HashSet, net::Ipv4Addr};

use bevy_ecs::prelude::*;
pub use input::{
    AcceptedDmxFrame, ArtNetRecentFramesByUniverse, BindingTransport, DmxInputSet,
    IoRuntimeNotification, SacnOutputIdentity,
};
use serde::{Deserialize, Serialize};

pub use crate::constants::{
    RESERVED_NETWORK_DMX_TARGET_KEYWORDS, RESERVED_USB_DMX_TARGET_KEYWORDS, UDMX_PRODUCT_ID,
    UDMX_VENDOR_ID,
};

/// Prelude for ergonomic IO transport imports.
pub mod prelude {
    pub use crate::{
        AcceptedDmxFrame, ArtNetDelivery, ArtNetRecentFramesByUniverse, AvailableUsbDmxDevices,
        BindingTransport, CurrentNetworkInterfaceMode, DEFAULT_INPUT_SIGNAL_LOSS_TIMEOUT_MS,
        DEFAULT_USB_DMX_DEVICE_SELECTOR, DmxInputSet, ExternalControlSettings,
        ExternalControlState, InputSignalLossPolicy, InputUniverseVisibilityMode,
        IoRuntimeNotification, IoRuntimeSettings, NetworkDmxDelivery, NetworkDmxOutputTarget,
        NetworkDmxOutputTargets, NetworkDmxProtocol, NetworkInterfaceInfo, NetworkInterfaceState,
        NetworkInterfaceStatus, OutputTransport, RESERVED_NETWORK_DMX_TARGET_KEYWORDS,
        RESERVED_USB_DMX_TARGET_KEYWORDS, SacnDelivery, SacnOutputIdentity, TransportRuntimePolicy,
        UDMX_PRODUCT_ID, UDMX_VENDOR_ID, UsbDmxDeviceInfo, UsbDmxOutputTarget, UsbDmxOutputTargets,
        get_available_interfaces, get_default_interface, is_reserved_network_dmx_target_id,
        is_reserved_usb_dmx_target_id, is_valid_network_dmx_target_id,
        output_transport_to_target_id, resolve_configured_network_interface,
        resolve_network_interface_status, sanitize_input_signal_loss_timeout, usb_dmx_device_label,
        usb_dmx_device_selector, usb_dmx_device_selector_matches,
        usb_dmx_device_selector_with_tiebreaker,
    };
}

pub use settings::{
    AvailableUsbDmxDevices, CurrentNetworkInterfaceMode, DEFAULT_INPUT_SIGNAL_LOSS_TIMEOUT_MS,
    ExternalControlSettings, ExternalControlState, InputSignalLossPolicy, IoRuntimeSettings,
    NetworkInterfaceInfo, NetworkInterfaceState, NetworkInterfaceStatus, TransportRuntimePolicy,
    UsbDmxDeviceInfo, default_input_signal_loss_timeout, default_network_input_enabled,
    default_network_output_enabled, default_usb_output_enabled, get_available_interfaces,
    get_default_interface, resolve_configured_network_interface, resolve_network_interface_status,
    sanitize_input_signal_loss_timeout, usb_dmx_device_label,
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
        ip: Ipv4Addr,
    },
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
    /// uDMX USB interface.
    Udmx {
        /// USB device selector used by the uDMX worker.
        device: String,
    },
    /// Art-Net protocol.
    ArtNet {
        /// Delivery mode (broadcast or unicast).
        mode: ArtNetDelivery,
    },
}

/// Default USB DMX device selector for automatic uDMX output.
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Resource)]
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
    /// Returns the target as the concrete uDMX output transport.
    pub fn output_transport(&self) -> OutputTransport {
        OutputTransport::Udmx {
            device: self.device.clone(),
        }
    }
}

/// Showfile-scoped USB DMX output target definitions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Resource)]
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

/// Builds a stable selector for a USB DMX device from the strongest available identity.
pub fn usb_dmx_device_selector(
    vendor_id: u16,
    product_id: u16,
    serial_number: Option<&str>,
    location_key: Option<&str>,
    fallback_id: &str,
) -> String {
    usb_dmx_device_selector_with_tiebreaker(
        vendor_id,
        product_id,
        serial_number,
        location_key,
        fallback_id,
        false,
    )
}

/// Builds a stable selector for a USB DMX device with optional serial collision disambiguation.
pub fn usb_dmx_device_selector_with_tiebreaker(
    vendor_id: u16,
    product_id: u16,
    serial_number: Option<&str>,
    location_key: Option<&str>,
    fallback_id: &str,
    use_location_tiebreaker: bool,
) -> String {
    if let Some(serial_number) = serial_number
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if use_location_tiebreaker
            && let Some(location_key) = location_key
                .map(str::trim)
                .filter(|value| !value.is_empty())
        {
            return format!(
                "{},serial-{serial_number},{}",
                usb_selector_id_field(vendor_id, product_id),
                usb_selector_location_field(location_key)
            );
        }
        return format!(
            "{},serial-{serial_number}",
            usb_selector_id_field(vendor_id, product_id)
        );
    }
    if let Some(location_key) = location_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!(
            "{},{}",
            usb_selector_id_field(vendor_id, product_id),
            usb_selector_location_field(location_key)
        );
    }
    format!(
        "{},device-{fallback_id}",
        usb_selector_id_field(vendor_id, product_id)
    )
}

/// Returns whether a saved selector identifies a currently visible USB DMX device.
pub fn usb_dmx_device_selector_matches(
    selector: &str,
    vendor_id: u16,
    product_id: u16,
    serial_number: Option<&str>,
    location_key: Option<&str>,
    fallback_id: &str,
    use_location_tiebreaker: bool,
) -> bool {
    let selector = selector.trim();
    if selector
        == usb_dmx_device_selector_with_tiebreaker(
            vendor_id,
            product_id,
            serial_number,
            location_key,
            fallback_id,
            use_location_tiebreaker,
        )
    {
        return true;
    }

    !use_location_tiebreaker
        && selector
            == usb_dmx_device_selector_with_tiebreaker(
                vendor_id,
                product_id,
                serial_number,
                location_key,
                fallback_id,
                true,
            )
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

/// Resolves a concrete output transport to the configured target ID used by patch bindings.
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
        OutputTransport::Udmx { device } => {
            Err(format!("USB output device '{device}' is not configured"))
        }
        OutputTransport::Disabled => Err("Output transport is disabled".to_string()),
    }
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Resource, Copy)]
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
            OutputTransport::Udmx {
                device: DEFAULT_USB_DMX_DEVICE_SELECTOR.to_string()
            }
        );
    }

    /// Verifies duplicate serial-number selectors include a location tie breaker.
    #[test]
    fn usb_dmx_device_selector_tiebreaks_duplicate_serials_by_location() {
        assert_eq!(
            usb_dmx_device_selector_with_tiebreaker(
                UDMX_VENDOR_ID,
                UDMX_PRODUCT_ID,
                Some("0001"),
                Some("port:20:1.2"),
                "fallback",
                true,
            ),
            "id-16c0:05dc,serial-0001,port-20:1.2"
        );
    }

    /// Verifies saved duplicate-serial selectors still match after the duplicate disappears.
    #[test]
    fn usb_dmx_device_selector_matches_saved_tiebreaker_without_current_duplicate() {
        assert!(usb_dmx_device_selector_matches(
            "id-16c0:05dc,serial-0001,port-20:1.2",
            UDMX_VENDOR_ID,
            UDMX_PRODUCT_ID,
            Some("0001"),
            Some("port:20:1.2"),
            "fallback",
            false,
        ));
    }

    /// Verifies serial-only selectors do not ambiguously match when a duplicate is present.
    #[test]
    fn usb_dmx_device_selector_does_not_match_serial_only_when_duplicate_exists() {
        assert!(!usb_dmx_device_selector_matches(
            "id-16c0:05dc,serial-0001",
            UDMX_VENDOR_ID,
            UDMX_PRODUCT_ID,
            Some("0001"),
            Some("port:20:1.2"),
            "fallback",
            true,
        ));
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
                &OutputTransport::Udmx {
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
                &OutputTransport::Udmx {
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
                &OutputTransport::Udmx {
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
}
