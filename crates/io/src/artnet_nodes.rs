// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Art-Net nodes discovered on the network through ArtPoll / ArtPollReply.

#[cfg(not(target_arch = "wasm32"))]
use std::net::SocketAddr;
use std::{
    collections::BTreeMap,
    net::Ipv4Addr,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use web_time::Instant;

/// Byte range of the little-endian opcode in every Art-Net packet.
#[cfg(not(target_arch = "wasm32"))]
const OPCODE_RANGE: std::ops::Range<usize> = 8..10;
/// OpPollReply opcode as it appears on the wire.
#[cfg(not(target_arch = "wasm32"))]
const POLL_REPLY_OPCODE: [u8; 2] = 0x2100u16.to_le_bytes();
/// Length of a complete Art-Net 4 ArtPollReply, including the header and opcode.
#[cfg(not(target_arch = "wasm32"))]
const POLL_REPLY_LEN: usize = 239;
/// Shortest ArtPollReply accepted: everything up to and including the long name. Older nodes
/// omit trailing fields added by later protocol revisions, which decode as zero.
#[cfg(not(target_arch = "wasm32"))]
const POLL_REPLY_MIN_LEN: usize = 108;

/// Decodes an ArtPollReply received from `source` into a node seen at `seen_at`.
///
/// Returns `None` for other opcodes and for replies too short to carry the node's identity. The
/// node's self-reported address is used unless it is unset, in which case the datagram's source
/// address stands in.
#[cfg(not(target_arch = "wasm32"))]
fn decode_poll_reply(packet: &[u8], source: SocketAddr, seen_at: Instant) -> Option<ArtNetNode> {
    if packet.len() < POLL_REPLY_MIN_LEN {
        return None;
    }
    let mut padded = packet.to_vec();
    if padded.len() < POLL_REPLY_LEN {
        padded.resize(POLL_REPLY_LEN, 0);
    }
    let artnet_protocol::ArtCommand::PollReply(reply) =
        artnet_protocol::ArtCommand::from_buffer(&padded).ok()?
    else {
        return None;
    };
    let ip = match (reply.address, source) {
        (address, _) if !address.is_unspecified() => address,
        (_, SocketAddr::V4(source)) => *source.ip(),
        (address, SocketAddr::V6(_)) => address,
    };
    Some(ArtNetNode {
        ip,
        bind_index: reply.bind_index,
        model: ArtNetNodeModel {
            esta_manufacturer: reply.esta_code,
            oem: u16::from_be_bytes(reply.oem),
        },
        short_name: nul_terminated_string(&reply.short_name),
        long_name: nul_terminated_string(&reply.long_name),
        last_seen: seen_at,
    })
}

/// Decodes a fixed-length, NUL-terminated name field, replacing invalid UTF-8 and trimming
/// surrounding whitespace.
#[cfg(not(target_arch = "wasm32"))]
fn nul_terminated_string(field: &[u8]) -> String {
    let end = field
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).trim().to_string()
}

/// Hardware model of an Art-Net node, as reported in its ArtPollReply.
///
/// Together the ESTA manufacturer and OEM codes identify the product independently of anything
/// the user configured on the node, unlike its short and long names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ArtNetNodeModel {
    /// ESTA manufacturer code (`EstaMan`), conventionally two ASCII initials such as `AL`.
    pub esta_manufacturer: u16,
    /// Art-Net OEM code (`Oem`) assigned to the product by Artistic Licence.
    pub oem: u16,
}

impl ArtNetNodeModel {
    /// Renders the ESTA manufacturer code as its two ASCII initials (high byte first), or `None`
    /// when either byte is not a printable ASCII character.
    pub fn esta_manufacturer_initials(&self) -> Option<String> {
        let [high, low] = self.esta_manufacturer.to_be_bytes();
        (high.is_ascii_graphic() && low.is_ascii_graphic())
            .then(|| String::from_utf8_lossy(&[high, low]).into_owned())
    }
}

/// One Art-Net node (or one bound sub-device of a node) that answered an ArtPoll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtNetNode {
    /// IPv4 address the node reports for itself.
    pub ip: Ipv4Addr,
    /// Position of this sub-device within a multi-port product; 0 or 1 is the root device.
    pub bind_index: u8,
    /// Hardware model identity.
    pub model: ArtNetNodeModel,
    /// Short name. Nodes ship with a product name here, but users can rename them.
    pub short_name: String,
    /// Long name. Nodes ship with a product name here, but users can rename them.
    pub long_name: String,
    /// When the node last answered a poll.
    pub last_seen: Instant,
}

/// Art-Net nodes that recently answered an ArtPoll, keyed by address and bind index.
///
/// Clones share one directory, so the listener thread that decodes ArtPollReply packets and the
/// ECS readers see the same nodes. A node drops out once it has not answered for
/// [`ArtNetNodeDirectory::NODE_TIMEOUT`].
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "ecs", derive(bevy_ecs::prelude::Resource))]
pub struct ArtNetNodeDirectory {
    nodes: Arc<Mutex<BTreeMap<(Ipv4Addr, u8), ArtNetNode>>>,
}

impl ArtNetNodeDirectory {
    /// How long a node stays listed after its last reply. Controllers poll every few seconds,
    /// so this tolerates a few missed replies before a node is considered gone.
    pub const NODE_TIMEOUT: Duration = Duration::from_secs(10);

    /// Most nodes listed at once, so a device flooding the network with replies under made-up
    /// addresses cannot grow the directory without bound. Real rigs stay far below this.
    pub const MAX_NODES: usize = 1024;

    /// Creates an empty directory.
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the directory shared by every Art-Net socket in this process.
    ///
    /// Nodes answer polls either at the Art-Net port, where the input listener receives them, or
    /// at the poll socket's own port, so both record into this one directory.
    pub fn process() -> Self {
        static PROCESS_DIRECTORY: OnceLock<ArtNetNodeDirectory> = OnceLock::new();
        PROCESS_DIRECTORY.get_or_init(Self::new).clone()
    }

    /// Records `packet` when it is an ArtPollReply received from `source`, logging nodes the
    /// first time they appear.
    ///
    /// Returns `true` when the packet was an ArtPollReply, whether or not it decoded into a
    /// usable node, so callers can skip their own decoding.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn record_poll_reply(&self, packet: &[u8], source: SocketAddr) -> bool {
        if packet.get(OPCODE_RANGE) != Some(&POLL_REPLY_OPCODE[..]) {
            return false;
        }
        let Some(node) = decode_poll_reply(packet, source, Instant::now()) else {
            return true;
        };
        let (ip, bind_index, model) = (node.ip, node.bind_index, node.model);
        if self.record(node) {
            tracing::info!(
                %ip,
                bind_index,
                esta_manufacturer = format_args!("{:#06x}", model.esta_manufacturer),
                oem = format_args!("{:#06x}", model.oem),
                "Discovered Art-Net node"
            );
        }
        true
    }

    /// Records a node's reply, replacing any earlier entry for the same address and bind index,
    /// and drops nodes that have timed out relative to the new reply.
    ///
    /// A node not yet listed is ignored while the directory holds [`Self::MAX_NODES`] nodes.
    ///
    /// Returns `true` when the node was newly listed, so callers can log new arrivals once.
    pub fn record(&self, node: ArtNetNode) -> bool {
        let Ok(mut nodes) = self.nodes.lock() else {
            return false;
        };
        let now = node.last_seen;
        nodes.retain(|_, existing| !Self::is_expired(existing, now));
        let key = (node.ip, node.bind_index);
        if nodes.len() >= Self::MAX_NODES && !nodes.contains_key(&key) {
            return false;
        }
        nodes.insert(key, node).is_none()
    }

    /// Returns the nodes that answered within [`Self::NODE_TIMEOUT`] of `now`, ordered by address
    /// and bind index.
    pub fn nodes(&self, now: Instant) -> Vec<ArtNetNode> {
        let Ok(nodes) = self.nodes.lock() else {
            return Vec::new();
        };
        nodes
            .values()
            .filter(|node| !Self::is_expired(node, now))
            .cloned()
            .collect()
    }

    /// Returns whether `node` last answered more than [`Self::NODE_TIMEOUT`] before `now`.
    fn is_expired(node: &ArtNetNode, now: Instant) -> bool {
        now.saturating_duration_since(node.last_seen) > Self::NODE_TIMEOUT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a node at `ip` that was last seen at `last_seen`.
    fn node(ip: [u8; 4], bind_index: u8, last_seen: Instant) -> ArtNetNode {
        ArtNetNode {
            ip: Ipv4Addr::from(ip),
            bind_index,
            model: ArtNetNodeModel {
                esta_manufacturer: 0x414C,
                oem: 0x0001,
            },
            short_name: "Node".to_string(),
            long_name: "Node long name".to_string(),
            last_seen,
        }
    }

    /// A repeated reply from the same node replaces its entry instead of duplicating it, while
    /// sub-devices of one product are listed separately.
    #[test]
    fn record_keys_nodes_by_address_and_bind_index() {
        let directory = ArtNetNodeDirectory::new();
        let start = Instant::now();
        assert!(directory.record(node([10, 0, 0, 5], 1, start)));
        assert!(!directory.record(node([10, 0, 0, 5], 1, start + Duration::from_secs(1))));
        assert!(directory.record(node([10, 0, 0, 5], 2, start + Duration::from_secs(1))));

        let nodes = directory.nodes(start + Duration::from_secs(1));
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].last_seen, start + Duration::from_secs(1));
        assert_eq!(nodes[1].bind_index, 2);
    }

    /// Once full, the directory keeps refreshing listed nodes but ignores new ones.
    #[test]
    fn record_ignores_new_nodes_when_full() {
        let directory = ArtNetNodeDirectory::new();
        let start = Instant::now();
        for index in 0..ArtNetNodeDirectory::MAX_NODES {
            let [_, _, high, low] = u32::try_from(index).expect("index fits").to_be_bytes();
            directory.record(node([10, 1, high, low], 1, start));
        }

        assert!(!directory.record(node([10, 2, 0, 0], 1, start)));
        assert!(!directory.record(node([10, 1, 0, 0], 1, start + Duration::from_secs(1))));
        let nodes = directory.nodes(start + Duration::from_secs(1));
        assert_eq!(nodes.len(), ArtNetNodeDirectory::MAX_NODES);
        assert_eq!(nodes[0].last_seen, start + Duration::from_secs(1));
    }

    /// Nodes that stop answering drop out of the listing after the timeout.
    #[test]
    fn nodes_omits_nodes_past_timeout() {
        let directory = ArtNetNodeDirectory::new();
        let start = Instant::now();
        directory.record(node([10, 0, 0, 5], 1, start));
        directory.record(node([10, 0, 0, 6], 1, start + Duration::from_secs(5)));

        let later = start + ArtNetNodeDirectory::NODE_TIMEOUT + Duration::from_secs(1);
        let nodes = directory.nodes(later);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].ip, Ipv4Addr::new(10, 0, 0, 6));
    }

    /// Copies `name` into a zero-filled, fixed-length Art-Net name field.
    fn name_field<const N: usize>(name: &str) -> [u8; N] {
        let mut field = [0u8; N];
        field[..name.len()].copy_from_slice(name.as_bytes());
        field
    }

    /// Encodes an ArtPollReply from a node reporting `address`, made by ESTA `AL` with OEM
    /// 0x1234.
    fn poll_reply_packet(address: Ipv4Addr) -> Vec<u8> {
        let reply = artnet_protocol::PollReply {
            address,
            oem: [0x12, 0x34],
            esta_code: 0x414C,
            short_name: name_field("Stage left"),
            long_name: name_field("Stage left node"),
            bind_index: 1,
            ..artnet_protocol::PollReply::default()
        };
        artnet_protocol::ArtCommand::PollReply(Box::new(reply))
            .write_to_buffer()
            .expect("poll reply should encode")
    }

    /// Source address the test replies arrive from.
    fn source() -> SocketAddr {
        SocketAddr::new(Ipv4Addr::new(10, 0, 0, 99).into(), 6454)
    }

    /// An ArtPollReply records the node's model and names.
    #[test]
    fn record_poll_reply_records_node_identity() {
        let directory = ArtNetNodeDirectory::new();

        assert!(
            directory.record_poll_reply(&poll_reply_packet(Ipv4Addr::new(10, 0, 0, 42)), source())
        );

        let nodes = directory.nodes(Instant::now());
        assert_eq!(nodes.len(), 1);
        let node = &nodes[0];
        assert_eq!(node.ip, Ipv4Addr::new(10, 0, 0, 42));
        assert_eq!(node.bind_index, 1);
        assert_eq!(
            node.model,
            ArtNetNodeModel {
                esta_manufacturer: 0x414C,
                oem: 0x1234,
            }
        );
        assert_eq!(
            node.model.esta_manufacturer_initials().as_deref(),
            Some("AL")
        );
        assert_eq!(node.short_name, "Stage left");
        assert_eq!(node.long_name, "Stage left node");
    }

    /// A node that does not report its own address is listed under the reply's source address.
    #[test]
    fn record_poll_reply_falls_back_to_source_address() {
        let directory = ArtNetNodeDirectory::new();

        directory.record_poll_reply(&poll_reply_packet(Ipv4Addr::UNSPECIFIED), source());

        assert_eq!(
            directory.nodes(Instant::now())[0].ip,
            Ipv4Addr::new(10, 0, 0, 99)
        );
    }

    /// Older nodes omit the trailing fields of later protocol revisions; their replies are still
    /// recorded, while replies cut off before the names are not.
    #[test]
    fn record_poll_reply_accepts_short_replies_with_identity() {
        let mut older = poll_reply_packet(Ipv4Addr::new(10, 0, 0, 42));
        older.truncate(207);
        let mut truncated = poll_reply_packet(Ipv4Addr::new(10, 0, 0, 43));
        truncated.truncate(POLL_REPLY_MIN_LEN - 1);
        let directory = ArtNetNodeDirectory::new();

        assert!(directory.record_poll_reply(&older, source()));
        assert!(directory.record_poll_reply(&truncated, source()));

        let nodes = directory.nodes(Instant::now());
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].ip, Ipv4Addr::new(10, 0, 0, 42));
        assert_eq!(nodes[0].bind_index, 0);
    }

    /// Packets with other opcodes are left for the caller to decode.
    #[test]
    fn record_poll_reply_ignores_other_opcodes() {
        let poll = artnet_protocol::ArtCommand::Poll(artnet_protocol::Poll::default())
            .write_to_buffer()
            .expect("poll should encode");
        let directory = ArtNetNodeDirectory::new();

        assert!(!directory.record_poll_reply(&poll, source()));
        assert!(!directory.record_poll_reply(&[0u8; 4], source()));
        assert!(directory.nodes(Instant::now()).is_empty());
    }

    /// ESTA codes render as the manufacturer's two ASCII initials when printable.
    #[test]
    fn esta_manufacturer_initials_decodes_printable_codes() {
        let model = ArtNetNodeModel {
            esta_manufacturer: 0x414C,
            oem: 0,
        };
        assert_eq!(model.esta_manufacturer_initials().as_deref(), Some("AL"));

        let unprintable = ArtNetNodeModel {
            esta_manufacturer: 0x0000,
            oem: 0,
        };
        assert_eq!(unprintable.esta_manufacturer_initials(), None);
    }
}
