// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programmer undo restoration and delegated cue-release completion.

use super::*;

/// Handles programmer undo-related events
pub fn handle_undo_events(
    mut events_reader: MessageReader<EngineActionEnvelope<crate::undo::RestoreProgrammerState>>,
    mut operation_results: MessageReader<OperationResult<(), CommandError>>,
    mut programmer: ResMut<Programmer>,
    mut cue_lifecycle_actions: MessageWriter<EngineActionEnvelope<CueLifecycleAction>>,
    mut responder: CommandResponder,
    mut pending_cue_releases: Local<HashMap<OperationId, CommandId>>,
) {
    let completed_releases = operation_results
        .read()
        .filter_map(|result| {
            pending_cue_releases
                .remove(&result.operation_id)
                .map(|command_id| (command_id, result.result.clone()))
        })
        .collect::<Vec<_>>();
    for (command_id, result) in completed_releases {
        let response = match result {
            Ok(()) => responder.succeed(command_id),
            Err(error) => responder.fail(command_id, error),
        };
        if let Err(error) = response {
            tracing::error!(%command_id, %error, "programmer_restore_completion_failed");
        }
    }

    for event in events_reader.read() {
        tracing::debug!("Restoring programmer state");

        // Release any materialized cues from current state before clearing
        let uids = programmer
            .live_instructions
            .iter()
            .chain(programmer.blind_instructions.iter())
            .map(|(uid, _)| *uid)
            .collect::<Vec<_>>();
        let release_pending = !uids.is_empty();
        if release_pending {
            let envelope = EngineActionEnvelope::with_context(
                OperationId::new(),
                event.command_id,
                event.undo_id,
                CueLifecycleAction::ReleaseCueInstances { uids },
            );
            if let Some(command_id) = event.command_id {
                pending_cue_releases.insert(envelope.operation_id, command_id);
            }
            cue_lifecycle_actions.write(envelope);
        }

        // Clear current state
        programmer.live_instructions.clear();
        programmer.blind_instructions.clear();

        // Restore live instructions
        for (uuid, instruction) in &event.action.live_instructions {
            programmer
                .live_instructions
                .insert(*uuid, instruction.clone());
        }

        // Restore blind instructions
        for (uuid, instruction) in &event.action.blind_instructions {
            programmer
                .blind_instructions
                .insert(*uuid, instruction.clone());
        }

        // Restore mode directly (no UI update needed for mode)
        programmer.mode = event.action.mode;
        programmer.set_active_spatial_selection(event.action.active_selection.clone());
        programmer.recalled_cue_timing_defaults = event.action.recalled_cue_timing_defaults.clone();
        programmer.transition_anchor_aliases = event.action.transition_anchor_aliases.clone();
        if !release_pending
            && let Some(command_id) = event.command_id
            && let Err(error) = responder.succeed(command_id)
        {
            tracing::error!(%command_id, %error, "programmer_restore_completion_failed");
        }
    }
}
