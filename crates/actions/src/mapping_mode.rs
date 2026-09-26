// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Controller mapping mode: pauses controller-driven actions while clients bind controls.
//!
//! While any client is mapping, touching an already-mapped MIDI or OSC control must not fire
//! its live action. Each client session enters and leaves mapping mode on its own. A hold is
//! a lease the client renews while it is mapping, so the desk's controllers never stay
//! paused because of a closed, crashed, or unresponsive tab:
//! - a session that disconnects leaves mapping mode immediately;
//! - a session that stops renewing leaves it once [`MAPPING_MODE_LEASE`] elapses;
//! - loading a show ends every session's mapping mode.
//!
//! Loading a show can replace the whole world, websocket sessions included, so clients
//! cannot be told by session. Instead the published state carries a show generation that
//! changes on every load, and a client that entered under another generation leaves.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::{ClientConnectionId, ClientDisconnected};
use serde::Serialize;
use uuid::Uuid;
use web_time::Instant;

/// How long a session keeps mapping mode after entering or last renewing it.
///
/// Clients renew well within this, so only an unresponsive client lets its lease lapse.
pub const MAPPING_MODE_LEASE: Duration = Duration::from_secs(15);

/// Renewal failure for a session whose lease lapsed before it renewed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappingLeaseExpired;

impl MappingLeaseExpired {
    /// Explains to the operator why mapping mode ended.
    pub const MESSAGE: &str = "Controller mapping ended because this window stopped \
                               responding; MIDI and OSC controls are live again";
}

/// One session's hold on mapping mode.
#[derive(Debug, Clone, Copy)]
struct Lease {
    /// When the session entered mapping mode; input received earlier is not its touch.
    since: Instant,
    /// When the hold lapses unless renewed.
    deadline: Instant,
}

/// Client sessions currently mapping controllers; controller actions pause while any are.
#[derive(Resource, Debug)]
pub struct ControllerMappingMode {
    /// Sessions that hold mapping mode, with their leases.
    clients: BTreeMap<ClientConnectionId, Lease>,
    /// Sessions whose lease lapsed, until they renew, re-enter, leave, or disconnect.
    expired: BTreeSet<ClientConnectionId>,
    /// Identifies the loaded show; a new world or an in-place load gets a new one.
    show_generation: Uuid,
}

impl Default for ControllerMappingMode {
    fn default() -> Self {
        Self {
            clients: BTreeMap::new(),
            expired: BTreeSet::new(),
            show_generation: Uuid::new_v4(),
        }
    }
}

impl ControllerMappingMode {
    /// Returns whether any client is mapping, which suppresses controller action dispatch.
    pub fn is_active(&self) -> bool {
        !self.clients.is_empty()
    }

    /// Returns whether one session is currently mapping.
    pub fn contains(&self, client: ClientConnectionId) -> bool {
        self.clients.contains_key(&client)
    }

    /// Records that a session entered mapping mode, starting or refreshing its lease.
    ///
    /// Returns `false` if the session was already mapping.
    pub fn enter(&mut self, client: ClientConnectionId, now: Instant) -> bool {
        self.expired.remove(&client);
        self.hold(client, now)
    }

    /// Starts or extends a session's lease at `now`, returning whether it newly entered.
    fn hold(&mut self, client: ClientConnectionId, now: Instant) -> bool {
        let deadline = now + MAPPING_MODE_LEASE;
        match self.clients.get_mut(&client) {
            Some(lease) => {
                lease.deadline = deadline;
                false
            }
            None => {
                self.clients.insert(
                    client,
                    Lease {
                        since: now,
                        deadline,
                    },
                );
                true
            }
        }
    }

    /// Returns whether input received at `received_at` counts as a mapping touch: some
    /// session was already mapping when it arrived.
    ///
    /// Input queued before mapping mode began, but read afterwards, is not a touch, so a
    /// control moved just before entering does not arm.
    pub fn records_touch(&self, received_at: Instant) -> bool {
        self.clients
            .values()
            .any(|lease| received_at >= lease.since)
    }

    /// Extends a mapping session's lease, returning whether the session newly entered.
    ///
    /// Fails when the session's lease lapsed, so a client that stopped responding notices
    /// instead of silently pausing controllers again. A session that is not mapping for any
    /// other reason enters, which covers a reconnected client renewing before re-entering.
    pub fn renew(
        &mut self,
        client: ClientConnectionId,
        now: Instant,
    ) -> Result<bool, MappingLeaseExpired> {
        if self.expired.remove(&client) {
            return Err(MappingLeaseExpired);
        }
        Ok(self.hold(client, now))
    }

    /// Records that a session left mapping mode; returns `false` if it was not mapping.
    pub fn leave(&mut self, client: ClientConnectionId) -> bool {
        self.expired.remove(&client);
        self.clients.remove(&client).is_some()
    }

    /// Returns whether any session's lease lapsed by `now`.
    pub fn has_expired(&self, now: Instant) -> bool {
        self.clients.values().any(|lease| lease.deadline <= now)
    }

    /// Ends mapping mode for sessions whose lease lapsed by `now`, returning them.
    pub fn expire(&mut self, now: Instant) -> Vec<ClientConnectionId> {
        let expired: Vec<_> = self
            .clients
            .iter()
            .filter(|(_, lease)| lease.deadline <= now)
            .map(|(client, _)| *client)
            .collect();
        for client in &expired {
            self.clients.remove(client);
            self.expired.insert(*client);
        }
        expired
    }

    /// Ends every session's mapping mode for an in-place show load and starts a new show
    /// generation, which tells mapping clients why they left.
    ///
    /// A load that replaces the world gets a fresh resource, and so a new generation, instead.
    pub fn end_for_show_load(&mut self) {
        self.clients.clear();
        self.expired.clear();
        self.show_generation = Uuid::new_v4();
    }

    /// Forgets a disconnected session entirely.
    fn disconnect(&mut self, client: ClientConnectionId) -> bool {
        self.expired.remove(&client);
        self.clients.remove(&client).is_some()
    }

    /// Returns the published snapshot of this state.
    pub fn state(&self) -> ControllerMappingModeState {
        ControllerMappingModeState {
            mapping_clients: u32::try_from(self.clients.len()).unwrap_or(u32::MAX),
            show_generation: self.show_generation.to_string(),
        }
    }
}

/// Controller mapping mode as published to every client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct ControllerMappingModeState {
    /// Number of client sessions mapping controllers; MIDI and OSC actions pause while
    /// this is non-zero.
    pub mapping_clients: u32,
    /// Changes whenever a show is loaded. A client that entered mapping mode under another
    /// generation had its mapping mode ended by the load.
    ///
    /// Published as text because binary websocket encodings serialize UUIDs as bytes, which
    /// clients could not compare by value.
    pub show_generation: String,
}

/// Releases mapping mode held by sessions that disconnected.
///
/// Runs after client commands are applied, so a session that entered mapping mode and
/// disconnected in the same frame does not leave controllers paused.
pub fn release_disconnected_mapping_clients(
    mut disconnects: MessageReader<ClientDisconnected>,
    mut mode: ResMut<ControllerMappingMode>,
) {
    for ClientDisconnected(client) in disconnects.read() {
        if mode.disconnect(*client) {
            tracing::info!(
                connection = client.0,
                "controller_mapping_mode_released_on_disconnect"
            );
        }
    }
}

/// Ends mapping mode for sessions that stopped renewing their lease.
///
/// Only touches the resource mutably when a lease lapsed, so renewals and idle frames do
/// not republish mapping mode state.
pub fn expire_mapping_mode_leases(mut mode: ResMut<ControllerMappingMode>) {
    let now = Instant::now();
    if !mode.has_expired(now) {
        return;
    }
    for client in mode.expire(now) {
        tracing::warn!(
            connection = client.0,
            "controller_mapping_mode_lease_expired"
        );
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use bevy_ecs::message::Messages;
    use nightfall_engine::prelude::{
        CommandEnvelope, CommandNotice, CommandOrigin, CommandOutcome, CommandReply, CommandResult,
        CommandTracker, FinishedCommand, ReplyTarget,
    };

    use super::*;
    use crate::command::{ActionCommand, handle_action_commands};
    use crate::invocation::ActionInvocation;

    /// Creates an app that applies action commands and releases disconnected sessions.
    fn mapping_app() -> App {
        let mut app = App::new();
        app.init_resource::<ControllerMappingMode>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<ActionCommand>>();
        app.add_message::<ActionInvocation>();
        app.add_message::<ClientDisconnected>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(
            Update,
            (handle_action_commands, release_disconnected_mapping_clients).chain(),
        );
        app
    }

    /// Submits one action command attributed to `client`, or to no session when `None`.
    fn submit(app: &mut App, command: ActionCommand, client: Option<u64>) {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let mut tracker = app.world_mut().resource_mut::<CommandTracker>();
        tracker
            .register(&envelope)
            .expect("mapping command should register");
        if let Some(client) = client {
            tracker.attach_connection(envelope.command_id, ClientConnectionId(client));
        }
        app.world_mut().write_message(envelope);
    }

    /// Returns how many sessions the app currently counts as mapping.
    fn mapping_clients(app: &App) -> u32 {
        app.world()
            .resource::<ControllerMappingMode>()
            .state()
            .mapping_clients
    }

    /// Verifies mapping mode stays active until every session that entered it has left.
    #[test]
    fn mapping_mode_is_held_per_session() {
        let mut app = mapping_app();
        submit(&mut app, ActionCommand::EnterControllerMappingMode, Some(1));
        submit(&mut app, ActionCommand::EnterControllerMappingMode, Some(1));
        submit(&mut app, ActionCommand::EnterControllerMappingMode, Some(2));
        app.update();
        assert_eq!(mapping_clients(&app), 2);

        submit(&mut app, ActionCommand::LeaveControllerMappingMode, Some(1));
        app.update();
        assert!(app.world().resource::<ControllerMappingMode>().is_active());

        submit(&mut app, ActionCommand::LeaveControllerMappingMode, Some(2));
        app.update();
        assert!(!app.world().resource::<ControllerMappingMode>().is_active());
    }

    /// Verifies a disconnect releases that session's hold, even in the frame it entered.
    #[test]
    fn disconnect_releases_mapping_mode() {
        let mut app = mapping_app();
        submit(&mut app, ActionCommand::EnterControllerMappingMode, Some(1));
        submit(&mut app, ActionCommand::EnterControllerMappingMode, Some(2));
        app.update();

        app.world_mut()
            .write_message(ClientDisconnected(ClientConnectionId(1)));
        app.update();
        assert_eq!(mapping_clients(&app), 1);

        submit(&mut app, ActionCommand::EnterControllerMappingMode, Some(3));
        app.world_mut()
            .write_message(ClientDisconnected(ClientConnectionId(3)));
        app.world_mut()
            .write_message(ClientDisconnected(ClientConnectionId(2)));
        app.update();
        assert!(!app.world().resource::<ControllerMappingMode>().is_active());
    }

    /// Verifies a command without an identified session cannot hold mapping mode.
    #[test]
    fn mapping_mode_requires_a_client_session() {
        let mut app = mapping_app();
        submit(&mut app, ActionCommand::EnterControllerMappingMode, None);
        app.update();

        assert!(!app.world().resource::<ControllerMappingMode>().is_active());
        let result = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("mapping command should finish");
        assert!(matches!(
            result.outcome,
            CommandOutcome::Failed(ref error) if error.code == "action.mapping_mode_requires_client"
        ));
    }

    /// Drains the finished command results and returns their failure codes, `None` for each
    /// success.
    fn result_codes(app: &mut App) -> Vec<Option<String>> {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .map(|result| match result.outcome {
                CommandOutcome::Failed(error) => Some(error.code),
                _ => None,
            })
            .collect()
    }

    /// Verifies a lease lapses only for sessions that stopped renewing, and that renewing
    /// pushes the deadline out.
    #[test]
    fn leases_lapse_without_renewal() {
        let mut mode = ControllerMappingMode::default();
        let start = Instant::now();
        let (renewing, silent) = (ClientConnectionId(1), ClientConnectionId(2));
        mode.enter(renewing, start);
        mode.enter(silent, start);

        let halfway = start + MAPPING_MODE_LEASE / 2;
        assert_eq!(mode.renew(renewing, halfway), Ok(false));
        assert!(!mode.has_expired(halfway));

        let lapsed = start + MAPPING_MODE_LEASE;
        assert_eq!(mode.expire(lapsed), vec![silent]);
        assert!(mode.contains(renewing));
        assert_eq!(mode.renew(silent, lapsed), Err(MappingLeaseExpired));
        assert_eq!(mode.renew(silent, lapsed), Ok(true));
    }

    /// Verifies only input received after some session entered counts as a touch, and that
    /// renewing does not move when the session entered.
    #[test]
    fn touches_count_only_after_mapping_began() {
        let mut mode = ControllerMappingMode::default();
        let entered = Instant::now();
        let before = entered - Duration::from_millis(5);
        assert!(!mode.records_touch(entered));

        mode.enter(ClientConnectionId(1), entered);
        assert!(!mode.records_touch(before));
        assert!(mode.records_touch(entered));

        let later = entered + Duration::from_secs(1);
        mode.renew(ClientConnectionId(1), later)
            .expect("lease is live");
        assert!(mode.records_touch(entered + Duration::from_millis(1)));
    }

    /// Verifies renewing without a lapsed lease enters mapping mode, as happens when a
    /// reconnected client renews before its re-entry arrives.
    #[test]
    fn renewing_without_a_lapsed_lease_enters() {
        let mut mode = ControllerMappingMode::default();

        assert_eq!(mode.renew(ClientConnectionId(3), Instant::now()), Ok(true));
        assert!(mode.contains(ClientConnectionId(3)));
    }

    /// Verifies an in-place show load ends every session's mapping mode and publishes a new
    /// show generation, and that each fresh world starts its own generation.
    #[test]
    fn show_load_ends_mapping_mode_under_a_new_generation() {
        let mut mode = ControllerMappingMode::default();
        let now = Instant::now();
        mode.enter(ClientConnectionId(1), now);
        let before = mode.state().show_generation;

        mode.end_for_show_load();
        assert!(!mode.is_active());
        assert_ne!(mode.state().show_generation, before);
        assert_ne!(
            ControllerMappingMode::default().state().show_generation,
            mode.state().show_generation
        );
    }

    /// Verifies renewal commands succeed without republishing state, and fail with
    /// `action.mapping_mode_ended` once the session's lease lapsed.
    #[test]
    fn renew_command_reports_ended_mapping_mode() {
        let mut app = mapping_app();
        submit(&mut app, ActionCommand::EnterControllerMappingMode, Some(1));
        app.update();
        result_codes(&mut app);
        let entered = app
            .world()
            .resource_ref::<ControllerMappingMode>()
            .last_changed();

        submit(&mut app, ActionCommand::RenewControllerMappingMode, Some(1));
        submit(&mut app, ActionCommand::EnterControllerMappingMode, Some(1));
        app.update();
        assert_eq!(result_codes(&mut app), vec![None, None]);
        assert_eq!(
            app.world()
                .resource_ref::<ControllerMappingMode>()
                .last_changed(),
            entered
        );

        app.world_mut()
            .resource_mut::<ControllerMappingMode>()
            .expire(Instant::now() + MAPPING_MODE_LEASE);
        submit(&mut app, ActionCommand::RenewControllerMappingMode, Some(1));
        app.update();
        assert_eq!(
            result_codes(&mut app),
            vec![Some("action.mapping_mode_ended".to_string())]
        );
    }
}
