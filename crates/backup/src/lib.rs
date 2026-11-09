// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Backup servers: a second Nightfall that follows a primary and can take over its output.
//!
//! A host becomes a backup by following a primary's address. From then on it keeps a copy of
//! the primary's live show, transmits sACN one priority step below the show's so receivers keep
//! following the primary, mutes Art-Net and USB DMX, and refuses changes from its own clients.
//! Taking over ends the role: the host keeps the copied show and outputs it as a normal desk.
//! A backup also takes over on its own when its primary stops answering, and a primary that
//! finds its backup took over rejoins as that host's backup; see [`failover`].
//!
//! The role is a host preference rather than show data, because the show itself is copied from
//! the primary.

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::{DmxOutputStandby, SacnOutputIdentity, sacn_source_heard_within};
use serde::{Deserialize, Serialize};

pub mod failover;
pub mod forwarding;
mod link;
mod preferences;

use forwarding::CommandsThrough;

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use crate::{
        BackupCommand, BackupLinkStatus, BackupPlugin, BackupState, MirroredShowfileReady,
        ShowfileRevision,
    };
}

/// Primary route that pairs a device with its PIN.
pub const PAIRING_PATH: &str = "/api/pairing";

/// Primary route that reports the revision of its live show.
pub const SHOWFILE_REVISION_PATH: &str = "/api/showfiles/current/revision";

/// Primary route that answers with a checkpoint of its live state: what is playing, at which
/// level and position, the tempo and the programmer.
pub const LIVE_STATE_PATH: &str = "/api/backup/live-state";

/// Response header on a live state checkpoint carrying how many milliseconds the primary waited
/// for its engine before capturing it, so the backup leaves that wait out of the checkpoint's age.
pub const LIVE_STATE_WAIT_HEADER: &str = "x-nightfall-capture-wait-ms";

/// Primary route that exports its live show as an archive.
pub const SHOWFILE_EXPORT_PATH: &str = "/api/showfiles/current/export";

/// Primary route a backup long-polls for the commands the primary forwards as they happen.
pub const FORWARDED_COMMANDS_PATH: &str = "/api/backup/commands";

/// Longest the primary holds a forwarded commands request open while nothing happens.
pub const FORWARDED_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// How often a primary reads how its backup is doing for clients.
const PEER_HEALTH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Export response header naming where the exported show came from.
pub const EXPORT_SOURCE_HEADER: &str = "x-showfile-export-source";

/// [`EXPORT_SOURCE_HEADER`] value of an export captured from the running engine; any other value
/// means the primary fell back to its stored show.
pub const EXPORT_SOURCE_LIVE: &str = "live";

/// [`EXPORT_SOURCE_HEADER`] value of an export read from the stored show.
pub const EXPORT_SOURCE_STORED: &str = "stored";

/// The live show a primary has open, identified by a hash of its contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowfileRevision {
    /// Name of the open showfile, or `None` for the default showfile.
    pub showfile_name: Option<String>,
    /// Opaque content hash that changes whenever the show does.
    pub revision: String,
}

/// Where a backup's connection to its primary stands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum BackupLinkStatus {
    /// The host follows no primary.
    #[default]
    Off,
    /// The host is reaching the primary for the first time.
    Connecting,
    /// The host copied the primary's current show and is loading it.
    Loading,
    /// The host holds the primary's current show.
    Synced,
    /// The primary refused this host and needs its pairing PIN again.
    PairingRequired,
    /// The primary could not be reached; the host keeps the last show it copied.
    Unreachable,
}

/// How the backup of a host running as a primary is doing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum BackupPeerState {
    /// Not checked yet.
    #[default]
    Checking,
    /// Follows a primary and copied this host's live state within the last few seconds.
    InStep,
    /// Answers, but has not copied this host's live state recently, as while it waits for a
    /// pairing PIN or follows another primary.
    NotInStep,
    /// Does not answer.
    Unreachable,
    /// Runs as a primary too, so both computers send output.
    AlsoPrimary,
}

/// The backup of a host running as a primary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BackupPeer {
    /// `host:port` of the backup.
    pub address: String,
    /// How the backup is doing.
    pub state: BackupPeerState,
    /// Unix time in milliseconds of the backup's last copy of this host's live state, while it is
    /// not in step.
    #[typeshare(serialized_as = "Option<number>")]
    pub last_seen_ms: Option<u64>,
}

/// The host's backup role and the state of its link, as clients see it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Resource)]
#[typeshare::typeshare]
pub struct BackupState {
    /// Whether this host can act as a backup at all.
    pub available: bool,
    /// `host:port` of the primary this host follows, or `None` when it runs on its own.
    pub primary_address: Option<String>,
    /// Where the connection to the primary stands.
    pub link: BackupLinkStatus,
    /// Why the link is not synced, or why the role could not be stored.
    pub error: Option<String>,
    /// Showfile the primary had open at the last sync.
    pub showfile_name: Option<String>,
    /// Unix time in milliseconds of the last show copied from the primary.
    #[typeshare(serialized_as = "Option<number>")]
    pub synced_at_ms: Option<u64>,
    /// Takeover epoch, raised by every takeover so the host that took over last can be told
    /// apart from the one it replaced.
    #[typeshare(serialized_as = "number")]
    pub epoch: u64,
    /// Whether this host takes over on its own when its primary stops answering.
    pub auto_take_over: bool,
    /// The host that backs this one up and how it is doing, while this host runs as a primary.
    /// Clients also switch to it when this host goes away.
    pub backup: Option<BackupPeer>,
    /// Unix time in milliseconds when this host last took over on its own because its primary
    /// stopped answering.
    #[typeshare(serialized_as = "Option<number>")]
    pub took_over_automatically_at_ms: Option<u64>,
    /// `host:port` of a primary this host is checking before it follows it, as while pairing.
    pub checking_address: Option<String>,
}

impl BackupState {
    /// Returns whether this host currently backs up a primary.
    pub fn is_backup(&self) -> bool {
        self.primary_address.is_some()
    }

    /// Takes the stored role, epoch and automatic takeover setting.
    fn apply_preferences(&mut self, stored: &preferences::BackupPreferences) {
        self.primary_address = stored.primary_address.clone();
        self.epoch = stored.epoch;
        self.auto_take_over = stored.auto_take_over;
    }

    /// Returns the reason shown to clients whose changes a backup refuses.
    fn read_only_reason(&self) -> Option<String> {
        self.primary_address.as_ref().map(|address| {
            format!(
                "This Nightfall is a backup following {address}. Take over or stop following to \
                 make changes here."
            )
        })
    }
}

/// Commands that change the host's backup role.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum BackupCommand {
    /// Follows the primary at `address` (`host:port`), pairing with `pin` when it gives one.
    FollowPrimary {
        /// `host:port` of the primary, with or without an `http://` prefix.
        address: String,
        /// The primary's pairing PIN, needed unless the primary runs on this computer.
        pin: Option<String>,
    },
    /// Stops following and outputs the copied show as a normal desk.
    TakeOver,
    /// Stops following without taking over: this host runs on its own again, remembers no
    /// primary, and keeps its epoch. Opening a show does the same.
    StopFollowing,
    /// Turns automatic takeover on or off for when this host follows a primary.
    SetAutoTakeOver {
        /// Whether to take over on its own once the primary stops answering.
        enabled: bool,
    },
}

impl IngressCommand for BackupCommand {}

/// A show copied from the primary, ready to replace the backup's world.
#[derive(Debug, Clone, PartialEq, Eq, Message)]
pub struct MirroredShowfileReady {
    /// Name to load the show under, or `None` for the default showfile.
    pub showfile_name: Option<String>,
    /// Loadable show directory, kept until the next copy replaces it.
    pub directory: std::path::PathBuf,
}

/// Messages the backup sends to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum BackupWsMessage<'a> {
    /// The host's backup role and link state.
    BackupState(&'a BackupState),
}

impl ResourceFeed for BackupState {
    /// Publishes the backup role and link state.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &BackupWsMessage::BackupState(self),
        );
    }
}

/// Normalizes an operator-typed primary address to `host:port`.
fn normalize_address(address: &str) -> Result<String, String> {
    let compact: String = address.chars().filter(|c| !c.is_whitespace()).collect();
    let trimmed = compact.as_str();
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("ws://"))
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    let Some((host, port)) = without_scheme.rsplit_once(':') else {
        return Err(
            "Enter the primary's address as host:port, for example 192.168.1.20:3000.".into(),
        );
    };
    if host.is_empty() || host.contains('/') || port.parse::<u16>().is_err() {
        return Err(
            "Enter the primary's address as host:port, for example 192.168.1.20:3000.".into(),
        );
    }
    Ok(format!("{host}:{port}"))
}

/// Why the role could not be read or stored, shown while the link has nothing to report.
#[derive(Debug, Default, Resource)]
struct RoleError(Option<String>);

/// A follow command waiting for the primary to be checked.
#[derive(Debug)]
struct PendingProbe {
    /// The follow command to complete.
    command_id: CommandId,
    /// `host:port` of the primary being checked.
    address: String,
    /// Number of the link's probe of that primary.
    probe: u64,
}

/// The follow command waiting for its primary to be checked, if any.
#[derive(Debug, Default, Resource)]
struct PendingFollow(Option<PendingProbe>);

/// Restores the stored role into a new world and points the link at the stored primary.
///
/// The output and ingress restrictions apply here too, before the world's first frame, so a
/// backup never transmits unprioritized output or accepts a change while a new world starts.
///
/// A host that remembers a backup also holds its output until it has checked whether that backup
/// took over while this host was away.
fn restore_backup_role(
    mut state: ResMut<BackupState>,
    mut role_error: ResMut<RoleError>,
    mut standby: ResMut<DmxOutputStandby>,
    mut gate: ResMut<ClientIngressGate>,
    port: Option<Res<nightfall_websocket::BackendPort>>,
) {
    let (stored, error) = preferences::current(preferences::preferences_path().as_deref());
    state.available = true;
    state.apply_preferences(&stored);
    state.took_over_automatically_at_ms = failover::took_over_automatically_at();
    role_error.0 = error;
    if let Some(port) = port {
        failover::set_own_port(port.0);
    }
    failover::set_backup_peer(stored.backup_peer.clone());
    // The link checks this host's backup against the stored epoch, so publish it before the
    // link starts rather than waiting for the first frame.
    failover::publish_host_status(failover::HostStatus {
        following: state.is_backup(),
        epoch: state.epoch,
        sacn_cid: None,
    });
    *standby = DmxOutputStandby(state.is_backup() || awaiting_peer_check());
    gate.set_read_only(state.read_only_reason());
    link::process_backup_link().finish_mirror_load();
    failover::share_pair_key(stored.pair_key.clone());
    link::process_backup_link().set_target(stored.primary_address.map(|address| {
        link::LinkTarget {
            address,
            token: stored.pair_key,
        }
    }));
}

/// Applies role changes, storing them so a restarted host keeps its role.
///
/// Following waits for the primary to be checked, and paired with when a PIN is given, so a
/// wrong address or PIN leaves the role as it was; [`finish_pending_follow`] completes it.
fn handle_backup_commands(
    mut commands: MessageReader<CommandEnvelope<BackupCommand>>,
    mut state: ResMut<BackupState>,
    mut role_error: ResMut<RoleError>,
    mut pending: ResMut<PendingFollow>,
    mut responder: CommandResponder,
) {
    for envelope in commands.read() {
        if let BackupCommand::FollowPrimary { address, pin } = &envelope.command {
            match normalize_address(address) {
                Ok(address) => {
                    if let Some(replaced) = pending.0.take() {
                        let _ = responder.fail(
                            replaced.command_id,
                            CommandError::new(
                                "backup.follow_replaced",
                                "Following another primary instead.",
                            ),
                        );
                    }
                    let pin: Option<String> = pin
                        .as_deref()
                        .map(|pin| pin.chars().filter(|c| !c.is_whitespace()).collect())
                        .filter(|pin: &String| !pin.is_empty());
                    role_error.0 = None;
                    state.checking_address = Some(address.clone());
                    let probe = link::process_backup_link().probe(address.clone(), pin);
                    pending.0 = Some(PendingProbe {
                        command_id: envelope.command_id,
                        address,
                        probe,
                    });
                }
                Err(message) => {
                    role_error.0 = Some(message.clone());
                    if let Err(error) = responder.fail(
                        envelope.command_id,
                        CommandError::new("backup.role_change_failed", message),
                    ) {
                        tracing::error!(command_id = %envelope.command_id, %error, "backup_command_completion_failed");
                    }
                }
            }
            continue;
        }
        let changes_role = !matches!(envelope.command, BackupCommand::SetAutoTakeOver { .. });
        let outcome: Result<RoleChange, String> = match &envelope.command {
            // Handled above, since it completes only once the primary was checked.
            BackupCommand::FollowPrimary { .. } => continue,
            BackupCommand::StopFollowing if state.is_backup() => Ok(stop_following()),
            // A host that follows no one, such as one that just took over, keeps its backup.
            BackupCommand::StopFollowing => Ok((
                preferences::current(preferences::preferences_path().as_deref()).0,
                None,
            )),
            BackupCommand::TakeOver if state.is_backup() => Ok(take_over()),
            // A host that follows no one has nothing to take over.
            BackupCommand::TakeOver => Ok((
                preferences::current(preferences::preferences_path().as_deref()).0,
                None,
            )),
            BackupCommand::SetAutoTakeOver { enabled } => {
                let enabled = *enabled;
                Ok(preferences::update(
                    preferences::preferences_path().as_deref(),
                    |stored| stored.auto_take_over = enabled,
                ))
            }
        };
        let result = match outcome {
            // The change applies even when it could not be stored, so a backup can always take
            // over; the operator learns it will not survive a restart.
            Ok((stored, save_error)) => {
                state.apply_preferences(&stored);
                if changes_role {
                    failover::set_took_over_automatically_at(None);
                    state.took_over_automatically_at_ms = None;
                }
                role_error.0 = save_error.clone();
                match save_error {
                    None => responder.succeed(envelope.command_id),
                    Some(message) => responder.fail(
                        envelope.command_id,
                        CommandError::new("backup.role_not_saved", message),
                    ),
                }
            }
            Err(message) => {
                role_error.0 = Some(message.clone());
                responder.fail(
                    envelope.command_id,
                    CommandError::new("backup.role_change_failed", message),
                )
            }
        };
        if let Err(error) = result {
            tracing::error!(command_id = %envelope.command_id, %error, "backup_command_completion_failed");
        }
    }
}

/// The role a change leaves this host with, and why it could not be stored, if it could not.
type RoleChange = (preferences::BackupPreferences, Option<String>);

/// Completes a follow command once the link has checked its primary: follows it with the
/// pairing token the check got, or fails the command and leaves the role as it was.
fn finish_pending_follow(
    mut pending: ResMut<PendingFollow>,
    mut state: ResMut<BackupState>,
    mut role_error: ResMut<RoleError>,
    mut responder: CommandResponder,
) {
    let Some(probe) = pending.0.as_ref() else {
        return;
    };
    let Some(result) = link::process_backup_link().take_probe(probe.probe) else {
        return;
    };
    let Some(PendingProbe {
        command_id,
        address,
        ..
    }) = pending.0.take()
    else {
        return;
    };
    state.checking_address = None;
    let completion = match result {
        Ok(token) => {
            let (stored, save_error) = follow_primary(address, token);
            state.apply_preferences(&stored);
            failover::set_took_over_automatically_at(None);
            state.took_over_automatically_at_ms = None;
            role_error.0 = save_error.clone();
            match save_error {
                None => responder.succeed(command_id),
                Some(message) => responder.fail(
                    command_id,
                    CommandError::new("backup.role_not_saved", message),
                ),
            }
        }
        Err(message) => {
            tracing::warn!(%address, %message, "Not following the primary");
            role_error.0 = Some(message.clone());
            responder.fail(
                command_id,
                CommandError::new("backup.primary_unavailable", message),
            )
        }
    };
    if let Err(error) = completion {
        tracing::error!(%command_id, %error, "backup_command_completion_failed");
    }
}

/// Stores `address` as this host's primary with the pair `key` it issued, if any, shares that key
/// so the primary can follow this host after a takeover, and starts following it, returning the
/// new role.
///
/// The primary becomes this host's only peer: a backup has no backup of its own to remember.
fn follow_primary(address: String, key: Option<String>) -> RoleChange {
    let (stored, save_error) =
        preferences::update(preferences::preferences_path().as_deref(), |stored| {
            stored.primary_address = Some(address.clone());
            stored.pair_key = key.clone();
            stored.backup_peer = None;
        });
    failover::set_backup_peer(None);
    failover::share_pair_key(stored.pair_key.clone());
    tracing::info!(%address, "Following a primary as its backup");
    link::process_backup_link().set_target(Some(link::LinkTarget {
        address,
        token: key,
    }));
    (stored, save_error)
}

/// Stops following without taking over and returns the new role: this host runs on its own,
/// remembers neither its primary nor a backup, and keeps its epoch.
fn stop_following() -> RoleChange {
    let (stored, save_error) =
        preferences::update(preferences::preferences_path().as_deref(), |stored| {
            stored.primary_address = None;
            stored.pair_key = None;
            stored.backup_peer = None;
        });
    failover::set_backup_peer(None);
    failover::share_pair_key(None);
    tracing::info!("Stopped following the primary");
    let link = link::process_backup_link();
    link.cancel_probe("Stopped following before the primary was checked.");
    link.set_target(None);
    link.mark_peer_checked();
    (stored, save_error)
}

/// Stops following when a client opens or creates a show, which replaces the copied show, and
/// returns why the change could not be stored, if it could not. Does nothing on a host that
/// follows no primary, apart from cancelling a follow still waiting for its primary to be checked.
pub fn leave_backup_role_for_show_load(state: &mut BackupState) -> Option<String> {
    if state.checking_address.is_some() {
        link::process_backup_link()
            .cancel_probe("A show was opened before the primary was checked.");
    }
    if !state.is_backup() {
        return None;
    }
    let (stored, save_error) = stop_following();
    state.apply_preferences(&stored);
    save_error
}

/// Stops following the primary and returns the new role.
///
/// The takeover raises the epoch past both hosts' last one and remembers the old primary as this
/// host's backup peer, so if the old primary is still running, or comes back, it sees this
/// takeover is newer and rejoins as this host's backup.
fn take_over() -> RoleChange {
    let link = link::process_backup_link();
    let primary_epoch = link.primary_epoch();
    let (stored, save_error) =
        preferences::update(preferences::preferences_path().as_deref(), |stored| {
            stored.epoch = failover::takeover_epoch(stored.epoch, primary_epoch);
            // The pair key stays, so the old primary can follow this host without its PIN.
            stored.backup_peer = stored.primary_address.take();
        });
    failover::set_backup_peer(stored.backup_peer.clone());
    failover::forget_checkpoints_served();
    tracing::info!(epoch = stored.epoch, "Backup took over output");
    link.cancel_probe("Took over before the primary was checked.");
    link.set_target(None);
    // The old primary is the host this one just replaced; checking it before outputting would
    // only delay the takeover.
    link.mark_peer_checked();
    (stored, save_error)
}

/// Becomes the backup of `address`, the host that last backed this one up and has since taken
/// over with `epoch`, and returns the new role.
///
/// It follows with the key the two share, so it needs no PIN, even after either restarted.
fn rejoin_as_backup(address: &str, epoch: u64) -> RoleChange {
    let (stored, save_error) =
        preferences::update(preferences::preferences_path().as_deref(), |stored| {
            stored.primary_address = Some(address.to_string());
            stored.backup_peer = None;
            stored.epoch = stored.epoch.max(epoch);
        });
    failover::set_backup_peer(None);
    failover::forget_checkpoints_served();
    let link = link::process_backup_link();
    link.cancel_probe("Started following a newer primary before this one was checked.");
    link.set_target(Some(link::LinkTarget {
        address: address.to_string(),
        token: stored.pair_key.clone(),
    }));
    (stored, save_error)
}

/// Returns whether this host remembers a backup it has not checked yet in this process, in which
/// case it holds its output: that backup may have taken over while this host was away.
fn awaiting_peer_check() -> bool {
    failover::backup_peer().is_some() && !link::process_backup_link().peer_checked()
}

/// Takes over on its own once the primary has not answered a heartbeat for
/// [`failover::FAILOVER_TIMEOUT`], when automatic takeover is on.
///
/// A primary whose sACN still arrives is alive even if the network between the hosts failed, so
/// the backup holds off while it hears it.
fn take_over_when_primary_is_lost(
    mut state: ResMut<BackupState>,
    mut role_error: ResMut<RoleError>,
    mut held_off: Local<bool>,
    mut notifications: MessageWriter<UiNotification>,
) {
    if !state.is_backup() || !state.auto_take_over {
        return;
    }
    let Some(silence) = link::process_backup_link().primary_silence() else {
        *held_off = false;
        return;
    };
    let sacn_heard = silence
        .primary
        .sacn_cid
        .is_some_and(|cid| sacn_source_heard_within(cid, failover::FAILOVER_TIMEOUT));
    if !failover::should_take_over(silence.silent_for, sacn_heard) {
        let holding_off = sacn_heard && silence.silent_for >= failover::FAILOVER_TIMEOUT;
        if holding_off && !*held_off {
            tracing::warn!(
                "The primary stopped answering, but its sACN still arrives; not taking over"
            );
        }
        *held_off = holding_off;
        return;
    }
    tracing::warn!(
        silent_for = ?silence.silent_for,
        "The primary stopped answering; taking over automatically"
    );
    let primary = state.primary_address.as_deref().map_or_else(
        || "The primary".to_string(),
        |address| format!("The primary {address}"),
    );
    let (stored, save_error) = take_over();
    state.apply_preferences(&stored);
    notifications.write(UiNotification::toast(
        ToastLevel::Warning,
        format!("{primary} stopped answering, so this computer took over its output."),
    ));
    let at = link::now_ms();
    failover::set_took_over_automatically_at(Some(at));
    state.took_over_automatically_at_ms = Some(at);
    role_error.0 = save_error;
}

/// Rejoins as the backup of the host that last backed this one up, once the link found it
/// running as a primary with a newer epoch.
fn rejoin_when_backup_took_over(
    mut state: ResMut<BackupState>,
    mut role_error: ResMut<RoleError>,
    mut notifications: MessageWriter<UiNotification>,
) {
    let Some((address, epoch)) = link::process_backup_link().take_rejoin() else {
        return;
    };
    if state.is_backup() {
        return;
    }
    let (stored, save_error) = rejoin_as_backup(&address, epoch);
    state.apply_preferences(&stored);
    notifications.write(UiNotification::toast(
        ToastLevel::Warning,
        format!(
            "{address} took over while this computer was away, so this computer now follows it \
             as its backup and sends no output."
        ),
    ));
    failover::set_took_over_automatically_at(None);
    state.took_over_automatically_at_ms = None;
    role_error.0 = save_error;
}

/// Mirrors the link's progress into the client-facing state, applies the output and ingress
/// restrictions of the backup role, adopts the primary's epoch, publishes this host's status to
/// other hosts, and hands newly copied shows to the world.
fn sync_backup_link(
    mut state: ResMut<BackupState>,
    role_error: Res<RoleError>,
    mut standby: ResMut<DmxOutputStandby>,
    mut gate: ResMut<ClientIngressGate>,
    mut mirrored: MessageWriter<MirroredShowfileReady>,
    sacn_identity: Option<Res<SacnOutputIdentity>>,
    mut peer_checked_at: Local<Option<std::time::Instant>>,
) {
    let link = link::process_backup_link();
    let report = if state.is_backup() {
        link.report()
    } else {
        link::LinkReport::default()
    };
    let mut epoch = state.epoch;
    if state.is_backup()
        && let Some(primary_epoch) = link.primary_epoch().filter(|primary| *primary > epoch)
    {
        // A later takeover by this host must outrank every takeover the primary saw.
        let (stored, save_error) =
            preferences::update(preferences::preferences_path().as_deref(), |stored| {
                stored.epoch = stored.epoch.max(primary_epoch);
            });
        if let Some(error) = save_error {
            tracing::warn!(%error, "Could not store the primary's epoch");
        }
        epoch = stored.epoch.max(primary_epoch);
    }
    let next = BackupState {
        link: report.status,
        error: report.error.or_else(|| role_error.0.clone()),
        showfile_name: report.showfile_name,
        synced_at_ms: report.synced_at_ms,
        epoch,
        backup: if state.is_backup() {
            None
        } else if peer_checked_at.is_none_or(|at| at.elapsed() >= PEER_HEALTH_INTERVAL) {
            // The backup's health changes on a scale of seconds, so it is not read every frame.
            *peer_checked_at = Some(std::time::Instant::now());
            failover::backup_peer().map(|address| {
                let check = link.peer_check(&address);
                failover::peer_health(address, check)
            })
        } else {
            state.backup.clone()
        },
        ..state.clone()
    };
    state.set_if_neq(next);
    failover::publish_host_status(failover::HostStatus {
        following: state.is_backup(),
        epoch: state.epoch,
        sacn_cid: sacn_identity.and_then(|identity| identity.cid),
    });

    standby.set_if_neq(DmxOutputStandby(state.is_backup() || awaiting_peer_check()));
    let reason = state.read_only_reason();
    if gate.read_only_reason() != reason.as_deref() {
        gate.set_read_only(reason);
    }

    if let Some(show) = link.take_mirror() {
        if state.is_backup() {
            mirrored.write(MirroredShowfileReady {
                showfile_name: show.showfile_name,
                directory: show.directory,
            });
        }
    }
}

/// How far this world has followed the primary. Every world starts with neither, so the world a
/// show load swaps in applies the latest checkpoint straight away and replays forwarded
/// commands only from there.
#[derive(Resource, Debug, Default)]
struct BackupTracking {
    /// Sequence of the newest checkpoint this world looked at.
    checkpoint: Option<u64>,
    /// The newest forwarded command this world's state reflects, once a checkpoint told it
    /// where to start. `None` while forwarded commands cannot be replayed.
    through: Option<CommandsThrough>,
}

impl BackupTracking {
    /// Returns whether a checkpoint reflecting `through` is older than what this world already
    /// replayed, so restoring it would undo forwarded commands.
    fn is_stale(&self, through: Option<CommandsThrough>) -> bool {
        matches!(
            (self.through, through),
            (Some(current), Some(through))
                if current.session == through.session && through.sequence < current.sequence
        )
    }
}

/// Brings this backup's playback, tempo, masters and programmer in line with the primary's newest
/// checkpoint, unless forwarded commands already took this world past it. Does nothing once this
/// host stops being a backup, so a takeover keeps the last state it applied.
fn apply_live_state_checkpoints(world: &mut World) {
    if !world.resource::<BackupState>().is_backup() {
        return;
    }
    let applied = world.resource::<BackupTracking>().checkpoint;
    let Some(checkpoint) = link::process_backup_link().checkpoint_after(applied) else {
        return;
    };
    let through = forwarding::commands_through(&checkpoint.snapshot);
    let mut tracking = world.resource_mut::<BackupTracking>();
    tracking.checkpoint = Some(checkpoint.sequence);
    if tracking.is_stale(through) {
        return;
    }
    tracking.through = through;
    let errors = restore_live_state(
        world,
        &checkpoint.snapshot,
        LiveStateRestore {
            age: checkpoint.age(),
        },
    );
    for error in errors {
        tracing::warn!(%error, "backup_live_state_restore_failed");
    }
}

/// Replays the commands the primary forwarded since this world's checkpoint, in order, and
/// skips those the checkpoint already reflects. A gap in the primary's history stops replay
/// until the next checkpoint.
///
/// Until a checkpoint tells this world where to start, as in a world a show load just swapped
/// in, forwarded commands stay queued, so none between that checkpoint and now are lost.
fn replay_forwarded_commands(world: &mut World) {
    if !world.resource::<BackupState>().is_backup() {
        let _ = link::process_backup_link().take_forwarded();
        return;
    }
    if world.resource::<BackupTracking>().through.is_none() {
        return;
    }
    for batch in link::process_backup_link().take_forwarded() {
        let mut tracking = world.resource_mut::<BackupTracking>();
        if batch.gap {
            tracking.through = None;
            continue;
        }
        let Some(mut through) = tracking
            .through
            .filter(|through| through.session == batch.session)
        else {
            continue;
        };
        for (sequence, entry) in batch.entries {
            if sequence <= through.sequence {
                continue;
            }
            through.sequence = sequence;
            if let Err(error) = apply_forwarded_entry(world, entry) {
                tracing::warn!(%error, "backup_forwarded_command_failed");
            }
        }
        world.resource_mut::<BackupTracking>().through = Some(through);
    }
}

/// Plugin that lets a native host follow a primary as its backup.
pub struct BackupPlugin;

impl Plugin for BackupPlugin {
    /// Registers the backup state feed, the role commands (allowed while read-only so a backup
    /// can always take over or re-pair), and the systems that restore the stored role and turn
    /// link progress into standby, the ingress gate and show loads.
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering BackupPlugin");
        nightfall_websocket::on_backup_pair_key_forgotten(failover::forget_stored_pair_key);
        app.init_resource::<BackupState>();
        app.init_resource::<RoleError>();
        app.init_resource::<PendingFollow>();
        app.init_resource::<BackupTracking>();
        app.init_resource::<CommandForwarding>();
        app.register_live_state(
            forwarding::COMMANDS_LIVE_STATE,
            forwarding::capture_commands_through,
            forwarding::restore_commands_through,
        );
        app.init_resource::<DmxOutputStandby>();
        app.init_resource::<ClientIngressGate>();
        app.add_message::<MirroredShowfileReady>();
        register_client_command::<BackupCommand>(app, Undo::Skipped);
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "TakeOver");
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "FollowPrimary");
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "SetAutoTakeOver");
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "StopFollowing");
        app.add_systems(Startup, restore_backup_role);
        app.add_systems(
            Update,
            (
                handle_backup_commands,
                finish_pending_follow,
                take_over_when_primary_is_lost,
                rejoin_when_backup_took_over,
                sync_backup_link,
            )
                .chain()
                .in_set(EventHandling),
        );
        // Replayed commands join the frame's command buffer before it is processed, so their
        // effect lands in the same frame and the next checkpoint never applies them twice.
        app.add_systems(
            Update,
            (apply_live_state_checkpoints, replay_forwarded_commands)
                .chain()
                .in_set(InputHandling),
        );
        app.add_systems(First, forwarding::update_forward_recording);
        app.add_systems(Last, forwarding::publish_forwarded_commands);
        app.add_resource_feed::<BackupState>();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A checkpoint older than the forwarded commands a world replayed is stale, while a newer
    /// one, one from a restarted primary, or the first one is not.
    #[test]
    fn checkpoints_behind_replayed_commands_are_stale() {
        let through = |session, sequence| Some(CommandsThrough { session, sequence });
        let tracking = BackupTracking {
            checkpoint: Some(4),
            through: through(1, 10),
        };
        assert!(tracking.is_stale(through(1, 9)));
        assert!(!tracking.is_stale(through(1, 10)));
        assert!(!tracking.is_stale(through(1, 11)));
        assert!(!tracking.is_stale(through(2, 1)));
        assert!(!BackupTracking::default().is_stale(through(1, 1)));
    }

    /// Typed addresses normalize to `host:port`, and anything else is refused with guidance.
    #[test]
    fn normalizes_primary_addresses() {
        assert_eq!(
            normalize_address(" http://192.168.1.20:3000/ ").unwrap(),
            "192.168.1.20:3000"
        );
        assert_eq!(
            normalize_address("desk.local:3544").unwrap(),
            "desk.local:3544"
        );
        assert_eq!(
            normalize_address(" 192.168.1.20 : 3000 ").unwrap(),
            "192.168.1.20:3000"
        );
        assert!(normalize_address("192.168.1.20").is_err());
        assert!(normalize_address(":3000").is_err());
        assert!(normalize_address("desk:port").is_err());
        assert!(normalize_address("desk/x:3000").is_err());
    }

    /// A backup refuses client changes with a reason naming its primary; a standalone host has
    /// no reason to refuse.
    #[test]
    fn only_a_backup_is_read_only() {
        let mut state = BackupState::default();
        assert_eq!(state.read_only_reason(), None);
        state.primary_address = Some("192.168.1.20:3000".into());
        assert!(
            state
                .read_only_reason()
                .unwrap()
                .contains("192.168.1.20:3000")
        );
    }
}
