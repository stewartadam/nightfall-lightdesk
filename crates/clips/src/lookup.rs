// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, hash::Hash};

use bevy_ecs::{prelude::*, system::SystemParam};
use uuid::Uuid;

use crate::Clip;

/// Failure returned when a clip identifier does not resolve uniquely.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClipLookupError {
    /// No clip has the requested identifier.
    NoEntities,
    /// More than one clip has the requested identifier.
    MultipleEntities,
}

/// Resolves persistent clip identifiers directly from ECS state.
#[derive(SystemParam)]
pub struct ClipLookup<'w, 's> {
    clips: Query<'w, 's, (Entity, &'static Clip)>,
}

/// Clip reference stored in a duplicate-aware lookup snapshot.
#[derive(Clone, Copy)]
enum ClipLookupEntry<'a> {
    Unique(Entity, &'a Clip),
    Multiple,
}

/// Per-system snapshot for resolving many clip identifiers in linear total time.
pub struct ClipLookupSnapshot<'a> {
    by_id: HashMap<u32, ClipLookupEntry<'a>>,
    by_uid: HashMap<Uuid, ClipLookupEntry<'a>>,
}

impl ClipLookup<'_, '_> {
    /// Returns the unique clip with the requested console-facing numeric ID.
    pub fn by_id(&self, id: u32) -> Result<(Entity, &Clip), ClipLookupError> {
        self.find_unique(|clip| clip.identifiers.id == id)
    }

    /// Returns the unique clip with the requested persistent UUID.
    pub fn by_uid(&self, uid: Uuid) -> Result<(Entity, &Clip), ClipLookupError> {
        self.find_unique(|clip| clip.identifiers.uid == uid)
    }

    /// Builds duplicate-aware ID and UUID maps for repeated lookups in this system invocation.
    pub fn snapshot(&self) -> ClipLookupSnapshot<'_> {
        let mut by_id = HashMap::new();
        let mut by_uid = HashMap::new();
        for (entity, clip) in self.clips.iter() {
            insert_snapshot_entry(&mut by_id, clip.identifiers.id, entity, clip);
            insert_snapshot_entry(&mut by_uid, clip.identifiers.uid, entity, clip);
        }
        ClipLookupSnapshot { by_id, by_uid }
    }

    /// Resolves exactly one clip matching the supplied identity predicate.
    fn find_unique(
        &self,
        mut matches: impl FnMut(&Clip) -> bool,
    ) -> Result<(Entity, &Clip), ClipLookupError> {
        let mut matching = self.clips.iter().filter(|(_, clip)| matches(clip));
        let Some(clip) = matching.next() else {
            return Err(ClipLookupError::NoEntities);
        };
        if matching.next().is_some() {
            return Err(ClipLookupError::MultipleEntities);
        }
        Ok(clip)
    }
}

impl ClipLookupSnapshot<'_> {
    /// Returns the unique clip with the requested console-facing numeric ID.
    pub fn by_id(&self, id: u32) -> Result<(Entity, &Clip), ClipLookupError> {
        resolve_snapshot_entry(self.by_id.get(&id))
    }

    /// Returns the unique clip with the requested persistent UUID.
    pub fn by_uid(&self, uid: Uuid) -> Result<(Entity, &Clip), ClipLookupError> {
        resolve_snapshot_entry(self.by_uid.get(&uid))
    }
}

/// Logs diagnostic context when a clip ID lookup fails.
pub fn log_clip_lookup_failure(
    clip_id: u32,
    lookup_error: impl std::fmt::Debug,
    clip_query: &Query<&Clip>,
    command: &'static str,
) {
    let mut available_clip_ids = clip_query
        .iter()
        .map(|clip| clip.identifiers.id)
        .collect::<Vec<_>>();
    available_clip_ids.sort_unstable();

    let matching_clip_uids = clip_query
        .iter()
        .filter(|clip| clip.identifiers.id == clip_id)
        .map(|clip| clip.identifiers.uid)
        .collect::<Vec<_>>();

    tracing::error!(
        clip_id,
        command,
        ?lookup_error,
        clip_count = available_clip_ids.len(),
        ?available_clip_ids,
        matching_clip_count = matching_clip_uids.len(),
        ?matching_clip_uids,
        "Failed to get clip for id"
    );
}

/// Inserts a clip into a snapshot map while retaining duplicate information.
fn insert_snapshot_entry<'a, K: Eq + Hash>(
    entries: &mut HashMap<K, ClipLookupEntry<'a>>,
    key: K,
    entity: Entity,
    clip: &'a Clip,
) {
    entries
        .entry(key)
        .and_modify(|entry| *entry = ClipLookupEntry::Multiple)
        .or_insert(ClipLookupEntry::Unique(entity, clip));
}

/// Converts a snapshot entry into the public uniqueness result.
fn resolve_snapshot_entry<'a>(
    entry: Option<&ClipLookupEntry<'a>>,
) -> Result<(Entity, &'a Clip), ClipLookupError> {
    match entry {
        Some(ClipLookupEntry::Unique(entity, clip)) => Ok((*entity, clip)),
        Some(ClipLookupEntry::Multiple) => Err(ClipLookupError::MultipleEntities),
        None => Err(ClipLookupError::NoEntities),
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use bevy_ecs::schedule::ApplyDeferred;
    use nightfall::prelude::Identifiers;

    use super::*;

    /// Result captured while exercising clip identifier lookup.
    #[derive(Default, Resource)]
    struct LookupResult {
        by_id: Option<Result<Entity, ClipLookupError>>,
        by_uid: Option<Result<Entity, ClipLookupError>>,
    }

    /// Captures numeric ID and UUID lookup results from the current ECS state.
    fn capture_lookup(mut result: ResMut<LookupResult>, lookup: ClipLookup) {
        let snapshot = lookup.snapshot();
        result.by_id = Some(snapshot.by_id(42).map(|(entity, _)| entity));
        result.by_uid = Some(
            snapshot
                .by_uid(Uuid::from_u128(42))
                .map(|(entity, _)| entity),
        );
    }

    /// Queues a clip spawn to exercise lookup after deferred commands apply.
    fn queue_clip(mut commands: Commands) {
        commands.spawn(clip(42, Uuid::from_u128(42)));
    }

    /// Builds a clip with matching numeric and persistent identifiers.
    fn clip(id: u32, uid: Uuid) -> Clip {
        Clip {
            identifiers: Identifiers {
                id,
                uid,
                label: format!("Clip {id}"),
            },
            ..Default::default()
        }
    }

    /// Verifies both identifier forms see clips created through deferred commands.
    #[test]
    fn resolves_deferred_clip_by_id_and_uid() {
        let mut app = App::new();
        app.init_resource::<LookupResult>();
        app.add_systems(Update, (queue_clip, ApplyDeferred, capture_lookup).chain());

        app.update();

        let result = app.world().resource::<LookupResult>();
        assert!(matches!(result.by_id, Some(Ok(_))));
        assert!(matches!(result.by_uid, Some(Ok(_))));
        assert_eq!(result.by_id, result.by_uid);
    }

    /// Verifies duplicate identifiers are rejected rather than resolving arbitrarily.
    #[test]
    fn rejects_duplicate_clip_identifiers() {
        let mut app = App::new();
        app.init_resource::<LookupResult>();
        app.add_systems(Update, capture_lookup);
        app.world_mut().spawn(clip(42, Uuid::from_u128(42)));
        app.world_mut().spawn(clip(42, Uuid::from_u128(42)));

        app.update();

        let result = app.world().resource::<LookupResult>();
        assert_eq!(result.by_id, Some(Err(ClipLookupError::MultipleEntities)));
        assert_eq!(result.by_uid, Some(Err(ClipLookupError::MultipleEntities)));
    }
}
