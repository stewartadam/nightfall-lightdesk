// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Per-sender arbitration for network DMX input universes.
//!
//! Several senders can transmit the same universe. Receivers keep one buffer per sender and
//! combine them instead of letting the most recent packet overwrite the universe: the
//! highest-priority senders win, and senders tied at that priority merge highest-takes-precedence
//! (HTP) per channel. A sender that falls silent for longer than the protocol's timeout is
//! dropped, so a lower-priority sender takes over.

use std::{collections::HashMap, hash::Hash, time::Duration};

use nightfall_dmx::MAX_CHANNELS_PER_UNIVERSE;
use web_time::Instant;

/// Silence after which an sACN source is dropped (E1.31 network data loss timeout).
pub const SACN_SOURCE_TIMEOUT: Duration = Duration::from_millis(2500);

/// Silence after which an Art-Net source leaves the merge (Art-Net 4 merge timeout).
///
/// Art-Net senders may refresh unchanged data only every few seconds, so the sACN timeout would
/// drop idle but healthy senders.
pub const ARTNET_SOURCE_TIMEOUT: Duration = Duration::from_secs(10);

/// Latest frame and priority held for one sender of one universe.
#[derive(Debug, Clone)]
struct SourceBuffer<K> {
    source: K,
    priority: u8,
    data: [u8; MAX_CHANNELS_PER_UNIVERSE],
    last_seen: Instant,
}

/// Per-universe sender buffers that resolve competing senders into one universe frame.
///
/// `K` identifies a sender: the CID for sACN, the IP address for Art-Net.
#[derive(Debug, Clone)]
pub struct UniverseSourceMerge<K> {
    timeout: Duration,
    universes: HashMap<u16, Vec<SourceBuffer<K>>>,
}

impl<K: Copy + Eq + Hash> UniverseSourceMerge<K> {
    /// Creates an empty merge that drops senders silent for longer than `timeout`.
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            universes: HashMap::new(),
        }
    }

    /// Records a sender's frame and returns the universe as receivers should now see it.
    ///
    /// Senders silent for longer than the timeout at `received_at` are dropped first, so the
    /// returned universe never includes a sender that has timed out.
    pub fn accept(
        &mut self,
        universe: u16,
        source: K,
        priority: u8,
        data: &[u8; MAX_CHANNELS_PER_UNIVERSE],
        received_at: Instant,
    ) -> [u8; MAX_CHANNELS_PER_UNIVERSE] {
        let timeout = self.timeout;
        let sources = self.universes.entry(universe).or_default();
        sources
            .retain(|buffer| buffer.source == source || !is_expired(buffer, received_at, timeout));
        match sources.iter_mut().find(|buffer| buffer.source == source) {
            Some(buffer) => {
                buffer.priority = priority;
                buffer.data = *data;
                buffer.last_seen = received_at;
            }
            None => sources.push(SourceBuffer {
                source,
                priority,
                data: *data,
                last_seen: received_at,
            }),
        }
        merge_sources(sources).expect("the accepted sender is always present")
    }

    /// Drops a sender that announced it stopped transmitting a universe.
    ///
    /// Returns the universe as the remaining live senders define it. Returns `None` when the
    /// sender was not live on that universe (nothing changed), or when no sender is left, in
    /// which case the universe's signal-loss handling takes over.
    pub fn remove_source(
        &mut self,
        universe: u16,
        source: K,
        now: Instant,
    ) -> Option<[u8; MAX_CHANNELS_PER_UNIVERSE]> {
        let timeout = self.timeout;
        let sources = self.universes.get_mut(&universe)?;
        let position = sources.iter().position(|buffer| buffer.source == source)?;
        sources.swap_remove(position);
        sources.retain(|buffer| !is_expired(buffer, now, timeout));
        let merged = merge_sources(sources);
        if merged.is_none() {
            self.universes.remove(&universe);
        }
        merged
    }
}

/// Returns true when a sender has been silent for longer than the timeout at `now`.
fn is_expired<K>(buffer: &SourceBuffer<K>, now: Instant, timeout: Duration) -> bool {
    now.saturating_duration_since(buffer.last_seen) > timeout
}

/// Combines live senders: only the highest priority counts, and ties merge HTP per channel.
///
/// HTP keeps tied senders stable, where newest-wins would flicker between them on every packet.
fn merge_sources<K>(sources: &[SourceBuffer<K>]) -> Option<[u8; MAX_CHANNELS_PER_UNIVERSE]> {
    let top_priority = sources.iter().map(|buffer| buffer.priority).max()?;
    let mut winners = sources
        .iter()
        .filter(|buffer| buffer.priority == top_priority);
    let mut merged = winners.next()?.data;
    for buffer in winners {
        for (merged_value, value) in merged.iter_mut().zip(buffer.data.iter()) {
            *merged_value = (*merged_value).max(*value);
        }
    }
    Some(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a universe with one channel set, everything else at zero.
    fn universe_with(address: usize, value: u8) -> [u8; MAX_CHANNELS_PER_UNIVERSE] {
        let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
        data[address - 1] = value;
        data
    }

    /// The higher-priority sender wins regardless of which sender's packet arrived last.
    #[test]
    fn higher_priority_sender_wins_in_either_arrival_order() {
        let start = Instant::now();
        let high = universe_with(1, 200);
        let low = universe_with(1, 10);

        let mut merge = UniverseSourceMerge::new(SACN_SOURCE_TIMEOUT);
        merge.accept(1, 'A', 100, &high, start);
        assert_eq!(merge.accept(1, 'B', 50, &low, start)[0], 200);

        let mut merge = UniverseSourceMerge::new(SACN_SOURCE_TIMEOUT);
        assert_eq!(merge.accept(1, 'B', 50, &low, start)[0], 10);
        assert_eq!(merge.accept(1, 'A', 100, &high, start)[0], 200);
        let later = start + Duration::from_millis(20);
        assert_eq!(merge.accept(1, 'B', 50, &low, later)[0], 200);
    }

    /// A lower-priority sender takes over once the higher one has been silent past the timeout.
    #[test]
    fn lower_priority_sender_takes_over_after_timeout() {
        let start = Instant::now();
        let mut merge = UniverseSourceMerge::new(SACN_SOURCE_TIMEOUT);
        merge.accept(1, 'A', 100, &universe_with(1, 200), start);

        let within = start + Duration::from_millis(2400);
        assert_eq!(
            merge.accept(1, 'B', 50, &universe_with(1, 10), within)[0],
            200
        );

        let after = start + Duration::from_millis(2600);
        assert_eq!(
            merge.accept(1, 'B', 50, &universe_with(1, 10), after)[0],
            10
        );
    }

    /// Senders tied at the top priority merge HTP per channel and lower senders are ignored.
    #[test]
    fn tied_senders_merge_highest_value_per_channel() {
        let start = Instant::now();
        let mut first = universe_with(1, 100);
        first[1] = 5;
        let mut second = universe_with(1, 20);
        second[1] = 80;

        let mut merge = UniverseSourceMerge::new(ARTNET_SOURCE_TIMEOUT);
        merge.accept(1, 'A', 100, &first, start);
        merge.accept(1, 'C', 10, &universe_with(3, 255), start);
        let merged = merge.accept(1, 'B', 100, &second, start);
        assert_eq!(&merged[..3], &[100, 80, 0]);
    }

    /// A terminated sender leaves at once and the remaining sender defines the universe.
    #[test]
    fn removed_sender_hands_over_immediately() {
        let start = Instant::now();
        let mut merge = UniverseSourceMerge::new(SACN_SOURCE_TIMEOUT);
        merge.accept(1, 'A', 100, &universe_with(1, 200), start);
        merge.accept(1, 'B', 50, &universe_with(1, 10), start);

        let merged = merge.remove_source(1, 'A', start).expect("B is still live");
        assert_eq!(merged[0], 10);
        assert_eq!(merge.remove_source(1, 'B', start), None);
    }

    /// Terminating a sender that is not live on the universe changes nothing.
    #[test]
    fn removing_unknown_sender_reports_no_change() {
        let start = Instant::now();
        let mut merge = UniverseSourceMerge::new(SACN_SOURCE_TIMEOUT);
        merge.accept(1, 'A', 100, &universe_with(1, 200), start);

        assert_eq!(merge.remove_source(1, 'Z', start), None);
        assert_eq!(merge.remove_source(2, 'A', start), None);
        assert_eq!(
            merge.accept(1, 'B', 50, &universe_with(1, 10), start)[0],
            200
        );
    }

    /// Senders are tracked per universe, so one universe's sender never affects another.
    #[test]
    fn universes_arbitrate_independently() {
        let start = Instant::now();
        let mut merge = UniverseSourceMerge::new(SACN_SOURCE_TIMEOUT);
        merge.accept(1, 'A', 100, &universe_with(1, 200), start);
        assert_eq!(
            merge.accept(2, 'B', 50, &universe_with(1, 10), start)[0],
            10
        );
    }
}
