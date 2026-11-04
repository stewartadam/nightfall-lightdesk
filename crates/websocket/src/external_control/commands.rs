// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The external control command and the client feed of the listener's preferences and status.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use super::{ExternalControlSettings, ExternalControlState};

/// Commands that change whether other computers may connect, and on which interface.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ExternalControlCommand {
    /// Replaces the host's external control preferences.
    SetSettings(ExternalControlSettings),
}

impl IngressCommand for ExternalControlCommand {}

/// External control messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum ExternalControlWsMessage<'a> {
    /// Host-owned external control preferences and listener status.
    ExternalControlState(&'a ExternalControlState),
}

/// Stores new external control preferences, which the listener then applies and saves. Hosts
/// without a native listener keep their defaults, since they have nothing to apply them to.
pub(crate) fn handle_external_control_commands(
    mut commands: MessageReader<CommandEnvelope<ExternalControlCommand>>,
    mut state: ResMut<ExternalControlState>,
    mut responder: CommandResponder,
) {
    for envelope in commands.read() {
        match &envelope.command {
            ExternalControlCommand::SetSettings(settings) => {
                if state.available {
                    state.settings = settings.clone();
                }
            }
        }
        if let Err(error) = responder.succeed(envelope.command_id) {
            tracing::error!(
                command_id = %envelope.command_id,
                %error,
                "external_control_command_completion_failed"
            );
        }
    }
}

/// Publishes the external control preferences and listener status to clients.
fn send_external_control_state(state: &ExternalControlState, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ExternalControlWsMessage::ExternalControlState(state),
    );
}

/// Publishes the external control state whenever the preferences or listener status change.
pub(crate) fn send_external_control_state_on_change(
    state: Res<ExternalControlState>,
    broadcaster: Res<ClientEventSink>,
) {
    if state.is_changed() {
        send_external_control_state(&state, &broadcaster);
    }
}

/// Sends the external control state to a client that asked for a full resync.
pub(crate) fn handle_resync_state(mut resync: ResyncReplies, state: Res<ExternalControlState>) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };
    send_external_control_state(&state, &broadcaster);
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Builds an app that applies external control commands and records their results.
    fn command_app() -> App {
        let mut app = App::new();
        app.init_resource::<ExternalControlState>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<ExternalControlCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        app.add_systems(Update, handle_external_control_commands);
        app
    }

    /// Registers and submits one command to the app.
    fn submit(app: &mut App, command: ExternalControlCommand) {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("external control command should register");
        app.world_mut().write_message(envelope);
    }

    /// Verifies new preferences are stored only on hosts with a native listener, and that the
    /// command succeeds either way.
    #[test]
    fn settings_apply_only_where_a_listener_exists() {
        let mut app = command_app();
        let settings = ExternalControlSettings {
            enabled: true,
            interface: Some("lan".into()),
        };
        submit(
            &mut app,
            ExternalControlCommand::SetSettings(settings.clone()),
        );
        app.update();
        assert_eq!(
            app.world().resource::<ExternalControlState>().settings,
            ExternalControlSettings::default()
        );

        app.world_mut()
            .resource_mut::<ExternalControlState>()
            .available = true;
        submit(
            &mut app,
            ExternalControlCommand::SetSettings(settings.clone()),
        );
        app.update();
        assert_eq!(
            app.world().resource::<ExternalControlState>().settings,
            settings
        );
        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert!(
            results
                .iter()
                .all(|result| result.outcome == CommandOutcome::succeeded())
        );
    }
}
