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
//! Leaving the pair instead, or a primary that leaves it, closes the copied show unsent.
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
pub use preferences::FailoverShow;

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use crate::{
        BackupCommand, BackupLinkStatus, BackupPlugin, BackupState, CopiedShowClosing,
        MirroredShowfileReady, ShowfileRevision,
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
    /// The primary answers but has no show open yet, as while it waits at startup for one.
    WaitingForShow,
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
    /// Milliseconds the backup took to answer its last check, while it answers.
    pub latency_ms: Option<u32>,
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
    /// Milliseconds the primary took to answer its last heartbeat, while it answers.
    pub latency_ms: Option<u32>,
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
    /// The failover pair's show this host ran last, which continuing as the primary opens.
    pub failover_show: Option<FailoverShow>,
}

impl BackupState {
    /// Returns whether this host currently backs up a primary.
    pub fn is_backup(&self) -> bool {
        self.primary_address.is_some()
    }

    /// Takes the stored role, epoch, automatic takeover setting and remembered backup.
    fn apply_preferences(&mut self, stored: &preferences::BackupPreferences) {
        self.primary_address = stored.primary_address.clone();
        self.epoch = stored.epoch;
        self.auto_take_over = stored.auto_take_over;
        self.failover_show = stored.failover_show.clone();
        // Clients learn at once whether this host belongs to a pair, before its backup is checked.
        self.backup = match (&stored.primary_address, &stored.backup_peer) {
            (None, Some(peer)) => Some(
                self.backup
                    .take()
                    .filter(|backup| &backup.address == peer)
                    .unwrap_or_else(|| BackupPeer {
                        address: peer.clone(),
                        state: BackupPeerState::Checking,
                        last_seen_ms: None,
                        latency_ms: None,
                    }),
            ),
            _ => None,
        };
    }

    /// Returns the reason shown to clients whose changes a backup refuses.
    fn read_only_reason(&self) -> Option<String> {
        self.primary_address.as_ref().map(|address| {
            format!(
                "This Nightfall is a backup following {address}. Take over to make changes \
                 here, or leave the pair."
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
    /// Leaves the backup pair on either computer: this host runs on its own and forgets its
    /// primary, its backup and the key they share, so neither follows the other again without the
    /// PIN. A backup also closes the copied show without ever sending it, so its clients return
    /// to the welcome screen.
    LeavePair,
    /// Turns automatic takeover on or off for when this host follows a primary.
    SetAutoTakeOver {
        /// Whether to take over on its own once the primary stops answering.
        enabled: bool,
    },
    /// Opens the failover pair's show this host ran last, from the failover folder, as when it
    /// continues as the primary after a restart.
    OpenFailoverShow,
}

impl IngressCommand for BackupCommand {}

/// A show in the failover folder, copied from the primary or opened again, ready to replace the
/// world.
#[derive(Debug, Clone, PartialEq, Eq, Message)]
pub struct MirroredShowfileReady {
    /// Name to load the show under, or `None` for the default showfile.
    pub showfile_name: Option<String>,
    /// Loadable show directory in the failover folder.
    pub directory: std::path::PathBuf,
}

/// A backup left its pair, so the world should close the copied show and wait for a show like a
/// freshly started host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Message)]
pub struct CopiedShowClosing;

/// Whether this world holds a copied show that a backup left the pair with and that waits to be
/// closed, or replaced by a show a client opened. Its output stays in standby until then, so the
/// copied show never sends as this host's own output, even when that close or load fails.
#[derive(Debug, Default, Resource)]
pub struct ClosingCopiedShow(bool);

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
    app_state: Option<Res<bevy_state::state::State<nightfall_engine::AppState>>>,
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
        show_open: show_is_open(app_state.as_deref()),
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
    mut mirrored: MessageWriter<MirroredShowfileReady>,
    mut closing: ResMut<ClosingCopiedShow>,
    mut close: MessageWriter<CopiedShowClosing>,
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
        if let BackupCommand::OpenFailoverShow = envelope.command {
            let result = match open_failover_show(&state) {
                Ok(show) => {
                    mirrored.write(show);
                    responder.succeed(envelope.command_id)
                }
                Err(message) => responder.fail(
                    envelope.command_id,
                    CommandError::new("backup.failover_show_unavailable", message),
                ),
            };
            if let Err(error) = result {
                tracing::error!(command_id = %envelope.command_id, %error, "backup_command_completion_failed");
            }
            continue;
        }
        let changes_role = !matches!(
            envelope.command,
            BackupCommand::SetAutoTakeOver { .. } | BackupCommand::OpenFailoverShow
        );
        let outcome: Result<RoleChange, String> = match &envelope.command {
            // Handled above, since it completes only once the primary was checked.
            BackupCommand::FollowPrimary { .. } | BackupCommand::OpenFailoverShow => continue,
            BackupCommand::LeavePair if state.is_backup() => {
                tell_primary_of_leave(&state);
                Ok(leave_pair_closing_copied_show(&mut closing, &mut close))
            }
            BackupCommand::LeavePair => {
                failover::note_left_pair();
                Ok(leave_pair(LeftShow::Kept))
            }
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

/// Finds the failover pair's show this host ran last: its working draft when one is kept, which
/// holds the latest state, otherwise its saved copy. A backup opens its primary's show instead.
fn open_failover_show(state: &BackupState) -> Result<MirroredShowfileReady, String> {
    if state.is_backup() {
        return Err("A backup opens its primary's show on its own.".to_string());
    }
    let show = state
        .failover_show
        .as_ref()
        .ok_or("This computer has no failover show to open.")?;
    let root = nightfall::failover_data_dir().ok_or("Could not find the app data folder.")?;
    let folder = show.folder_name();
    let directory = [root.join("drafts").join(&folder), root.join(&folder)]
        .into_iter()
        .find(|directory| directory.is_dir())
        .ok_or_else(|| format!("The failover folder no longer holds {folder}."))?;
    Ok(MirroredShowfileReady {
        showfile_name: show.name.clone(),
        directory,
    })
}

/// Records which show this host opened: the failover pair's show when it is stored in the
/// failover folder, so continuing as the primary after a restart opens it again, or none for one
/// of this computer's own showfiles.
pub fn remember_open_show(name: Option<&str>, in_failover_folder: bool) {
    let failover_show = in_failover_folder.then(|| FailoverShow {
        name: name.map(str::to_string),
    });
    let path = preferences::preferences_path();
    if preferences::current(path.as_deref()).0.failover_show == failover_show {
        return;
    }
    let (_, error) = preferences::update(path.as_deref(), |stored| {
        stored.failover_show = failover_show;
    });
    if let Some(error) = error {
        tracing::warn!(%error, "Could not store which failover show is open");
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
    failover::note_joined_pair();
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

/// What becomes of the open show when this host leaves the pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeftShow {
    /// The show stays open: a primary keeps running its show, and a show load replaces a
    /// backup's copy anyway.
    Kept,
    /// A backup's copy of its primary's show is closed, so continuing as a primary after a
    /// restart no longer offers it.
    Closed,
}

/// Leaves the pair, or stops following without taking over, and returns the new role: this host
/// runs on its own, remembers neither its primary nor a backup nor their shared key, and keeps
/// its epoch.
fn leave_pair(show: LeftShow) -> RoleChange {
    let (stored, save_error) =
        preferences::update(preferences::preferences_path().as_deref(), |stored| {
            stored.primary_address = None;
            stored.pair_key = None;
            stored.backup_peer = None;
            if show == LeftShow::Closed {
                stored.failover_show = None;
            }
        });
    failover::set_backup_peer(None);
    failover::share_pair_key(None);
    tracing::info!("Left the backup pair; running on its own");
    let link = link::process_backup_link();
    link.cancel_probe("Stopped following before the primary was checked.");
    link.set_target(None);
    link.mark_peer_checked();
    (stored, save_error)
}

/// Tells the primary this host follows that it is leaving the pair, while the two still share
/// their key, so the primary forgets this host as its backup.
fn tell_primary_of_leave(state: &BackupState) {
    if let (Some(address), Some(key)) = (state.primary_address.clone(), failover::pair_key()) {
        link::process_backup_link().tell_primary_of_leave(address, key);
    }
}

/// Leaves the pair as a backup and asks the world to close the copied show, holding its output in
/// standby until the empty world replaces it, and returns the new role.
fn leave_pair_closing_copied_show(
    closing: &mut ClosingCopiedShow,
    close: &mut MessageWriter<CopiedShowClosing>,
) -> RoleChange {
    closing.0 = true;
    close.write(CopiedShowClosing);
    leave_pair(LeftShow::Closed)
}

/// Stops following when a client opens or creates a show, which replaces the copied show, and
/// returns why the change could not be stored, if it could not. The copied show stays in standby
/// until the opened show replaces it. Does nothing on a host that follows no primary, apart from
/// cancelling a follow still waiting for its primary to be checked.
pub fn leave_backup_role_for_show_load(
    state: &mut BackupState,
    closing: &mut ClosingCopiedShow,
) -> Option<String> {
    if state.checking_address.is_some() {
        link::process_backup_link()
            .cancel_probe("A show was opened before the primary was checked.");
    }
    if !state.is_backup() {
        return None;
    }
    tell_primary_of_leave(state);
    closing.0 = true;
    let (stored, save_error) = leave_pair(LeftShow::Kept);
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
    failover::note_joined_pair();
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

/// Rounds a round trip up to whole milliseconds, so a fast local link reads as 1 ms, not 0.
fn latency_ms(latency: std::time::Duration) -> u32 {
    u32::try_from(latency.as_micros().div_ceil(1000)).unwrap_or(u32::MAX)
}

/// Keeps the latency clients were shown until a new measurement differs by a quarter or by at
/// least 2 ms, so jitter does not resend the backup state with every heartbeat.
fn steady_latency(shown: Option<u32>, measured: Option<u32>) -> Option<u32> {
    match (shown, measured) {
        (Some(shown), Some(measured)) if measured.abs_diff(shown) < (shown / 4).max(2) => {
            Some(shown)
        }
        _ => measured,
    }
}

/// Returns whether the world holds an open show, rather than waiting at startup for one.
fn show_is_open(app_state: Option<&bevy_state::state::State<nightfall_engine::AppState>>) -> bool {
    app_state.is_some_and(|app_state| *app_state.get() == nightfall_engine::AppState::Ready)
}

/// Leaves the pair when the primary answers that it left it, closing the copied show without
/// ever sending it, and tells every client why.
fn leave_when_primary_left(
    mut state: ResMut<BackupState>,
    mut role_error: ResMut<RoleError>,
    mut closing: ResMut<ClosingCopiedShow>,
    mut close: MessageWriter<CopiedShowClosing>,
    mut notifications: MessageWriter<UiNotification>,
) {
    if !link::process_backup_link().take_primary_left() || !state.is_backup() {
        return;
    }
    let primary = state.primary_address.clone().unwrap_or_default();
    let (stored, save_error) = leave_pair_closing_copied_show(&mut closing, &mut close);
    state.apply_preferences(&stored);
    failover::set_took_over_automatically_at(None);
    state.took_over_automatically_at_ms = None;
    role_error.0 = save_error;
    notifications.write(UiNotification::toast(
        ToastLevel::Warning,
        format!("{primary} left the failover pair, so this instance closed the copied show."),
    ));
}

/// Forgets this primary's backup once that backup said it left the pair, and tells every client.
fn forget_backup_that_left(
    mut state: ResMut<BackupState>,
    mut notifications: MessageWriter<UiNotification>,
) {
    let Some(address) = failover::take_backup_left() else {
        return;
    };
    state.backup = None;
    notifications.write(UiNotification::toast(
        ToastLevel::Warning,
        format!("The backup {address} left the failover pair, so this instance has no backup."),
    ));
}

/// Mirrors the link's progress into the client-facing state, applies the output and ingress
/// restrictions of the backup role, keeping output in standby while a copied show waits to close,
/// adopts the primary's epoch, publishes this host's status to other hosts, and hands newly
/// copied shows to the world.
fn sync_backup_link(
    mut state: ResMut<BackupState>,
    role_error: Res<RoleError>,
    mut standby: ResMut<DmxOutputStandby>,
    mut gate: ResMut<ClientIngressGate>,
    mut mirrored: MessageWriter<MirroredShowfileReady>,
    closing: Res<ClosingCopiedShow>,
    sacn_identity: Option<Res<SacnOutputIdentity>>,
    app_state: Option<Res<bevy_state::state::State<nightfall_engine::AppState>>>,
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
        latency_ms: if state.is_backup() {
            steady_latency(state.latency_ms, link.primary_latency().map(latency_ms))
        } else {
            None
        },
        epoch,
        backup: if state.is_backup() {
            None
        } else if peer_checked_at.is_none_or(|at| at.elapsed() >= PEER_HEALTH_INTERVAL) {
            // The backup's health changes on a scale of seconds, so it is not read every frame.
            *peer_checked_at = Some(std::time::Instant::now());
            failover::backup_peer().map(|address| {
                let check = link.peer_check(&address);
                let shown = state
                    .backup
                    .as_ref()
                    .filter(|backup| backup.address == address)
                    .and_then(|backup| backup.latency_ms);
                let latency = steady_latency(shown, link.peer_latency(&address).map(latency_ms));
                BackupPeer {
                    latency_ms: latency,
                    ..failover::peer_health(address, check)
                }
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
        show_open: show_is_open(app_state.as_deref()),
    });

    standby.set_if_neq(DmxOutputStandby(
        state.is_backup() || awaiting_peer_check() || closing.0,
    ));
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
        app.init_resource::<BackupState>();
        app.init_resource::<RoleError>();
        app.init_resource::<PendingFollow>();
        app.init_resource::<BackupTracking>();
        app.init_resource::<ClosingCopiedShow>();
        app.init_resource::<CommandForwarding>();
        app.register_live_state(
            forwarding::COMMANDS_LIVE_STATE,
            forwarding::capture_commands_through,
            forwarding::restore_commands_through,
        );
        app.init_resource::<DmxOutputStandby>();
        app.init_resource::<ClientIngressGate>();
        app.add_message::<MirroredShowfileReady>();
        app.add_message::<CopiedShowClosing>();
        register_client_command::<BackupCommand>(app, Undo::Skipped);
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "TakeOver");
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "FollowPrimary");
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "SetAutoTakeOver");
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "LeavePair");
        app.add_systems(Startup, restore_backup_role);
        app.add_systems(
            Update,
            (
                handle_backup_commands,
                finish_pending_follow,
                take_over_when_primary_is_lost,
                rejoin_when_backup_took_over,
                leave_when_primary_left,
                forget_backup_that_left,
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

    /// Latency shown to clients ignores small jitter but follows real changes and a link that
    /// starts or stops answering.
    #[test]
    fn latency_ignores_jitter() {
        assert_eq!(steady_latency(None, Some(3)), Some(3));
        assert_eq!(steady_latency(Some(3), Some(4)), Some(3));
        assert_eq!(steady_latency(Some(3), Some(5)), Some(5));
        assert_eq!(steady_latency(Some(40), Some(48)), Some(40));
        assert_eq!(steady_latency(Some(40), Some(50)), Some(50));
        assert_eq!(steady_latency(Some(3), None), None);
    }
}
