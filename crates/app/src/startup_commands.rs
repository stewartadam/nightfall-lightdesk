// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy::prelude::{App, Messages};
use nightfall_desk::prelude::DeskCommand;
use nightfall_engine::prelude::{CommandEnvelope, CommandOrigin, CommandTracker, ReplyTarget};

pub(super) const STARTUP_CMDS_ENV: &str = "NIGHTFALL_STARTUP_CMDS";

/// Read command string from stdin if input is piped
pub fn get_stdin() -> Option<String> {
    use std::io::BufRead;
    use std::io::IsTerminal;

    if IsTerminal::is_terminal(&std::io::stdin()) {
        return None;
    }

    let input = std::io::stdin()
        .lock()
        .lines()
        .map_while(Result::ok)
        .collect::<Vec<_>>()
        .join("");

    normalize_command_input(input)
}

/// Trim command input and discard blank values.
pub(super) fn normalize_command_input(input: String) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Enqueue a startup command through the same `DeskCommand::Eval` path as runtime input.
pub(super) fn queue_startup_command(bevy_app: &mut App, source: &str, cmd_str: String) {
    tracing::info!(source, command = %cmd_str, "Queueing startup command");

    let eval_event = CommandEnvelope::new(
        DeskCommand::Eval(cmd_str),
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    );
    if let Err(error) = bevy_app
        .world_mut()
        .resource_mut::<CommandTracker>()
        .register(&eval_event)
    {
        tracing::error!(source, %error, "Failed to register startup command");
        return;
    }

    if let Some(mut writer) = bevy_app
        .world_mut()
        .get_resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
    {
        writer.write(eval_event);
    } else {
        tracing::error!(
            source,
            "Failed to get DeskCommand message writer for startup command"
        );
    }
}
