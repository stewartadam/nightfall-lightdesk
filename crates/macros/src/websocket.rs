// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Websocket ingress for macro commands and publication of macros and their live runs.

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::command::MacroCommand;
use crate::runner::{MacroRunStatus, MacroRuns};

/// Macro messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum MacroWsMessage<'a> {
    /// Every macro definition.
    MacroDefinitions(&'a [Macro]),
    /// Every running macro body and the statement it is on.
    MacroRunStates(&'a [MacroRunStatus]),
}

/// Deserializes a macro command from a client and queues it for undo capture and dispatch.
pub fn deserialize_macro_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: MacroCommand = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse MacroCommand: {error}"))?;
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
    Ok(())
}

/// Collects macro definitions in ID order.
fn sorted_macros(macros: &DataProvider<Macro>) -> Vec<Macro> {
    let mut macros: Vec<Macro> = macros.iter().map(|entry| entry.value().clone()).collect();
    macros.sort_by_key(|definition| definition.identifiers.id);
    macros
}

/// Sends every macro definition to all clients.
fn send_macros(macros: &DataProvider<Macro>, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MacroWsMessage::MacroDefinitions(&sorted_macros(macros)),
    );
}

/// Publishes macro definitions when they change.
pub fn send_macros_on_change(macros: Res<DataProvider<Macro>>, broadcaster: Res<ClientEventSink>) {
    if macros.is_changed() {
        send_macros(&macros, &broadcaster);
    }
}

/// Publishes live runs when a run starts, moves to another statement or ends.
pub fn send_macro_runs_on_change(
    runs: Res<MacroRuns>,
    mut last_sent: Local<Option<Vec<MacroRunStatus>>>,
    broadcaster: Res<ClientEventSink>,
) {
    if !runs.is_changed() && last_sent.is_some() {
        return;
    }
    let statuses = runs.statuses();
    if last_sent.as_ref() == Some(&statuses) {
        return;
    }
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MacroWsMessage::MacroRunStates(&statuses),
    );
    *last_sent = Some(statuses);
}

/// Sends macros and live runs to clients that asked for a full resync.
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    macros: Res<DataProvider<Macro>>,
    runs: Res<MacroRuns>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };
    send_macros(&macros, &broadcaster);
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MacroWsMessage::MacroRunStates(&runs.statuses()),
    );
}
