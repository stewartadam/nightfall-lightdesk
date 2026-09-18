// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! System for processing scheduled commands (sleep/delay functionality)

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;

/// Process commands from the scheduled queue whose time has arrived.
///
/// This system runs early in EventHandling to move scheduled commands
/// into PendingCommandBuffer when their scheduled time is reached.
pub fn process_scheduled_commands(
    mut scheduled: ResMut<DelayedCommandQueue>,
    mut pending: ResMut<PendingCommandBuffer>,
    mut responder: CommandResponder,
) {
    let ready_commands = scheduled.take_ready();
    let ready_completions = scheduled.take_ready_completions();

    if !ready_commands.is_empty() {
        tracing::debug!("Processing {} scheduled commands", ready_commands.len());
        for cmd in ready_commands {
            pending.push(cmd);
        }
    }

    for command_id in ready_completions {
        if let Err(error) = responder.succeed(command_id) {
            tracing::error!(%command_id, %error, "delayed_command_finish_failed");
        }
    }
}
