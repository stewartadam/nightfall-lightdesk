// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Enttec DMX USB Pro protocol: framed messages over the interface's FTDI serial port.
//!
//! The widget runs its own firmware and keeps transmitting the last universe it was sent, so the
//! host only writes when channels change. Every message is framed as
//! `0x7E, label, length LSB, length MSB, data…, 0xE7`.
//!
//! The FTDI chip it uses also sits in Open DMX dongles and generic USB serial adapters under the
//! same USB vendor and product ID, so a device only counts as a USB Pro once it answers a
//! "get widget parameters" request.

use std::io;
use std::time::{Duration, Instant};

use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use serialport::{ClearBuffer, DataBits, FlowControl, Parity, SerialPort, StopBits};

use crate::driver::{OpenError, Universe, WriteOutcome};
use crate::serial_port::{SerialPortIdentity, find_serial_port};

/// First byte of every message.
const START_OF_MESSAGE: u8 = 0x7E;

/// Last byte of every message.
const END_OF_MESSAGE: u8 = 0xE7;

/// Label of the "get widget parameters" request and its reply.
const LABEL_GET_WIDGET_PARAMETERS: u8 = 3;

/// Label of the "output only send DMX packet" request.
const LABEL_OUTPUT_ONLY_SEND_DMX: u8 = 6;

/// Largest data length the widget firmware accepts or sends in one message.
const MAX_MESSAGE_DATA: usize = 600;

/// Bytes of a message around its data: start, label, two length bytes, and end.
const MESSAGE_OVERHEAD: usize = 5;

/// DMX512 null start code for dimmer data.
const NULL_START_CODE: u8 = 0;

/// Line rate requested for the port. The widget talks to the FTDI chip over a FIFO, so the
/// value does not change its DMX timing; it only has to be one the OS driver accepts.
const PORT_BAUD_RATE: u32 = 115_200;

/// Longest a single port read or write blocks.
const PORT_TIMEOUT: Duration = Duration::from_millis(50);

/// How long a probed device has to answer before it is taken for something other than a USB
/// Pro. Widgets answer within a few milliseconds; the probe blocks the output worker, so this
/// stays short.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// Pause between probe reads that return no bytes without waiting for the port timeout.
const PROBE_IDLE_READ_DELAY: Duration = Duration::from_millis(5);

/// Device settings a USB Pro reports in its "get widget parameters" reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WidgetParameters {
    /// Firmware version.
    pub(crate) firmware_version: u16,
    /// DMX break time, in units of 10.67 µs.
    pub(crate) break_time: u8,
    /// DMX mark-after-break time, in units of 10.67 µs.
    pub(crate) mark_after_break_time: u8,
    /// DMX output rate in packets per second, where 0 means as fast as possible.
    pub(crate) output_rate: u8,
}

impl WidgetParameters {
    /// Reads the parameters from a reply's data, which holds at least five bytes followed by
    /// any user configuration.
    fn parse(data: &[u8]) -> Option<Self> {
        let [
            firmware_lsb,
            firmware_msb,
            break_time,
            mark_after_break_time,
            output_rate,
            ..,
        ] = *data
        else {
            return None;
        };
        Some(Self {
            firmware_version: u16::from_le_bytes([firmware_lsb, firmware_msb]),
            break_time,
            mark_after_break_time,
            output_rate,
        })
    }
}

/// Open serial port of an Enttec DMX USB Pro.
pub(crate) struct UsbProPort {
    port: Box<dyn SerialPort>,
    port_name: String,
    /// Bytes of the current DMX packet not yet written to the port.
    unsent: Vec<u8>,
}

impl UsbProPort {
    /// Finds the serial port of an FTDI device, opens it, and checks a USB Pro answers on it.
    pub(crate) fn open(device: &nusb::DeviceInfo) -> Result<Self, OpenError> {
        let Some(port_name) = find_serial_port(&SerialPortIdentity::of(device)) else {
            return Err(OpenError::Unavailable);
        };
        let port = serialport::new(&port_name, PORT_BAUD_RATE)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(PORT_TIMEOUT)
            .open()
            .map_err(|error| {
                tracing::debug!(port_name, %error, "failed to open USB serial port");
                OpenError::Unavailable
            })?;
        Self::connect(port, port_name)
    }

    /// Probes an open port for a USB Pro and keeps it when one answers.
    fn connect(mut port: Box<dyn SerialPort>, port_name: String) -> Result<Self, OpenError> {
        match probe(port.as_mut()) {
            Ok(Some(parameters)) => {
                tracing::info!(
                    port_name,
                    firmware_version = format!(
                        "{}.{}",
                        parameters.firmware_version >> 8,
                        parameters.firmware_version & 0xff
                    ),
                    break_time_us = f32::from(parameters.break_time) * 10.67,
                    mark_after_break_time_us = f32::from(parameters.mark_after_break_time) * 10.67,
                    output_rate = parameters.output_rate,
                    "Enttec DMX USB Pro found"
                );
                Ok(Self {
                    port,
                    port_name,
                    unsent: Vec::with_capacity(MAX_CHANNELS_PER_UNIVERSE + 1 + MESSAGE_OVERHEAD),
                })
            }
            Ok(None) => {
                tracing::debug!(
                    port_name,
                    "USB serial device did not answer as an Enttec DMX USB Pro"
                );
                Err(OpenError::Unsupported)
            }
            Err(error) => {
                tracing::debug!(port_name, %error, "failed to probe USB serial device");
                Err(OpenError::Unavailable)
            }
        }
    }

    /// Sends the universe as one DMX packet, which the widget then repeats on the line until
    /// the next one arrives.
    ///
    /// When a write stops partway through a packet, the unsent rest is kept and sent first next
    /// time, so the widget never sees a cut-off frame followed by a new one. Data the widget
    /// sent back unasked, such as DMX it received while in input mode, is discarded first so it
    /// cannot fill the OS buffer.
    pub(crate) fn write(&mut self, next: &Universe) -> WriteOutcome {
        // Discarding input before the write rather than after leaves the packet just written
        // alone: on macOS pseudo-terminals, flushing one direction can drop data still in
        // transit.
        if let Err(error) = self.port.clear(ClearBuffer::Input) {
            tracing::debug!(port_name = self.port_name, %error, "could not discard USB Pro input");
        }
        // A cut-off packet is finished first, and `next` goes out on a later tick.
        let finishing_earlier_packet = !self.unsent.is_empty();
        if !finishing_earlier_packet {
            encode_dmx_packet(next, &mut self.unsent);
        }
        match write_some(self.port.as_mut(), &mut self.unsent) {
            Ok(()) if self.unsent.is_empty() && !finishing_earlier_packet => WriteOutcome::Written,
            Ok(()) => WriteOutcome::Failed,
            Err(error) => {
                tracing::warn!(port_name = self.port_name, %error, "Enttec DMX USB Pro write failed");
                WriteOutcome::Disconnected
            }
        }
    }
}

/// Writes as much of `pending` as the port takes before its write timeout, removing what was
/// written.
///
/// Returns an error only for failures other than the port being temporarily unable to take
/// more, which usually mean the device is gone.
fn write_some(port: &mut dyn SerialPort, pending: &mut Vec<u8>) -> io::Result<()> {
    let mut written = 0;
    let result = loop {
        if written == pending.len() {
            break Ok(());
        }
        match port.write(&pending[written..]) {
            Ok(0) => break Ok(()),
            Ok(count) => written += count,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                break Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => break Err(error),
        }
    };
    pending.drain(..written);
    result
}

/// Asks the device on `port` for its widget parameters and waits for the reply.
///
/// Returns `None` when no valid reply arrives in time, as from a device that is not a USB Pro.
/// Other messages the widget sends meanwhile are skipped.
fn probe(port: &mut dyn SerialPort) -> io::Result<Option<WidgetParameters>> {
    port.clear(ClearBuffer::All)?;
    let mut request = Vec::with_capacity(2 + MESSAGE_OVERHEAD);
    // The data is the length of user configuration to return, which is none.
    encode_message(LABEL_GET_WIDGET_PARAMETERS, &[0, 0], &mut request);
    port.write_all(&request)?;

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut received = Vec::new();
    let mut chunk = [0u8; 256];
    while Instant::now() < deadline {
        match port.read(&mut chunk) {
            // A port whose far end hung up reads nothing without waiting.
            Ok(0) => std::thread::sleep(PROBE_IDLE_READ_DELAY),
            Ok(read) => received.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
            Err(error) => return Err(error),
        }
        let mut rest = received.as_slice();
        while let Some((label, data, after)) = next_message(rest) {
            if label == LABEL_GET_WIDGET_PARAMETERS
                && let Some(parameters) = WidgetParameters::parse(data)
            {
                return Ok(Some(parameters));
            }
            rest = after;
        }
    }
    Ok(None)
}

/// Appends one framed message to `out`.
fn encode_message(label: u8, data: &[u8], out: &mut Vec<u8>) {
    let length = u16::try_from(data.len())
        .expect("USB Pro message data fits the 16-bit length field")
        .to_le_bytes();
    out.extend_from_slice(&[START_OF_MESSAGE, label, length[0], length[1]]);
    out.extend_from_slice(data);
    out.push(END_OF_MESSAGE);
}

/// Appends an "output only send DMX packet" message carrying the null start code and every
/// channel of `universe`.
fn encode_dmx_packet(universe: &Universe, out: &mut Vec<u8>) {
    let length = (universe.len() + 1) as u16;
    let length = length.to_le_bytes();
    out.extend_from_slice(&[
        START_OF_MESSAGE,
        LABEL_OUTPUT_ONLY_SEND_DMX,
        length[0],
        length[1],
        NULL_START_CODE,
    ]);
    out.extend_from_slice(universe);
    out.push(END_OF_MESSAGE);
}

/// Finds the first complete, well-formed message in `bytes`.
///
/// Returns its label, its data, and the bytes after it. Bytes before a start marker, and start
/// markers that do not begin a well-formed message, are skipped. Returns `None` when no
/// complete message is in `bytes` yet.
fn next_message(bytes: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let mut start = 0;
    while let Some(offset) = bytes[start..]
        .iter()
        .position(|&byte| byte == START_OF_MESSAGE)
    {
        let message = &bytes[start + offset..];
        let [_, label, length_lsb, length_msb, ..] = *message else {
            return None;
        };
        let length = usize::from(u16::from_le_bytes([length_lsb, length_msb]));
        let end = 4 + length;
        // A frame cut off before its end marker may start at a stray start byte, so the scan
        // goes on to any complete message after it.
        if length <= MAX_MESSAGE_DATA && message.get(end) == Some(&END_OF_MESSAGE) {
            return Some((label, &message[4..end], &message[end + 1..]));
        }
        start += offset + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use super::*;

    /// Verifies a DMX packet is framed with the output label, a length covering the start code
    /// and all 512 channels, the null start code, and the end marker.
    #[test]
    fn encode_dmx_packet_frames_start_code_and_every_channel() {
        let mut universe = [0u8; MAX_CHANNELS_PER_UNIVERSE];
        universe[0] = 10;
        universe[MAX_CHANNELS_PER_UNIVERSE - 1] = 20;
        let mut message = Vec::new();

        encode_dmx_packet(&universe, &mut message);

        assert_eq!(
            message.len(),
            MAX_CHANNELS_PER_UNIVERSE + 1 + MESSAGE_OVERHEAD
        );
        assert_eq!(&message[..6], &[0x7E, 6, 0x01, 0x02, 0, 10]);
        assert_eq!(&message[message.len() - 2..], &[20, 0xE7]);
    }

    /// Verifies the parser skips noise and malformed frames, returns a complete message, and
    /// waits for more bytes when a message is cut off.
    #[test]
    fn next_message_skips_noise_and_waits_for_complete_frames() {
        let bytes = [
            0x01, 0x7E, 0x05, 0xFF, 0xFF, // oversized length, skipped
            0x7E, 0x03, 0x01, 0x00, 0xAA, 0x00, // wrong end marker, skipped
            0x7E, 0x03, 0x02, 0x00, 0x11, 0x22, 0xE7, // valid
            0x7E, 0x06,
        ];

        let (label, data, rest) = next_message(&bytes).expect("a valid message is present");

        assert_eq!(label, 3);
        assert_eq!(data, &[0x11, 0x22]);
        assert_eq!(rest, &[0x7E, 0x06]);
        assert!(next_message(rest).is_none());
    }

    /// Verifies a stray start byte claiming a long message does not hide a complete message
    /// after it.
    #[test]
    fn next_message_finds_complete_frame_after_cut_off_one() {
        let bytes = [
            0x7E, 0x05, 0xF4, 0x01, 0x00, // claims 500 bytes that never arrive
            0x7E, 0x03, 0x01, 0x00, 0x11, 0xE7,
        ];

        let (label, data, _) = next_message(&bytes).expect("the complete message is found");

        assert_eq!((label, data), (3, &[0x11][..]));
    }

    /// Verifies widget parameters are read from a reply that also carries user configuration,
    /// and a reply too short to hold them is rejected.
    #[test]
    fn widget_parameters_parse_reply_data() {
        assert_eq!(
            WidgetParameters::parse(&[0x44, 0x01, 9, 1, 40, 0xAB]),
            Some(WidgetParameters {
                firmware_version: 0x0144,
                break_time: 9,
                mark_after_break_time: 1,
                output_rate: 40,
            })
        );
        assert_eq!(WidgetParameters::parse(&[0x44, 0x01, 9, 1]), None);
    }

    /// Reads exactly `len` bytes from the far end of a pseudo-terminal pair.
    #[cfg(unix)]
    fn read_exact_from(port: &mut serialport::TTYPort, len: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; len];
        port.read_exact(&mut bytes)
            .expect("the far end should receive the message");
        bytes
    }

    /// Verifies a device answering the parameters request is accepted as a USB Pro, and a
    /// written universe reaches it as one DMX packet.
    #[cfg(unix)]
    #[test]
    fn connect_probes_widget_and_writes_dmx_packets() {
        let (host, mut widget) = serialport::TTYPort::pair().expect("pseudo-terminal pair");
        widget.set_timeout(Duration::from_secs(2)).unwrap();

        let fake_widget = std::thread::spawn(move || {
            let request = read_exact_from(&mut widget, 2 + MESSAGE_OVERHEAD);
            assert_eq!(request, [0x7E, 3, 2, 0, 0, 0, 0xE7]);
            // A received-DMX message from input mode arrives before the reply and is skipped.
            widget
                .write_all(&[
                    0x7E, 5, 2, 0, 0, 0, 0xE7, 0x7E, 3, 5, 0, 0x44, 0x01, 9, 1, 40, 0xE7,
                ])
                .unwrap();
            read_exact_from(
                &mut widget,
                MAX_CHANNELS_PER_UNIVERSE + 1 + MESSAGE_OVERHEAD,
            )
        });

        let mut host = host;
        host.set_timeout(PORT_TIMEOUT).unwrap();
        let mut port = UsbProPort::connect(Box::new(host), "pty".to_string())
            .unwrap_or_else(|_| panic!("the fake widget should be accepted"));
        let universe = [42u8; MAX_CHANNELS_PER_UNIVERSE];
        assert_eq!(port.write(&universe), WriteOutcome::Written);

        let packet = fake_widget.join().expect("fake widget should not panic");
        assert_eq!(&packet[..5], &[0x7E, 6, 0x01, 0x02, 0]);
        assert!(
            packet[5..5 + MAX_CHANNELS_PER_UNIVERSE]
                .iter()
                .all(|&value| value == 42)
        );
        assert_eq!(packet.last(), Some(&0xE7));
    }

    /// Verifies a device that never answers is reported as unsupported once the probe times
    /// out.
    #[cfg(unix)]
    #[test]
    fn connect_rejects_silent_device() {
        let (mut host, _silent) = serialport::TTYPort::pair().expect("pseudo-terminal pair");
        host.set_timeout(PORT_TIMEOUT).unwrap();

        let result = UsbProPort::connect(Box::new(host), "pty".to_string());

        assert!(matches!(result, Err(OpenError::Unsupported)));
    }
}
