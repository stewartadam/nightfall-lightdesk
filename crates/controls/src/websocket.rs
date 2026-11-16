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
use nightfall_instances::{HeldButtonEffect, InstanceControls};
use serde::Serialize;
use serde_json::Value;

use crate::faders::{FaderSnapshot, FaderUpdate, Faders};
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

/// The master definitions feed.
#[derive(SystemParam)]
pub(crate) struct MastersFeed<'w> {
    masters: Res<'w, DataProvider<Master>>,
}

impl ClientFeed for MastersFeed<'static> {
    /// Publishes every master definition.
    fn publish(feed: &MastersFeed<'_>, sink: &ClientEventSink) {
        let masters: Vec<Master> = feed
            .masters
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ControlsWsMessage::MasterDefinitions(&masters),
        );
    }
}

/// The faders feed: every fader's backend-owned state, including the playback state it shows.
#[derive(SystemParam)]
pub struct FadersFeed<'w, 's> {
    faders: Res<'w, Faders>,
    masters: Res<'w, DataProvider<Master>>,
    clips: Query<'w, 's, &'static Clip>,
    materialized_clips: Query<'w, 's, &'static MaterializedClip>,
    instance_index: Res<'w, InstanceIndex>,
    controls: Query<'w, 's, &'static InstanceControls>,
    held_buttons: Query<'w, 's, &'static HeldButtonEffect>,
}

impl ClientFeed for FadersFeed<'static, 'static> {
    /// Publishes every fader's backend-owned state.
    fn publish(feed: &FadersFeed<'_, '_>, sink: &ClientEventSink) {
        let snapshots = feed.faders.snapshots(
            &feed.clips,
            &feed.masters,
            &feed.materialized_clips,
            &feed.instance_index,
            &feed.controls,
            &feed.held_buttons,
        );
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ControlsWsMessage::Faders(&snapshots),
        );
    }
}

/// Run condition that passes when the faders' own state or the playback state they show changes.
///
/// Every input is read on each run, so removals are consumed and none is reported twice. Runs
/// where clip removals are still visible, so a fader whose clip stopped is resent.
pub(crate) fn faders_changed(
    faders: Res<Faders>,
    masters: Res<DataProvider<Master>>,
    added_materialized_clips: Query<(), Added<MaterializedClip>>,
    mut removed_materialized_clips: RemovedComponents<MaterializedClip>,
    changed_instance_controls: Query<(), Changed<InstanceControls>>,
    changed_held_buttons: Query<(), Changed<HeldButtonEffect>>,
    mut removed_held_buttons: RemovedComponents<HeldButtonEffect>,
) -> bool {
    let materialized_removed = removed_materialized_clips.read().count() > 0;
    let held_buttons_removed = removed_held_buttons.read().count() > 0;
    faders.is_changed()
        || masters.is_changed()
        || materialized_removed
        || held_buttons_removed
        || !added_materialized_clips.is_empty()
        || !changed_instance_controls.is_empty()
        || !changed_held_buttons.is_empty()
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
