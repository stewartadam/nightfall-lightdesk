// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;

/// Handle quit commands by requesting shutdown and emitting `AppExit`.
pub fn handle_events(
    mut showfile_save_state: super::showfile_events::ShowfileSaveState,
    current_showfile: Res<super::showfile_events::CurrentShowfile>,
    mut clean_snapshot_hash: ResMut<super::showfile_events::ShowfileCleanSnapshotHash>,
    mut events: MessageReader<CommandEnvelope<DeskCommand>>,
    mut quit_event: MessageWriter<AppExit>,
    mut responder: CommandResponder,
) {
    // Check if engine was instructed to quit
    for event in events.read() {
        if let DeskCommand::Quit = &event.command {
            tracing::info!("Requesting application shutdown");
            if let Err(error) = super::showfile_events::save_draft_showfile_if_dirty(
                &mut showfile_save_state,
                current_showfile.name(),
                &mut clean_snapshot_hash,
                &Default::default(),
            ) {
                tracing::error!("Failed to preserve showfile draft before quit: {}", error);
                if let Err(completion_error) = responder.fail(
                    event.command_id,
                    CommandError::new(
                        "app.quit_draft_failed",
                        format!("Failed to preserve showfile draft before quit: {error}"),
                    ),
                ) {
                    tracing::error!(%completion_error, "quit_command_failure_failed");
                }
                continue;
            }
            quit_event.write(AppExit::Success);
            if let Err(error) = responder.succeed(event.command_id) {
                tracing::error!(%error, "quit_command_completion_failed");
            }
        }
    }
}
