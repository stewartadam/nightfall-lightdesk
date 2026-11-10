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
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::{BackupPeer, BackupPeerState, preferences};

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
    /// Whether the host has a show open, rather than waiting at startup for one to be picked.
    pub show_open: bool,
}

/// This host's status, as the world last published it.
static HOST_STATUS: Mutex<HostStatus> = Mutex::new(HostStatus {
    following: false,
    epoch: 0,
    sacn_cid: None,
    show_open: false,
});

/// `host:port` of the backup that last followed this host, if any.
static BACKUP_PEER: Mutex<Option<String>> = Mutex::new(None);

/// Route on which a host that took over asks the primary it replaced to step down.
///
/// It skips pairing, since a primary forgets its paired devices when it restarts, which is
/// exactly when it needs to hear this. Only the remembered backup peer is listened to.
pub const STEP_DOWN_PATH: &str = "/api/public/backup/step-down";

/// Asks a primary to step down because the host sending it took over with a newer epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepDownRequest {
    /// Epoch of the takeover.
    pub epoch: u64,
    /// Port the sender's server listens on, so the receiver can follow it.
    pub port: u16,
    /// The key the two hosts share, which proves the sender is this host's backup.
    pub key: String,
}

/// The backup that last received a checkpoint from this host, when, and the same time as Unix
/// milliseconds.
static LAST_PEER_REQUEST: Mutex<Option<(String, Instant, u64)>> = Mutex::new(None);

/// Time since its last checkpoint after which a backup no longer counts as in step.
pub(crate) const PEER_IN_STEP_WINDOW: Duration = Duration::from_secs(5);

/// What the last check of this host's backup found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PeerCheck {
    /// The backup answered and follows a primary.
    Following,
    /// The backup answered as a primary itself, without a newer epoch than this host's.
    Primary,
    /// The backup did not answer.
    Unreachable,
}

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

/// Route on which a backup asks its primary for the key the two will share.
pub const PAIR_KEY_PATH: &str = "/api/backup/pair-key";

/// Makes `key` the one this host shares with its primary or backup, or forgets it with `None`.
/// The server accepts it like a pairing token, so the other host stays paired after a restart.
pub(crate) fn share_pair_key(key: Option<String>) {
    nightfall_websocket::set_backup_pair_key(key);
}

/// Forgets the stored pair key after a new PIN signed every device out, including the other
/// host of the pair, which then needs the PIN again.
pub(crate) fn forget_stored_pair_key() {
    tracing::info!("A new PIN signed out the backup pair");
    let (_, error) = preferences::update(preferences::preferences_path().as_deref(), |stored| {
        stored.pair_key = None;
    });
    if let Some(error) = error {
        tracing::warn!(%error, "Could not forget the backup pair key");
    }
}

/// Returns the key this host shares with its primary or backup, if any.
pub(crate) fn pair_key() -> Option<String> {
    nightfall_websocket::backup_pair_key()
}

/// Returns whether `key` is the key this host shares with its primary or backup.
fn is_pair_key(key: &str) -> bool {
    pair_key().as_deref() == Some(key)
}

/// Issues a new key for the backup that just paired with this host, stores it, and returns it.
/// It replaces any earlier key, so a backup that followed this host before loses its access.
///
/// A host that follows a primary itself refuses, since a backup cannot have a backup.
pub fn issue_pair_key() -> Result<String, String> {
    if host_status().following {
        return Err("This computer is a backup itself.".to_string());
    }
    let key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let (_, error) = preferences::update(preferences::preferences_path().as_deref(), |stored| {
        stored.pair_key = Some(key.clone());
    });
    if let Some(error) = error {
        tracing::warn!(%error, "Could not save the backup pair key");
    }
    share_pair_key(Some(key.clone()));
    tracing::info!("Issued a pair key to a new backup");
    Ok(key)
}

/// Answers a step-down request from the host at `ip`: when it comes from this host's remembered
/// backup with the key the two share, took over with a newer epoch than this host's, and this
/// host runs as a primary, this host rejoins as the backup of that host. Returns whether this
/// host steps down.
///
/// The route skips pairing, since it must work whatever the pairing state; the address and the
/// key together prove the sender is the backup this host trusts to take its place.
pub fn request_step_down(ip: IpAddr, request: &StepDownRequest) -> bool {
    let address = peer_address(ip, request.port);
    if backup_peer().as_deref() != Some(address.as_str()) || !is_pair_key(&request.key) {
        tracing::warn!(%address, "Ignored a step-down request that is not from this host's backup");
        return false;
    }
    if !should_step_down(&host_status(), request.epoch) {
        return false;
    }
    tracing::warn!(%address, epoch = request.epoch, "A newer primary asked this host to step down");
    crate::link::process_backup_link().request_rejoin(address, request.epoch);
    true
}

/// Returns whether a host with status `own` steps down for a takeover with `epoch`.
pub(crate) fn should_step_down(own: &HostStatus, epoch: u64) -> bool {
    !own.following && epoch > own.epoch
}

/// Returns whether this host, a primary with `own_epoch`, should ask its backup peer to step
/// down: the peer runs as a primary too, from before this host's takeover.
pub(crate) fn should_ask_to_step_down(own_epoch: u64, peer: &HostStatus) -> bool {
    !peer.following && peer.epoch < own_epoch
}

/// Remembers the backup that just asked this host for a checkpoint, storing it when it changed so
/// a restarted host still knows where its backup is.
///
/// Only requests the primary already accepted should reach this, since the remembered backup is
/// trusted to take this host's place.
pub fn note_backup_peer(ip: IpAddr, headers: &reqwest::header::HeaderMap) {
    let Some(port) = backup_port(headers) else {
        return;
    };
    // A host that left its pair holds no key, and does not take a backup back that way.
    if pair_key().is_none() {
        return;
    }
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

/// Records that this host just sent a checkpoint to the backup that asked for it, which keeps
/// that backup in step.
pub fn note_checkpoint_served(ip: IpAddr, headers: &reqwest::header::HeaderMap) {
    let Some(port) = backup_port(headers) else {
        return;
    };
    *LAST_PEER_REQUEST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((
        peer_address(ip, port),
        Instant::now(),
        crate::link::now_ms(),
    ));
}

/// Forgets when a backup last received a checkpoint, as when this host changes role, so an old
/// time is never shown for a later stint as primary.
pub(crate) fn forget_checkpoints_served() {
    *LAST_PEER_REQUEST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// Reads the port a backup sends with its checkpoint requests.
fn backup_port(headers: &reqwest::header::HeaderMap) -> Option<u16> {
    headers
        .get(BACKUP_PORT_HEADER)
        .and_then(|value| value.to_str().ok()?.parse::<u16>().ok())
}

/// Returns how this host's backup at `address` is doing, from the last check of it and the last
/// checkpoint this host sent it.
pub(crate) fn peer_health(address: String, check: Option<PeerCheck>) -> BackupPeer {
    let last_request = LAST_PEER_REQUEST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(requester, _, _)| *requester == address)
        .map(|(_, at, at_ms)| (at.elapsed(), *at_ms));
    let state = peer_state(check, last_request.map(|(since, _)| since));
    BackupPeer {
        address,
        state,
        last_seen_ms: (state != BackupPeerState::InStep)
            .then_some(last_request.map(|(_, at_ms)| at_ms))
            .flatten(),
    }
}

/// Classifies a backup from the last check of it and the time since its last checkpoint.
fn peer_state(check: Option<PeerCheck>, since_request: Option<Duration>) -> BackupPeerState {
    match check {
        None => BackupPeerState::Checking,
        Some(PeerCheck::Unreachable) => BackupPeerState::Unreachable,
        Some(PeerCheck::Primary) => BackupPeerState::AlsoPrimary,
        Some(PeerCheck::Following)
            if since_request.is_some_and(|since| since <= PEER_IN_STEP_WINDOW) =>
        {
            BackupPeerState::InStep
        }
        Some(PeerCheck::Following) => BackupPeerState::NotInStep,
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
            show_open: true,
        };
        assert!(should_rejoin(1, &peer(false, 2)));
        assert!(!should_rejoin(2, &peer(false, 2)));
        assert!(!should_rejoin(3, &peer(false, 2)));
        assert!(!should_rejoin(1, &peer(true, 2)));
    }

    /// A host that took over asks only a peer still running as a primary from before its
    /// takeover to step down, and a primary steps down only for a newer takeover, sent by the
    /// backup it remembers with the key the two share.
    #[test]
    fn steps_down_only_for_a_newer_takeover() {
        let host = |following, epoch| HostStatus {
            following,
            epoch,
            sacn_cid: None,
            show_open: true,
        };
        assert!(should_ask_to_step_down(2, &host(false, 1)));
        assert!(!should_ask_to_step_down(2, &host(false, 2)));
        assert!(!should_ask_to_step_down(2, &host(true, 1)));
        assert!(should_step_down(&host(false, 1), 2));
        assert!(!should_step_down(&host(false, 2), 2));
        assert!(!should_step_down(&host(true, 1), 2));

        // Neither a stranger with the key nor the remembered backup without it is listened to.
        set_backup_peer(Some("192.0.2.11:3000".into()));
        share_pair_key(Some("pair-key".into()));
        let with_key = StepDownRequest {
            epoch: u64::MAX,
            port: 3000,
            key: "pair-key".into(),
        };
        assert!(!request_step_down("192.0.2.12".parse().unwrap(), &with_key));
        let without_key = StepDownRequest {
            key: "not-the-pair-key".into(),
            ..with_key.clone()
        };
        assert!(!request_step_down(
            "192.0.2.11".parse().unwrap(),
            &without_key
        ));
        share_pair_key(None);
        set_backup_peer(None);
    }

    /// A backup takes over only after the timeout, and never while the primary's sACN arrives.
    #[test]
    fn takes_over_only_after_silence() {
        assert!(!should_take_over(Duration::from_secs(1), false));
        assert!(should_take_over(FAILOVER_TIMEOUT, false));
        assert!(!should_take_over(FAILOVER_TIMEOUT * 2, true));
    }

    /// A backup is in step only while it follows and asked for a checkpoint recently; otherwise
    /// the check's finding names the problem.
    #[test]
    fn classifies_the_backup() {
        let recent = Some(Duration::from_secs(1));
        let stale = Some(PEER_IN_STEP_WINDOW * 2);
        assert_eq!(peer_state(None, recent), BackupPeerState::Checking);
        assert_eq!(
            peer_state(Some(PeerCheck::Following), recent),
            BackupPeerState::InStep
        );
        assert_eq!(
            peer_state(Some(PeerCheck::Following), stale),
            BackupPeerState::NotInStep
        );
        assert_eq!(
            peer_state(Some(PeerCheck::Following), None),
            BackupPeerState::NotInStep
        );
        assert_eq!(
            peer_state(Some(PeerCheck::Unreachable), recent),
            BackupPeerState::Unreachable
        );
        assert_eq!(
            peer_state(Some(PeerCheck::Primary), recent),
            BackupPeerState::AlsoPrimary
        );
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
