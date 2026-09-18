// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Instruction removal by stable programmer instruction identity.

use super::*;

/// Handles remove instruction by UUID events
pub fn handle_remove_instruction_events(
    mut events_reader: MessageReader<
        EngineActionEnvelope<crate::undo::RemoveProgrammerInstructionByUuid>,
    >,
    mut programmer: ResMut<Programmer>,
    mut responder: CommandResponder,
) {
    for event in events_reader.read() {
        let uuid = event.action.uuid;
        tracing::debug!("Removing programmer instruction by UUID: {}", uuid);

        // Try to remove from live instructions first, then blind
        if programmer.live_instructions.remove(&uuid).is_none() {
            programmer.blind_instructions.remove(&uuid);
        }

        if programmer.live_instructions.is_empty() && programmer.blind_instructions.is_empty() {
            programmer.clear_recalled_cue_timing_defaults();
        }
        if let Some(command_id) = event.command_id
            && let Err(error) = responder.succeed(command_id)
        {
            tracing::error!(%command_id, %error, "programmer_remove_completion_failed");
        }
    }
}
