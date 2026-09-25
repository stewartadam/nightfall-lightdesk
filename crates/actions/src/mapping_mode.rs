// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Controller mapping mode: pauses controller-driven actions while clients bind controls.
//!
//! While any client is mapping, touching an already-mapped MIDI or OSC control must not fire
//! its live action. Each client session enters and leaves mapping mode on its own, and a
//! session that disconnects leaves it automatically, so a crashed or closed tab never
//! leaves the desk's controllers paused.

use std::collections::BTreeSet;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::{ClientConnectionId, ClientDisconnected};
use serde::Serialize;

/// Client sessions currently mapping controllers; controller actions pause while any are.
#[derive(Resource, Debug, Default)]
pub struct ControllerMappingMode {
    /// Sessions that entered mapping mode and have not left or disconnected.
    clients: BTreeSet<ClientConnectionId>,
}

impl ControllerMappingMode {
    /// Returns whether any client is mapping, which suppresses controller action dispatch.
    pub fn is_active(&self) -> bool {
        !self.clients.is_empty()
    }

    /// Returns whether one session is currently mapping.
    pub fn contains(&self, client: ClientConnectionId) -> bool {
        self.clients.contains(&client)
    }

    /// Records that a session entered mapping mode; returns `false` if it already had.
    pub fn enter(&mut self, client: ClientConnectionId) -> bool {
        self.clients.insert(client)
    }

    /// Records that a session left mapping mode; returns `false` if it was not mapping.
    pub fn leave(&mut self, client: ClientConnectionId) -> bool {
        self.clients.remove(&client)
    }

    /// Returns the published snapshot of this state.
    pub fn state(&self) -> ControllerMappingModeState {
        ControllerMappingModeState {
            mapping_clients: u32::try_from(self.clients.len()).unwrap_or(u32::MAX),
        }
    }
}

/// Controller mapping mode as published to every client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct ControllerMappingModeState {
    /// Number of client sessions mapping controllers; MIDI and OSC actions pause while
    /// this is non-zero.
    pub mapping_clients: u32,
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
        if mode.contains(*client) {
            mode.leave(*client);
            tracing::info!(
                connection = client.0,
                "controller_mapping_mode_released_on_disconnect"
            );
        }
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
}
