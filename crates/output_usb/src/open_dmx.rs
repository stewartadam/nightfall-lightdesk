// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Open DMX output through FTDI USB serial interfaces.
//!
//! Open DMX style dongles (Enttec Open DMX USB and its many clones) are a bare FTDI UART with an
//! RS-485 line driver and no firmware of their own. The host generates the DMX512 signal itself:
//! a break, a mark-after-break, then the start code and channel slots at 250 kbaud 8N2, repeated
//! continuously because fixtures hold their last frame only for a short time. Each opened port
//! gets a dedicated writer thread that refreshes the latest submitted frame.
//!
//! The port is driven through the operating system's FTDI serial driver rather than raw USB so
//! it works with the drivers macOS, Linux, and Windows bind to these chips by default.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};

/// DMX512 line rate.
const DMX_BAUD_RATE: u32 = 250_000;

/// Wire time of one 8N2 slot at 250 kbaud (11 bits of 4µs).
const SLOT_WIRE_TIME: Duration = Duration::from_micros(44);

/// Allowance for the USB transfer to start feeding the chip after the packet is written.
const USB_SCHEDULING_MARGIN: Duration = Duration::from_millis(2);

/// Break length requested before each frame; DMX512 requires at least 88µs. The USB control
/// transfers that raise and drop the break stretch it further, which receivers tolerate.
const BREAK_TIME: Duration = Duration::from_micros(150);

/// Mark-after-break requested before the start code; DMX512 requires at least 8µs.
const MARK_AFTER_BREAK_TIME: Duration = Duration::from_micros(20);

/// Minimum frame period, keeping the refresh rate at or below 40Hz.
const MIN_FRAME_PERIOD: Duration = Duration::from_millis(25);

/// Write timeout for one frame, well above its 23ms wire time.
const WRITE_TIMEOUT: Duration = Duration::from_millis(250);

/// DMX512 null start code for dimmer data.
const NULL_START_CODE: u8 = 0;

/// USB identity of an Open DMX device, used to find the serial port the OS created for it.
pub(crate) struct UsbDeviceIdentity<'a> {
    pub(crate) vendor_id: u16,
    pub(crate) product_id: u16,
    pub(crate) serial_number: Option<&'a str>,
    /// Bus ID as nusb formats it.
    pub(crate) bus_id: &'a str,
    /// Hub port numbers from the root hub to the device.
    pub(crate) port_chain: &'a [u8],
}

/// Serial port of a USB device as the OS reports it.
struct PortCandidate {
    port_name: String,
    serial_number: Option<String>,
    /// Bus ID as serialport formats it, and the hub port chain.
    location: Option<(String, Vec<u8>)>,
}

/// Open DMX port and the writer thread that keeps refreshing its output.
pub(crate) struct OpenDmxPort {
    frame: Arc<Mutex<[u8; MAX_CHANNELS_PER_UNIVERSE]>>,
    alive: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    frames_sent: Arc<AtomicU64>,
    join_handle: Option<thread::JoinHandle<()>>,
}

impl OpenDmxPort {
    /// Finds the serial port of an FTDI device, configures it for DMX512, and starts refreshing
    /// an all-zero frame.
    ///
    /// Returns `None` when no matching serial port exists or it cannot be opened, for example
    /// while the OS driver is still binding to a freshly attached device.
    pub(crate) fn open(device: &UsbDeviceIdentity<'_>) -> Option<Self> {
        let Some(port_name) = find_serial_port(device) else {
            tracing::warn!(
                vendor_id = format!("{:04x}", device.vendor_id),
                product_id = format!("{:04x}", device.product_id),
                serial_number = device.serial_number,
                bus_id = device.bus_id,
                port_chain = ?device.port_chain,
                "no serial port found for Open DMX device"
            );
            return None;
        };
        let port = match serialport::new(&port_name, DMX_BAUD_RATE)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::Two)
            .flow_control(FlowControl::None)
            .timeout(WRITE_TIMEOUT)
            .open()
        {
            Ok(port) => port,
            Err(error) => {
                tracing::error!(port_name, %error, "failed to open Open DMX serial port");
                return None;
            }
        };

        let frame = Arc::new(Mutex::new([0u8; MAX_CHANNELS_PER_UNIVERSE]));
        let alive = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let frames_sent = Arc::new(AtomicU64::new(0));
        let join_handle = {
            let frame = Arc::clone(&frame);
            let alive = Arc::clone(&alive);
            let stop = Arc::clone(&stop);
            let frames_sent = Arc::clone(&frames_sent);
            let port_name = port_name.clone();
            thread::Builder::new()
                .name("open-dmx-writer".to_string())
                .spawn(move || {
                    refresh_frames(port, &port_name, &frame, &stop, &frames_sent);
                    alive.store(false, Ordering::Release);
                })
                .ok()?
        };

        tracing::info!(port_name, "Open DMX serial port opened");
        Some(Self {
            frame,
            alive,
            stop,
            frames_sent,
            join_handle: Some(join_handle),
        })
    }

    /// Replaces the frame the writer thread refreshes; channels past `data` are zeroed.
    pub(crate) fn submit(&self, data: &[u8]) {
        let Ok(mut frame) = self.frame.lock() else {
            return;
        };
        let len = data.len().min(MAX_CHANNELS_PER_UNIVERSE);
        frame[..len].copy_from_slice(&data[..len]);
        frame[len..].fill(0);
    }

    /// Returns how many frames the writer thread has put on the wire.
    #[cfg(test)]
    fn frames_sent_count(&self) -> u64 {
        self.frames_sent.load(Ordering::Relaxed)
    }

    /// Returns whether the writer thread is still driving the port.
    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
}

impl Drop for OpenDmxPort {
    /// Stops the writer thread, waits for it to release the serial port, and logs how many frames
    /// it sent.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
        tracing::debug!(
            frames_sent = self.frames_sent.load(Ordering::Relaxed),
            "Open DMX port closed"
        );
    }
}

/// Writes the latest frame to the port in a loop until stopped or the port fails.
///
/// Each iteration sends a break and mark-after-break, then the start code and all 512 slots.
/// The next break waits until the previous frame has left the wire. Some OS drivers return from
/// the drain once the bytes reach the chip, not once its transmit FIFO is empty, so the wait also
/// covers the packet's own wire time from when it was written.
fn refresh_frames(
    mut port: Box<dyn SerialPort>,
    port_name: &str,
    frame: &Mutex<[u8; MAX_CHANNELS_PER_UNIVERSE]>,
    stop: &AtomicBool,
    frames_sent: &AtomicU64,
) {
    let mut packet = [0u8; MAX_CHANNELS_PER_UNIVERSE + 1];
    packet[0] = NULL_START_CODE;
    let packet_wire_time = SLOT_WIRE_TIME * packet.len() as u32;

    while !stop.load(Ordering::Acquire) {
        let frame_start = Instant::now();
        match frame.lock() {
            Ok(frame) => packet[1..].copy_from_slice(&*frame),
            Err(_) => break,
        }

        let written_at = match write_frame(port.as_mut(), &packet) {
            Ok(written_at) => written_at,
            Err(error) => {
                tracing::warn!(port_name, %error, "Open DMX write failed; closing port");
                break;
            }
        };
        let drained_at = Instant::now();
        frames_sent.fetch_add(1, Ordering::Relaxed);

        let wire_idle_at = (written_at + packet_wire_time + USB_SCHEDULING_MARGIN).max(drained_at);
        let next_frame_at = wire_idle_at.max(frame_start + MIN_FRAME_PERIOD);
        thread::sleep(next_frame_at.saturating_duration_since(Instant::now()));
    }
    tracing::debug!(port_name, "Open DMX writer exiting");
}

/// Sends one break, mark-after-break, and packet, returning once the OS has drained it.
///
/// Returns when the packet write began, which is when it starts going out on the wire.
fn write_frame(port: &mut dyn SerialPort, packet: &[u8]) -> std::io::Result<Instant> {
    port.set_break()?;
    thread::sleep(BREAK_TIME);
    port.clear_break()?;
    thread::sleep(MARK_AFTER_BREAK_TIME);
    let written_at = Instant::now();
    port.write_all(packet)?;
    port.flush()?;
    Ok(written_at)
}

/// Returns the name of the serial port the OS created for a USB device.
///
/// See [`select_serial_port`] for how the port is matched.
fn find_serial_port(device: &UsbDeviceIdentity<'_>) -> Option<String> {
    // Without libudev, serialport scans /sys/class/tty and panics when it is missing, as in some
    // containers.
    #[cfg(target_os = "linux")]
    if !std::path::Path::new("/sys/class/tty").is_dir() {
        tracing::warn!("/sys/class/tty is unavailable; cannot find Open DMX serial ports");
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
    select_serial_port(candidates, device)
}

/// Picks the port for a device from candidates sharing its USB ID.
///
/// Matches by serial number when the device reports one. When several ports remain, as with
/// clones that all ship the same serial, the device's USB bus and port chain pick between them.
/// On macOS the `cu.` callout device is preferred over the `tty.` dial-in device, which can block
/// opens waiting for carrier.
fn select_serial_port(
    candidates: Vec<PortCandidate>,
    device: &UsbDeviceIdentity<'_>,
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

    /// Builds a device identity on the first port of bus 2.
    fn device(serial_number: Option<&str>) -> UsbDeviceIdentity<'_> {
        UsbDeviceIdentity {
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
                located_candidate("/dev/ttyUSB0", "AB0KT9HX", "3", &[1]),
                located_candidate("/dev/ttyUSB1", "AB0KT9HX", "2", &[1]),
                located_candidate("/dev/ttyUSB2", "AB0KT9HX", "2", &[2]),
            ],
            &device(Some("AB0KT9HX")),
        );

        assert_eq!(selected.as_deref(), Some("/dev/ttyUSB1"));
    }

    /// Verifies the serial number picks the right port among several adapters of the same model.
    #[test]
    fn select_serial_port_matches_serial_number() {
        let selected = select_serial_port(
            vec![
                candidate("/dev/ttyUSB0", Some("AAAA")),
                candidate("/dev/ttyUSB1", Some("AB0KT9HX")),
            ],
            &device(Some("AB0KT9HX")),
        );

        assert_eq!(selected.as_deref(), Some("/dev/ttyUSB1"));
    }

    /// Verifies a Windows FTDIBUS port serial with its channel letter still matches the USB serial.
    #[test]
    fn select_serial_port_accepts_ftdi_channel_suffix() {
        let selected = select_serial_port(
            vec![
                candidate("COM3", Some("AB0KT9HXA")),
                candidate("COM4", Some("AB0KT9HX2A")),
            ],
            &device(Some("AB0KT9HX")),
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
                candidate("/dev/tty.usbserial-AB0KT9HX", Some("AB0KT9HX")),
                candidate("/dev/cu.usbserial-AB0KT9HX", Some("AB0KT9HX")),
            ],
            &device(Some("AB0KT9HX")),
        );

        assert_eq!(selected.as_deref(), Some("/dev/cu.usbserial-AB0KT9HX"));
    }

    /// Verifies submitted frames are copied into the refresh buffer and stale channels cleared.
    #[test]
    fn submit_replaces_frame_and_zeroes_remaining_channels() {
        let port = OpenDmxPort {
            frame: Arc::new(Mutex::new([7u8; MAX_CHANNELS_PER_UNIVERSE])),
            alive: Arc::new(AtomicBool::new(true)),
            stop: Arc::new(AtomicBool::new(false)),
            frames_sent: Arc::new(AtomicU64::new(0)),
            join_handle: None,
        };

        port.submit(&[1, 2, 3]);

        let frame = port.frame.lock().unwrap();
        assert_eq!(&frame[..4], &[1, 2, 3, 0]);
        assert!(frame[3..].iter().all(|&channel| channel == 0));
    }

    /// Drives every attached Open DMX dongle at once for five seconds with a ramp on every
    /// channel and checks each writer keeps refreshing at 30-40Hz without write failures. With
    /// several clones sharing a serial number, this also checks each resolves to its own port.
    ///
    /// Run with FTDI Open DMX interfaces attached:
    /// `cargo test -p nightfall-output-usb open_dmx_hardware -- --ignored --nocapture`.
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    #[test]
    #[ignore = "requires an FTDI Open DMX interface"]
    fn open_dmx_hardware_refreshes_frames() {
        use nightfall_io::prelude::{OPEN_DMX_PRODUCT_ID, OPEN_DMX_VENDOR_ID};
        use nusb::MaybeFuture;

        let usb_devices = nusb::list_devices()
            .wait()
            .expect("USB devices should enumerate")
            .filter(|device| {
                device.vendor_id() == OPEN_DMX_VENDOR_ID
                    && device.product_id() == OPEN_DMX_PRODUCT_ID
            })
            .collect::<Vec<_>>();
        assert!(
            !usb_devices.is_empty(),
            "an Open DMX interface should be attached"
        );
        let ports = usb_devices
            .iter()
            .map(|usb_device| {
                OpenDmxPort::open(&UsbDeviceIdentity {
                    vendor_id: usb_device.vendor_id(),
                    product_id: usb_device.product_id(),
                    serial_number: usb_device.serial_number(),
                    bus_id: usb_device.bus_id(),
                    port_chain: usb_device.port_chain(),
                })
                .unwrap_or_else(|| {
                    panic!(
                        "Open DMX interface on bus {} port {:?} should open",
                        usb_device.bus_id(),
                        usb_device.port_chain()
                    )
                })
            })
            .collect::<Vec<_>>();

        let duration = Duration::from_secs(5);
        let start = Instant::now();
        while start.elapsed() < duration {
            let level = ((start.elapsed().as_millis() / 10) % 256) as u8;
            for port in &ports {
                port.submit(&[level; MAX_CHANNELS_PER_UNIVERSE]);
            }
            thread::sleep(Duration::from_millis(25));
        }
        for port in &ports {
            port.submit(&[0; MAX_CHANNELS_PER_UNIVERSE]);
        }
        thread::sleep(Duration::from_millis(100));

        for port in &ports {
            let rate_hz = port.frames_sent_count() as f64 / start.elapsed().as_secs_f64();
            println!("Open DMX refresh rate: {rate_hz:.1}Hz");
            assert!(port.is_alive(), "writer thread should still be running");
            assert!(
                (30.0..=41.0).contains(&rate_hz),
                "unexpected refresh rate {rate_hz:.1}Hz"
            );
        }
    }
}
