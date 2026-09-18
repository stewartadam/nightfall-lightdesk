// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Stale runtime entity reconciliation before timeline seek materialization.

use super::*;

/// Query filter selecting released materialized sequence instances.
type TimelineSequenceReleaseFilter = (With<MaterializedSequence>, With<ReleaseMarker>);

/// Query over released sequence playback clocks that may require stale cleanup.
type TimelineSequenceReleaseQuery<'w, 's> =
    Query<'w, 's, (Entity, &'static InstanceClock), TimelineSequenceReleaseFilter>;

/// Runtime queries used to reconcile stale instance before materialization.
#[derive(SystemParam)]
pub struct TimelineSeekReconciliationParams<'w, 's> {
    /// Clips whose runtime instance ownership may need reconciliation.
    pub(super) exec_query: Query<'w, 's, (Entity, &'static Clip)>,
    /// Playback entities indexed by runtime instance ID for direct cleanup.
    pub(super) instance_ids: Query<'w, 's, (Entity, &'static InstanceId)>,
    /// Materialized clip links used to detach stale direct playback.
    pub(super) materialized_clip_links: Query<'w, 's, (Entity, &'static MaterializedClip)>,
    /// Timeline-sourced sequence releases that may have lost timeline tracking.
    pub(super) timeline_sequence_releases: TimelineSequenceReleaseQuery<'w, 's>,
}

/// Mutable entity ownership accumulated across reconciliation and materialization stages.
pub(super) struct TimelineReconciliationState {
    /// Clips that remain active after stale state is reconciled.
    pub(super) active_clip_entities: HashSet<Entity>,
    /// Authored owners that had clip tracking before reconstruction.
    pub(super) existing_spawned_clip_owners: HashSet<(String, String)>,
    /// Clips still scheduled for a queued stop instead of direct replacement.
    pub(super) queued_clip_cleanup_entities: HashSet<Entity>,
    /// Runtime entities that should be committed back to timeline ownership tracking.
    pub(super) tracked_spawned_entities: HashMap<Entity, (String, String, SpawnedEntityType)>,
    /// Active start owners retained across mutation reconstruction.
    pub(super) preserved_active_start_owners: HashSet<(String, String)>,
    /// Fire-cue owners retained across mutation reconstruction.
    pub(super) preserved_fire_cue_owners: HashSet<(String, String)>,
    /// Authored owners whose deterministic playback was materialized directly.
    pub(super) direct_materialized_actions: HashSet<(String, String)>,
    /// Clips whose rate was restored as part of direct materialization.
    pub(super) direct_materialized_clip_uids: HashSet<Uuid>,
}

/// Returns the authored clip owners present in a spawned-entity snapshot.
fn existing_spawned_clip_owners(
    spawned_entities: &HashMap<Entity, (String, String, SpawnedEntityType)>,
) -> HashSet<(String, String)> {
    spawned_entities
        .values()
        .filter_map(|(track_id, action_id, spawn_type)| {
            matches!(spawn_type, SpawnedEntityType::Clip)
                .then_some((track_id.clone(), action_id.clone()))
        })
        .collect()
}

/// Returns clip entities that require cleanup unless a later branch preserves them.
fn queued_clip_cleanup_entities(
    spawned_entities: &HashMap<Entity, (String, String, SpawnedEntityType)>,
) -> HashSet<Entity> {
    spawned_entities
        .iter()
        .filter_map(|(entity, (_, _, spawn_type))| {
            matches!(spawn_type, SpawnedEntityType::Clip).then_some(*entity)
        })
        .collect()
}

/// Despawns release instances that still belong to this timeline but lost timeline tracking.
fn despawn_untracked_timeline_sequence_releases(
    commands: &mut Commands,
    timeline_sequence_releases: &TimelineSequenceReleaseQuery,
    tracked_entities: &HashMap<Entity, (String, String, SpawnedEntityType)>,
    timeline_uid: Uuid,
) {
    for (entity, clock) in timeline_sequence_releases.iter() {
        if tracked_entities.contains_key(&entity) {
            continue;
        }
        if matches!(
            clock.source,
            InstanceClockSource::Timeline {
                timeline_uid: source_timeline_uid,
                ..
            } if source_timeline_uid == timeline_uid
        ) {
            commands.entity(entity).despawn();
        }
    }
}

/// Reconciles timeline-owned runtime entities against the deterministic target plan.
pub(super) fn reconcile_timeline_runtime_entities(
    timeline: &mut MaterializedTimeline,
    reason: TimelineReconstructionReason,
    plan: &TimelineReconstructionPlan,
    params: &TimelineSeekReconciliationParams,
    dispatch: &mut TimelineSeekDispatch,
    commands: &mut Commands,
) -> TimelineReconciliationState {
    let mut active_clip_entities =
        active_clip_entities(&params.exec_query, &params.materialized_clip_links);
    let old_spawned_entities = timeline.spawned_entities.clone();
    let existing_spawned_clip_owners = existing_spawned_clip_owners(&old_spawned_entities);
    let mut queued_clip_cleanup_entities = queued_clip_cleanup_entities(&old_spawned_entities);
    let mut tracked_spawned_entities = HashMap::new();
    let mut preserved_active_start_owners = HashSet::new();
    let mut preserved_fire_cue_owners = HashSet::new();

    for (entity, (track_id, action_id, spawn_type)) in &timeline.spawned_entities {
        let owner = (track_id.clone(), action_id.clone());
        match spawn_type {
            SpawnedEntityType::Clip => {
                tracing::debug!(
                    "Cleaning up clip from timeline track={} action={}",
                    track_id,
                    action_id
                );
                if let Ok((_, clip)) = params.exec_query.get(*entity) {
                    let has_materialized_clip_link =
                        params
                            .materialized_clip_links
                            .iter()
                            .any(|(_, materialized_clip)| {
                                materialized_clip.clip_id == clip.identifiers.id
                            });
                    if matches!(reason, TimelineReconstructionReason::ActionsChanged)
                        && plan.active_start_owners.contains(&owner)
                        && active_start_timing_changed(
                            &timeline.triggered_actions,
                            &plan.active_start_positions,
                            &owner,
                        )
                        && has_materialized_clip_link
                    {
                        despawn_clip_playback_links(
                            commands,
                            &params.materialized_clip_links,
                            &params.instance_ids,
                            clip.identifiers.id,
                            false,
                        );
                        queued_clip_cleanup_entities.remove(entity);
                        active_clip_entities.remove(entity);
                        continue;
                    }
                    if matches!(reason, TimelineReconstructionReason::ActionsChanged)
                        && (plan.target_playback_clip_entities.contains(entity)
                            || plan.active_start_owners.contains(&owner))
                    {
                        track_timeline_clip_entity(
                            &mut tracked_spawned_entities,
                            &mut active_clip_entities,
                            *entity,
                            track_id,
                            action_id,
                        );
                        queued_clip_cleanup_entities.remove(entity);
                        preserved_active_start_owners.insert(owner);
                        continue;
                    }
                    let is_timeline_sequence_start_clip = plan
                        .timeline_start_clip_owners
                        .contains(&(track_id.clone(), action_id.clone()))
                        && matches!(clip.source, Some(Source::Sequence(_)));
                    if plan.directly_replaced_clip_entities.contains(entity) {
                        if !plan
                            .preserve_direct_playback_link_clip_entities
                            .contains(entity)
                        {
                            despawn_clip_playback_links(
                                commands,
                                &params.materialized_clip_links,
                                &params.instance_ids,
                                clip.identifiers.id,
                                false,
                            );
                        }
                        queued_clip_cleanup_entities.remove(entity);
                    } else if is_timeline_sequence_start_clip && has_materialized_clip_link {
                        let arm_auto_release = !plan.target_playback_clip_entities.contains(entity)
                            && clip.options.auto_release;
                        despawn_clip_playback_links(
                            commands,
                            &params.materialized_clip_links,
                            &params.instance_ids,
                            clip.identifiers.id,
                            arm_auto_release,
                        );
                        queued_clip_cleanup_entities.remove(entity);
                    } else {
                        write_timeline_clip_action(
                            &mut dispatch.ev_clip,
                            &mut dispatch.timeline_command_origins,
                            ClipAction::Stop(IdExpr::Single(clip.identifiers.id)),
                        );
                    }
                }
                active_clip_entities.remove(entity);
            }
            SpawnedEntityType::Cue => {
                tracing::debug!(
                    "Releasing cue from timeline track={} action={}",
                    track_id,
                    action_id
                );
                if matches!(reason, TimelineReconstructionReason::ActionsChanged)
                    && plan.desired_fire_cue_owners.contains(&owner)
                {
                    tracked_spawned_entities.insert(
                        *entity,
                        (track_id.clone(), action_id.clone(), SpawnedEntityType::Cue),
                    );
                    preserved_fire_cue_owners.insert(owner);
                    continue;
                }
                commands.entity(*entity).insert(ReleaseMarker::default());
            }
            SpawnedEntityType::Instance => {
                tracing::debug!(
                    "Despawning planner materialized instance from timeline track={} action={}",
                    track_id,
                    action_id
                );
                commands.entity(*entity).despawn();
            }
        }
    }
    despawn_untracked_timeline_sequence_releases(
        commands,
        &params.timeline_sequence_releases,
        &old_spawned_entities,
        timeline.timeline.identifiers.uid,
    );
    timeline.spawned_entities.clear();

    TimelineReconciliationState {
        active_clip_entities,
        existing_spawned_clip_owners,
        queued_clip_cleanup_entities,
        tracked_spawned_entities,
        preserved_active_start_owners,
        preserved_fire_cue_owners,
        direct_materialized_actions: HashSet::new(),
        direct_materialized_clip_uids: HashSet::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies reconciliation indexes only classify clip-owned spawned entities.
    #[test]
    fn reconciliation_indexes_only_include_clip_tracking() {
        let clip = Entity::from_bits(1);
        let cue = Entity::from_bits(2);
        let playback = Entity::from_bits(3);
        let spawned = HashMap::from([
            (
                clip,
                (
                    "track-a".to_owned(),
                    "clip-action".to_owned(),
                    SpawnedEntityType::Clip,
                ),
            ),
            (
                cue,
                (
                    "track-a".to_owned(),
                    "cue-action".to_owned(),
                    SpawnedEntityType::Cue,
                ),
            ),
            (
                playback,
                (
                    "track-a".to_owned(),
                    "playback-action".to_owned(),
                    SpawnedEntityType::Instance,
                ),
            ),
        ]);

        assert_eq!(
            existing_spawned_clip_owners(&spawned),
            HashSet::from([("track-a".to_owned(), "clip-action".to_owned())])
        );
        assert_eq!(
            queued_clip_cleanup_entities(&spawned),
            HashSet::from([clip])
        );
    }
}
