// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OSC UDP listener and packet parsing.

use std::io::ErrorKind;
use std::net::{SocketAddr, UdpSocket};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use nightfall_engine::prelude::{
    DebugPanicTarget, is_process_shutdown_requested, maybe_trigger_debug_worker_panic,
};
use rosc::{OscPacket as RoscPacket, OscType as RoscType, decoder};
use tokio::sync::mpsc::UnboundedSender;

use crate::command::{OscColor, OscLastEvent, OscListenerStatus, OscMidiMessage, OscTime, OscType};

/// Raw OSC event decoded from UDP packets.
#[derive(Debug, Clone)]
pub struct RawOscEvent {
    /// Monotonic receipt time shared by messages decoded from one packet.
    pub received_at: web_time::Instant,
    /// Source UDP address (`ip:port`).
    pub source: String,
    /// OSC address.
    pub address: String,
    /// OSC arguments.
    pub args: Vec<OscType>,
}

/// Background OSC listener thread handle.
pub struct OscListener {
    handle: Option<std::thread::JoinHandle<()>>,
    stop_signal: Arc<AtomicBool>,
}

impl OscListener {
    /// Return true while the background listener thread is still running.
    pub fn is_alive(&self) -> bool {
        self.handle
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
    }
}

impl Drop for OscListener {
    fn drop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Start OSC UDP listener thread.
pub fn start_listener(
    bind_addr: SocketAddr,
    osc_tx: UnboundedSender<RawOscEvent>,
) -> (Option<OscListener>, OscListenerStatus) {
    let socket = match UdpSocket::bind(bind_addr) {
        Ok(socket) => socket,
        Err(error) => {
            tracing::warn!(?bind_addr, ?error, "Could not bind OSC input socket");
            return (
                None,
                OscListenerStatus {
                    is_listening: false,
                    bind_address: bind_addr.ip().to_string(),
                    port: bind_addr.port(),
                },
            );
        }
    };

    if let Err(error) = socket.set_read_timeout(Some(Duration::from_millis(250))) {
        tracing::warn!(?error, "Could not set read timeout on OSC input socket");
        return (
            None,
            OscListenerStatus {
                is_listening: false,
                bind_address: bind_addr.ip().to_string(),
                port: bind_addr.port(),
            },
        );
    }

    tracing::info!(?bind_addr, "Starting OSC input listener");

    let stop_signal = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop_signal);
    let listener = std::thread::spawn(move || {
        let mut buffer = [0_u8; 64 * 1024];

        loop {
            maybe_trigger_debug_worker_panic(DebugPanicTarget::InputOscListener);

            if stop_for_thread.load(Ordering::Relaxed)
                || osc_tx.is_closed()
                || is_process_shutdown_requested()
            {
                break;
            }

            let (len, source_addr) = match socket.recv_from(&mut buffer) {
                Ok((len, source_addr)) => (len, source_addr),
                Err(error)
                    if error.kind() == ErrorKind::WouldBlock
                        || error.kind() == ErrorKind::TimedOut =>
                {
                    continue;
                }
                Err(error) => {
                    tracing::warn!(?error, "OSC receive failed");
                    continue;
                }
            };

            match decode_packet(&buffer[..len], source_addr) {
                Ok(events) => {
                    for event in events {
                        if osc_tx.send(event).is_err() {
                            return;
                        }
                    }
                }
                Err(error) => {
                    tracing::trace!(
                        source_addr = %source_addr,
                        error = %error,
                        "Ignoring invalid OSC packet"
                    );
                }
            }
        }
    });

    (
        Some(OscListener {
            handle: Some(listener),
            stop_signal,
        }),
        OscListenerStatus {
            is_listening: true,
            bind_address: bind_addr.ip().to_string(),
            port: bind_addr.port(),
        },
    )
}

/// Decode OSC packet bytes into flattened events.
pub fn decode_packet(payload: &[u8], source_addr: SocketAddr) -> Result<Vec<RawOscEvent>, String> {
    let received_at = web_time::Instant::now();
    let (remainder, packet) = decoder::decode_udp(payload)
        .map_err(|error| format!("Failed to decode OSC packet: {error}"))?;
    if !remainder.is_empty() {
        tracing::trace!(
            trailing_bytes = remainder.len(),
            "OSC packet had trailing bytes after decode"
        );
    }

    let source = source_addr.to_string();
    let mut events = Vec::new();
    flatten_packet(packet, &source, received_at, &mut events);
    Ok(events)
}

/// Preserves packet receipt time while flattening nested bundles in source order.
fn flatten_packet(
    packet: RoscPacket,
    source: &str,
    received_at: web_time::Instant,
    output: &mut Vec<RawOscEvent>,
) {
    match packet {
        RoscPacket::Message(message) => output.push(RawOscEvent {
            received_at,
            source: source.to_string(),
            address: message.addr,
            args: message.args.into_iter().map(convert_arg).collect(),
        }),
        RoscPacket::Bundle(bundle) => {
            for packet in bundle.content {
                flatten_packet(packet, source, received_at, output);
            }
        }
    }
}

fn convert_arg(value: RoscType) -> OscType {
    match value {
        RoscType::Int(value) => OscType::Int(value),
        RoscType::Float(value) => OscType::Float(value),
        RoscType::Double(value) => OscType::Double(value),
        RoscType::Long(value) => OscType::Long(value.to_string()),
        RoscType::String(value) => OscType::String(value),
        RoscType::Blob(value) => OscType::Blob(value),
        RoscType::Time(value) => OscType::Time(OscTime {
            seconds: value.seconds,
            fractional: value.fractional,
        }),
        RoscType::Char(value) => OscType::Char(value.to_string()),
        RoscType::Color(value) => OscType::Color(OscColor {
            red: value.red,
            green: value.green,
            blue: value.blue,
            alpha: value.alpha,
        }),
        RoscType::Midi(value) => OscType::Midi(OscMidiMessage {
            port: value.port,
            status: value.status,
            data1: value.data1,
            data2: value.data2,
        }),
        RoscType::Bool(value) => OscType::Bool(value),
        RoscType::Array(value) => {
            OscType::Array(value.content.into_iter().map(convert_arg).collect())
        }
        RoscType::Nil => OscType::Nil,
        RoscType::Inf => OscType::Inf,
    }
}

impl From<RawOscEvent> for OscLastEvent {
    fn from(value: RawOscEvent) -> Self {
        Self {
            source: value.source,
            address: value.address,
            args: value.args,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use rosc::{
        OscArray, OscBundle, OscMessage, OscMidiMessage, OscPacket, OscTime, OscType, encoder,
    };

    use super::*;
    use crate::command::{
        OscColor, OscMidiMessage as NightfallOscMidiMessage, OscTime as NightfallOscTime,
    };

    fn source_addr() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 54321)
    }

    #[test]
    fn decode_single_message_packet() {
        let packet = OscPacket::Message(OscMessage {
            addr: "/exec/start".to_string(),
            args: vec![
                OscType::Int(7),
                OscType::Float(0.5),
                OscType::String("hello".to_string()),
                OscType::Bool(true),
                OscType::Bool(false),
                OscType::Nil,
                OscType::Inf,
            ],
        });
        let bytes = encoder::encode(&packet).expect("packet should encode");
        let events = decode_packet(&bytes, source_addr()).expect("packet should decode");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].address, "/exec/start");
        assert_eq!(
            events[0].args,
            vec![
                crate::command::OscType::Int(7),
                crate::command::OscType::Float(0.5),
                crate::command::OscType::String("hello".to_string()),
                crate::command::OscType::Bool(true),
                crate::command::OscType::Bool(false),
                crate::command::OscType::Nil,
                crate::command::OscType::Inf,
            ]
        );
    }

    #[test]
    fn decode_extended_message_types() {
        let packet = OscPacket::Message(OscMessage {
            addr: "/extended".to_string(),
            args: vec![
                OscType::Long(9_223_372_036_854_775_000_i64),
                OscType::Double(42.125_f64),
                OscType::Blob(vec![0xde, 0xad, 0xbe, 0xef]),
                OscType::Char('x'),
                OscType::Time(OscTime::from((12_u32, 34_u32))),
                OscType::Midi(OscMidiMessage {
                    port: 1,
                    status: 0x90,
                    data1: 60,
                    data2: 100,
                }),
                OscType::Color(rosc::OscColor {
                    red: 1,
                    green: 2,
                    blue: 3,
                    alpha: 4,
                }),
                OscType::Array(OscArray {
                    content: vec![OscType::Int(1), OscType::String("go".to_string())],
                }),
            ],
        });
        let bytes = encoder::encode(&packet).expect("packet should encode");
        let events = decode_packet(&bytes, source_addr()).expect("packet should decode");

        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].args,
            vec![
                crate::command::OscType::Long("9223372036854775000".to_string()),
                crate::command::OscType::Double(42.125_f64),
                crate::command::OscType::Blob(vec![0xde, 0xad, 0xbe, 0xef]),
                crate::command::OscType::Char("x".to_string()),
                crate::command::OscType::Time(NightfallOscTime {
                    seconds: 12,
                    fractional: 34,
                }),
                crate::command::OscType::Midi(NightfallOscMidiMessage {
                    port: 1,
                    status: 0x90,
                    data1: 60,
                    data2: 100,
                }),
                crate::command::OscType::Color(OscColor {
                    red: 1,
                    green: 2,
                    blue: 3,
                    alpha: 4,
                }),
                crate::command::OscType::Array(vec![
                    crate::command::OscType::Int(1),
                    crate::command::OscType::String("go".to_string())
                ]),
            ]
        );
    }

    #[test]
    fn decode_bundle_packet() {
        let first = OscPacket::Message(OscMessage {
            addr: "/a".to_string(),
            args: vec![OscType::Int(1)],
        });
        let second = OscPacket::Message(OscMessage {
            addr: "/b".to_string(),
            args: vec![OscType::String("go".to_string())],
        });
        let packet = OscPacket::Bundle(OscBundle {
            timetag: OscTime::from((0_u32, 1_u32)),
            content: vec![first, second],
        });
        let bytes = encoder::encode(&packet).expect("bundle should encode");

        let events = decode_packet(&bytes, source_addr()).expect("bundle should decode");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].address, "/a");
        assert_eq!(events[1].address, "/b");
    }
}
