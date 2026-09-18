// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};

use crate::{InputUniverseVisibilityMode, NetworkDmxOutputTargets, UsbDmxOutputTargets};

/// Default timeout before clearing channels set by a stale input.
pub const DEFAULT_INPUT_SIGNAL_LOSS_TIMEOUT_MS: u32 = 2_000;

/// Process-scoped permissions that cap showfile transport preferences.
///
/// This resource is intentionally not serialized. A showfile can preserve the
/// operator's preferred transport state while a host process prevents physical
/// input or output for its entire lifetime.
#[derive(Resource, Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportRuntimePolicy {
    /// Whether showfiles may enable network DMX output.
    pub allow_network_output: bool,
    /// Whether showfiles may enable network DMX input.
    pub allow_network_input: bool,
    /// Whether showfiles may enable USB DMX output.
    pub allow_usb_output: bool,
}

impl TransportRuntimePolicy {
    /// Builds a process transport policy from host-level permissions.
    pub const fn new(
        allow_network_output: bool,
        allow_network_input: bool,
        allow_usb_output: bool,
    ) -> Self {
        Self {
            allow_network_output,
            allow_network_input,
            allow_usb_output,
        }
    }

    /// Returns whether network output is both requested and allowed.
    pub const fn network_output_enabled(&self, settings: &IoRuntimeSettings) -> bool {
        self.allow_network_output && settings.network_output_enabled
    }

    /// Returns whether network input is both requested and allowed.
    pub const fn network_input_enabled(&self, settings: &IoRuntimeSettings) -> bool {
        self.allow_network_input && settings.network_input_enabled
    }

    /// Returns whether USB output is both requested and allowed.
    pub const fn usb_output_enabled(&self, settings: &IoRuntimeSettings) -> bool {
        self.allow_usb_output && settings.usb_output_enabled
    }
}

impl Default for TransportRuntimePolicy {
    fn default() -> Self {
        Self::new(true, true, true)
    }
}

/// Host-owned external control preferences, deliberately excluded from showfiles.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
#[serde(default)]
pub struct ExternalControlSettings {
    /// Whether other computers may connect to the backend.
    pub enabled: bool,
    /// Selected interface name, or `None` to listen on all IPv4 interfaces.
    pub interface: Option<String>,
}

/// Host control preferences and the native listener's actual runtime state.
#[derive(Resource, Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct ExternalControlState {
    /// Whether this runtime hosts a native network listener.
    pub available: bool,
    /// Preferences persisted independently from the active showfile.
    pub settings: ExternalControlSettings,
    /// Addresses on which the backend is currently listening.
    pub listening_addresses: Vec<String>,
    /// Binding or persistence failure requiring operator attention.
    pub error: Option<String>,
}

/// Showfile-scoped runtime settings for network and USB transports.
#[derive(Resource, Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct IoRuntimeSettings {
    /// Selected network interface name, or `None` for the system default.
    #[serde(default)]
    pub network_interface: Option<String>,
    /// Whether network DMX output is allowed to transmit.
    #[serde(default = "default_network_output_enabled")]
    pub network_output_enabled: bool,
    /// Whether network DMX input listeners are allowed to receive frames.
    #[serde(default = "default_network_input_enabled")]
    pub network_input_enabled: bool,
    /// Whether USB DMX output is allowed to transmit.
    #[serde(default = "default_usb_output_enabled")]
    pub usb_output_enabled: bool,
    /// Showfile-scoped named network DMX output targets.
    #[serde(default)]
    pub network_dmx_outputs: NetworkDmxOutputTargets,
    /// Showfile-scoped named USB DMX output targets.
    #[serde(default)]
    pub usb_dmx_outputs: UsbDmxOutputTargets,
    /// Transport input behavior when input signal stops.
    #[serde(default)]
    pub input_signal_loss_policy: InputSignalLossPolicy,
    /// Stale input age threshold used for automatic clearing and manual stale release.
    #[serde(default = "default_input_signal_loss_timeout")]
    pub input_signal_loss_timeout: Duration,
    /// Which transport inputs are surfaced in input views.
    #[serde(default)]
    pub input_universe_visibility_mode: InputUniverseVisibilityMode,
}

impl Default for IoRuntimeSettings {
    fn default() -> Self {
        Self {
            network_interface: None,
            network_output_enabled: default_network_output_enabled(),
            network_input_enabled: default_network_input_enabled(),
            usb_output_enabled: default_usb_output_enabled(),
            network_dmx_outputs: NetworkDmxOutputTargets::default(),
            usb_dmx_outputs: UsbDmxOutputTargets::default(),
            input_signal_loss_policy: InputSignalLossPolicy::Hold,
            input_signal_loss_timeout: default_input_signal_loss_timeout(),
            input_universe_visibility_mode: InputUniverseVisibilityMode::default(),
        }
    }
}

/// Returns whether network output should transmit by default.
pub fn default_network_output_enabled() -> bool {
    true
}

/// Returns whether network input should receive frames by default.
pub fn default_network_input_enabled() -> bool {
    true
}

/// Returns whether USB output should transmit by default.
pub fn default_usb_output_enabled() -> bool {
    true
}

/// Returns the default stale input timeout for serde defaults.
pub fn default_input_signal_loss_timeout() -> Duration {
    Duration::from_millis(DEFAULT_INPUT_SIGNAL_LOSS_TIMEOUT_MS.into())
}

/// Ensures timeout is at least 1 ms to avoid zero-duration expiry loops.
pub fn sanitize_input_signal_loss_timeout(timeout: Duration) -> Duration {
    if timeout.is_zero() {
        Duration::from_millis(1)
    } else {
        timeout
    }
}

/// Policy for input signal loss behavior.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum InputSignalLossPolicy {
    /// Keep the last input values until updated again.
    #[default]
    Hold,
    /// Clear input channels after the configured timeout duration.
    ClearAfterTimeout {},
}

/// Snapshot of compatible USB DMX devices currently surfaced to clients.
#[derive(Resource, Debug, Default, Clone, PartialEq, Eq)]
pub struct AvailableUsbDmxDevices(pub Vec<UsbDmxDeviceInfo>);

/// Compatible USB DMX device currently visible to the host OS.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct UsbDmxDeviceInfo {
    /// Stable device selector persisted in showfile USB transport mappings.
    pub id: String,
    /// Human-readable label for select controls.
    pub label: String,
    /// USB vendor ID.
    pub vendor_id: u16,
    /// USB product ID.
    pub product_id: u16,
    /// USB manufacturer string, when the device exposes one.
    pub manufacturer: Option<String>,
    /// USB product string, when the device exposes one.
    pub product: Option<String>,
    /// USB serial number, when the device exposes one.
    pub serial_number: Option<String>,
    /// Human-readable physical location, when the OS exposes one.
    pub location: Option<String>,
}

/// Network interface information for UI display.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct NetworkInterfaceInfo {
    /// System name of the network interface.
    pub name: String,
    /// Human-readable interface name, when provided by the platform.
    pub friendly_name: Option<String>,
    /// IPv4 addresses associated with this interface.
    pub addresses: Vec<String>,
}

/// Snapshot of currently available/default network interfaces.
#[derive(Resource, Debug, Clone, PartialEq, Eq)]
pub struct NetworkInterfaceState {
    /// Available non-loopback IPv4 interfaces.
    pub available_interfaces: Vec<NetworkInterfaceInfo>,
    /// The current system default interface, if available.
    pub default_interface: Option<NetworkInterfaceInfo>,
}

impl Default for NetworkInterfaceState {
    fn default() -> Self {
        Self::capture()
    }
}

impl NetworkInterfaceState {
    /// Captures the current set of available/default interfaces from the host OS.
    pub fn capture() -> Self {
        Self {
            available_interfaces: get_available_interfaces(),
            default_interface: get_default_interface(),
        }
    }
}

/// How the current network interface was resolved.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub enum CurrentNetworkInterfaceMode {
    /// Use the system default interface.
    #[default]
    SystemDefault,
    /// Use the interface explicitly selected in settings.
    SelectedInterface,
}

/// Current network interface status for UI display.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct NetworkInterfaceStatus {
    /// The system default interface, if one with IPv4 addressing is available.
    pub default_interface: Option<NetworkInterfaceInfo>,
    /// The interface currently selected for use.
    pub current_interface: Option<NetworkInterfaceInfo>,
    /// Whether the current interface comes from system default or an explicit selection.
    pub current_interface_mode: CurrentNetworkInterfaceMode,
    /// Whether the explicitly selected interface is currently unavailable.
    pub selected_interface_missing: bool,
}

/// Converts a host network interface into its client-facing representation.
#[cfg(not(target_arch = "wasm32"))]
fn interface_info_from_netdev(interface: netdev::Interface) -> Option<NetworkInterfaceInfo> {
    let addresses = interface
        .ipv4
        .iter()
        .map(|addr| addr.addr().to_string())
        .collect::<Vec<_>>();
    if interface.is_loopback() || addresses.is_empty() {
        return None;
    }
    Some(NetworkInterfaceInfo {
        name: interface.name,
        friendly_name: interface.friendly_name,
        addresses,
    })
}

/// Gets the list of available non-loopback IPv4 interfaces.
#[cfg(not(target_arch = "wasm32"))]
pub fn get_available_interfaces() -> Vec<NetworkInterfaceInfo> {
    netdev::get_interfaces()
        .into_iter()
        .filter_map(interface_info_from_netdev)
        .collect()
}

/// Returns an empty interface list when host discovery is unavailable in WASM.
#[cfg(target_arch = "wasm32")]
pub fn get_available_interfaces() -> Vec<NetworkInterfaceInfo> {
    Vec::new()
}

/// Gets the current default interface when it has a non-loopback IPv4 address.
#[cfg(not(target_arch = "wasm32"))]
pub fn get_default_interface() -> Option<NetworkInterfaceInfo> {
    netdev::get_default_interface()
        .ok()
        .and_then(interface_info_from_netdev)
}

/// Returns no default interface when host discovery is unavailable in WASM.
#[cfg(target_arch = "wasm32")]
pub fn get_default_interface() -> Option<NetworkInterfaceInfo> {
    None
}

/// Resolves the configured interface from the current settings and host snapshot.
pub fn resolve_configured_network_interface(
    settings: &IoRuntimeSettings,
    interface_state: &NetworkInterfaceState,
) -> Option<NetworkInterfaceInfo> {
    let selected_interface = settings
        .network_interface
        .as_ref()
        .and_then(|selected_name| {
            interface_state
                .available_interfaces
                .iter()
                .find(|interface| interface.name == *selected_name)
                .cloned()
        });
    match settings.network_interface.as_ref() {
        Some(_) => selected_interface,
        None => interface_state.default_interface.clone(),
    }
}

/// Resolves the current/default interface state for clients.
pub fn resolve_network_interface_status(
    settings: &IoRuntimeSettings,
    interface_state: &NetworkInterfaceState,
) -> NetworkInterfaceStatus {
    let current_interface = resolve_configured_network_interface(settings, interface_state);
    match settings.network_interface.as_ref() {
        Some(_) => NetworkInterfaceStatus {
            default_interface: interface_state.default_interface.clone(),
            current_interface: current_interface.clone(),
            current_interface_mode: CurrentNetworkInterfaceMode::SelectedInterface,
            selected_interface_missing: current_interface.is_none(),
        },
        None => NetworkInterfaceStatus {
            current_interface,
            default_interface: interface_state.default_interface.clone(),
            current_interface_mode: CurrentNetworkInterfaceMode::SystemDefault,
            selected_interface_missing: false,
        },
    }
}

/// Builds a concise display label for a USB DMX device selector.
pub fn usb_dmx_device_label(
    vendor_id: u16,
    product_id: u16,
    manufacturer: Option<&str>,
    product: Option<&str>,
    serial_number: Option<&str>,
    location: Option<&str>,
) -> String {
    let manufacturer = manufacturer
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let product = product.map(str::trim).filter(|value| !value.is_empty());
    let name = match (manufacturer, product) {
        (Some(manufacturer), Some(product)) => format!("{manufacturer} {product}"),
        (Some(manufacturer), None) => manufacturer.to_string(),
        (None, Some(product)) => product.to_string(),
        (None, None) => "uDMX adapter".to_string(),
    };
    let identity = serial_number
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|serial| format!("serial {serial}"))
        .or_else(|| {
            location
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        });
    match identity {
        Some(identity) => format!("{name} ({vendor_id:04x}:{product_id:04x}) - {identity}"),
        None => format!("{name} ({vendor_id:04x}:{product_id:04x})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{UDMX_PRODUCT_ID, UDMX_VENDOR_ID};

    /// Verifies process permissions cap enabled showfile transport preferences.
    #[test]
    fn transport_runtime_policy_caps_showfile_preferences() {
        let settings = IoRuntimeSettings::default();
        let policy = TransportRuntimePolicy::new(false, false, false);

        assert!(!policy.network_output_enabled(&settings));
        assert!(!policy.network_input_enabled(&settings));
        assert!(!policy.usb_output_enabled(&settings));
    }

    /// Verifies allowed transports continue to follow showfile preferences.
    #[test]
    fn transport_runtime_policy_preserves_disabled_showfile_preferences() {
        let settings = IoRuntimeSettings {
            network_output_enabled: false,
            network_input_enabled: false,
            usb_output_enabled: false,
            ..IoRuntimeSettings::default()
        };
        let policy = TransportRuntimePolicy::default();

        assert!(!policy.network_output_enabled(&settings));
        assert!(!policy.network_input_enabled(&settings));
        assert!(!policy.usb_output_enabled(&settings));
    }

    /// Creates a deterministic network interface fixture.
    fn network_interface(name: &str, addresses: &[&str]) -> NetworkInterfaceInfo {
        NetworkInterfaceInfo {
            name: name.to_string(),
            friendly_name: None,
            addresses: addresses
                .iter()
                .map(|address| address.to_string())
                .collect(),
        }
    }

    /// Creates a deterministic host interface snapshot.
    fn interface_state(
        available_interfaces: Vec<NetworkInterfaceInfo>,
        default_interface: Option<NetworkInterfaceInfo>,
    ) -> NetworkInterfaceState {
        NetworkInterfaceState {
            available_interfaces,
            default_interface,
        }
    }

    /// Verifies zero-duration expiry loops are prevented.
    #[test]
    fn input_signal_loss_timeout_is_clamped_to_non_zero() {
        assert_eq!(
            sanitize_input_signal_loss_timeout(Duration::ZERO),
            Duration::from_millis(1)
        );
    }

    /// Verifies valid positive signal-loss timeouts are preserved.
    #[test]
    fn input_signal_loss_timeout_keeps_positive_values() {
        assert_eq!(
            sanitize_input_signal_loss_timeout(Duration::from_millis(250)),
            Duration::from_millis(250)
        );
    }

    /// Verifies automatic selection resolves to the host default interface.
    #[test]
    fn resolve_network_interface_status_uses_default_when_no_explicit_selection() {
        let settings = IoRuntimeSettings::default();
        let state = interface_state(
            vec![
                network_interface("en0", &["192.168.1.10"]),
                network_interface("en7", &["10.0.0.5"]),
            ],
            Some(network_interface("en0", &["192.168.1.10"])),
        );

        let status = resolve_network_interface_status(&settings, &state);

        assert_eq!(
            status.current_interface_mode,
            CurrentNetworkInterfaceMode::SystemDefault
        );
        assert_eq!(
            status.current_interface,
            Some(network_interface("en0", &["192.168.1.10"]))
        );
        assert!(!status.selected_interface_missing);
    }

    /// Verifies an available explicit selection overrides the host default.
    #[test]
    fn resolve_network_interface_status_uses_selected_interface_when_available() {
        let settings = IoRuntimeSettings {
            network_interface: Some("en7".to_string()),
            ..IoRuntimeSettings::default()
        };
        let state = interface_state(
            vec![
                network_interface("en0", &["192.168.1.10"]),
                network_interface("en7", &["10.0.0.5"]),
            ],
            Some(network_interface("en0", &["192.168.1.10"])),
        );

        let status = resolve_network_interface_status(&settings, &state);

        assert_eq!(
            status.current_interface_mode,
            CurrentNetworkInterfaceMode::SelectedInterface
        );
        assert_eq!(
            status.current_interface,
            Some(network_interface("en7", &["10.0.0.5"]))
        );
        assert!(!status.selected_interface_missing);
    }

    /// Verifies an unavailable explicit selection is reported without fallback.
    #[test]
    fn resolve_network_interface_status_marks_missing_selected_interface() {
        let settings = IoRuntimeSettings {
            network_interface: Some("en9".to_string()),
            ..IoRuntimeSettings::default()
        };
        let state = interface_state(
            vec![network_interface("en0", &["192.168.1.10"])],
            Some(network_interface("en0", &["192.168.1.10"])),
        );

        let status = resolve_network_interface_status(&settings, &state);

        assert_eq!(
            status.current_interface_mode,
            CurrentNetworkInterfaceMode::SelectedInterface
        );
        assert_eq!(status.current_interface, None);
        assert!(status.selected_interface_missing);
        assert_eq!(
            status.default_interface,
            Some(network_interface("en0", &["192.168.1.10"]))
        );
    }

    /// Verifies transport binding resolves the explicitly configured interface.
    #[test]
    fn resolve_configured_network_interface_returns_selected_interface() {
        let settings = IoRuntimeSettings {
            network_interface: Some("en7".to_string()),
            ..IoRuntimeSettings::default()
        };
        let state = interface_state(
            vec![
                network_interface("en0", &["192.168.1.10"]),
                network_interface("en7", &["10.0.0.5"]),
            ],
            Some(network_interface("en0", &["192.168.1.10"])),
        );

        assert_eq!(
            resolve_configured_network_interface(&settings, &state),
            Some(network_interface("en7", &["10.0.0.5"]))
        );
    }

    /// Verifies display labels surface physical paths for identical adapter SKUs.
    #[test]
    fn usb_dmx_device_label_distinguishes_same_sku_by_location() {
        assert_eq!(
            usb_dmx_device_label(
                UDMX_VENDOR_ID,
                UDMX_PRODUCT_ID,
                Some("Anyma"),
                Some("uDMX"),
                None,
                Some("bus 20 port 1.2")
            ),
            "Anyma uDMX (16c0:05dc) - bus 20 port 1.2"
        );
    }
}
