// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Websocket publication of masters and faders, and parsing of their untracked updates.

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall_clips::{Clip, InstanceIndex, MaterializedClip};
use nightfall_engine::prelude::*;
use nightfall_instances::InstanceControls;
use serde::Serialize;
use serde_json::Value;

use crate::faders::{FaderSnapshot, FaderUpdate, Faders, HeldButtonEffects};
use crate::masters::{Master, MasterUpdate};

/// Master and fader messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum ControlsWsMessage<'a> {
    /// Definition of all masters
    MasterDefinitions(&'a [Master]),
    /// Backend-owned fader state
    Faders(&'a [FaderSnapshot]),
}

/// Sends every master definition to clients.
fn send_masters(masters: &DataProvider<Master>, broadcaster: &ClientEventSink) {
    let masters: Vec<Master> = masters.iter().map(|entry| entry.value().clone()).collect();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ControlsWsMessage::MasterDefinitions(&masters),
    );
    tracing::trace!("Sending master definitions to websocket clients");
}

/// Publishes master definitions when they change.
pub fn send_masters_on_change(
    masters: Res<DataProvider<Master>>,
    broadcaster: Res<ClientEventSink>,
) {
    if masters.is_changed() {
        send_masters(&masters, &broadcaster);
    }
}

/// State a fader snapshot is built from.
#[derive(SystemParam)]
pub struct FaderSnapshotParams<'w, 's> {
    faders: Res<'w, Faders>,
    masters: Res<'w, DataProvider<Master>>,
    clips: Query<'w, 's, &'static Clip>,
    materialized_clips: Query<'w, 's, &'static MaterializedClip>,
    instance_index: Res<'w, InstanceIndex>,
    controls: Query<'w, 's, &'static InstanceControls>,
    held_buttons: Res<'w, HeldButtonEffects>,
}

impl FaderSnapshotParams<'_, '_> {
    /// Sends every fader's backend-owned state to clients.
    fn send(&self, broadcaster: &ClientEventSink) {
        let snapshots = self.faders.snapshots(
            &self.clips,
            &self.masters,
            &self.materialized_clips,
            &self.instance_index,
            &self.controls,
            &self.held_buttons,
        );
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ControlsWsMessage::Faders(&snapshots),
        );
        tracing::trace!("Sending {} faders to websocket clients", snapshots.len());
    }
}

/// Publishes faders when their own state or the playback state they show changes.
///
/// Runs where clip removals are still visible, so a fader whose clip stopped is resent.
pub fn send_faders_on_change(
    faders: FaderSnapshotParams,
    added_materialized_clips: Query<(), Added<MaterializedClip>>,
    mut removed_materialized_clips: RemovedComponents<MaterializedClip>,
    changed_instance_controls: Query<(), Changed<InstanceControls>>,
    broadcaster: Res<ClientEventSink>,
) {
    let materialized_removed = !removed_materialized_clips.is_empty();
    removed_materialized_clips.clear();
    let materialized_changed = !added_materialized_clips.is_empty() || materialized_removed;

    if !faders.faders.is_changed()
        && !faders.masters.is_changed()
        && changed_instance_controls.is_empty()
        && !materialized_changed
        && !faders.held_buttons.is_changed()
    {
        return;
    }
    faders.send(&broadcaster);
}

/// Sends masters and faders to a client that asked for a full resync.
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    masters: Res<DataProvider<Master>>,
    faders: FaderSnapshotParams,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };
    send_masters(&masters, &broadcaster);
    faders.send(&broadcaster);
}

/// Deserializes and dispatches an untracked master level update from JSON.
pub fn deserialize_master_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: MasterUpdate =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse MasterUpdate: {}", e))?;
    world.write_message(update);
    Ok(())
}

/// Deserializes and dispatches an untracked fader update from JSON.
pub fn deserialize_fader_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: FaderUpdate =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse FaderUpdate: {}", e))?;
    world.write_message(update);
    Ok(())
}
