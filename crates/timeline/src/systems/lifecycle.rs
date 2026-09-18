// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::planner_adapter::*;
use super::*;

/// Timeline-owned release clocks waiting to detach after a stop command.
#[derive(Resource, Default)]
pub struct PendingStoppedTimelineReleaseClocks(HashSet<Uuid>);

/// Spawns a FireCue instance at an already evaluated source-local instance position.
pub(super) fn spawn_fire_cue_at_playback_position(
    commands: &mut Commands,
    cue_uid: &Uuid,
    cue_data_provider: &DataProvider<Cue>,
    color_path_data_provider: Option<&DataProvider<ColorPath>>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
    parameter_query: &Query<InstanceRef<Parameter>>,
    instance_clock_position: Option<Duration>,
    playback_source: Option<InstanceClockSource>,
    release_timing: Option<PlaybackReleaseTiming>,
) -> Option<Entity> {
    let cue = match cue_data_provider.get(*cue_uid) {
        Ok(cue) => cue,
        Err(err) => {
            tracing::warn!(
                "Failed to materialize timeline FireCue {}: {}",
                cue_uid,
                err
            );
            return None;
        }
    };
    let mut mcue = MaterializedCue::materialize_with_sources(
        &cue,
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        &parameter_query.as_readonly(),
        selection_resolver,
    );
    if let Some(release_timing) = release_timing {
        mcue.release_with_ltp_hold_at_playback_position(
            fixture_data_provider,
            &parameter_query.as_readonly(),
            Some(release_timing.released_at),
        );
    }
    let instance_clock = instance_clock_position
        .map(|position| {
            let mut clock = InstanceClock {
                source: playback_source.unwrap_or(InstanceClockSource::ExternalPosition),
                ..Default::default()
            };
            clock.seek_to(position);
            clock
        })
        .unwrap_or_default();
    let marker = ObjectRefMarker(ObjectRef::ByUid {
        object_type: ObjectType::Cue,
        uid: *cue_uid,
    });

    let mut entity_commands = commands.spawn((mcue, marker, instance_clock));
    if let Some(release_timing) = release_timing {
        entity_commands.insert((ReleaseMarker::default(), release_timing));
    }

    Some(entity_commands.id())
}

/// Materializes an evaluated FireCue instance state into ECS state.
pub(super) fn materialize_evaluated_fire_cue(
    commands: &mut Commands,
    instance: &EvaluatedInstanceState,
    timeline_uid: Uuid,
    cue_data_provider: &DataProvider<Cue>,
    color_path_data_provider: Option<&DataProvider<ColorPath>>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
    parameter_query: &Query<InstanceRef<Parameter>>,
) -> Option<Entity> {
    let PlannedPlaybackSource::Cue(cue_uid) = instance.source else {
        return None;
    };
    let release_timing = instance
        .release_snapshot_position
        .map(|released_at| PlaybackReleaseTiming { released_at });
    spawn_fire_cue_at_playback_position(
        commands,
        &cue_uid,
        cue_data_provider,
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        selection_resolver,
        parameter_query,
        Some(instance.instance_clock_position),
        Some(timeline_instance_clock_source(
            timeline_uid,
            instance.started_at_timeline,
        )),
        release_timing,
    )
}

pub(super) fn resolve_clip_entity_and_id(
    clip_lookup: &ClipLookupSnapshot,
    clip_uid: &Uuid,
    context: &str,
) -> Option<(Entity, u32)> {
    match clip_lookup.by_uid(*clip_uid) {
        Ok((entity, clip)) => Some((entity, clip.identifiers.id)),
        Err(error) => {
            tracing::warn!(
                context,
                clip_uid = %clip_uid,
                ?error,
                "Skipping timeline action for missing clip"
            );
            None
        }
    }
}

/// Returns clip entities that currently have materialized clip instance.
pub(super) fn active_clip_entities(
    exec_query: &Query<(Entity, &Clip)>,
    materialized_clips: &Query<(Entity, &MaterializedClip)>,
) -> HashSet<Entity> {
    let active_clip_ids: HashSet<u32> = materialized_clips
        .iter()
        .map(|(_, mexec)| mexec.clip_id)
        .collect();
    exec_query
        .iter()
        .filter_map(|(entity, clip)| {
            active_clip_ids
                .contains(&clip.identifiers.id)
                .then_some(entity)
        })
        .collect()
}

/// Directly removes the current instance link for a clip during seek reconstruction.
pub(super) fn despawn_clip_playback_links(
    commands: &mut Commands,
    materialized_clip_links: &Query<(Entity, &MaterializedClip)>,
    instance_ids: &Query<(Entity, &InstanceId)>,
    clip_id: u32,
    arm_auto_release: bool,
) {
    for (materialized_clip_entity, materialized_clip) in materialized_clip_links
        .iter()
        .filter(|(_, materialized_clip)| materialized_clip.clip_id == clip_id)
    {
        if arm_auto_release {
            commands.spawn(ClipReleaseAfterInstance {
                clip_id: materialized_clip.clip_id,
                attached_instance: materialized_clip.attached_instance,
            });
        }
        if let Some((playback_entity, _)) = instance_ids
            .iter()
            .find(|(_, instance_id)| **instance_id == materialized_clip.attached_instance)
        {
            commands.entity(playback_entity).despawn();
        }
        commands.entity(materialized_clip_entity).despawn();
    }
}

/// Returns timecode UIDs whose follow-timecode timelines should perform stop cleanup.
fn stopped_timecode_uids_from_timecode_events(
    events: &mut MessageReader<TimecodeEvent>,
    timecode_uid_by_id: &HashMap<u32, Uuid>,
) -> HashSet<Uuid> {
    let mut stopped_timecode_uids = HashSet::new();
    for event in events.read() {
        if let TimecodeEvent::Stopped(id) = event {
            if let Some(timecode_uid) = timecode_uid_by_id.get(id) {
                stopped_timecode_uids.insert(*timecode_uid);
            }
        }
    }
    stopped_timecode_uids
}

/// Returns timeline IDs that received an explicit stop command this frame.
fn stopped_timeline_ids_from_timeline_events(
    events: &mut MessageReader<CommandEnvelope<TimelineCommand>>,
) -> HashSet<u32> {
    let mut stopped_timeline_ids = HashSet::new();
    for event in events.read() {
        if let TimelineCommand::StopTimeline(id) = &event.command {
            stopped_timeline_ids.insert(*id);
        }
    }
    stopped_timeline_ids
}

/// Returns timeline IDs that received an internal stop action this frame.
fn stopped_timeline_ids_from_actions(
    actions: &mut MessageReader<EngineActionEnvelope<TimelineAction>>,
) -> HashSet<u32> {
    actions
        .read()
        .filter_map(|event| match event.action {
            TimelineAction::Stop(id) => Some(id),
            TimelineAction::Start(_) | TimelineAction::InsertRecordedActions { .. } => None,
        })
        .collect()
}

/// Returns whether a timeline should run stop cleanup for the collected stop signals.
fn timeline_matches_stop_signal(
    timeline: &MaterializedTimeline,
    stopped_timecode_uids: &HashSet<Uuid>,
    stopped_timeline_ids: &HashSet<u32>,
) -> bool {
    stopped_timecode_uids.contains(&timeline.timeline.timecode_uid)
        || stopped_timeline_ids.contains(&timeline.timeline.identifiers.id)
}

pub fn reset_timeline_triggers_system(
    mut timecode_events: MessageReader<TimecodeEvent>,
    mut timeline_events: MessageReader<CommandEnvelope<TimelineCommand>>,
    mut timeline_actions: MessageReader<EngineActionEnvelope<TimelineAction>>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
) {
    let timecode_uid_by_id = timecode_uid_by_id(&timecode_query);
    let stopped_timecode_uids =
        stopped_timecode_uids_from_timecode_events(&mut timecode_events, &timecode_uid_by_id);
    let mut stopped_timeline_ids = stopped_timeline_ids_from_timeline_events(&mut timeline_events);
    stopped_timeline_ids.extend(stopped_timeline_ids_from_actions(&mut timeline_actions));
    for (_, mut timeline) in timeline_query.iter_mut() {
        if timeline_matches_stop_signal(&timeline, &stopped_timecode_uids, &stopped_timeline_ids)
            && timeline.timeline.stop_behavior == TimelineStopBehavior::ResetAndReleaseOwnedActions
        {
            timeline.reset_action_triggers();
            tracing::debug!(
                "Reset action triggers for timeline {}",
                timeline.timeline.identifiers.id
            );
        }
    }
}

/// Records timelines whose driving timecode received a stop command.
pub fn record_stopped_timeline_release_clocks(
    mut timecode_events: MessageReader<TimecodeEvent>,
    mut timeline_events: MessageReader<CommandEnvelope<TimelineCommand>>,
    mut timeline_actions: MessageReader<EngineActionEnvelope<TimelineAction>>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    timeline_query: Query<&MaterializedTimeline>,
    mut pending_detaches: ResMut<PendingStoppedTimelineReleaseClocks>,
) {
    let timecode_uid_by_id = timecode_uid_by_id(&timecode_query);
    let stopped_timecode_uids =
        stopped_timecode_uids_from_timecode_events(&mut timecode_events, &timecode_uid_by_id);
    let mut stopped_timeline_ids = stopped_timeline_ids_from_timeline_events(&mut timeline_events);
    stopped_timeline_ids.extend(stopped_timeline_ids_from_actions(&mut timeline_actions));
    if stopped_timecode_uids.is_empty() && stopped_timeline_ids.is_empty() {
        return;
    }

    pending_detaches.0.extend(
        timeline_query
            .iter()
            .filter(|timeline| {
                timeline_matches_stop_signal(
                    timeline,
                    &stopped_timecode_uids,
                    &stopped_timeline_ids,
                ) && timeline.timeline.stop_behavior
                    == TimelineStopBehavior::ResetAndReleaseOwnedActions
            })
            .map(|timeline| timeline.timeline.identifiers.uid),
    );
}

/// Detaches stopped timeline-sourced release clocks once release markers are visible.
pub fn detach_stopped_timeline_release_clocks(
    mut pending_detaches: ResMut<PendingStoppedTimelineReleaseClocks>,
    mut instances: Query<(
        &mut InstanceClock,
        Option<&mut InstanceControls>,
        Option<&ReleaseMarker>,
    )>,
) {
    if pending_detaches.0.is_empty() {
        return;
    }

    let pending_timeline_uids = pending_detaches.0.clone();
    let mut timelines_still_waiting = HashSet::new();
    for (mut clock, controls, release_marker) in instances.iter_mut() {
        let InstanceClockSource::Timeline { timeline_uid, .. } = clock.source else {
            continue;
        };
        if !pending_timeline_uids.contains(&timeline_uid) {
            continue;
        }
        if release_marker.is_none() {
            timelines_still_waiting.insert(timeline_uid);
            continue;
        }

        let release_rate = controls
            .as_ref()
            .map(|controls| controls.effective_rate())
            .filter(|rate| *rate > 0.0)
            .unwrap_or(1.0);
        clock.source = InstanceClockSource::Realtime;
        clock.set_rate(release_rate);

        if let Some(mut controls) = controls {
            controls.set_rate(release_rate as f32);
        }
    }

    pending_detaches
        .0
        .retain(|timeline_uid| timelines_still_waiting.contains(timeline_uid));
}

/// Sends stop commands for clip entities owned by stopped timelines before event consumers run.
pub fn stop_timeline_owned_clips(
    timeline_query: Query<&MaterializedTimeline>,
    mut timecode_events: MessageReader<TimecodeEvent>,
    mut timeline_events: MessageReader<CommandEnvelope<TimelineCommand>>,
    mut timeline_actions: MessageReader<EngineActionEnvelope<TimelineAction>>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    mut ev_clip: MessageWriter<EngineActionEnvelope<ClipAction>>,
    mut timeline_command_origins: ResMut<TimelineCommandOrigins>,
    clip_query: Query<&Clip>,
) {
    use crate::components::SpawnedEntityType;

    let timecode_uid_by_id = timecode_uid_by_id(&timecode_query);
    let stopped_timecode_uids =
        stopped_timecode_uids_from_timecode_events(&mut timecode_events, &timecode_uid_by_id);
    let mut stopped_timeline_ids = stopped_timeline_ids_from_timeline_events(&mut timeline_events);
    stopped_timeline_ids.extend(stopped_timeline_ids_from_actions(&mut timeline_actions));

    if stopped_timecode_uids.is_empty() && stopped_timeline_ids.is_empty() {
        return;
    }

    for timeline in timeline_query.iter() {
        if !timeline_matches_stop_signal(timeline, &stopped_timecode_uids, &stopped_timeline_ids)
            || timeline.timeline.stop_behavior != TimelineStopBehavior::ResetAndReleaseOwnedActions
        {
            continue;
        }

        for (entity, (track_id, action_id, spawn_type)) in &timeline.spawned_entities {
            if !matches!(spawn_type, SpawnedEntityType::Clip) {
                continue;
            }

            tracing::debug!(
                "Stopping clip from timeline track={} action={}",
                track_id,
                action_id
            );

            if let Ok(clip) = clip_query.get(*entity) {
                tracing::debug!("Sending StopClip command for clip {}", clip.identifiers.id);
                write_timeline_clip_action(
                    &mut ev_clip,
                    &mut timeline_command_origins,
                    ClipAction::Stop(IdExpr::Single(clip.identifiers.id)),
                );
            } else {
                tracing::warn!(
                    ?entity,
                    track_id,
                    action_id,
                    "Clip entity no longer exists for action"
                );
            }
        }
    }
}

/// System that cleans up entities spawned by a timeline when the timeline stops
pub fn cleanup_timeline_entities(
    mut timeline_query: Query<&mut MaterializedTimeline>,
    mut timecode_events: MessageReader<TimecodeEvent>,
    mut timeline_events: MessageReader<CommandEnvelope<TimelineCommand>>,
    mut timeline_actions: MessageReader<EngineActionEnvelope<TimelineAction>>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    mut commands: Commands,
) {
    use crate::components::SpawnedEntityType;

    let timecode_uid_by_id = timecode_uid_by_id(&timecode_query);
    let stopped_timecode_uids =
        stopped_timecode_uids_from_timecode_events(&mut timecode_events, &timecode_uid_by_id);
    let mut stopped_timeline_ids = stopped_timeline_ids_from_timeline_events(&mut timeline_events);
    stopped_timeline_ids.extend(stopped_timeline_ids_from_actions(&mut timeline_actions));

    // Release or despawn non-clip entities spawned by stopped timelines.
    if !stopped_timecode_uids.is_empty() || !stopped_timeline_ids.is_empty() {
        for mut timeline in timeline_query.iter_mut() {
            if timeline_matches_stop_signal(
                &timeline,
                &stopped_timecode_uids,
                &stopped_timeline_ids,
            ) && timeline.timeline.stop_behavior
                == TimelineStopBehavior::ResetAndReleaseOwnedActions
            {
                for (entity, (track_id, action_id, spawn_type)) in &timeline.spawned_entities {
                    match spawn_type {
                        SpawnedEntityType::Clip => {}
                        SpawnedEntityType::Cue => {
                            tracing::debug!(
                                "Releasing cue from timeline track={} action={}",
                                track_id,
                                action_id
                            );
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

                // Clear the tracking map
                timeline.spawned_entities.clear();
            }
        }
    }
}
