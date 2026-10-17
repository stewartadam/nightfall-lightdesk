// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Art-Net node discovery: polls the network for nodes while Art-Net output runs.
//!
//! Nodes answer an ArtPoll with an ArtPollReply sent to the Art-Net port, and some answer at
//! the poll's source port instead. When Art-Net input is enabled its listener owns the Art-Net
//! port and records replies there, so discovery polls from an ephemeral port to avoid splitting
//! that port's unicast traffic. Otherwise discovery binds the Art-Net port itself. Every reply
//! lands in [`ArtNetNodeDirectory::process`].

use std::collections::BTreeSet;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use nightfall_engine::prelude::is_process_shutdown_requested;
use nightfall_io::prelude::ArtNetNodeDirectory;
use socket2::{Domain, Protocol, Socket, Type};

use crate::service::ArtNetOutputClient;

/// How often nodes are polled. The Art-Net specification asks controllers to poll every 2.5 to
/// 3 seconds.
const ARTNET_POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Longest a receive blocks before the worker rechecks its stop signal and poll schedule.
const RECEIVE_TIMEOUT: Duration = Duration::from_millis(250);

/// Returns the encoded ArtPoll packet, which never changes, so it is built once per process.
fn artnet_poll_packet() -> &'static [u8] {
    static PACKET: OnceLock<Vec<u8>> = OnceLock::new();
    PACKET.get_or_init(|| {
        artnet_protocol::ArtCommand::Poll(artnet_protocol::Poll::default())
            .write_to_buffer()
            .expect("the default ArtPoll always encodes")
    })
}

/// Where discovery polls from, derived from the output interface and whether input owns the
/// Art-Net port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ArtNetDiscoveryBinding {
    /// Output interface address to poll from, or `None` when output is off.
    bind_ip: Option<Ipv4Addr>,
    /// Local port: the Art-Net port when input is off, or 0 for an ephemeral port.
    port: u16,
    /// Destination for broadcast polls.
    broadcast_dest: SocketAddrV4,
}

impl ArtNetDiscoveryBinding {
    /// Polls from `bind_ip` while output is enabled. When `input_listening` is false the poll
    /// socket also binds `broadcast_dest`'s port so replies sent there are heard.
    pub(crate) fn new(
        bind_ip: Option<Ipv4Addr>,
        input_listening: bool,
        broadcast_dest: SocketAddrV4,
    ) -> Self {
        Self {
            bind_ip,
            port: if input_listening {
                0
            } else {
                broadcast_dest.port()
            },
            broadcast_dest,
        }
    }
}

/// Socket that sends ArtPoll packets and records the replies that reach it.
struct PollSocket {
    socket: UdpSocket,
    broadcast_dest: SocketAddrV4,
    nodes: ArtNetNodeDirectory,
}

impl PollSocket {
    /// Binds `bind_ip:port`, sharing the port with other Art-Net listeners, with a receive
    /// timeout so the worker can notice its stop signal.
    fn bind(
        bind_ip: Ipv4Addr,
        port: u16,
        broadcast_dest: SocketAddrV4,
        nodes: ArtNetNodeDirectory,
    ) -> std::io::Result<Self> {
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        #[cfg(unix)]
        socket.set_reuse_port(true)?;
        socket.set_reuse_address(true)?;
        socket.set_broadcast(true)?;
        socket.bind(&SocketAddr::new(bind_ip.into(), port).into())?;
        let socket: UdpSocket = socket.into();
        socket.set_read_timeout(Some(RECEIVE_TIMEOUT))?;
        Ok(Self {
            socket,
            broadcast_dest,
            nodes,
        })
    }

    /// Broadcasts an ArtPoll and unicasts it to each of `unicast_targets`, which reaches nodes
    /// on routed subnets that broadcast cannot.
    ///
    /// Send failures are only traced: discovery is best effort and never affects DMX output.
    fn poll(&self, unicast_targets: BTreeSet<Ipv4Addr>) {
        let port = self.broadcast_dest.port();
        let destinations = std::iter::once(self.broadcast_dest).chain(
            unicast_targets
                .into_iter()
                .map(|ip| SocketAddrV4::new(ip, port)),
        );
        for destination in destinations {
            if let Err(error) = self.socket.send_to(artnet_poll_packet(), destination) {
                tracing::trace!(?error, %destination, "Sending ArtPoll failed");
            }
        }
    }

    /// Waits up to [`RECEIVE_TIMEOUT`] for one datagram and records it if it is an
    /// ArtPollReply; everything else, including ArtDmx on a shared Art-Net port, is ignored.
    fn receive(&self, buffer: &mut [u8]) {
        if let Ok((len, source)) = self.socket.recv_from(buffer) {
            self.nodes.record_poll_reply(&buffer[..len], source);
        }
    }
}

/// Background worker that polls for Art-Net nodes from the output interface and records the
/// replies it hears.
///
/// It runs on its own thread and socket, so polling never delays or shares a socket with DMX
/// frames.
pub(crate) struct ArtNetDiscoveryWorker {
    stop_signal: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl ArtNetDiscoveryWorker {
    /// Starts polling as `binding` describes, also unicasting polls to the nodes `client`
    /// currently sends unicast frames to. Returns `None` when output is off or the socket or
    /// thread cannot start.
    pub(crate) fn spawn(
        binding: ArtNetDiscoveryBinding,
        client: ArtNetOutputClient,
    ) -> Option<Self> {
        let bind_ip = binding.bind_ip?;
        let socket = match PollSocket::bind(
            bind_ip,
            binding.port,
            binding.broadcast_dest,
            ArtNetNodeDirectory::process(),
        ) {
            Ok(socket) => socket,
            Err(error) => {
                tracing::warn!(?error, %bind_ip, port = binding.port, "Could not bind Art-Net discovery socket");
                return None;
            }
        };
        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop_signal);
        let spawned = std::thread::Builder::new()
            .name("artnet-discovery".to_string())
            .spawn(move || {
                let mut buffer = [0u8; 1024];
                let mut next_poll = Instant::now();
                while !stop_for_thread.load(Ordering::Relaxed) && !is_process_shutdown_requested() {
                    if Instant::now() >= next_poll {
                        socket.poll(client.unicast_targets());
                        next_poll = Instant::now() + ARTNET_POLL_INTERVAL;
                    }
                    socket.receive(&mut buffer);
                }
            });
        match spawned {
            Ok(join_handle) => Some(Self {
                stop_signal,
                join_handle: Some(join_handle),
            }),
            Err(error) => {
                tracing::warn!(?error, "Could not start Art-Net discovery worker");
                None
            }
        }
    }

    /// Stops polling and waits for the worker thread to release its socket.
    pub(crate) fn shutdown(&mut self) {
        self.stop_signal.store(true, Ordering::Relaxed);
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }

    /// Returns whether the worker thread is still running.
    pub(crate) fn is_alive(&self) -> bool {
        self.join_handle
            .as_ref()
            .is_some_and(|join_handle| !join_handle.is_finished())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Binds a loopback socket standing in for a node, returning it with its address.
    fn loopback_node() -> (UdpSocket, SocketAddrV4) {
        let node = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("node should bind");
        node.set_read_timeout(Some(Duration::from_millis(500)))
            .expect("node should accept a read timeout");
        let SocketAddr::V4(address) = node.local_addr().expect("node should have an address")
        else {
            panic!("loopback node should be IPv4");
        };
        (node, address)
    }

    /// Receives one datagram at `node`, asserts it is an ArtPoll, and returns its source.
    fn expect_poll(node: &UdpSocket) -> SocketAddr {
        let mut buffer = [0u8; 64];
        let (len, source) = node
            .recv_from(&mut buffer)
            .expect("an ArtPoll should arrive");
        assert!(matches!(
            artnet_protocol::ArtCommand::from_buffer(&buffer[..len]),
            Ok(artnet_protocol::ArtCommand::Poll(_))
        ));
        source
    }

    /// Encodes an ArtPollReply from a node reporting `address` with ESTA code `AL`.
    fn poll_reply_packet(address: Ipv4Addr) -> Vec<u8> {
        let reply = artnet_protocol::PollReply {
            address,
            esta_code: 0x414C,
            ..artnet_protocol::PollReply::default()
        };
        artnet_protocol::ArtCommand::PollReply(Box::new(reply))
            .write_to_buffer()
            .expect("poll reply should encode")
    }

    /// Input owns the Art-Net port while it listens, so discovery only binds that port when
    /// input is off.
    #[test]
    fn binding_uses_artnet_port_only_without_input() {
        let dest = SocketAddrV4::new(Ipv4Addr::BROADCAST, 6454);
        assert_eq!(ArtNetDiscoveryBinding::new(None, true, dest).port, 0);
        assert_eq!(ArtNetDiscoveryBinding::new(None, false, dest).port, 6454);
    }

    /// Output being off means no discovery worker.
    #[test]
    fn spawn_without_bind_ip_starts_nothing() {
        let binding =
            ArtNetDiscoveryBinding::new(None, false, SocketAddrV4::new(Ipv4Addr::BROADCAST, 6454));
        assert!(ArtNetDiscoveryWorker::spawn(binding, ArtNetOutputClient::default()).is_none());
    }

    /// Each poll is broadcast and unicast once to every unicast target.
    #[test]
    fn poll_broadcasts_and_unicasts_to_each_target() {
        let (node, address) = loopback_node();
        let socket = PollSocket::bind(Ipv4Addr::LOCALHOST, 0, address, ArtNetNodeDirectory::new())
            .expect("poll socket should bind");

        socket.poll(BTreeSet::from([Ipv4Addr::LOCALHOST]));

        // The unicast target shares the loopback address and port with the broadcast stand-in,
        // so the node sees exactly two polls.
        expect_poll(&node);
        expect_poll(&node);
        node.set_read_timeout(Some(Duration::from_millis(100)))
            .expect("node should accept a read timeout");
        let mut buffer = [0u8; 64];
        assert!(node.recv_from(&mut buffer).is_err());
    }

    /// A running worker polls immediately and records a reply sent back to its socket.
    #[test]
    fn worker_records_replies() {
        let (node, address) = loopback_node();
        let binding = ArtNetDiscoveryBinding {
            bind_ip: Some(Ipv4Addr::LOCALHOST),
            port: 0,
            broadcast_dest: address,
        };
        let mut worker = ArtNetDiscoveryWorker::spawn(binding, ArtNetOutputClient::default())
            .expect("worker should start");

        let poll_source = expect_poll(&node);
        let reply_ip = Ipv4Addr::new(10, 0, 0, 8);
        node.send_to(&poll_reply_packet(reply_ip), poll_source)
            .expect("reply should send");

        let nodes = ArtNetNodeDirectory::process();
        let deadline = Instant::now() + Duration::from_secs(2);
        let is_recorded = || {
            nodes
                .nodes(Instant::now())
                .iter()
                .any(|node| node.ip == reply_ip)
        };
        while !is_recorded() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(is_recorded());

        worker.shutdown();
        assert!(!worker.is_alive());
    }

    /// The cached ArtPoll decodes as an ArtPoll.
    #[test]
    fn artnet_poll_packet_decodes_as_poll() {
        assert!(matches!(
            artnet_protocol::ArtCommand::from_buffer(artnet_poll_packet()),
            Ok(artnet_protocol::ArtCommand::Poll(_))
        ));
    }
}
