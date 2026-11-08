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
//!
//! The role is a host preference rather than show data, because the show itself is copied from
//! the primary.

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::DmxOutputStandby;
use serde::{Deserialize, Serialize};

mod link;
mod preferences;

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
    /// The host holds the primary's current show.
    Synced,
    /// The primary refused this host and needs its pairing PIN again.
    PairingRequired,
    /// The primary could not be reached; the host keeps the last show it copied.
    Unreachable,
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
}

impl BackupState {
    /// Returns whether this host currently backs up a primary.
    pub fn is_backup(&self) -> bool {
        self.primary_address.is_some()
    }

    /// Returns the reason shown to clients whose changes a backup refuses.
    fn read_only_reason(&self) -> Option<String> {
        self.primary_address.as_ref().map(|address| {
            format!(
                "This Nightfall is a backup following {address}. Take over to make changes here."
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
    let trimmed = address.trim();
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

/// Restores the stored role into a new world and points the link at the stored primary.
///
/// The output and ingress restrictions apply here too, before the world's first frame, so a
/// backup never transmits unprioritized output or accepts a change while a new world starts.
fn restore_backup_role(
    mut state: ResMut<BackupState>,
    mut role_error: ResMut<RoleError>,
    mut standby: ResMut<DmxOutputStandby>,
    mut gate: ResMut<ClientIngressGate>,
) {
    let (stored, error) = preferences::load(preferences::preferences_path().as_deref());
    state.available = true;
    state.primary_address = stored.primary_address.clone();
    role_error.0 = error;
    *standby = DmxOutputStandby(state.is_backup());
    gate.set_read_only(state.read_only_reason());
    link::process_backup_link().set_target(stored.primary_address.map(|address| {
        link::LinkTarget {
            address,
            pin: None,
            token: stored.pairing_token,
        }
    }));
}

/// Applies role changes, storing them so a restarted host keeps its role.
fn handle_backup_commands(
    mut commands: MessageReader<CommandEnvelope<BackupCommand>>,
    mut state: ResMut<BackupState>,
    mut role_error: ResMut<RoleError>,
    mut responder: CommandResponder,
) {
    for envelope in commands.read() {
        let outcome = match &envelope.command {
            BackupCommand::FollowPrimary { address, pin } => {
                follow_primary(address, pin.as_deref())
            }
            BackupCommand::TakeOver => take_over(),
        };
        let result = match outcome {
            Ok(primary_address) => {
                state.primary_address = primary_address;
                role_error.0 = None;
                responder.succeed(envelope.command_id)
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

/// Stores `address` as this host's primary and starts following it.
fn follow_primary(address: &str, pin: Option<&str>) -> Result<Option<String>, String> {
    let address = normalize_address(address)?;
    let pin = pin.map(str::trim).filter(|pin| !pin.is_empty());
    preferences::save(
        preferences::preferences_path().as_deref(),
        &preferences::BackupPreferences {
            primary_address: Some(address.clone()),
            pairing_token: None,
        },
    )?;
    tracing::info!(%address, "Following a primary as its backup");
    link::process_backup_link().set_target(Some(link::LinkTarget {
        address: address.clone(),
        pin: pin.map(str::to_string),
        token: None,
    }));
    Ok(Some(address))
}

/// Clears the stored primary and stops following it.
fn take_over() -> Result<Option<String>, String> {
    preferences::save(
        preferences::preferences_path().as_deref(),
        &preferences::BackupPreferences::default(),
    )?;
    tracing::info!("Backup took over output");
    link::process_backup_link().set_target(None);
    Ok(None)
}

/// Mirrors the link's progress into the client-facing state, applies the output and ingress
/// restrictions of the backup role, and hands newly copied shows to the world.
fn sync_backup_link(
    mut state: ResMut<BackupState>,
    role_error: Res<RoleError>,
    mut standby: ResMut<DmxOutputStandby>,
    mut gate: ResMut<ClientIngressGate>,
    mut mirrored: MessageWriter<MirroredShowfileReady>,
) {
    let link = link::process_backup_link();
    let report = if state.is_backup() {
        link.report()
    } else {
        link::LinkReport::default()
    };
    let next = BackupState {
        link: report.status,
        error: report.error.or_else(|| role_error.0.clone()),
        showfile_name: report.showfile_name,
        synced_at_ms: report.synced_at_ms,
        ..state.clone()
    };
    state.set_if_neq(next);

    standby.set_if_neq(DmxOutputStandby(state.is_backup()));
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

/// Sequence of the newest live state checkpoint this world applied. Every world starts without
/// one, so the world a show load swaps in applies the latest checkpoint straight away.
#[derive(Resource, Debug, Default)]
struct AppliedCheckpoint(Option<u64>);

/// Brings this backup's playback, tempo, masters and programmer in line with the primary's newest
/// checkpoint. Does nothing once this host stops being a backup, so a takeover keeps the last
/// state it applied.
fn apply_live_state_checkpoints(world: &mut World) {
    if !world.resource::<BackupState>().is_backup() {
        return;
    }
    let applied = world.resource::<AppliedCheckpoint>().0;
    let Some(checkpoint) = link::process_backup_link().checkpoint_after(applied) else {
        return;
    };
    world.resource_mut::<AppliedCheckpoint>().0 = Some(checkpoint.sequence);
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
        app.init_resource::<AppliedCheckpoint>();
        app.init_resource::<DmxOutputStandby>();
        app.init_resource::<ClientIngressGate>();
        app.add_message::<MirroredShowfileReady>();
        register_client_command::<BackupCommand>(app, Undo::Skipped);
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "TakeOver");
        allow_command_while_read_only(app, BackupCommand::COMMAND_MODULE, "FollowPrimary");
        app.add_systems(Startup, restore_backup_role);
        app.add_systems(
            Update,
            (
                handle_backup_commands,
                sync_backup_link,
                apply_live_state_checkpoints,
            )
                .chain()
                .in_set(EventHandling),
        );
        app.add_resource_feed::<BackupState>();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
