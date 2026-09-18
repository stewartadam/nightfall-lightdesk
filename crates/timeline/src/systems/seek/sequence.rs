// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Sequence interval materialization for deterministic timeline seek plans.

use super::*;

/// Sequence-specific dependencies used during timeline reconstruction.
#[derive(SystemParam)]
pub struct TimelineSequenceSeekMaterializer<'w, 's> {
    /// Optional sequence definitions used to rebuild planned playback intervals.
    sequence_data_provider: Option<Res<'w, DataProvider<Sequence>>>,
    /// Cue definitions referenced by reconstructed sequence steps.
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    /// Optional color paths referenced by reconstructed sequence cues.
    color_path_data_provider: Option<Res<'w, DataProvider<ColorPath>>>,
    /// Optional Blueprints referenced by reconstructed sequence cues.
    blueprint_data_provider: Option<Res<'w, DataProvider<Blueprint>>>,
    /// Fixture data used to resolve sequence cue output and durations.
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    /// Spatial resolver used to expand cue selections.
    selection_resolver: SpatialSelectionResolver<'w>,
    /// Read-only parameter instances used by active sequence reconstruction.
    parameter_query: Query<'w, 's, InstanceRef<'static, Parameter>>,
    /// Mutable parameter instances used to reconstruct released sequence output.
    parameter_mut_query: Query<'w, 's, InstanceMut<'static, Parameter>>,
    /// Clips that own reconstructed sequence playback.
    exec_query: Query<'w, 's, (Entity, &'static Clip)>,
}

/// Returns every authored action represented by one directly materialized sequence interval.
fn direct_interval_action_owners(
    interval: &nightfall_playback_planner::PlannedPlaybackInterval,
    timeline_actions_before_target: &[TimelineActionSnapshot],
    clip_uid: Uuid,
) -> HashSet<(String, String)> {
    let mut owners = HashSet::from([(
        interval.owner.track_id.clone(),
        interval.owner.action_id.clone(),
    )]);
    owners.extend(interval.explicit_interventions.iter().map(|intervention| {
        (
            intervention.owner.track_id.clone(),
            intervention.owner.action_id.clone(),
        )
    }));
    if let Some(stopped_at_timeline) = interval.stopped_at_timeline {
        owners.extend(timeline_actions_before_target.iter().filter_map(
            |(track_id, action_id, action, action_position, _)| match action {
                ActionKind::StopClip(uid)
                    if *uid == clip_uid && *action_position == stopped_at_timeline =>
                {
                    Some((track_id.clone(), action_id.clone()))
                }
                _ => None,
            },
        ));
    }
    owners
}

/// Materializes planned active and releasing sequence intervals at the reconstruction target.
pub(super) fn materialize_timeline_sequences(
    materializer: &mut TimelineSequenceSeekMaterializer,
    commands: &mut Commands,
    timeline: &MaterializedTimeline,
    plan: &TimelineReconstructionPlan,
    clip_snapshot: &ClipLookupSnapshot,
    state: &mut TimelineReconciliationState,
) {
    let materializer_registry = TimelineSeekMaterializerRegistry;
    let timeline_position = plan.timeline_plan.target_time;
    for interval in plan.timeline_plan.instances.iter().filter(|interval| {
        materializer_registry.materializes_planned_interval(
            interval.source,
            interval.lifecycle,
            interval.is_noop_at(timeline_position),
        )
    }) {
        let Some(clip_uid) = plan
            .clip_uid_by_owner
            .get(&(
                interval.owner.track_id.clone(),
                interval.owner.action_id.clone(),
            ))
            .copied()
        else {
            continue;
        };
        let Some((clip_entity, clip_id)) =
            resolve_clip_entity_and_id(clip_snapshot, &clip_uid, "seek-planned-sequence")
        else {
            continue;
        };
        let sequence_is_resolvable = || {
            let Ok((_, clip)) = materializer.exec_query.get(clip_entity) else {
                return None;
            };
            let Some(Source::Sequence(sequence_uid)) = &clip.source else {
                return None;
            };
            let sequence_data_provider = materializer.sequence_data_provider.as_ref()?;
            let Ok(sequence) = sequence_data_provider.get(*sequence_uid) else {
                return None;
            };
            sequence
                .steps
                .iter()
                .all(|cue_uid| materializer.cue_data_provider.get(cue_uid.0).is_ok())
                .then_some((clip, sequence))
        };
        let Ok((_, clip)) = materializer.exec_query.get(clip_entity) else {
            continue;
        };
        let Some(mut playback) = SequenceTimelineSeekPlayback::from_clip(
            clip_id,
            clip,
            materializer.sequence_data_provider.as_deref(),
            &materializer.cue_data_provider,
            &materializer.fixture_data_provider,
            &materializer.selection_resolver,
            interval.started_at_timeline,
        ) else {
            tracing::error!(
                clip_uid = %clip_uid,
                track_id = %interval.owner.track_id,
                action_id = %interval.owner.action_id,
                "Cannot reconstruct planned sequence seek target because sequence or cue data is incomplete"
            );
            continue;
        };
        if interval.lifecycle == PlannedPlaybackLifecycle::Releasing {
            let Some(release) = interval.release else {
                continue;
            };
            playback.apply_planned_interval_until(interval, release.source_snapshot_at_timeline);
            if !state.queued_clip_cleanup_entities.contains(&clip_entity)
                && let Some((clip, sequence)) = sequence_is_resolvable()
            {
                let target = playback.target();
                let release_timing = PlaybackReconstructionTiming::timeline_source_local(
                    interval.playback_position_at(release.released_at_timeline),
                    interval.playback_position_at(timeline_position),
                    timeline.timeline.identifiers.uid,
                    interval.started_at_timeline,
                );
                let materialized = spawn_released_reconstructed_sequence_for_clip(
                    commands,
                    clip,
                    &sequence,
                    &materializer.cue_data_provider,
                    materializer.color_path_data_provider.as_deref(),
                    materializer.blueprint_data_provider.as_deref(),
                    &materializer.fixture_data_provider,
                    &mut materializer.parameter_mut_query,
                    &materializer.parameter_query,
                    &materializer.selection_resolver,
                    target.position,
                    target.started_at,
                    release_timing,
                    None,
                );
                state.active_clip_entities.remove(&clip_entity);
                state.tracked_spawned_entities.insert(
                    materialized.sequence_entity,
                    (
                        interval.owner.track_id.clone(),
                        interval.owner.action_id.clone(),
                        SpawnedEntityType::Instance,
                    ),
                );
                state
                    .direct_materialized_actions
                    .extend(direct_interval_action_owners(
                        interval,
                        &plan.timeline_actions_before_target,
                        clip_uid,
                    ));
                state.direct_materialized_clip_uids.insert(clip_uid);
            } else {
                tracing::error!(
                    clip_uid = %clip_uid,
                    track_id = %interval.owner.track_id,
                    action_id = %interval.owner.action_id,
                    "Cannot materialize planned sequence release because sequence or cue data is incomplete"
                );
            }
            continue;
        }
        playback.apply_planned_interval_until(interval, timeline_position);
        if sequence_auto_end_release_completed(
            &playback,
            timeline_position,
            &materializer.exec_query,
            materializer.sequence_data_provider.as_deref(),
            &materializer.fixture_data_provider,
            &materializer.selection_resolver,
        ) {
            continue;
        }
        if !state.queued_clip_cleanup_entities.contains(&clip_entity)
            && let Some((clip, sequence)) = sequence_is_resolvable()
        {
            let target = playback.target();
            spawn_reconstructed_sequence_for_clip(
                commands,
                clip,
                &sequence,
                &materializer.cue_data_provider,
                materializer.color_path_data_provider.as_deref(),
                materializer.blueprint_data_provider.as_deref(),
                &materializer.fixture_data_provider,
                &materializer.parameter_query,
                &materializer.selection_resolver,
                target.position,
                PlaybackReconstructionTiming::timeline_source_local(
                    target.started_at,
                    interval.playback_position_at(timeline_position),
                    timeline.timeline.identifiers.uid,
                    interval.started_at_timeline,
                ),
                lookahead_override_for_timeline(timeline),
            );
            track_timeline_clip_entity(
                &mut state.tracked_spawned_entities,
                &mut state.active_clip_entities,
                clip_entity,
                &interval.owner.track_id,
                &interval.owner.action_id,
            );
            state
                .direct_materialized_actions
                .extend(direct_interval_action_owners(
                    interval,
                    &plan.timeline_actions_before_target,
                    clip_uid,
                ));
            state.direct_materialized_clip_uids.insert(clip_uid);
            continue;
        }
        tracing::error!(
            clip_uid = %clip_uid,
            track_id = %interval.owner.track_id,
            action_id = %interval.owner.action_id,
            "Cannot materialize planned sequence seek target because sequence or cue data is incomplete"
        );
    }
}

#[cfg(test)]
mod tests {
    use nightfall_playback_planner::{
        PlannedPlaybackInterval, PlannedPlaybackIntervention, PlannedPlaybackInterventionKind,
        TimelinePlaybackOwner,
    };

    use super::*;

    /// Builds a planner owner for focused sequence tracking tests.
    fn owner(action_id: &str) -> TimelinePlaybackOwner {
        TimelinePlaybackOwner {
            timeline_uid: Uuid::from_u128(1),
            track_id: "track-a".to_owned(),
            action_id: action_id.to_owned(),
        }
    }

    /// Verifies direct sequence materialization covers starts, interventions, and matching stops.
    #[test]
    fn direct_sequence_interval_owners_include_all_reconstructed_actions() {
        let clip_uid = Uuid::from_u128(2);
        let interval = PlannedPlaybackInterval {
            owner: owner("start"),
            source: PlannedPlaybackSource::Sequence(Uuid::from_u128(3)),
            started_at_timeline: Duration::from_secs(1),
            stopped_at_timeline: Some(Duration::from_secs(4)),
            source_local_start: Duration::ZERO,
            release: None,
            rate_changes: Vec::new(),
            explicit_interventions: vec![PlannedPlaybackIntervention {
                owner: owner("go"),
                timeline_position: Duration::from_secs(2),
                playback_position: Duration::from_secs(1),
                kind: PlannedPlaybackInterventionKind::SequenceGo,
            }],
            lifecycle: PlannedPlaybackLifecycle::Active,
        };
        let actions = vec![
            (
                "track-a".to_owned(),
                "stop".to_owned(),
                ActionKind::StopClip(clip_uid),
                Duration::from_secs(4),
                Duration::ZERO,
            ),
            (
                "track-a".to_owned(),
                "unrelated-stop".to_owned(),
                ActionKind::StopClip(Uuid::from_u128(4)),
                Duration::from_secs(4),
                Duration::ZERO,
            ),
        ];

        assert_eq!(
            direct_interval_action_owners(&interval, &actions, clip_uid),
            HashSet::from([
                ("track-a".to_owned(), "start".to_owned()),
                ("track-a".to_owned(), "go".to_owned()),
                ("track-a".to_owned(), "stop".to_owned()),
            ])
        );
    }
}
