// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Inbound command deserialization, routing, and outbound command echoes.

use super::*;

/// Forward clip commands to UI via broadcaster
///
/// Note: RenameClip is intentionally NOT forwarded here because the command
/// echo would be sent before we know if the rename succeeded. Instead, we rely
/// on send_clips_on_clip_change to send full definitions after changes.
pub fn forward_clip_commands(
    mut events: MessageReader<CommandEnvelope<ClipCommand>>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        if matches!(event.command, ClipCommand::DeleteClip(..)) {
            tracing::trace!(?event, "Forwarding ClipCommand to UI");
            broadcaster.publish(
                DISCRIMINATOR_NON_DROPPABLE,
                &DeskWsMessage::ClipCommand(&event.command),
            );
        }
    }
}

/// Forward selected desk commands to UI via broadcaster.
///
/// Currently only SetLogLevel is forwarded so CLI log-level changes can update
/// both backend tracing and the UI logger configuration.
pub fn forward_desk_commands(
    mut events: MessageReader<CommandEnvelope<DeskCommand>>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        if matches!(event.command, DeskCommand::SetLogLevel(_)) {
            tracing::trace!(?event, "Forwarding DeskCommand to UI");
            broadcaster.publish(
                DISCRIMINATOR_NON_DROPPABLE,
                &DeskWsMessage::DeskCommand(&event.command),
            );
        }
    }
}

/// Deserializes and dispatches an untracked master level update from JSON.
pub fn deserialize_master_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: crate::masters::MasterUpdate =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse MasterUpdate: {}", e))?;

    world.write_message(update);

    Ok(())
}

/// Deserializes and dispatches an untracked fader update from JSON.
pub fn deserialize_fader_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: crate::faders::FaderUpdate =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse FaderUpdate: {}", e))?;

    world.write_message(update);

    Ok(())
}
