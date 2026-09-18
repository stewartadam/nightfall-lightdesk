// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Network output timing statistics for instrumentation

use std::net::Ipv4Addr;
use std::time::Duration;

use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};

const MAX_RECENT_SEND_FAILURES: usize = 32;

/// Recent network output send failure surfaced to the operator UI.
#[typeshare::typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkOutputSendFailure {
    /// Protocol that attempted the send.
    pub protocol: String,
    /// Output universe that failed.
    pub universe: u16,
    /// Unicast destination IP when available.
    pub destination_ip: Option<Ipv4Addr>,
    /// Stable error category.
    pub error_kind: String,
    /// OS or transport error message.
    pub message: String,
    /// Number of consecutive frames that hit this failure.
    pub count: u32,
}

/// Tracks timing statistics for network output operations
#[derive(Resource, Default, Debug, Clone)]
pub struct NetworkStats {
    /// Time spent sending Art-Net universes in the last frame
    artnet_send_time: Option<Duration>,
    /// Number of Art-Net universes sent in the last frame
    artnet_universe_count: u32,
    /// Time spent sending sACN universes in the last frame
    sacn_send_time: Option<Duration>,
    /// Number of sACN universes sent in the last frame
    sacn_universe_count: u32,
    /// Recent network output send failures.
    recent_send_failures: Vec<NetworkOutputSendFailure>,
}

impl NetworkStats {
    /// Records Art-Net send timing for the current frame
    pub fn set_artnet_timing(&mut self, duration: Duration, universe_count: u32) {
        self.artnet_send_time = Some(duration);
        self.artnet_universe_count = universe_count;
    }

    /// Records sACN send timing for the current frame
    pub fn set_sacn_timing(&mut self, duration: Duration, universe_count: u32) {
        self.sacn_send_time = Some(duration);
        self.sacn_universe_count = universe_count;
    }

    /// Records one network output send failure for operator diagnostics.
    pub fn record_send_failure(
        &mut self,
        protocol: &'static str,
        universe: u16,
        destination_ip: Option<Ipv4Addr>,
        error_kind: &'static str,
        message: impl Into<String>,
    ) {
        let message = message.into();
        if let Some(existing) = self.recent_send_failures.iter_mut().find(|failure| {
            failure.protocol == protocol
                && failure.universe == universe
                && failure.destination_ip == destination_ip
        }) {
            if existing.error_kind == error_kind && existing.message == message {
                existing.count = existing.count.saturating_add(1);
                return;
            }
        }

        self.recent_send_failures.retain(|failure| {
            failure.protocol != protocol
                || failure.universe != universe
                || failure.destination_ip != destination_ip
        });

        if self.recent_send_failures.len() >= MAX_RECENT_SEND_FAILURES {
            self.recent_send_failures.remove(0);
        }

        tracing::warn!(
            protocol,
            universe,
            destination_ip = ?destination_ip,
            error_kind,
            message = %message,
            "Network output send failure"
        );

        self.recent_send_failures.push(NetworkOutputSendFailure {
            protocol: protocol.to_string(),
            universe,
            destination_ip,
            error_kind: error_kind.to_string(),
            message,
            count: 1,
        });
    }

    /// Clears send failures for one physical output after a successful send.
    pub fn clear_send_failure(
        &mut self,
        protocol: &'static str,
        universe: u16,
        destination_ip: Option<Ipv4Addr>,
    ) {
        self.recent_send_failures.retain(|failure| {
            failure.protocol != protocol
                || failure.universe != universe
                || failure.destination_ip != destination_ip
        });
    }

    /// Returns Art-Net send time in milliseconds
    pub fn artnet_send_time_ms(&self) -> Option<f64> {
        self.artnet_send_time.map(|d| d.as_secs_f64() * 1000.0)
    }

    /// Returns the number of Art-Net universes sent
    pub fn artnet_universe_count(&self) -> u32 {
        self.artnet_universe_count
    }

    /// Returns sACN send time in milliseconds
    pub fn sacn_send_time_ms(&self) -> Option<f64> {
        self.sacn_send_time.map(|d| d.as_secs_f64() * 1000.0)
    }

    /// Returns the number of sACN universes sent
    pub fn sacn_universe_count(&self) -> u32 {
        self.sacn_universe_count
    }

    /// Returns recent network output send failures.
    pub fn recent_send_failures(&self) -> &[NetworkOutputSendFailure] {
        &self.recent_send_failures
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies repeated send failures are coalesced into an incrementing counter.
    #[test]
    fn record_send_failure_coalesces_matching_failures() {
        let mut stats = NetworkStats::default();
        let destination = Some(Ipv4Addr::new(2, 0, 0, 50));

        stats.record_send_failure(
            "ArtNet",
            0,
            destination,
            "HostUnreachable",
            "No route to host",
        );
        stats.record_send_failure(
            "ArtNet",
            0,
            destination,
            "HostUnreachable",
            "No route to host",
        );

        assert_eq!(stats.recent_send_failures().len(), 1);
        assert_eq!(stats.recent_send_failures()[0].count, 2);
    }

    /// Verifies changed send failure status replaces the current physical output status.
    #[test]
    fn record_send_failure_replaces_changed_status_for_same_output() {
        let mut stats = NetworkStats::default();
        let destination = Some(Ipv4Addr::new(2, 0, 0, 50));

        stats.record_send_failure(
            "ArtNet",
            0,
            destination,
            "HostUnreachable",
            "No route to host",
        );
        stats.record_send_failure(
            "ArtNet",
            0,
            destination,
            "NetworkUnreachable",
            "Network is unreachable",
        );

        assert_eq!(stats.recent_send_failures().len(), 1);
        assert_eq!(
            stats.recent_send_failures()[0].error_kind,
            "NetworkUnreachable"
        );
        assert_eq!(
            stats.recent_send_failures()[0].message,
            "Network is unreachable"
        );
        assert_eq!(stats.recent_send_failures()[0].count, 1);
    }

    /// Verifies a cleared physical output can record the same failure as a new status.
    #[test]
    fn record_send_failure_after_clear_starts_new_status() {
        let mut stats = NetworkStats::default();
        let destination = Some(Ipv4Addr::new(2, 0, 0, 50));

        stats.record_send_failure(
            "ArtNet",
            0,
            destination,
            "HostUnreachable",
            "No route to host",
        );
        stats.record_send_failure(
            "ArtNet",
            0,
            destination,
            "HostUnreachable",
            "No route to host",
        );
        stats.clear_send_failure("ArtNet", 0, destination);
        stats.record_send_failure(
            "ArtNet",
            0,
            destination,
            "HostUnreachable",
            "No route to host",
        );

        assert_eq!(stats.recent_send_failures().len(), 1);
        assert_eq!(stats.recent_send_failures()[0].count, 1);
    }

    /// Verifies successful output clears only the matching target failure.
    #[test]
    fn clear_send_failure_removes_only_matching_physical_output() {
        let mut stats = NetworkStats::default();
        let failing_destination = Some(Ipv4Addr::new(2, 0, 0, 50));
        let healthy_destination = Some(Ipv4Addr::new(2, 0, 0, 51));

        stats.record_send_failure(
            "ArtNet",
            0,
            failing_destination,
            "HostUnreachable",
            "No route to host",
        );
        stats.record_send_failure(
            "ArtNet",
            0,
            healthy_destination,
            "HostUnreachable",
            "No route to host",
        );

        stats.clear_send_failure("ArtNet", 0, healthy_destination);

        assert_eq!(stats.recent_send_failures().len(), 1);
        assert_eq!(
            stats.recent_send_failures()[0].destination_ip,
            failing_destination
        );
    }
}
