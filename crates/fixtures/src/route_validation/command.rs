// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command that chooses how strictly patch overlaps are validated.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use super::{RouteValidationMode, RouteValidationSettings};

/// Commands that change [`RouteValidationSettings`].
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum RouteValidationCommand {
    /// Set how strictly patch overlaps are validated.
    SetMode(RouteValidationMode),
}

impl IngressCommand for RouteValidationCommand {}

/// Applies route validation commands; these edits cannot fail.
pub(crate) fn handle_route_validation_commands(
    mut commands: MessageReader<CommandEnvelope<RouteValidationCommand>>,
    mut settings: ResMut<RouteValidationSettings>,
    mut responder: CommandResponder,
) {
    for envelope in commands.read() {
        match envelope.command {
            RouteValidationCommand::SetMode(mode) => {
                settings.mode = mode;
                tracing::debug!(?mode, "Route validation mode set");
            }
        }
        if let Err(error) = responder.succeed(envelope.command_id) {
            tracing::error!(
                command_id = %envelope.command_id,
                %error,
                "route_validation_command_completion_failed"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Verifies the mode command updates the settings and succeeds.
    #[test]
    fn set_mode_updates_settings() {
        let mut app = App::new();
        app.init_resource::<RouteValidationSettings>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<RouteValidationCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        app.add_systems(Update, handle_route_validation_commands);
        let envelope = CommandEnvelope::new(
            RouteValidationCommand::SetMode(RouteValidationMode::Permissive),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        );
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("route validation command should register");
        app.world_mut().write_message(envelope);

        app.update();

        assert_eq!(
            app.world().resource::<RouteValidationSettings>().mode,
            RouteValidationMode::Permissive
        );
        let result = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("route validation command should finish");
        assert_eq!(result.outcome, CommandOutcome::succeeded());
    }
}
