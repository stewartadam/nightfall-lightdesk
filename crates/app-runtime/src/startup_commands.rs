// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy::prelude::{App, Messages};
use nightfall_cmd_parse::split_command_script;
use nightfall_engine::prelude::{
    CommandEnvelope, CommandOrigin, CommandTracker, EngineCommand, ReplyTarget,
};

pub(super) const STARTUP_CMDS_ENV: &str = "NIGHTFALL_STARTUP_CMDS";

/// Reads the whole piped stdin as a command script, keeping its line breaks so each line
/// queues as its own statement. Invalid UTF-8 is replaced rather than discarding the script.
/// Returns `None` for an interactive terminal, unreadable input, or blank input.
pub fn get_stdin() -> Option<String> {
    use std::io::{IsTerminal, Read};

    if IsTerminal::is_terminal(&std::io::stdin()) {
        return None;
    }

    let mut input = Vec::new();
    if let Err(error) = std::io::stdin().lock().read_to_end(&mut input) {
        tracing::error!(%error, "Failed to read startup commands from stdin");
        return None;
    }

    normalize_command_input(String::from_utf8_lossy(&input).into_owned())
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

/// Enqueue startup input through the same `EngineCommand::Eval` path as runtime input.
///
/// Eval accepts exactly one statement, so input is split on line breaks and semicolons and
/// each statement is queued as its own command, in order.
pub(super) fn queue_startup_command(bevy_app: &mut App, source: &str, cmd_str: String) {
    for statement in split_command_script(&cmd_str) {
        queue_startup_statement(bevy_app, source, statement.to_owned());
    }
}

/// Enqueue one startup statement as a detached `EngineCommand::Eval`.
fn queue_startup_statement(bevy_app: &mut App, source: &str, cmd_str: String) {
    tracing::info!(source, command = %cmd_str, "Queueing startup command");

    let eval_event = CommandEnvelope::new(
        EngineCommand::Eval(cmd_str),
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
        .get_resource_mut::<Messages<CommandEnvelope<EngineCommand>>>()
    {
        writer.write(eval_event);
    } else {
        tracing::error!(
            source,
            "Failed to get EngineCommand message writer for startup command"
        );
    }
}
