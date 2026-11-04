// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resolves saved USB DMX output targets to the adapters attached right now.
//!
//! A saved target names its adapter by serial number and USB port. Adapters that share a serial
//! number can only be told apart by port, so a target only follows its adapter to another port
//! when no other attached adapter reports the same serial and no other unresolved target wants
//! it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{
    DEFAULT_USB_DMX_DEVICE_SELECTOR, UsbDmxDeviceIdentity, UsbDmxDeviceInfo, UsbDmxOutputTarget,
    usb_dmx_serial_selector,
};

/// How a saved USB DMX output target relates to the adapters attached right now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum UsbDmxTargetStatus {
    /// The target outputs to the first free uDMX interface.
    Auto,
    /// Output goes to the adapter on the saved port.
    Connected {
        /// Selector of the attached adapter.
        device: String,
    },
    /// The saved adapter is on another port and output follows it there.
    Moved {
        /// Selector of the attached adapter on its new port.
        device: String,
    },
    /// The only attached adapter with the saved serial number could belong to this target or to
    /// another one, so output waits until the operator picks which target it drives.
    NeedsChoice {
        /// Selector of the attached adapter waiting for a target.
        device: String,
    },
    /// Nothing is on the saved port, while an adapter sharing the saved serial number with
    /// another attached adapter is on a different port. Output waits because such adapters can
    /// only be told apart by port.
    OtherPort {
        /// Selector of the unassigned adapter that shares the saved serial number.
        device: String,
    },
    /// No attached adapter matches the saved one.
    Missing,
}

impl UsbDmxTargetStatus {
    /// Returns the selector of the attached adapter that receives this target's output, if any.
    pub fn output_device(&self) -> Option<&str> {
        match self {
            Self::Connected { device } | Self::Moved { device } => Some(device),
            _ => None,
        }
    }

    /// Returns the attached adapter the operator can bind this target to with one action: the
    /// adapter it moved to, the twin on another port, or the adapter waiting for a choice.
    pub fn suggested_device(&self) -> Option<&str> {
        match self {
            Self::Moved { device } | Self::NeedsChoice { device } | Self::OtherPort { device } => {
                Some(device)
            }
            _ => None,
        }
    }
}

/// A saved USB DMX output target and its status against the attached adapters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct UsbDmxTargetState {
    /// Target identifier.
    pub target: String,
    /// Status against the attached adapters.
    pub status: UsbDmxTargetStatus,
}

/// Binds a saved USB DMX output target to an attached adapter, saving the adapter's current port.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct UsbDmxDeviceAssignment {
    /// Target identifier.
    pub target: String,
    /// Selector of the attached adapter.
    pub device: String,
}

/// Status of every saved USB DMX output target, and where each target's output goes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[cfg_attr(feature = "ecs", derive(bevy_ecs::prelude::Resource))]
pub struct UsbDmxTargetStates {
    /// Target statuses in saved target order.
    pub states: Vec<UsbDmxTargetState>,
    /// Attached adapter selector each saved selector outputs to.
    outputs: HashMap<String, String>,
}

impl UsbDmxTargetStates {
    /// Resolves saved targets against the attached adapters.
    pub fn resolve(targets: &[UsbDmxOutputTarget], devices: &[UsbDmxDeviceInfo]) -> Self {
        let keys = devices
            .iter()
            .map(|device| DeviceKeys {
                selector: device.id.clone(),
                serial_selector: usb_dmx_serial_selector(
                    device.vendor_id,
                    device.product_id,
                    device.serial_number.as_deref(),
                ),
            })
            .collect::<Vec<_>>();
        let explicit = targets
            .iter()
            .filter(|target| target.device.trim() != DEFAULT_USB_DMX_DEVICE_SELECTOR)
            .collect::<Vec<_>>();
        let selectors = explicit
            .iter()
            .map(|target| target.device.as_str())
            .collect::<Vec<_>>();
        let mut matches = explicit
            .iter()
            .map(|target| target.id.as_str())
            .zip(match_selectors(&selectors, &keys))
            .collect::<HashMap<_, _>>();

        let mut outputs = HashMap::new();
        let states = targets
            .iter()
            .map(|target| {
                let device = |index: usize| devices[index].id.clone();
                let status = match matches.remove(target.id.as_str()) {
                    None => UsbDmxTargetStatus::Auto,
                    Some(SelectorMatch::Exact(index)) => UsbDmxTargetStatus::Connected {
                        device: device(index),
                    },
                    Some(SelectorMatch::Moved(index)) => UsbDmxTargetStatus::Moved {
                        device: device(index),
                    },
                    Some(SelectorMatch::NeedsChoice(index)) => UsbDmxTargetStatus::NeedsChoice {
                        device: device(index),
                    },
                    Some(SelectorMatch::OtherPort(index)) => UsbDmxTargetStatus::OtherPort {
                        device: device(index),
                    },
                    Some(SelectorMatch::Missing) => UsbDmxTargetStatus::Missing,
                };
                if let Some(device) = status.output_device() {
                    outputs.insert(target.device.trim().to_string(), device.to_string());
                }
                UsbDmxTargetState {
                    target: target.id.clone(),
                    status,
                }
            })
            .collect();
        Self { states, outputs }
    }

    /// Returns the selector output for a saved selector is sent to: the attached adapter it
    /// resolved to, the default selector unchanged, or `None` while output must wait.
    pub fn output_selector<'a>(&'a self, saved_selector: &'a str) -> Option<&'a str> {
        let saved_selector = saved_selector.trim();
        if saved_selector == DEFAULT_USB_DMX_DEVICE_SELECTOR {
            return Some(saved_selector);
        }
        self.outputs.get(saved_selector).map(String::as_str)
    }

    /// Returns the status of one target.
    pub fn status(&self, target: &str) -> Option<&UsbDmxTargetStatus> {
        self.states
            .iter()
            .find(|state| state.target == target)
            .map(|state| &state.status)
    }
}

/// Returns the USB port named by a selector, such as `02:1` for `...,port-02:1`.
pub fn usb_dmx_selector_port(selector: &str) -> Option<&str> {
    selector
        .split(',')
        .map(str::trim)
        .find_map(|field| field.strip_prefix("port-"))
}

/// Selectors an attached device answers to.
struct DeviceKeys {
    /// Full selector naming the device's serial and port.
    selector: String,
    /// Serial-only selector prefix, when the device reports a serial number.
    serial_selector: Option<String>,
}

/// How one saved selector matched the attached devices; indexes point into the device list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SelectorMatch {
    /// The device on the saved port, or the only device with a serial-only selector's serial.
    Exact(usize),
    /// The only device with the saved serial, on another port.
    Moved(usize),
    /// The only device with the saved serial, wanted by several unresolved selectors.
    NeedsChoice(usize),
    /// The only unassigned device among several sharing the saved serial.
    OtherPort(usize),
    /// No device matched.
    Missing,
}

/// Matches saved selectors to attached devices, giving each device to at most one selector.
///
/// Exact matches come first. A selector left over then follows the device carrying its serial
/// number only when that device is the only attached one with the serial, is not taken, and no
/// other leftover selector names the same serial; otherwise it reports which device the operator
/// could bind it to.
fn match_selectors(selectors: &[&str], devices: &[DeviceKeys]) -> Vec<SelectorMatch> {
    let serial_count = |serial_selector: &str| {
        devices
            .iter()
            .filter(|device| device.serial_selector.as_deref() == Some(serial_selector))
            .count()
    };
    let mut claimed = vec![false; devices.len()];
    let mut matches = vec![SelectorMatch::Missing; selectors.len()];
    for (selector_index, selector) in selectors.iter().enumerate() {
        let selector = selector.trim();
        let exact = (0..devices.len()).find(|&index| {
            !claimed[index]
                && (devices[index].selector == selector
                    || devices[index]
                        .serial_selector
                        .as_deref()
                        .is_some_and(|serial| serial == selector && serial_count(serial) == 1))
        });
        if let Some(index) = exact {
            claimed[index] = true;
            matches[selector_index] = SelectorMatch::Exact(index);
        }
    }

    let leftover_serials = selectors
        .iter()
        .zip(&matches)
        .map(|(selector, matched)| {
            (*matched == SelectorMatch::Missing)
                .then(|| named_serial(selector.trim(), devices))
                .flatten()
        })
        .collect::<Vec<_>>();
    for (selector_index, serial) in leftover_serials.iter().enumerate() {
        let Some(serial) = serial else {
            continue;
        };
        let unclaimed = (0..devices.len())
            .filter(|&index| {
                !claimed[index] && devices[index].serial_selector.as_deref() == Some(*serial)
            })
            .collect::<Vec<_>>();
        let [device] = unclaimed[..] else {
            continue;
        };
        let competing = leftover_serials
            .iter()
            .filter(|other| **other == Some(*serial))
            .count();
        matches[selector_index] = match (serial_count(serial), competing) {
            (1, 1) => SelectorMatch::Moved(device),
            (1, _) => SelectorMatch::NeedsChoice(device),
            _ => SelectorMatch::OtherPort(device),
        };
    }
    for matched in &matches {
        if let SelectorMatch::Moved(index) = matched {
            claimed[*index] = true;
        }
    }
    matches
}

/// Returns the serial-only selector of an attached device whose serial a saved selector names.
fn named_serial<'a>(selector: &str, devices: &'a [DeviceKeys]) -> Option<&'a str> {
    devices
        .iter()
        .filter_map(|device| device.serial_selector.as_deref())
        .find(|serial| {
            selector == *serial
                || selector
                    .strip_prefix(serial)
                    .is_some_and(|rest| rest.starts_with(','))
        })
}

/// Resolves saved USB DMX selectors to attached devices, returning for each selector the index
/// of its device in `devices`, following the rules of [`UsbDmxTargetStates::resolve`]. Each
/// device resolves at most one selector, and the default selector is left to the caller.
pub fn resolve_usb_dmx_selectors(
    selectors: &[&str],
    devices: &[UsbDmxDeviceIdentity<'_>],
) -> Vec<Option<usize>> {
    let keys = devices
        .iter()
        .map(|device| DeviceKeys {
            selector: device.selector(),
            serial_selector: usb_dmx_serial_selector(
                device.vendor_id,
                device.product_id,
                device.serial_number,
            ),
        })
        .collect::<Vec<_>>();
    match_selectors(selectors, &keys)
        .into_iter()
        .map(|matched| match matched {
            SelectorMatch::Exact(index) | SelectorMatch::Moved(index) => Some(index),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::UsbDmxOutputTargets;
    use crate::constants::{UDMX_PRODUCT_ID, UDMX_VENDOR_ID};

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

    /// Builds attached uDMX device info with serial `0001` on port `20:<port>`.
    fn udmx_device(port: &str) -> UsbDmxDeviceInfo {
        let location_key = format!("port:20:{port}");
        UsbDmxDeviceInfo {
            id: udmx_identity(&location_key).selector(),
            label: "uDMX".to_string(),
            vendor_id: UDMX_VENDOR_ID,
            product_id: UDMX_PRODUCT_ID,
            manufacturer: None,
            product: None,
            serial_number: Some("0001".to_string()),
            location: Some(format!("bus 20 port {port}")),
        }
    }

    /// Builds a target saved for the uDMX with serial `0001` on port `20:<port>`.
    fn target(id: &str, port: &str) -> UsbDmxOutputTarget {
        UsbDmxOutputTarget {
            id: id.to_string(),
            device: format!("id-16c0:05dc,serial-0001,port-20:{port}"),
            device_label: None,
        }
    }

    /// Returns each target's status in saved order.
    fn statuses(
        targets: &[UsbDmxOutputTarget],
        devices: &[UsbDmxDeviceInfo],
    ) -> Vec<UsbDmxTargetStatus> {
        UsbDmxTargetStates::resolve(targets, devices)
            .states
            .into_iter()
            .map(|state| state.status)
            .collect()
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

    /// Verifies a lone adapter on neither saved port is not handed to whichever twin target was
    /// saved first; both targets wait for the operator to choose.
    #[test]
    fn lone_twin_on_new_port_needs_a_choice() {
        let targets = [target("left", "1"), target("right", "2")];
        let devices = [udmx_device("3")];
        let device = devices[0].id.clone();

        assert_eq!(
            statuses(&targets, &devices),
            vec![
                UsbDmxTargetStatus::NeedsChoice {
                    device: device.clone()
                },
                UsbDmxTargetStatus::NeedsChoice { device },
            ]
        );
        let states = UsbDmxTargetStates::resolve(&targets, &devices);
        assert_eq!(states.output_selector(&targets[0].device), None);
        assert_eq!(states.output_selector(&targets[1].device), None);
    }

    /// Verifies a lone adapter on one twin's saved port drives that twin's target without a
    /// prompt.
    #[test]
    fn lone_twin_on_saved_port_connects() {
        let targets = [target("left", "1"), target("right", "2")];
        let devices = [udmx_device("2")];

        assert_eq!(
            statuses(&targets, &devices),
            vec![
                UsbDmxTargetStatus::Missing,
                UsbDmxTargetStatus::Connected {
                    device: devices[0].id.clone()
                },
            ]
        );
    }

    /// Verifies a twin moved to a free port is not followed, and its target points at it.
    #[test]
    fn twin_on_other_port_is_suggested_not_followed() {
        let targets = [target("left", "1"), target("right", "2")];
        let devices = [udmx_device("2"), udmx_device("3")];

        let states = UsbDmxTargetStates::resolve(&targets, &devices);
        assert_eq!(
            states.status("left"),
            Some(&UsbDmxTargetStatus::OtherPort {
                device: devices[1].id.clone()
            })
        );
        assert_eq!(states.output_selector(&targets[0].device), None);
        assert_eq!(
            states.output_selector(&targets[1].device),
            Some(devices[0].id.as_str())
        );
    }

    /// Verifies a unique adapter on a new port is followed and output goes to its new selector.
    #[test]
    fn unique_adapter_on_new_port_moves() {
        let targets = [target("left", "1")];
        let devices = [udmx_device("4")];

        let states = UsbDmxTargetStates::resolve(&targets, &devices);
        assert_eq!(
            states.status("left"),
            Some(&UsbDmxTargetStatus::Moved {
                device: devices[0].id.clone()
            })
        );
        assert_eq!(
            states.output_selector(&targets[0].device),
            Some(devices[0].id.as_str())
        );
    }

    /// Verifies the default selector is reported as Auto and passed through for output.
    #[test]
    fn default_selector_is_auto() {
        let targets = UsbDmxOutputTargets::default().targets;

        let states = UsbDmxTargetStates::resolve(&targets, &[udmx_device("1")]);
        assert_eq!(states.status("udmx"), Some(&UsbDmxTargetStatus::Auto));
        assert_eq!(
            states.output_selector(DEFAULT_USB_DMX_DEVICE_SELECTOR),
            Some(DEFAULT_USB_DMX_DEVICE_SELECTOR)
        );
    }

    /// Verifies the port is read from a saved selector.
    #[test]
    fn selector_port_reads_port_field() {
        assert_eq!(
            usb_dmx_selector_port("id-16c0:05dc,serial-0001,port-20:1.2"),
            Some("20:1.2")
        );
        assert_eq!(usb_dmx_selector_port("id-16c0:05dc,serial-0001"), None);
    }
}
