// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_instances::{
    InstanceClock, InstanceClockSource, InstanceControls, InstanceId, PlaybackAction, PlaybackScope,
};
use web_time::Instant;

use crate::clips::{Clip, MaterializedClip};

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
    pub fn get(&self, id: &InstanceId) -> Option<Entity> {
        self.0.get(id).copied()
    }

    pub fn insert(&mut self, id: InstanceId, entity: Entity) {
        self.0.insert(id, entity);
    }

    pub fn remove(&mut self, id: &InstanceId) -> Option<Entity> {
        self.0.remove(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&InstanceId, &Entity)> {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

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

/// Adds default real-time playback clocks to playback entities that do not have one yet.
pub fn add_missing_instance_clocks(
    mut commands: Commands,
    query: Query<Entity, (With<InstanceId>, Without<InstanceClock>)>,
) {
    for entity in query.iter() {
        commands.entity(entity).insert(InstanceClock::default());
    }
}

/// Advances playback clocks that are driven by wall-clock frame deltas.
pub fn advance_realtime_instance_clocks(
    mut clocks: Query<(&mut InstanceClock, Option<&InstanceControls>)>,
    mut last_update: Local<Option<Instant>>,
) {
    let now = Instant::now();
    let real_delta = last_update
        .map(|last_update| now.saturating_duration_since(last_update))
        .unwrap_or_default();
    *last_update = Some(now);

    for (mut clock, controls) in clocks.iter_mut() {
        if let Some(controls) = controls {
            clock.set_rate(controls.effective_rate());
        }

        if matches!(clock.source, InstanceClockSource::Realtime) {
            clock.advance_by_realtime_delta(real_delta);
        }
    }
}

/// System to despawn orphaned MaterializedClip entities when their playback despawns.
/// This handles the case where a playback is stopped via InstanceCommand::Stop rather than
/// ClipCommand::StopClip - the playback despawns but the separate MaterializedClip
/// entity would otherwise remain orphaned.
pub fn sync_active_state_on_instance_despawn(
    mut commands: Commands,
    instance_index: Res<InstanceIndex>,
    clips: Query<&Clip>,
    materialized_clips: Query<(Entity, &MaterializedClip)>,
    added_materialized_clips: Query<(), Added<MaterializedClip>>,
    release_watchers: Query<(Entity, &ClipReleaseAfterInstance)>,
    mut action_writer: MessageWriter<EngineActionEnvelope<PlaybackAction>>,
) {
    for (materialized_clip_entity, materialized_clip) in materialized_clips.iter() {
        if added_materialized_clips.contains(materialized_clip_entity) {
            continue;
        }

        // If the attached playback no longer exists in the index, despawn this MaterializedClip
        if instance_index
            .get(&materialized_clip.attached_instance)
            .is_none()
        {
            tracing::debug!(
                clip_id = %materialized_clip.clip_id,
                instance_id = ?materialized_clip.attached_instance,
                "Despawning orphaned MaterializedClip (playback despawned externally)"
            );
            commands.entity(materialized_clip_entity).despawn();
        }
    }

    for (watcher_entity, watcher) in release_watchers.iter() {
        if instance_index.get(&watcher.attached_instance).is_some() {
            continue;
        }

        if clips
            .iter()
            .any(|clip| clip.identifiers.id == watcher.clip_id)
        {
            action_writer.write(EngineActionEnvelope::detached(
                PlaybackAction::ReleaseParameters {
                    scope: PlaybackScope::All,
                },
            ));
        }

        tracing::debug!(
            clip_id = %watcher.clip_id,
            instance_id = ?watcher.attached_instance,
            "Despawning clip release watcher after playback despawn"
        );
        commands.entity(watcher_entity).despawn();
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::prelude::*;
    use nightfall::prelude::Identifiers;
    use nightfall_clips::ClipOptions;
    use uuid::Uuid;

    use super::*;

    /// Verifies playback index insertion, lookup, and removal behavior.
    #[test]
    fn instance_index_crud() {
        let mut index = InstanceIndex::default();
        let id = InstanceId::new();
        let entity = Entity::from_bits(42);

        assert!(index.is_empty());
        index.insert(id, entity);
        assert_eq!(index.len(), 1);
        assert_eq!(index.get(&id), Some(entity));

        let removed = index.remove(&id);
        assert_eq!(removed, Some(entity));
        assert!(index.is_empty());
    }

    /// Verifies clip release watchers emit global release after playback despawn.
    #[test]
    fn sync_active_state_emits_release_after_auto_release_playback_despawns() {
        let mut app = App::new();
        app.add_message::<EngineActionEnvelope<PlaybackAction>>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, sync_active_state_on_instance_despawn);

        let instance_id = InstanceId::new();
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id: 7,
                uid: Uuid::new_v4(),
                label: "exec-7".to_owned(),
            },
            options: ClipOptions {
                auto_release: true,
                deactivate_on_sequence_end: false,
            },
            ..Default::default()
        });
        app.world_mut().spawn(ClipReleaseAfterInstance {
            clip_id: 7,
            attached_instance: instance_id,
        });

        app.update();

        let remaining_watchers = app
            .world_mut()
            .query::<&ClipReleaseAfterInstance>()
            .iter(app.world())
            .count();
        assert_eq!(remaining_watchers, 0, "expected release watcher to despawn");

        let action_events: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<PlaybackAction>>>()
            .drain()
            .collect();
        assert!(
            action_events.iter().any(|event| {
                matches!(
                    &event.action,
                    PlaybackAction::ReleaseParameters {
                        scope: PlaybackScope::All
                    }
                )
            }),
            "expected auto_release clip to emit playback release after despawn"
        );
    }

    /// Verifies unarmed clip bindings do not emit global release after cleanup.
    #[test]
    fn sync_active_state_does_not_emit_release_without_auto_release_marker() {
        let mut app = App::new();
        app.add_message::<EngineActionEnvelope<PlaybackAction>>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, sync_active_state_on_instance_despawn);

        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id: 8,
                uid: Uuid::new_v4(),
                label: "exec-8".to_owned(),
            },
            options: ClipOptions {
                auto_release: true,
                deactivate_on_sequence_end: false,
            },
            ..Default::default()
        });
        app.world_mut().spawn(MaterializedClip {
            clip_id: 8,
            attached_instance: InstanceId::new(),
            auto_release_on_stop: false,
        });

        app.update();

        let action_events: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<PlaybackAction>>>()
            .drain()
            .collect();
        assert!(
            action_events.is_empty(),
            "expected no playback release when auto_release_on_stop is not armed"
        );
    }

    /// Verifies newly spawned clip bindings survive until InstanceIndex can observe their playback.
    #[test]
    fn sync_active_state_preserves_new_materialized_clip_before_indexing() {
        let mut app = App::new();
        app.add_message::<EngineActionEnvelope<PlaybackAction>>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, sync_active_state_on_instance_despawn);

        let instance_id = InstanceId::new();
        app.world_mut().spawn(MaterializedClip {
            clip_id: 9,
            attached_instance: instance_id,
            auto_release_on_stop: false,
        });

        app.update();

        let remaining_bindings = app
            .world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .filter(|materialized_clip| materialized_clip.attached_instance == instance_id)
            .count();
        assert_eq!(
            remaining_bindings, 1,
            "expected newly added MaterializedClip to survive its first cleanup frame"
        );

        app.update();

        let remaining_bindings = app
            .world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .filter(|materialized_clip| materialized_clip.attached_instance == instance_id)
            .count();
        assert_eq!(
            remaining_bindings, 0,
            "expected stale MaterializedClip to despawn after the added frame"
        );
    }
}
