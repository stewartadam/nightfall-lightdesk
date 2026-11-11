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
//! Open DMX dongles share the FTDI USB ID with Enttec DMX USB Pro widgets and have no firmware to
//! answer a probe, so an FTDI device is driven as Open DMX once it has not answered the USB Pro
//! probe.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};

use crate::driver::{OpenError, Universe, WriteOutcome};
use crate::serial_port::{SerialPortIdentity, find_serial_port};

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

/// Open DMX port and the writer thread that keeps refreshing its output.
pub(crate) struct OpenDmxPort {
    frame: Arc<Mutex<Universe>>,
    alive: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    frames_sent: Arc<AtomicU64>,
}

impl OpenDmxPort {
    /// Finds the serial port of an FTDI device, configures it for DMX512, and starts refreshing
    /// an all-zero frame.
    ///
    /// Fails as unavailable when no matching serial port exists or it cannot be opened, for
    /// example while the OS driver is still binding to a freshly attached device.
    pub(crate) fn open(device: &nusb::DeviceInfo) -> Result<Self, OpenError> {
        let Some(port_name) = find_serial_port(&SerialPortIdentity::of(device)) else {
            return Err(OpenError::Unavailable);
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
                tracing::debug!(port_name, %error, "failed to open Open DMX serial port");
                return Err(OpenError::Unavailable);
            }
        };

        let frame = Arc::new(Mutex::new([0u8; MAX_CHANNELS_PER_UNIVERSE]));
        let alive = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let frames_sent = Arc::new(AtomicU64::new(0));
        // The writer is detached: dropping the port only asks it to stop, see `Drop`.
        {
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
                .map_err(|_| OpenError::Unavailable)?;
        }

        tracing::info!(port_name, "Open DMX serial port opened");
        Ok(Self {
            frame,
            alive,
            stop,
            frames_sent,
        })
    }

    /// Makes `next` the universe the writer thread refreshes, or reports the device gone once
    /// that thread has stopped on a write failure.
    pub(crate) fn write(&mut self, next: &Universe) -> WriteOutcome {
        if !self.alive.load(Ordering::Acquire) {
            return WriteOutcome::Disconnected;
        }
        match self.frame.lock() {
            Ok(mut frame) => {
                *frame = *next;
                WriteOutcome::Written
            }
            Err(_) => WriteOutcome::Disconnected,
        }
    }

    /// Returns how many frames the writer thread has put on the wire.
    #[cfg(test)]
    fn frames_sent_count(&self) -> u64 {
        self.frames_sent.load(Ordering::Relaxed)
    }
}

impl Drop for OpenDmxPort {
    /// Tells the writer thread to stop and logs how many frames it sent.
    ///
    /// The thread is not joined: it may be blocked in a write for up to the write timeout, which
    /// would stall every other USB output on the worker. It releases the serial port once its
    /// current frame ends.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
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
    frame: &Mutex<Universe>,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a port with no writer thread whose liveness flag is `alive`.
    fn detached_port(alive: bool) -> OpenDmxPort {
        OpenDmxPort {
            frame: Arc::new(Mutex::new([7u8; MAX_CHANNELS_PER_UNIVERSE])),
            alive: Arc::new(AtomicBool::new(alive)),
            stop: Arc::new(AtomicBool::new(false)),
            frames_sent: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Verifies a written universe becomes the frame the writer thread refreshes.
    #[test]
    fn write_replaces_refreshed_frame() {
        let mut port = detached_port(true);
        let mut next = [0u8; MAX_CHANNELS_PER_UNIVERSE];
        next[..3].copy_from_slice(&[1, 2, 3]);

        assert_eq!(port.write(&next), WriteOutcome::Written);
        assert_eq!(*port.frame.lock().unwrap(), next);
    }

    /// Verifies a port whose writer thread stopped reports the device gone.
    #[test]
    fn write_reports_disconnect_after_writer_stops() {
        let mut port = detached_port(false);

        assert_eq!(
            port.write(&[0; MAX_CHANNELS_PER_UNIVERSE]),
            WriteOutcome::Disconnected
        );
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
        use nightfall_io::prelude::{FTDI_FT232R_PRODUCT_ID, FTDI_VENDOR_ID};
        use nusb::MaybeFuture;

        let usb_devices = nusb::list_devices()
            .wait()
            .expect("USB devices should enumerate")
            .filter(|device| {
                device.vendor_id() == FTDI_VENDOR_ID
                    && device.product_id() == FTDI_FT232R_PRODUCT_ID
            })
            .collect::<Vec<_>>();
        assert!(
            !usb_devices.is_empty(),
            "an Open DMX interface should be attached"
        );
        let mut ports = usb_devices
            .iter()
            .map(|usb_device| {
                OpenDmxPort::open(usb_device).unwrap_or_else(|_| {
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
            for port in &mut ports {
                assert_eq!(
                    port.write(&[level; MAX_CHANNELS_PER_UNIVERSE]),
                    WriteOutcome::Written,
                    "writer thread should still be running"
                );
            }
            thread::sleep(Duration::from_millis(25));
        }
        for port in &mut ports {
            port.write(&[0; MAX_CHANNELS_PER_UNIVERSE]);
        }
        thread::sleep(Duration::from_millis(100));

        for port in &ports {
            let rate_hz = port.frames_sent_count() as f64 / start.elapsed().as_secs_f64();
            println!("Open DMX refresh rate: {rate_hz:.1}Hz");
            assert!(
                (30.0..=41.0).contains(&rate_hz),
                "unexpected refresh rate {rate_hz:.1}Hz"
            );
        }
    }
}
