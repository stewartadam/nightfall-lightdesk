// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::planner_adapter::{
    planned_source_for_clip, timeline_instance_clock_source, tracked_action_position,
};
use super::*;
use crate::timeline::Track;

/// Playback controls and clocks synchronized with a timeline pause state.
type TimelineInstanceControlData = (
    &'static InstanceId,
    &'static mut InstanceControls,
    Option<&'static mut InstanceClock>,
    Option<&'static Owner>,
);

/// Playback rates captured while timeline pause owns a playback-rate override.
#[derive(Resource, Default)]
pub struct TimelinePausedPlaybackRates {
    rates: HashMap<InstanceId, f32>,
    source_positions: HashMap<InstanceId, Duration>,
}

/// Query action for timeline-owned cue playback clocks.
type TimelineCueClockItem<'a> = (Entity, Option<&'a mut InstanceClock>);

/// Query filter selecting materialized cue entities for timeline pause synchronization.
type TimelineCueClockFilter = With<MaterializedCue>;

/// Synchronizes timeline-owned playback clocks from their driving timecode.
pub fn sync_timeline_paused_instance_controls_system(
    timeline_query: Query<&MaterializedTimeline>,
    timecode_query: Query<&TimecodeGenerator>,
    exec_query: Query<&Clip>,
    materialized_clips: Query<&MaterializedClip>,
    action_registry: Option<Res<ActionRegistry>>,
    mut instance_controls: Query<TimelineInstanceControlData, Without<MaterializedCue>>,
    mut materialized_cues: Query<TimelineCueClockItem<'_>, TimelineCueClockFilter>,
    mut paused_rates: ResMut<TimelinePausedPlaybackRates>,
) {
    let planner_resolver = TimelineSyncPlannerResolver {
        source_by_clip_uid: exec_query
            .iter()
            .filter_map(|clip| {
                planned_source_for_clip(clip).map(|source| (clip.identifiers.uid, source))
            })
            .collect(),
    };
    let timecode_state_by_uid: HashMap<Uuid, (bool, Duration)> = timecode_query
        .iter()
        .map(|timecode| {
            (
                timecode.timecode.identifiers.uid,
                (timecode.state.is_active, timecode.state.current_time),
            )
        })
        .collect();
    let playback_by_clip_id: HashMap<u32, InstanceId> = materialized_clips
        .iter()
        .map(|materialized_clip| {
            (
                materialized_clip.clip_id,
                materialized_clip.attached_instance,
            )
        })
        .collect();

    let mut should_pause_playback = HashMap::new();
    let mut playback_positions = HashMap::new();
    let mut reconstruction_rates = HashMap::new();
    let mut playback_source_positions = HashMap::new();
    let mut playback_sources = HashMap::new();
    let mut playback_states_by_timeline_clip_uid = HashMap::new();
    let mut timeline_positions_by_uid = HashMap::new();
    let mut should_pause_cue = HashMap::new();
    let mut cue_positions = HashMap::new();
    let mut cue_sources = HashMap::new();
    for timeline in timeline_query.iter() {
        if !timeline.is_active && timeline.spawned_entities.is_empty() {
            continue;
        }
        let Some((timecode_is_active, timecode_time)) =
            timecode_state_by_uid.get(&timeline.timeline.timecode_uid)
        else {
            continue;
        };
        let timeline_position = timeline.get_playback_position(*timecode_time);
        timeline_positions_by_uid.insert(
            timeline.timeline.identifiers.uid,
            (*timecode_is_active, timeline_position),
        );
        let planned_playback_states = planned_clip_playback_sync_states(
            timeline,
            timeline_position,
            &planner_resolver,
            action_registry.as_deref(),
        );
        for ((track_id, action_id), state) in &planned_playback_states {
            if let Some(action) = timeline
                .timeline
                .tracks
                .iter()
                .find(|track| track.id == *track_id)
                .and_then(|track| track.actions.iter().find(|action| action.id == *action_id))
                .map(|action| &action.action)
                && let Some(clip_uid) = timeline_start_clip_uid(action, action_registry.as_deref())
            {
                playback_states_by_timeline_clip_uid
                    .insert((timeline.timeline.identifiers.uid, clip_uid), state.clone());
            }
        }
        for (entity, (track_id, action_id, spawn_type)) in &timeline.spawned_entities {
            match spawn_type {
                SpawnedEntityType::Clip => {
                    let Ok(clip) = exec_query.get(*entity) else {
                        continue;
                    };
                    let Some(instance_id) = playback_by_clip_id.get(&clip.identifiers.id).copied()
                    else {
                        continue;
                    };
                    should_pause_playback
                        .entry(instance_id)
                        .and_modify(|should_pause| *should_pause |= !timecode_is_active)
                        .or_insert(!timecode_is_active);
                    if timeline.is_active
                        && let Some(action_position) =
                            tracked_action_position(timeline, track_id, action_id)
                    {
                        let source = timeline_instance_clock_source(
                            timeline.timeline.identifiers.uid,
                            action_position,
                        );
                        let playback_state_key = (track_id.clone(), action_id.clone());
                        let playback_position = planned_playback_states
                            .get(&playback_state_key)
                            .map(|state| state.position)
                            .unwrap_or_else(|| timeline_position.saturating_sub(action_position));
                        if let Some(state) = planned_playback_states.get(&playback_state_key) {
                            reconstruction_rates.insert(instance_id, state.rate);
                        }
                        playback_source_positions.insert(
                            instance_id,
                            timeline_position.saturating_sub(action_position),
                        );
                        playback_positions.insert(instance_id, playback_position);
                        playback_sources.insert(instance_id, source);
                    }
                }
                SpawnedEntityType::Cue => {
                    should_pause_cue
                        .entry(*entity)
                        .and_modify(|should_pause| *should_pause |= !timecode_is_active)
                        .or_insert(!timecode_is_active);
                    if timeline.is_active
                        && let Some(action_position) =
                            tracked_action_position(timeline, track_id, action_id)
                    {
                        let source = timeline_instance_clock_source(
                            timeline.timeline.identifiers.uid,
                            action_position,
                        );
                        cue_positions
                            .insert(*entity, timeline_position.saturating_sub(action_position));
                        cue_sources.insert(*entity, source);
                    }
                }
                SpawnedEntityType::Instance => {}
            }
        }
    }

    let mut seen_instances = HashSet::new();
    for (instance_id, mut controls, clock, owner) in instance_controls.iter_mut() {
        let mut should_pause = should_pause_playback
            .get(instance_id)
            .copied()
            .unwrap_or(false);
        let mut playback_position = playback_positions.get(instance_id).copied();
        let mut playback_source_position = playback_source_positions.get(instance_id).copied();
        let mut playback_source = playback_sources.get(instance_id).copied();
        if playback_position.is_none()
            && let Some(clock) = clock.as_ref()
            && let InstanceClockSource::Timeline {
                timeline_uid,
                started_at_timeline,
            } = clock.source
            && let Some((timecode_is_active, timeline_position)) =
                timeline_positions_by_uid.get(&timeline_uid)
        {
            should_pause |= !timecode_is_active;
            let source_position = timeline_position.saturating_sub(started_at_timeline);
            if let Some(state) = owner.and_then(|owner| {
                playback_states_by_timeline_clip_uid.get(&(timeline_uid, owner.0))
            }) {
                playback_source_position = Some(source_position);
                reconstruction_rates.insert(*instance_id, state.rate);
                playback_source_positions.insert(*instance_id, source_position);
                playback_position = Some(state.position);
            } else {
                playback_position = Some(source_position);
            }
            playback_source = Some(clock.source);
        }
        // Reconstruct the rate property only for explicit seeks, never ordinary playback ticks.
        let reconstructing = clock
            .as_ref()
            .is_some_and(|clock| clock.discontinuity == InstanceClockDiscontinuity::Discontinuous)
            || playback_source_position.is_some_and(|position| {
                paused_rates
                    .source_positions
                    .get(instance_id)
                    .is_some_and(|previous| position < *previous)
            });
        if reconstructing && let Some(rate) = reconstruction_rates.get(instance_id) {
            controls.set_rate(*rate);
            if should_pause {
                paused_rates.rates.insert(*instance_id, *rate);
            }
        }
        if should_pause {
            seen_instances.insert(*instance_id);
            paused_rates
                .rates
                .entry(*instance_id)
                .or_insert(controls.rate);
            controls.set_rate(0.0);
        } else if let Some(previous_rate) = paused_rates.rates.remove(instance_id) {
            controls.set_rate(previous_rate);
        }
        if let Some(mut clock) = clock
            && let Some(position) = playback_position
        {
            clock.set_rate(controls.effective_rate());
            if let Some(source_position) = playback_source_position {
                sync_timeline_owned_instance_clock(
                    instance_id,
                    &mut clock,
                    playback_source,
                    source_position,
                    position,
                    controls.effective_rate(),
                    should_pause,
                    &mut paused_rates.source_positions,
                );
            } else {
                if let Some(source) = playback_source {
                    clock.source = source;
                }
                if should_pause {
                    clock.freeze();
                } else if clock.frozen {
                    clock.unfreeze();
                }
                clock.sync_to_external_position(position);
            }
        }
    }

    paused_rates.rates.retain(|instance_id, _| {
        seen_instances.contains(instance_id) || should_pause_playback.contains_key(instance_id)
    });
    paused_rates
        .source_positions
        .retain(|instance_id, _| playback_source_positions.contains_key(instance_id));

    for (entity, instance_clock) in materialized_cues.iter_mut() {
        let should_pause = should_pause_cue.get(&entity).copied().unwrap_or(false);
        if let Some(mut instance_clock) = instance_clock {
            if should_pause {
                instance_clock.freeze();
            } else if instance_clock.frozen {
                instance_clock.unfreeze();
            }
            if let Some(position) = cue_positions.get(&entity) {
                if let Some(source) = cue_sources.get(&entity) {
                    instance_clock.source = *source;
                }
                instance_clock.sync_to_external_position(*position);
            }
        }
    }
}

/// Advances or seeds a timeline-owned clip playback clock from raw timeline progress.
fn sync_timeline_owned_instance_clock(
    instance_id: &InstanceId,
    clock: &mut InstanceClock,
    source: Option<InstanceClockSource>,
    source_position: Duration,
    seed_position: Duration,
    final_rate: f64,
    should_pause: bool,
    source_positions: &mut HashMap<InstanceId, Duration>,
) {
    if let Some(source) = source {
        clock.source = source;
    }

    let previous_source_position = source_positions.get(instance_id).copied();
    let should_seed = previous_source_position.is_none_or(|previous| source_position < previous)
        || clock.discontinuity == InstanceClockDiscontinuity::Discontinuous;

    if should_seed {
        clock.seek_to(seed_position);
        clock.discontinuity = InstanceClockDiscontinuity::Continuous;
    } else if !should_pause && let Some(previous_source_position) = previous_source_position {
        clock.set_rate(final_rate);
        clock.advance_by_source_delta(source_position.saturating_sub(previous_source_position));
    }

    if should_pause {
        clock.set_rate(0.0);
    } else {
        set_timeline_owned_instance_clock_rate(clock, final_rate);
    }
    source_positions.insert(*instance_id, source_position);
}

/// Applies the final timeline-owned clock rate without discarding this frame's delta.
fn set_timeline_owned_instance_clock_rate(clock: &mut InstanceClock, rate: f64) {
    let previous_position = clock.previous_position;
    let delta = clock.delta;
    let discontinuity = clock.discontinuity;
    clock.set_rate(rate);
    clock.previous_position = previous_position;
    clock.delta = delta;
    clock.discontinuity = discontinuity;
}

/// Resolver used by timeline clock sync when only clip source identity matters.
struct TimelineSyncPlannerResolver {
    source_by_clip_uid: HashMap<Uuid, PlannedPlaybackSource>,
}

impl TimelinePlaybackSourceResolver for TimelineSyncPlannerResolver {
    fn clip_source(&self, clip_uid: Uuid) -> Option<PlannedPlaybackSource> {
        self.source_by_clip_uid.get(&clip_uid).copied()
    }

    fn duration_profile(&self, _source: PlannedPlaybackSource) -> PlaybackDurationProfile {
        PlaybackDurationProfile::unknown()
    }
}

/// Timeline-owned playback state used to synchronize runtime clocks and controls.
#[derive(Clone)]
struct TimelinePlaybackSyncState {
    position: Duration,
    rate: f32,
}

/// Evaluates a timeline into source-local states for active clip-owned instances.
fn planned_clip_playback_sync_states(
    timeline: &MaterializedTimeline,
    timeline_position: Duration,
    resolver: &impl TimelinePlaybackSourceResolver,
    action_registry: Option<&ActionRegistry>,
) -> HashMap<(String, String), TimelinePlaybackSyncState> {
    plan_timeline_at(
        timeline.timeline.identifiers.uid,
        timeline_position,
        timeline_planning_actions(timeline),
        resolver,
        action_registry,
    )
    .instances
    .into_iter()
    .filter(|playback| !playback.is_noop_at(timeline_position))
    .map(|playback| {
        let state = TimelinePlaybackSyncState {
            position: playback.playback_position_at(timeline_position),
            rate: playback.playback_rate_at(timeline_position),
        };
        ((playback.owner.track_id, playback.owner.action_id), state)
    })
    .collect()
}

/// Converts authored track actions into the source-agnostic planning action DTO.
fn timeline_planning_actions(
    timeline: &MaterializedTimeline,
) -> impl Iterator<Item = TimelinePlanningAction> + '_ {
    let solo_mode = timeline.timeline.tracks.iter().any(|track| track.solo);
    timeline
        .timeline
        .tracks
        .iter()
        .filter(move |track| timeline_track_is_active(track, solo_mode))
        .flat_map(|track| {
            track.actions.iter().map(|action| TimelinePlanningAction {
                track_id: track.id.clone(),
                action_id: action.id.clone(),
                action: action.action.clone(),
                position: action.position,
                duration: action.duration,
            })
        })
}

/// Returns whether a track participates in timeline playback for the current solo mode.
fn timeline_track_is_active(track: &Track, solo_mode: bool) -> bool {
    !track.muted && (!solo_mode || track.solo)
}
