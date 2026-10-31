// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for fx commands.
//!
//! This module handles self-registration with the websocket infrastructure and
//! owns all fx-related websocket forwarding logic.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::FxCommand;
use crate::events::{FxPreviewUpdate, StepFxPreviewUpdate};
use crate::fx::Fx;
use crate::step_fx::StepFx;

/// Wrapper for serializing fx messages with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum FxWsMessage<'a> {
    /// List of all fx
    FxDefinitions(&'a [Fx]),
    /// List of all step-based fx
    StepFxDefinitions(&'a [StepFx]),
}

/// Deserializes and dispatches an untracked FX preview update from JSON.
///
pub fn deserialize_fx_preview_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: FxPreviewUpdate = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse FxPreviewUpdate: {}", e))?;

    world.write_message(update);

    Ok(())
}

/// Deserializes and dispatches an untracked Step FX preview update from JSON.
pub fn deserialize_step_fx_preview_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: StepFxPreviewUpdate = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse StepFxPreviewUpdate: {error}"))?;
    world.write_message(update);
    Ok(())
}

/// Forward fx commands to the UI for reactive handling.
///
/// Note: CRUD commands (StoreFx, RenameFx, DeleteFx) are intentionally NOT
/// forwarded here because the command echo would be sent before we know if
/// the operation succeeded. Instead, we rely on send_fx_on_change to send
/// full definitions after changes.
pub fn forward_fx_commands(
    mut events: MessageReader<CommandEnvelope<FxCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    // Drain the events to avoid them accumulating
    for _event in events.read() {
        // CRUD commands are not forwarded - rely on send_fx_on_change instead
    }
}

/// Send FX definitions when DataProvider<Fx> changes.
pub fn send_fx_on_change(fx_provider: Res<DataProvider<Fx>>, broadcaster: Res<ClientEventSink>) {
    if fx_provider.is_changed() {
        send_fx(&fx_provider, &broadcaster);
    }
}

/// Send step FX definitions when step FX entities change.
pub fn send_step_fx_on_change(
    step_fx_query: Query<&StepFx>,
    changed_step_fx_query: Query<(), Changed<StepFx>>,
    mut removed_step_fx: RemovedComponents<StepFx>,
    broadcaster: Res<ClientEventSink>,
) {
    let step_fx_removed = !removed_step_fx.is_empty();
    removed_step_fx.clear();
    let has_step_fx_changes = !changed_step_fx_query.is_empty() || step_fx_removed;
    if has_step_fx_changes {
        send_step_fx(&step_fx_query, &broadcaster);
    }
}

/// Send FX list to UI on DataProvider changes.
pub fn send_fx(fx_provider: &DataProvider<Fx>, broadcaster: &ClientEventSink) {
    let fx_list: Vec<Fx> = fx_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FxWsMessage::FxDefinitions(&fx_list),
    );
    tracing::trace!("Sending fx definitions to websocket clients");
}

/// Send step FX list to UI on entity changes.
pub fn send_step_fx(step_fx_query: &Query<&StepFx>, broadcaster: &ClientEventSink) {
    let step_fx_list: Vec<StepFx> = step_fx_query.iter().cloned().collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FxWsMessage::StepFxDefinitions(&step_fx_list),
    );
    tracing::trace!("Sending step fx definitions to websocket clients");
}

/// Handle ResyncState by sending FX list immediately
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    fx_provider: Res<DataProvider<Fx>>,
    step_fx_query: Query<&StepFx>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };

    send_fx(&fx_provider, &broadcaster);
    send_step_fx(&step_fx_query, &broadcaster);
}
