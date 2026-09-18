// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Client bridge integration for engine commands.
//!
//! This module provides deserializers for all engine-related command types.
use bevy_ecs::prelude::*;
use serde_json::Value;

use crate::prelude::*;

/// Deserializes and dispatches an engine command in its admitted lifecycle context.
pub fn deserialize_engine_commands(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: EngineCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse EngineCommand: {}", e))?;

    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));

    Ok(())
}
