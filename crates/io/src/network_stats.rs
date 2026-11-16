// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Network output send failures, kept for the operator until the output recovers.

use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

#[cfg(feature = "plugin")]
pub(crate) mod feed;

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

/// Recent send failures of the network outputs, one per physical output.
#[cfg_attr(feature = "ecs", derive(bevy_ecs::prelude::Resource))]
#[derive(Default, Debug, Clone)]
pub struct NetworkStats {
    /// Recent network output send failures.
    recent_send_failures: Vec<NetworkOutputSendFailure>,
}

impl NetworkStats {
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
