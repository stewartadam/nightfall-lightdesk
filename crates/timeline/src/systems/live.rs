// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::lifecycle::*;
use super::planner_adapter::*;
use super::*;
#[cfg(feature = "audio")]
use crate::TimelineAudioOutputEnabled;

mod actions;

/// Synchronize materialized timelines with their timecodes and apply enabled loop seeks.
pub fn update_timeline_system(
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
    mut timecode_query: Query<(Entity, &mut TimecodeGenerator)>,
) {
    let timecode_entities = timecode_query
        .iter_mut()
        .map(|(entity, timecode)| (timecode.timecode.identifiers.uid, entity))
        .collect::<HashMap<_, _>>();

    for (_, mut timeline) in timeline_query.iter_mut() {
        let Some(timecode_entity) = timecode_entities.get(&timeline.timeline.timecode_uid) else {
            continue;
        };
        let Ok((_, mut timecode)) = timecode_query.get_mut(*timecode_entity) else {
            continue;
        };
        if timeline.is_active
            && let Some(loop_range) = timeline
                .timeline
                .loop_range
                .as_ref()
                .filter(|range| range.enabled && range.end > range.start)
        {
            let timeline_position = timecode
                .state
                .current_time
                .saturating_sub(timeline.timeline.timecode_start);
            if timeline_position >= loop_range.end {
                timecode.seek(timeline.timeline.timecode_start + loop_range.start);
                timeline.audio_needs_sync = true;
            }
        }
        timeline.update_with_timecode(timecode.state.current_time);
    }
}

/// System that handles audio playback for timelines that had significant state changes
#[cfg(feature = "audio")]
pub fn handle_timeline_audio_system(
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    mut audio_controller: ResMut<AudioController>,
    audio_output_enabled: Res<TimelineAudioOutputEnabled>,
) {
    // Create a map of timecode UIDs to their current times and running state for quick lookup
    let mut timecode_info = std::collections::HashMap::new();

    for (_, timecode) in timecode_query.iter() {
        timecode_info.insert(
            timecode.timecode.identifiers.uid,
            (timecode.state.current_time, timecode.state.is_active),
        );
    }

    // Handle each timeline that needs audio sync
    for (entity, mut timeline) in timeline_query
        .iter_mut()
        .filter(|(_, t)| t.audio_needs_sync)
    {
        let (current_time, timecode_running) = timecode_info
            .get(&timeline.timeline.timecode_uid)
            .copied()
            .unwrap_or((Duration::ZERO, false));

        let playback_position = timeline.get_playback_position(current_time);
        let audio_enabled = timeline.timeline.audio_enabled && audio_output_enabled.0;
        tracing::trace!(
            %entity,
            timeline_id = timeline.timeline.identifiers.id,
            timecode_current_time = ?current_time,
            timecode_running,
            timeline_active = timeline.is_active,
            audio_enabled,
            audio_needs_sync = timeline.audio_needs_sync,
            audio_sink_id = ?timeline.audio_sink_id,
            playback_position = ?playback_position,
            "Processing timeline audio sync"
        );
        if timeline.is_active && timecode_running && audio_enabled {
            // Timeline is active, audio should play, and timecode is running
            if timeline.audio_sink_id.is_none() {
                // Create a new audio sink for this timeline if it doesn't have one
                if let Some(sink_id) = audio_controller.create_sink() {
                    timeline.audio_sink_id = Some(sink_id);
                    tracing::info!(
                        ?sink_id,
                        timeline_id = %timeline.timeline.identifiers.id,
                        "Created audio sink for timeline"
                    );
                } else {
                    tracing::error!(
                        "Failed to create audio sink for timeline {}",
                        timeline.timeline.identifiers.id
                    );
                    continue;
                }
            }

            if let Some(sink_id) = timeline.audio_sink_id {
                tracing::trace!(
                    timeline_id = %timeline.timeline.identifiers.id,
                    ?playback_position,
                    ?sink_id,
                    "Loading and playing audio for timeline"
                );
                let audio_path = match crate::storage::resolve_timeline_audio_path(
                    &timeline.timeline.audio_path,
                ) {
                    Ok(path) => path,
                    Err(error) => {
                        tracing::error!(
                            "Failed to resolve audio path for timeline {}: {}",
                            timeline.timeline.identifiers.id,
                            error
                        );
                        continue;
                    }
                };
                if let Some(path_str) = audio_path.to_str() {
                    let loaded = audio_controller.load_file(sink_id, path_str);
                    if !loaded {
                        tracing::error!(
                            timeline_id = %timeline.timeline.identifiers.id,
                            ?sink_id,
                            "Failed to load audio file for timeline"
                        );
                    }
                    let seeked = audio_controller.seek(sink_id, playback_position);
                    tracing::trace!(
                        %entity,
                        timeline_id = timeline.timeline.identifiers.id,
                        ?sink_id,
                        playback_position = ?playback_position,
                        seeked,
                        "Seeking audio seek for timeline"
                    );
                    if !seeked {
                        tracing::error!(
                            timeline_id = %timeline.timeline.identifiers.id,
                            ?sink_id,
                            "Failed to seek in audio for timeline"
                        );
                    }
                    let playing = audio_controller.play(sink_id);
                    tracing::trace!(
                        %entity,
                        timeline_id = timeline.timeline.identifiers.id,
                        ?sink_id,
                        playing,
                        "Playing audio for timeline"
                    );
                    if !playing {
                        tracing::error!(
                            timeline_id = %timeline.timeline.identifiers.id,
                            ?sink_id,
                            "Failed to play audio for timeline"
                        );
                    }
                } else {
                    tracing::error!(
                        timeline_id = %timeline.timeline.identifiers.id,
                        path = ?audio_path,
                        "Invalid audio path for timeline"
                    );
                }
            }
        } else {
            // Timeline is inactive, audio should be stopped, or timecode is paused
            if let Some(sink_id) = timeline.audio_sink_id {
                tracing::trace!(
                    timeline_id = %timeline.timeline.identifiers.id,
                    ?sink_id,
                    timeline_active = timeline.is_active,
                    timecode_running,
                    audio_enabled,
                    "Stopping audio for timeline"
                );
                audio_controller.stop(sink_id);

                // If the timeline will not resume from this sink, clean it up.
                if !timeline.is_active || !audio_enabled {
                    if audio_controller.destroy_sink(sink_id) {
                        timeline.audio_sink_id = None;
                        tracing::debug!(
                            ?sink_id,
                            timeline_id = %timeline.timeline.identifiers.id,
                            "Destroyed audio sink for timeline"
                        );
                    } else {
                        tracing::error!(
                            ?sink_id,
                            timeline_id = %timeline.timeline.identifiers.id,
                            "Failed to destroy audio sink for timeline"
                        );
                    }
                }
            }
        }

        // Reset the significant change flag after handling
        // This prevents repeated audio control operations on subsequent frames
        timeline.audio_needs_sync = false;
    }
}

/// Source data providers used while emitting live timeline clip commands.
#[derive(SystemParam)]
pub struct TimelineLiveSourceData<'w> {
    /// Cue definitions used by cue actions and sequence render target planning.
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    /// Optional color path definitions used by cue actions.
    color_path_data_provider: Option<Res<'w, DataProvider<ColorPath>>>,
    /// Optional Blueprint definitions used by cue actions.
    blueprint_data_provider: Option<Res<'w, DataProvider<Blueprint>>>,
    /// Optional sequence definitions used by sequence render target planning.
    sequence_data_provider: Option<Res<'w, DataProvider<Sequence>>>,
    /// Fixture data used for cue and sequence duration planning.
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
}

/// Clip lookup and playback-link state used while emitting live timeline actions.
#[derive(SystemParam)]
pub struct TimelineLiveClipState<'w, 's> {
    /// Clip entities addressed by timeline action kinds.
    exec_query: Query<'w, 's, (Entity, &'static Clip)>,
    /// Direct ECS lookup used to resolve timeline clip references.
    clip_lookup: ClipLookup<'w, 's>,
    /// Materialized clip links with their ECS entities for direct live cleanup.
    materialized_clip_links: Query<'w, 's, (Entity, &'static MaterializedClip)>,
}

/// Read-only sources consulted while dispatching live timeline actions.
#[derive(SystemParam)]
pub struct TimelineLiveActionSources<'w, 's> {
    /// Cue, color path, Blueprint, sequence, and fixture definitions.
    source_data: TimelineLiveSourceData<'w>,
    /// Resolves cue selections during cue materialization and duration planning.
    selection_resolver: SpatialSelectionResolver<'w>,
    /// Fixture parameters addressed by materialized cues.
    parameter_query: Query<'w, 's, InstanceRef<'static, Parameter>>,
    /// Optional registry used to resolve registered timeline actions.
    action_registry: Option<Res<'w, ActionRegistry>>,
    /// Clip lookup and playback-link state.
    clip_state: TimelineLiveClipState<'w, 's>,
}

/// Outputs written while dispatching live timeline actions.
#[derive(SystemParam)]
pub struct TimelineLiveActionSinks<'w, 's> {
    /// Materialized cues released when bounded fire-cue actions end.
    materialized_cues: Query<'w, 's, &'static mut MaterializedCue>,
    /// Deferred ECS mutations for cue materialization and release markers.
    commands: Commands<'w, 's>,
    /// Desk eval operations emitted by desk eval actions.
    ev_desk: MessageWriter<'w, EngineOperationEnvelope<EvalOperation>>,
    /// Clip operations emitted by clip and sequence actions.
    ev_clip: MessageWriter<'w, EngineOperationEnvelope<ClipOperation>>,
    /// Optional invocations for registered domain actions.
    action_invocations: Option<MessageWriter<'w, ActionInvocation>>,
    /// Origins retained for timeline-issued operations.
    timeline_command_origins: ResMut<'w, TimelineCommandOrigins>,
}

/// Per-timeline state accumulated while dispatching the actions triggered in one scan.
struct TimelineActionScan<'a> {
    /// Timeline being scanned.
    timeline_uid: Uuid,
    /// Numeric timeline ID used in action invocation sources.
    timeline_id: u32,
    /// Timeline playhead position the scan ends at.
    current_position: Duration,
    /// Beats the timeline plays per second, which beat-timed sequences count in.
    beats_per_second: f64,
    /// Clip lookup shared by every timeline scanned this frame.
    clip_snapshot: &'a ClipLookupSnapshot<'a>,
    /// Planner input for sequence navigation; empty when the scan crosses no navigation.
    planning_actions: Vec<TimelinePlanningAction>,
    /// Positions of every timeline action by track and action ID.
    action_positions: HashMap<(String, String), Duration>,
    /// Timeline-owned entities as they were before this scan.
    existing_spawned_entities: HashMap<Entity, (String, String, SpawnedEntityType)>,
    /// Timeline-level playback options applied to started and rendered clips.
    instance_options: Option<InstanceOptions>,
    /// Entities that become timeline-owned once the scan finishes.
    entities_to_track: HashMap<Entity, (String, String, SpawnedEntityType)>,
    /// Entities that stop being timeline-owned once the scan finishes.
    entities_to_untrack: HashSet<Entity>,
    /// Clip entities with live playback, updated as actions start and stop clips.
    active_clip_entities: HashSet<Entity>,
}

/// System that processes track actions to trigger actions when timecode passes their position.
///
/// Each active timeline scans the actions crossed since its last scan and dispatches them in
/// order, then commits the resulting entity ownership and releases bounded fired cues that
/// have reached their end.
pub fn process_actions_system(
    mut timeline_query: Query<(&mut MaterializedTimeline, &mut TimelineActionCursor)>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    sources: TimelineLiveActionSources,
    mut sinks: TimelineLiveActionSinks,
) {
    let clip_snapshot = sources.clip_state.clip_lookup.snapshot();

    let mut timecode_times = std::collections::HashMap::new();
    for (_, timecode) in timecode_query.iter() {
        timecode_times.insert(
            timecode.timecode.identifiers.uid,
            timecode.state.current_time,
        );
    }

    for (mut timeline, mut cursor) in timeline_query.iter_mut() {
        if !timeline.is_active {
            continue;
        }

        let Some(timecode_time) = timecode_times.get(&timeline.timeline.timecode_uid).copied()
        else {
            continue;
        };

        let current_position = timeline.get_playback_position(timecode_time);
        let timeline_uid = timeline.timeline.identifiers.uid;
        let timeline_id = timeline.timeline.identifiers.id;

        // Seek replay reconstructs timeline-owned state in handle_timeline_seek_system.
        // Skip regular trigger scanning in the render after a seek to avoid duplicate lifecycle
        // actions.
        let Some(last_processed) = cursor.take_scan_start() else {
            continue;
        };

        let mut scan = TimelineActionScan {
            timeline_uid,
            timeline_id,
            current_position,
            beats_per_second: timeline.timeline.beats_per_second(),
            clip_snapshot: &clip_snapshot,
            active_clip_entities: active_clip_entities(
                &sources.clip_state.exec_query,
                &sources.clip_state.materialized_clip_links,
            ),
            action_positions: timeline_action_positions(&timeline),
            planning_actions: navigation_planning_actions(
                &timeline,
                last_processed,
                current_position,
                sources.action_registry.as_deref(),
            ),
            existing_spawned_entities: timeline.spawned_entities.clone(),
            instance_options: instance_options_for_timeline(&timeline),
            entities_to_track: HashMap::new(),
            entities_to_untrack: HashSet::new(),
        };
        let actions_to_trigger = timeline.process_actions(last_processed, current_position);
        cursor.advance_to(current_position);

        for (track, timeline_action) in actions_to_trigger {
            actions::dispatch_triggered_action(
                &sources,
                &mut sinks,
                &mut scan,
                track,
                timeline_action,
            );
        }

        commit_scan_ownership(&sources, &mut sinks, &mut timeline, scan);
    }
}

/// Returns planner input for every action up to the playhead when the scan crosses navigation.
///
/// Sequence navigation reconstructs its render target from the full action history, so the
/// history is only collected when an advance, back, or jump-to-cue action lies between
/// `last_processed` and `current_position`.
fn navigation_planning_actions(
    timeline: &MaterializedTimeline,
    last_processed: Duration,
    current_position: Duration,
    action_registry: Option<&ActionRegistry>,
) -> Vec<TimelinePlanningAction> {
    let has_navigation = timeline
        .collect_actions_in_range(last_processed, current_position)
        .iter()
        .any(|(action, _)| {
            matches!(
                action.kind(action_registry),
                ActionKind::AdvanceSequence(_)
                    | ActionKind::BackSequence(_)
                    | ActionKind::JumpToCue { .. }
            )
        });
    if !has_navigation {
        return Vec::new();
    }
    timeline
        .collect_actions_in_range(Duration::ZERO, current_position)
        .into_iter()
        .map(|(action, track)| TimelinePlanningAction {
            track_id: track.id.clone(),
            action_id: action.id.clone(),
            action: action.kind(action_registry),
            position: action.position,
            duration: action.duration,
        })
        .collect()
}

/// Applies a finished scan's ownership changes and releases ended bounded fired cues.
///
/// Newly tracked entities are recorded first so bounded-cue release sees cues fired in this
/// scan. Cues whose playback fully ended are untracked along with the scan's untracked
/// entities.
fn commit_scan_ownership(
    sources: &TimelineLiveActionSources,
    sinks: &mut TimelineLiveActionSinks,
    timeline: &mut Mut<MaterializedTimeline>,
    scan: TimelineActionScan,
) {
    let TimelineActionScan {
        timeline_uid,
        current_position,
        entities_to_track,
        mut entities_to_untrack,
        ..
    } = scan;

    for (entity, (track_id, action_id, spawned_type)) in &entities_to_track {
        entities_to_untrack.remove(entity);
        timeline.spawned_entities.insert(
            *entity,
            (track_id.clone(), action_id.clone(), spawned_type.clone()),
        );
    }

    let bounded_cue_lifecycle_updates =
        actions::bounded_cue_releases(sources, timeline, timeline_uid, current_position);
    for (entity, release_timing, is_complete) in bounded_cue_lifecycle_updates {
        if let Ok(mut mcue) = sinks.materialized_cues.get_mut(entity) {
            mcue.release_with_ltp_hold_at_playback_position(
                &sources.source_data.fixture_data_provider,
                &sources.parameter_query,
                Some(release_timing.released_at),
            );
        }
        sinks
            .commands
            .entity(entity)
            .insert((ReleaseMarker::default(), release_timing));
        if is_complete {
            entities_to_untrack.insert(entity);
        }
    }

    for entity in entities_to_untrack {
        timeline.spawned_entities.remove(&entity);
    }
}

#[cfg(test)]
mod update_timeline_tests {
    use bevy_app::{App, Update};

    use super::*;
    use crate::prelude::{Timeline, TimelineLoopRange};

    /// Looping one timeline seeks only its UID-associated timecode generator.
    #[test]
    fn loop_seek_targets_associated_timecode() {
        let mut app = App::new();
        crate::install_timeline_test_actions(&mut app);
        app.add_systems(Update, update_timeline_system);

        let mut unrelated_timecode = TimecodeGenerator::default();
        unrelated_timecode.state.current_time = Duration::from_secs(9);
        let unrelated_entity = app.world_mut().spawn(unrelated_timecode).id();

        let mut associated_timecode = TimecodeGenerator::default();
        associated_timecode.state.current_time = Duration::from_secs(6);
        let associated_uid = associated_timecode.timecode.identifiers.uid;
        let associated_entity = app.world_mut().spawn(associated_timecode).id();

        let mut timeline = Timeline {
            timecode_uid: associated_uid,
            timecode_start: Duration::from_secs(1),
            loop_range: Some(TimelineLoopRange {
                start: Duration::from_secs(2),
                end: Duration::from_secs(4),
                enabled: true,
            }),
            ..Default::default()
        };
        timeline.identifiers.id = 1;
        let mut materialized_timeline = MaterializedTimeline::new(timeline);
        materialized_timeline.is_active = true;
        app.world_mut().spawn(materialized_timeline);

        app.update();

        let unrelated_timecode = app
            .world()
            .entity(unrelated_entity)
            .get::<TimecodeGenerator>()
            .expect("unrelated timecode should remain materialized");
        assert_eq!(
            unrelated_timecode.state.current_time,
            Duration::from_secs(9)
        );

        let associated_timecode = app
            .world()
            .entity(associated_entity)
            .get::<TimecodeGenerator>()
            .expect("associated timecode should remain materialized");
        assert_eq!(
            associated_timecode.state.current_time,
            Duration::from_secs(3)
        );

        let materialized_timeline = app
            .world_mut()
            .query::<&MaterializedTimeline>()
            .single(app.world())
            .expect("timeline should remain materialized");
        assert!(materialized_timeline.audio_needs_sync);
    }
}
