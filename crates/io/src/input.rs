// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Transport input contracts shared by protocol adapters and routing consumers.

use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    time::Duration,
};

use bevy_ecs::prelude::*;
use nightfall_dmx::MAX_CHANNELS_PER_UNIVERSE;
use serde::{Deserialize, Serialize};
use web_time::Instant;

/// Transport identifier used in binding declarations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "lowercase")]
pub enum BindingTransport {
    /// Streaming ACN (E1.31).
    Sacn,
    /// Art-Net protocol.
    ArtNet,
    /// uDMX USB interface.
    Udmx,
}

/// Metadata about the local sACN output source identity.
#[derive(Debug, Default, Clone, Resource)]
pub struct SacnOutputIdentity {
    /// CID bytes of the local sACN output source, if configured.
    pub cid: Option<[u8; 16]>,
}

/// Metadata about the local Art-Net output source identity.
#[derive(Debug, Clone, Resource, Default)]
pub struct ArtNetRecentFramesByUniverse {
    recent_frames: HashMap<u16, VecDeque<ArtNetRecentFrame>>,
}

/// Most recent Art-Net frame seen for a universe and its source endpoint.
#[derive(Debug, Clone)]
struct ArtNetRecentFrame {
    sequence: u8,
    source_addr: Option<SocketAddr>,
    sent_at: Instant,
}

impl ArtNetRecentFramesByUniverse {
    const MAX_RECENT_FRAMES_PER_UNIVERSE: usize = 256;
    const MAX_RECENT_FRAME_AGE: Duration = Duration::from_secs(3);

    /// Creates a new Art-Net recent frames tracker.
    pub fn new() -> Self {
        Self {
            recent_frames: HashMap::new(),
        }
    }

    /// Records a recently transmitted Art-Net frame fingerprint for local loopback filtering.
    pub fn record_recent_frame(
        &mut self,
        universe_id: u16,
        sequence: u8,
        _data: &[u8; MAX_CHANNELS_PER_UNIVERSE],
        source_addr: Option<SocketAddr>,
        sent_at: Instant,
    ) {
        let recent = self.recent_frames.entry(universe_id).or_default();
        recent.push_front(ArtNetRecentFrame {
            sequence,
            source_addr,
            sent_at,
        });
        while recent.back().is_some_and(|frame| {
            sent_at.saturating_duration_since(frame.sent_at) > Self::MAX_RECENT_FRAME_AGE
        }) {
            recent.pop_back();
        }
        while recent.len() > Self::MAX_RECENT_FRAMES_PER_UNIVERSE {
            recent.pop_back();
        }
    }

    /// Returns true when a frame matches a recently transmitted local Art-Net sender identity.
    pub fn has_recent_local_sender_sequence_match(
        &self,
        universe_id: u16,
        sequence: u8,
        source_addr: &SocketAddr,
        received_at: Instant,
        match_window: Duration,
    ) -> bool {
        self.recent_frames
            .get(&universe_id)
            .into_iter()
            .flatten()
            .any(|recent| {
                recent.sequence == sequence
                    && recent
                        .source_addr
                        .is_some_and(|recent_source_addr| recent_source_addr == *source_addr)
                    && received_at.saturating_duration_since(recent.sent_at) <= match_window
            })
    }
}

/// One accepted DMX frame, after protocol validation and local-source filtering.
#[derive(Debug, Clone, Message)]
pub struct AcceptedDmxFrame {
    /// Protocol that delivered the frame.
    pub transport: BindingTransport,
    /// Source universe identifier.
    pub universe: u16,
    /// Decoded channel data, padded to a complete universe by the adapter.
    pub data: [u8; MAX_CHANNELS_PER_UNIVERSE],
    /// Original receive time, retained for signal-loss decisions.
    pub received_at: Instant,
    /// Whether the adapter identified this frame as local output loopback.
    pub is_self_frame: bool,
}

/// Shared ordering boundary for adapter publication and routing consumption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, SystemSet)]
pub enum DmxInputSet {
    /// Protocol adapters publish accepted frames.
    Ingress,
    /// Routing consumers apply accepted frames to their destinations.
    Apply,
}

/// IO runtime observations that integration layers may present to an operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IoRuntimeNotification {
    /// A network listener could not bind, causing network input to be disabled.
    InputBindFailed {
        /// Protocol whose listener failed.
        transport: BindingTransport,
        /// UDP port requested by the listener.
        port: u16,
    },
}
