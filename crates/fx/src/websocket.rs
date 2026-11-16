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
use bevy_ecs::system::SystemParam;
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
/// the operation succeeded. Instead, we rely on [`FxFeed`] to send
/// full definitions after changes.
pub fn forward_fx_commands(
    mut events: MessageReader<CommandEnvelope<FxCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    // Drain the events to avoid them accumulating
    for _event in events.read() {
        // CRUD commands are not forwarded; FxFeed sends the definitions instead
    }
}

/// The FX definitions feed.
#[derive(SystemParam)]
pub(crate) struct FxFeed<'w> {
    fx: Res<'w, DataProvider<Fx>>,
}

impl ClientFeed for FxFeed<'static> {
    /// Publishes every FX definition.
    fn publish(feed: &FxFeed<'_>, sink: &ClientEventSink) {
        let fx_list: Vec<Fx> = feed.fx.iter().map(|entry| entry.value().clone()).collect();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &FxWsMessage::FxDefinitions(&fx_list),
        );
    }
}

/// The step FX definitions feed.
#[derive(SystemParam)]
pub(crate) struct StepFxFeed<'w, 's> {
    step_fx: Query<'w, 's, &'static StepFx>,
}

impl ClientFeed for StepFxFeed<'static, 'static> {
    /// Publishes every step FX definition.
    fn publish(feed: &StepFxFeed<'_, '_>, sink: &ClientEventSink) {
        let step_fx_list: Vec<StepFx> = feed.step_fx.iter().cloned().collect();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &FxWsMessage::StepFxDefinitions(&step_fx_list),
        );
    }
}

/// Run condition that passes when a step FX entity is added, edited or removed, consuming the
/// removals so one removal does not pass next update too.
pub(crate) fn step_fx_changed(
    changed_step_fx: Query<(), Changed<StepFx>>,
    mut removed_step_fx: RemovedComponents<StepFx>,
) -> bool {
    let removed = removed_step_fx.read().count() > 0;
    removed || !changed_step_fx.is_empty()
}
