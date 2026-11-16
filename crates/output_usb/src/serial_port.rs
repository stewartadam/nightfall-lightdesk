// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Finds the serial port the OS created for a USB serial interface.
//!
//! FTDI-based DMX interfaces are driven through the operating system's serial driver rather
//! than raw USB, so they work with the drivers macOS, Linux, and Windows bind to these chips by
//! default. The output worker discovers them as USB devices, so each must be matched to its
//! serial port.

use serialport::SerialPortType;

/// USB identity of a device, used to find the serial port the OS created for it.
pub(crate) struct SerialPortIdentity<'a> {
    /// USB vendor ID.
    pub(crate) vendor_id: u16,
    /// USB product ID.
    pub(crate) product_id: u16,
    /// USB serial number, when the device reports one.
    pub(crate) serial_number: Option<&'a str>,
    /// Bus ID as nusb formats it.
    pub(crate) bus_id: &'a str,
    /// Hub port numbers from the root hub to the device.
    pub(crate) port_chain: &'a [u8],
}

impl<'a> SerialPortIdentity<'a> {
    /// Reads the identity of a USB device as nusb reports it.
    pub(crate) fn of(device: &'a nusb::DeviceInfo) -> Self {
        Self {
            vendor_id: device.vendor_id(),
            product_id: device.product_id(),
            serial_number: device.serial_number(),
            bus_id: usb_bus_id(device),
            port_chain: usb_port_chain(device),
        }
    }
}

/// Serial port of a USB device as the OS reports it.
struct PortCandidate {
    port_name: String,
    serial_number: Option<String>,
    /// Bus ID as serialport formats it, and the hub port chain.
    location: Option<(String, Vec<u8>)>,
}

/// Returns the name of the serial port the OS created for a USB device.
///
/// See [`select_serial_port`] for how the port is matched.
pub(crate) fn find_serial_port(device: &SerialPortIdentity<'_>) -> Option<String> {
    // Without libudev, serialport scans /sys/class/tty and panics when it is missing, as in some
    // containers.
    #[cfg(target_os = "linux")]
    if !std::path::Path::new("/sys/class/tty").is_dir() {
        tracing::warn!("/sys/class/tty is unavailable; cannot find USB serial ports");
        return None;
    }
    let ports = match serialport::available_ports() {
        Ok(ports) => ports,
        Err(error) => {
            tracing::warn!(%error, "failed to enumerate serial ports");
            return None;
        }
    };
    let candidates = ports
        .into_iter()
        .filter_map(|port| match port.port_type {
            SerialPortType::UsbPort(info)
                if info.vid == device.vendor_id && info.pid == device.product_id =>
            {
                Some(PortCandidate {
                    port_name: port.port_name,
                    serial_number: info.serial_number,
                    location: info.location.map(|location| {
                        (
                            location.bus_id().to_string(),
                            location.port_chain().to_vec(),
                        )
                    }),
                })
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let port_name = select_serial_port(candidates, device);
    if port_name.is_none() {
        tracing::debug!(
            vendor_id = format!("{:04x}", device.vendor_id),
            product_id = format!("{:04x}", device.product_id),
            serial_number = device.serial_number,
            bus_id = device.bus_id,
            port_chain = ?device.port_chain,
            "no serial port found for USB device"
        );
    }
    port_name
}

/// Picks the port for a device from candidates sharing its USB ID.
///
/// Matches by serial number when the device reports one. When several ports remain, as with
/// clones that all ship the same serial, the device's USB bus and port chain pick between them.
/// On macOS the `cu.` callout device is preferred over the `tty.` dial-in device, which can block
/// opens waiting for carrier.
fn select_serial_port(
    candidates: Vec<PortCandidate>,
    device: &SerialPortIdentity<'_>,
) -> Option<String> {
    let serial_number = device
        .serial_number
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut matches = candidates
        .into_iter()
        .filter(|candidate| match serial_number {
            Some(serial_number) => candidate
                .serial_number
                .as_deref()
                .is_some_and(|port_serial| port_serial_matches(port_serial.trim(), serial_number)),
            None => true,
        })
        .filter(|candidate| {
            !candidate.port_name.starts_with("/dev/tty.") || cfg!(not(target_os = "macos"))
        })
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        matches.retain(|candidate| {
            candidate
                .location
                .as_ref()
                .is_some_and(|(bus_id, port_chain)| {
                    port_chain == device.port_chain && same_usb_bus(device.bus_id, bus_id)
                })
        });
    }
    let mut port_names = matches
        .into_iter()
        .map(|candidate| candidate.port_name)
        .collect::<Vec<_>>();
    port_names.sort();
    port_names.dedup();
    if port_names.len() == 1 {
        port_names.pop()
    } else {
        None
    }
}

/// Returns whether nusb's and serialport's bus IDs name the same USB bus.
///
/// Both read the same OS location, but nusb formats macOS bus numbers in hex and Linux ones
/// zero-padded, while serialport uses plain decimal. Windows bus IDs are location path strings
/// in both.
fn same_usb_bus(nusb_bus_id: &str, serialport_bus_id: &str) -> bool {
    let nusb_radix = if cfg!(any(target_os = "macos", target_os = "ios")) {
        16
    } else {
        10
    };
    match (
        u32::from_str_radix(nusb_bus_id, nusb_radix),
        serialport_bus_id.parse::<u32>(),
    ) {
        (Ok(nusb_bus), Ok(serialport_bus)) => nusb_bus == serialport_bus,
        _ => nusb_bus_id == serialport_bus_id,
    }
}

/// Returns whether a serial number reported for a port belongs to a USB serial number.
///
/// Windows reads port serial numbers from the FTDIBUS hardware ID, which appends the chip's
/// channel letter to the USB descriptor's serial (`AB0KT9HXA` for `AB0KT9HX`).
fn port_serial_matches(port_serial: &str, usb_serial: &str) -> bool {
    port_serial == usb_serial
        || port_serial.strip_prefix(usb_serial).is_some_and(|channel| {
            channel.len() == 1 && channel.bytes().all(|byte| byte.is_ascii_uppercase())
        })
}

/// Returns the bus ID nusb reports for a device.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn usb_bus_id(device: &nusb::DeviceInfo) -> &str {
    device.bus_id()
}

/// Returns no bus ID on platforms where nusb does not expose one.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn usb_bus_id(_device: &nusb::DeviceInfo) -> &str {
    ""
}

/// Returns the hub port chain nusb reports for a device.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn usb_port_chain(device: &nusb::DeviceInfo) -> &[u8] {
    device.port_chain()
}

/// Returns no port chain on platforms where nusb does not expose one.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn usb_port_chain(_device: &nusb::DeviceInfo) -> &[u8] {
    &[]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a candidate port without location information.
    fn candidate(port_name: &str, serial_number: Option<&str>) -> PortCandidate {
        PortCandidate {
            port_name: port_name.to_string(),
            serial_number: serial_number.map(ToOwned::to_owned),
            location: None,
        }
    }

    /// Builds a candidate port on a USB bus and port chain.
    fn located_candidate(
        port_name: &str,
        serial_number: &str,
        bus_id: &str,
        port_chain: &[u8],
    ) -> PortCandidate {
        PortCandidate {
            location: Some((bus_id.to_string(), port_chain.to_vec())),
            ..candidate(port_name, Some(serial_number))
        }
    }

    /// Builds an FTDI device identity on the first port of bus 2.
    fn device(serial_number: Option<&str>) -> SerialPortIdentity<'_> {
        SerialPortIdentity {
            vendor_id: 0x0403,
            product_id: 0x6001,
            serial_number,
            bus_id: "02",
            port_chain: &[1],
        }
    }

    /// Verifies clones sharing a serial number are told apart by their USB bus and port chain.
    #[test]
    fn select_serial_port_uses_location_for_duplicate_serials() {
        let selected = select_serial_port(
            vec![
                located_candidate("/dev/ttyUSB0", "EN123456", "3", &[1]),
                located_candidate("/dev/ttyUSB1", "EN123456", "2", &[1]),
                located_candidate("/dev/ttyUSB2", "EN123456", "2", &[2]),
            ],
            &device(Some("EN123456")),
        );

        assert_eq!(selected.as_deref(), Some("/dev/ttyUSB1"));
    }

    /// Verifies the serial number picks the right port among several interfaces of one model.
    #[test]
    fn select_serial_port_matches_serial_number() {
        let selected = select_serial_port(
            vec![
                candidate("/dev/ttyUSB0", Some("AAAA")),
                candidate("/dev/ttyUSB1", Some("EN123456")),
            ],
            &device(Some("EN123456")),
        );

        assert_eq!(selected.as_deref(), Some("/dev/ttyUSB1"));
    }

    /// Verifies a Windows FTDIBUS port serial with its channel letter still matches the USB serial.
    #[test]
    fn select_serial_port_accepts_ftdi_channel_suffix() {
        let selected = select_serial_port(
            vec![
                candidate("COM3", Some("EN123456A")),
                candidate("COM4", Some("EN1234562A")),
            ],
            &device(Some("EN123456")),
        );

        assert_eq!(selected.as_deref(), Some("COM3"));
    }

    /// Verifies a device without a serial number only resolves when its port is unambiguous.
    #[test]
    fn select_serial_port_without_serial_requires_single_candidate() {
        assert_eq!(
            select_serial_port(vec![candidate("COM3", None)], &device(None)).as_deref(),
            Some("COM3")
        );
        assert_eq!(
            select_serial_port(
                vec![candidate("COM3", None), candidate("COM4", None)],
                &device(None)
            ),
            None
        );
    }

    /// Verifies the macOS dial-in device is skipped in favour of the callout device.
    #[cfg(target_os = "macos")]
    #[test]
    fn select_serial_port_prefers_macos_callout_device() {
        let selected = select_serial_port(
            vec![
                candidate("/dev/tty.usbserial-EN123456", Some("EN123456")),
                candidate("/dev/cu.usbserial-EN123456", Some("EN123456")),
            ],
            &device(Some("EN123456")),
        );

        assert_eq!(selected.as_deref(), Some("/dev/cu.usbserial-EN123456"));
    }

    /// Verifies bus numbers match across nusb's and serialport's formatting.
    #[test]
    fn same_usb_bus_compares_numbers_not_strings() {
        assert!(same_usb_bus(
            if cfg!(target_os = "macos") {
                "0a"
            } else {
                "010"
            },
            "10"
        ));
        assert!(!same_usb_bus("2", "3"));
    }
}
