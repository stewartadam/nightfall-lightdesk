// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Automatic failover between a primary and its backup.
//!
//! Every host reports its role on a public status route: whether it follows a primary, its
//! takeover epoch, and the CID it transmits sACN under. A backup polls its primary's status as a
//! heartbeat and takes over on its own once the primary stops answering, unless the primary's
//! sACN still arrives. Each takeover raises the epoch past both hosts' last one, so when the old
//! primary comes back and finds its backup answering as a primary with a newer epoch, it rejoins
//! as that host's backup instead of transmitting over it.

use std::{
    net::IpAddr,
    sync::{
        Mutex,
        atomic::{AtomicU16, AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::preferences;

/// Public route every host answers with its [`HostStatus`].
pub const HOST_STATUS_PATH: &str = "/api/public/backup/status";

/// Request header in which a backup names the port its own server listens on, so its primary
/// can tell clients and its own recovery where the backup is.
pub const BACKUP_PORT_HEADER: &str = "x-nightfall-backup-port";

/// Time between heartbeats a backup sends its primary.
pub(crate) const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(500);

/// Longest a heartbeat or a check of the backup waits for an answer.
pub(crate) const STATUS_TIMEOUT: Duration = Duration::from_secs(1);

/// Time without an answer from the primary after which a backup takes over on its own.
pub(crate) const FAILOVER_TIMEOUT: Duration = Duration::from_secs(3);

/// Time between a primary's checks of whether its backup took over.
pub(crate) const PEER_CHECK_INTERVAL: Duration = Duration::from_secs(2);

/// A host's role as other hosts see it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    /// Whether the host follows a primary as its backup.
    pub following: bool,
    /// The host's takeover epoch, which every takeover raises.
    pub epoch: u64,
    /// CID the host transmits sACN under, if it transmits sACN.
    pub sacn_cid: Option<[u8; 16]>,
}

/// This host's status, as the world last published it.
static HOST_STATUS: Mutex<HostStatus> = Mutex::new(HostStatus {
    following: false,
    epoch: 0,
    sacn_cid: None,
});

/// `host:port` of the backup that last followed this host, if any.
static BACKUP_PEER: Mutex<Option<String>> = Mutex::new(None);

/// Port this host's server listens on, or 0 when unknown.
static OWN_PORT: AtomicU16 = AtomicU16::new(0);

/// Unix time in milliseconds of this process's last automatic takeover, or 0 for none, kept
/// outside the world so a show load right after the takeover still reports it.
static TOOK_OVER_AUTOMATICALLY_AT_MS: AtomicU64 = AtomicU64::new(0);

/// Records when this host took over on its own, or clears it with `None`.
pub(crate) fn set_took_over_automatically_at(at_ms: Option<u64>) {
    TOOK_OVER_AUTOMATICALLY_AT_MS.store(at_ms.unwrap_or(0), Ordering::Relaxed);
}

/// Returns when this host last took over on its own in this process.
pub(crate) fn took_over_automatically_at() -> Option<u64> {
    Some(TOOK_OVER_AUTOMATICALLY_AT_MS.load(Ordering::Relaxed)).filter(|at| *at != 0)
}

/// Replaces the status this host reports to other hosts.
pub(crate) fn publish_host_status(status: HostStatus) {
    *HOST_STATUS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = status;
}

/// Returns the status this host reports to other hosts.
pub fn host_status() -> HostStatus {
    HOST_STATUS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// Records the port this host's server listens on.
pub(crate) fn set_own_port(port: u16) {
    OWN_PORT.store(port, Ordering::Relaxed);
}

/// Returns the port this host's server listens on, if known.
pub(crate) fn own_port() -> Option<u16> {
    Some(OWN_PORT.load(Ordering::Relaxed)).filter(|port| *port != 0)
}

/// Returns `host:port` of the backup that last followed this host.
pub(crate) fn backup_peer() -> Option<String> {
    BACKUP_PEER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// Replaces the remembered backup without storing it, as when a world restores the stored one.
pub(crate) fn set_backup_peer(peer: Option<String>) {
    *BACKUP_PEER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = peer;
}

/// Remembers the backup that just asked this host for a checkpoint, storing it when it changed so
/// a restarted host still knows where its backup is.
///
/// Only requests the primary already accepted should reach this, since the remembered backup is
/// trusted to take this host's place.
pub fn note_backup_peer(ip: IpAddr, headers: &reqwest::header::HeaderMap) {
    let Some(port) = headers
        .get(BACKUP_PORT_HEADER)
        .and_then(|value| value.to_str().ok()?.parse::<u16>().ok())
    else {
        return;
    };
    let address = peer_address(ip, port);
    {
        let mut peer = BACKUP_PEER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if peer.as_deref() == Some(address.as_str()) {
            return;
        }
        *peer = Some(address.clone());
    }
    tracing::info!(%address, "A backup is following this host");
    let (_, error) = preferences::update(preferences::preferences_path().as_deref(), |stored| {
        stored.backup_peer = Some(address);
    });
    if let Some(error) = error {
        tracing::warn!(%error, "Could not save this host's backup");
    }
}

/// Formats `ip` and `port` as an address the link accepts, bracketing IPv6.
fn peer_address(ip: IpAddr, port: u16) -> String {
    match ip.to_canonical() {
        IpAddr::V4(ip) => format!("{ip}:{port}"),
        IpAddr::V6(ip) => format!("[{ip}]:{port}"),
    }
}

/// Returns the epoch a host takes when it takes over: one past both its own and the newest it
/// heard from its primary, so the other host can tell which takeover is newer.
pub(crate) fn takeover_epoch(own: u64, primary: Option<u64>) -> u64 {
    own.max(primary.unwrap_or(0)).saturating_add(1)
}

/// Returns whether a host running as a primary should become the backup of `peer`, the host
/// that last followed it: only when the peer took over since, which shows as the peer running as
/// a primary with a newer epoch.
pub(crate) fn should_rejoin(own_epoch: u64, peer: &HostStatus) -> bool {
    !peer.following && peer.epoch > own_epoch
}

/// Returns whether a backup should take over after its primary has not answered for
/// `silent_for`, given whether the primary's sACN still arrived within the timeout.
pub(crate) fn should_take_over(silent_for: Duration, primary_sacn_heard: bool) -> bool {
    silent_for >= FAILOVER_TIMEOUT && !primary_sacn_heard
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::*;

    /// A takeover's epoch is newer than both the host's own and its primary's.
    #[test]
    fn takeover_epoch_passes_both_hosts() {
        assert_eq!(takeover_epoch(0, None), 1);
        assert_eq!(takeover_epoch(2, Some(5)), 6);
        assert_eq!(takeover_epoch(7, Some(5)), 8);
    }

    /// A primary rejoins only a peer that runs as a primary with a newer epoch.
    #[test]
    fn rejoins_only_a_newer_primary() {
        let peer = |following, epoch| HostStatus {
            following,
            epoch,
            sacn_cid: None,
        };
        assert!(should_rejoin(1, &peer(false, 2)));
        assert!(!should_rejoin(2, &peer(false, 2)));
        assert!(!should_rejoin(3, &peer(false, 2)));
        assert!(!should_rejoin(1, &peer(true, 2)));
    }

    /// A backup takes over only after the timeout, and never while the primary's sACN arrives.
    #[test]
    fn takes_over_only_after_silence() {
        assert!(!should_take_over(Duration::from_secs(1), false));
        assert!(should_take_over(FAILOVER_TIMEOUT, false));
        assert!(!should_take_over(FAILOVER_TIMEOUT * 2, true));
    }

    /// Peer addresses read back as `host:port`, with IPv6 bracketed and mapped IPv4 unwrapped.
    #[test]
    fn formats_peer_addresses() {
        assert_eq!(
            peer_address(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 7)), 3030),
            "192.0.2.7:3030"
        );
        assert_eq!(
            peer_address(
                IpAddr::V6(Ipv4Addr::new(192, 0, 2, 7).to_ipv6_mapped()),
                3030
            ),
            "192.0.2.7:3030"
        );
        assert_eq!(
            peer_address(IpAddr::V6(Ipv6Addr::LOCALHOST), 3030),
            "[::1]:3030"
        );
    }
}
