// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Playback instance lookup and clip auto-release tracking shared by playback domains.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall_instances::InstanceId;

/// Tracks a stopped clip playback until it despawns so auto-release can run later.
#[derive(Component)]
pub struct ClipReleaseAfterInstance {
    /// Clip ID whose stopped playback is being watched.
    pub clip_id: u32,
    /// Playback that must finish releasing before auto-release runs.
    pub attached_instance: InstanceId,
}

/// Fast lookup from InstanceId to Entity, maintained on spawn/despawn
#[derive(Resource, Default)]
pub struct InstanceIndex(pub HashMap<InstanceId, Entity>);

impl InstanceIndex {
    /// Returns the entity currently hosting the playback instance, if it has been indexed.
    pub fn get(&self, id: &InstanceId) -> Option<Entity> {
        self.0.get(id).copied()
    }

    /// Records the entity hosting a playback instance, replacing any previous entry.
    pub fn insert(&mut self, id: InstanceId, entity: Entity) {
        self.0.insert(id, entity);
    }

    /// Forgets a playback instance and returns the entity it was mapped to.
    pub fn remove(&mut self, id: &InstanceId) -> Option<Entity> {
        self.0.remove(id)
    }

    /// Iterates over every indexed playback instance and its entity.
    pub fn iter(&self) -> impl Iterator<Item = (&InstanceId, &Entity)> {
        self.0.iter()
    }

    /// Returns the number of indexed playback instances.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Returns true when no playback instances are indexed.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// System to add new instances to the InstanceIndex when they spawn
pub fn add_instances_to_index(
    query: Query<(Entity, &InstanceId), Added<InstanceId>>,
    mut index: ResMut<InstanceIndex>,
) {
    for (entity, instance_id) in query.iter() {
        index.insert(*instance_id, entity);
    }
}

/// System to remove instances from the InstanceIndex when they despawn
pub fn remove_instances_from_index(
    mut removed: RemovedComponents<InstanceId>,
    mut index: ResMut<InstanceIndex>,
) {
    for entity in removed.read() {
        // We need to find which InstanceId was on this entity.
        // Since the component is already removed, we need to scan the index.
        // This is O(n) but despawns should be infrequent.
        let mut to_remove = None;
        for (id, &indexed_entity) in index.iter() {
            if indexed_entity == entity {
                to_remove = Some(*id);
                break;
            }
        }
        if let Some(id) = to_remove {
            index.remove(&id);
        }
    }
}
