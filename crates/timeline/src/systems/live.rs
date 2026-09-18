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
use crate::timeline_events::TimelineActionsChanged;

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

#[cfg(test)]
mod update_timeline_tests {
    use bevy_app::{App, Update};

    use super::*;
    use crate::prelude::{Timeline, TimelineLoopRange};

    /// Looping one timeline seeks only its UID-associated timecode generator.
    #[test]
    fn loop_seek_targets_associated_timecode() {
        let mut app = App::new();
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

/// System that processes track actions to trigger actions when timecode passes their position
pub fn process_actions_system(
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    mut timecode_events: MessageReader<TimecodeEvent>,
    mut action_events: Option<MessageReader<TimelineActionsChanged>>,
    source_data: TimelineLiveSourceData,
    selection_resolver: SpatialSelectionResolver,
    parameter_query: Query<InstanceRef<Parameter>>,
    mut materialized_cues: Query<&mut MaterializedCue>,
    mut commands: Commands,
    mut ev_desk: MessageWriter<EngineActionEnvelope<DeskAction>>,
    mut ev_clip: MessageWriter<EngineActionEnvelope<ClipAction>>,
    mut action_invocations: Option<MessageWriter<ActionInvocation>>,
    action_registry: Option<Res<ActionRegistry>>,
    mut timeline_command_origins: ResMut<TimelineCommandOrigins>,
    clip_state: TimelineLiveClipState,
    mut last_processed_by_timeline: Local<HashMap<Entity, Duration>>,
) {
    use crate::components::SpawnedEntityType;

    let cue_data_provider = source_data.cue_data_provider;
    let color_path_data_provider = source_data.color_path_data_provider;
    let blueprint_data_provider = source_data.blueprint_data_provider;
    let sequence_data_provider = source_data.sequence_data_provider;
    let fixture_data_provider = source_data.fixture_data_provider;
    let clip_snapshot = clip_state.clip_lookup.snapshot();

    let timecode_uid_by_id = timecode_uid_by_id(&timecode_query);
    let seeked_timecode_positions_by_id: std::collections::HashMap<u32, Duration> = timecode_events
        .read()
        .filter_map(|event| {
            if let TimecodeEvent::Seeked { id, position } = event {
                Some((*id, *position))
            } else {
                None
            }
        })
        .collect();
    let seeked_timecode_positions_by_uid: std::collections::HashMap<Uuid, Duration> =
        seeked_timecode_positions_by_id
            .iter()
            .filter_map(|(id, position)| {
                timecode_uid_by_id
                    .get(id)
                    .copied()
                    .map(|uid| (uid, *position))
            })
            .collect();
    let changed_timeline_ids = action_events
        .as_mut()
        .map(|events| {
            events
                .read()
                .map(|event| event.timeline_id)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();

    // Create a map of timecode UIDs to their current times for quick lookup
    let mut timecode_times = std::collections::HashMap::new();

    for (_, timecode) in timecode_query.iter() {
        timecode_times.insert(
            timecode.timecode.identifiers.uid,
            timecode.state.current_time,
        );
    }

    // Process each timeline
    for (timeline_entity, mut timeline) in timeline_query.iter_mut() {
        // Skip inactive timelines
        if !timeline.is_active {
            continue;
        }

        // Get the current timecode time for this timeline
        let timecode_time = match timecode_times.get(&timeline.timeline.timecode_uid) {
            Some(time) => *time,
            None => continue, // Skip if no timecode found
        };

        // Calculate the timeline position
        let current_position = timeline.get_playback_position(timecode_time);
        let timeline_uid = timeline.timeline.identifiers.uid;
        let timeline_id = timeline.timeline.identifiers.id;

        let changed_timeline = changed_timeline_ids.contains(&timeline.timeline.identifiers.id);
        let seeked_timecode_position =
            seeked_timecode_positions_by_uid.get(&timeline.timeline.timecode_uid);
        let seeked_timecode = seeked_timecode_position.is_some();
        let mutation_replaced_ignored_seek = changed_timeline
            && timeline.timeline.seek_behavior == TimelineSeekBehavior::MovePlayheadOnly;

        // Seek replay reconstructs timeline-owned state in handle_timeline_seek_system.
        // Skip regular trigger scanning in seek frames to avoid duplicate lifecycle actions.
        if seeked_timecode && !mutation_replaced_ignored_seek {
            let seek_target_position = seeked_timecode_position
                .copied()
                .unwrap_or_default()
                .saturating_sub(timeline.timeline.timecode_start);
            last_processed_by_timeline.insert(timeline_entity, seek_target_position);
            continue;
        }
        if changed_timeline {
            last_processed_by_timeline.insert(timeline_entity, Duration::ZERO);
        }

        // Collect tracking updates to apply after processing actions
        let mut entities_to_track: HashMap<Entity, (String, String, SpawnedEntityType)> =
            HashMap::new();
        let mut entities_to_untrack: HashSet<Entity> = HashSet::new();
        let mut active_clip_entities =
            active_clip_entities(&clip_state.exec_query, &clip_state.materialized_clip_links);

        let action_positions = timeline_action_positions(&timeline);
        let existing_spawned_entities = timeline.spawned_entities.clone();
        let timeline_instance_options = instance_options_for_timeline(&timeline);

        // Process track actions to find those that should be triggered
        let last_processed = last_processed_by_timeline
            .get(&timeline_entity)
            .copied()
            .unwrap_or_default();
        let actions_to_trigger = timeline.process_actions(last_processed, current_position);
        last_processed_by_timeline.insert(timeline_entity, current_position);

        // Handle each triggered action
        for (track, timeline_action) in actions_to_trigger {
            tracing::debug!(
                action_id = %timeline_action.id,
                position = ?current_position,
                "Triggering action"
            );
            let normalized_action = normalized_registered_action_kind(
                &timeline_action.action,
                action_registry.as_deref(),
            );
            if normalized_action.is_none()
                && let ActionKind::RegisteredAction(registered_action) = &timeline_action.action
            {
                if let Some(action_invocations) = action_invocations.as_mut() {
                    action_invocations.write(
                        ActionInvocation::trigger(
                            registered_action.clone(),
                            ActionSurface::Timeline,
                        )
                        .with_source(format!(
                            "Timeline {} action {}",
                            timeline_id, timeline_action.id
                        )),
                    );
                } else {
                    tracing::warn!(
                        action_id = registered_action.id.as_str(),
                        "Registered action invocation is unavailable"
                    );
                }
                continue;
            }
            let action_kind = normalized_action
                .as_ref()
                .unwrap_or(&timeline_action.action);

            match action_kind {
                ActionKind::FireCue(cue_uid) => {
                    tracing::debug!("Materializing cue {} from timeline FireCue action", cue_uid);
                    let source = PlannedPlaybackSource::Cue(*cue_uid);
                    let planner_resolver = TimelinePlannerResolver {
                        source_by_clip_uid: HashMap::new(),
                        duration_by_source: HashMap::from([(
                            source,
                            playback_duration_profile_for_source(
                                source,
                                &cue_data_provider,
                                None,
                                &fixture_data_provider,
                                &selection_resolver,
                            ),
                        )]),
                    };
                    let evaluated_timeline_state = plan_timeline_at(
                        timeline_uid,
                        current_position,
                        [TimelinePlanningAction {
                            track_id: track.id.clone(),
                            action_id: timeline_action.id.clone(),
                            action: action_kind.clone(),
                            position: timeline_action.position,
                            duration: timeline_action.duration,
                        }],
                        &planner_resolver,
                        None,
                    )
                    .evaluate();
                    let Some(playback) =
                        evaluated_timeline_state.instances.iter().find(|playback| {
                            playback.owner.track_id == track.id
                                && playback.owner.action_id == timeline_action.id
                        })
                    else {
                        continue;
                    };
                    if let Some(entity) = materialize_evaluated_fire_cue(
                        &mut commands,
                        playback,
                        timeline_uid,
                        &cue_data_provider,
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &selection_resolver,
                        &parameter_query,
                    ) {
                        debug_assert!(
                            !track.id.is_empty(),
                            "Timeline track id should not be empty when tracking spawned entities"
                        );
                        entities_to_track.insert(
                            entity,
                            (
                                track.id.clone(),
                                timeline_action.id.clone(),
                                SpawnedEntityType::Cue,
                            ),
                        );
                    }
                }
                ActionKind::StartClip(clip_uid) => {
                    tracing::debug!("Starting clip {}", clip_uid);
                    let Some((entity, id)) =
                        resolve_clip_entity_and_id(&clip_snapshot, clip_uid, "start-clip")
                    else {
                        continue;
                    };
                    let timing = if let Some(source) = clip_state
                        .exec_query
                        .get(entity)
                        .ok()
                        .and_then(|(_, clip)| planned_source_for_clip(clip))
                    {
                        let planner_resolver = TimelinePlannerResolver {
                            source_by_clip_uid: HashMap::from([(*clip_uid, source)]),
                            duration_by_source: HashMap::from([(
                                source,
                                playback_duration_profile_for_source(
                                    source,
                                    &cue_data_provider,
                                    None,
                                    &fixture_data_provider,
                                    &selection_resolver,
                                ),
                            )]),
                        };
                        let evaluated_timeline_state = plan_timeline_at(
                            timeline_uid,
                            current_position,
                            [TimelinePlanningAction {
                                track_id: track.id.clone(),
                                action_id: timeline_action.id.clone(),
                                action: action_kind.clone(),
                                position: timeline_action.position,
                                duration: timeline_action.duration,
                            }],
                            &planner_resolver,
                            None,
                        )
                        .evaluate();
                        let Some(playback) =
                            evaluated_timeline_state.instances.iter().find(|playback| {
                                playback.owner.track_id == track.id
                                    && playback.owner.action_id == timeline_action.id
                            })
                        else {
                            continue;
                        };
                        reconstruction_timing_from_evaluated_instance(playback, timeline_uid)
                    } else {
                        PlaybackReconstructionTiming::timeline(
                            timeline_action.position,
                            current_position,
                            timeline_uid,
                            timeline_action.position,
                        )
                    };
                    write_timeline_clip_action(
                        &mut ev_clip,
                        &mut timeline_command_origins,
                        ClipAction::StartAtTiming {
                            clip_id: IdExpr::Single(id),
                            timing,
                            instance_options: timeline_instance_options,
                        },
                    );
                    track_timeline_clip_entity(
                        &mut entities_to_track,
                        &mut active_clip_entities,
                        entity,
                        &track.id,
                        &timeline_action.id,
                    );
                }
                ActionKind::StopClip(clip_uid) => {
                    tracing::debug!("Stopping clip {}", clip_uid);
                    let Some((entity, id)) =
                        resolve_clip_entity_and_id(&clip_snapshot, clip_uid, "stop-clip")
                    else {
                        continue;
                    };
                    let command = clip_state
                        .exec_query
                        .get(entity)
                        .ok()
                        .and_then(|(_, clip)| planned_source_for_clip(clip))
                        .and_then(|source| {
                            planned_release_reconstruction_timing_for_clip_stop(
                                &action_positions,
                                &existing_spawned_entities,
                                &entities_to_untrack,
                                &entities_to_track,
                                entity,
                                *clip_uid,
                                source,
                                timeline_uid,
                                &track.id,
                                &timeline_action.id,
                                timeline_action.position,
                                current_position,
                                &cue_data_provider,
                                &fixture_data_provider,
                                &selection_resolver,
                            )
                        })
                        .map(|timing| ClipAction::StopAtTiming {
                            clip_id: IdExpr::Single(id),
                            timing,
                        })
                        .unwrap_or(ClipAction::Stop(IdExpr::Single(id)));
                    write_timeline_clip_action(
                        &mut ev_clip,
                        &mut timeline_command_origins,
                        command,
                    );
                    active_clip_entities.remove(&entity);
                    entities_to_track.remove(&entity);

                    // Mark to remove from tracked spawned entities (apply after loop)
                    entities_to_untrack.insert(entity);
                }
                ActionKind::AdvanceSequence(clip_id) => {
                    tracing::debug!("Advancing sequence on clip {}", clip_id);
                    let Some((entity, id)) =
                        resolve_clip_entity_and_id(&clip_snapshot, clip_id, "advance-sequence")
                    else {
                        continue;
                    };
                    let render_command = clip_state
                        .exec_query
                        .get(entity)
                        .ok()
                        .and_then(|(_, clip)| planned_source_for_clip(clip))
                        .and_then(|source| {
                            planned_intervention_render_target_for_clip_action(
                                &action_positions,
                                &existing_spawned_entities,
                                &entities_to_untrack,
                                &entities_to_track,
                                entity,
                                id,
                                *clip_id,
                                source,
                                timeline_uid,
                                &track.id,
                                &timeline_action.id,
                                action_kind.clone(),
                                timeline_action.position,
                                current_position,
                                &cue_data_provider,
                                sequence_data_provider.as_deref(),
                                &fixture_data_provider,
                                &selection_resolver,
                                PlannedPlaybackInterventionKind::SequenceGo,
                            )
                        })
                        .map(|render_target| ClipAction::RenderAt {
                            clip_id: IdExpr::Single(id),
                            position: render_target.position,
                            timing: render_target.timing,
                            instance_options: timeline_instance_options,
                        });
                    write_timeline_clip_action(
                        &mut ev_clip,
                        &mut timeline_command_origins,
                        render_command.unwrap_or(ClipAction::Go(IdExpr::Single(id))),
                    );
                    track_timeline_clip_navigation_entity(
                        &existing_spawned_entities,
                        &entities_to_untrack,
                        &mut entities_to_track,
                        &mut active_clip_entities,
                        entity,
                        &track.id,
                        &timeline_action.id,
                    );
                }
                ActionKind::BackSequence(clip_id) => {
                    tracing::debug!("Going back in sequence on clip {}", clip_id);
                    let Some((entity, id)) =
                        resolve_clip_entity_and_id(&clip_snapshot, clip_id, "back-sequence")
                    else {
                        continue;
                    };
                    let render_command = clip_state
                        .exec_query
                        .get(entity)
                        .ok()
                        .and_then(|(_, clip)| planned_source_for_clip(clip))
                        .and_then(|source| {
                            planned_intervention_render_target_for_clip_action(
                                &action_positions,
                                &existing_spawned_entities,
                                &entities_to_untrack,
                                &entities_to_track,
                                entity,
                                id,
                                *clip_id,
                                source,
                                timeline_uid,
                                &track.id,
                                &timeline_action.id,
                                action_kind.clone(),
                                timeline_action.position,
                                current_position,
                                &cue_data_provider,
                                sequence_data_provider.as_deref(),
                                &fixture_data_provider,
                                &selection_resolver,
                                PlannedPlaybackInterventionKind::SequenceBack,
                            )
                        })
                        .map(|render_target| ClipAction::RenderAt {
                            clip_id: IdExpr::Single(id),
                            position: render_target.position,
                            timing: render_target.timing,
                            instance_options: timeline_instance_options,
                        });
                    write_timeline_clip_action(
                        &mut ev_clip,
                        &mut timeline_command_origins,
                        render_command.unwrap_or(ClipAction::Back(IdExpr::Single(id))),
                    );
                    track_timeline_clip_navigation_entity(
                        &existing_spawned_entities,
                        &entities_to_untrack,
                        &mut entities_to_track,
                        &mut active_clip_entities,
                        entity,
                        &track.id,
                        &timeline_action.id,
                    );
                }
                ActionKind::SetClipRate { uid, rate } => {
                    tracing::debug!("Setting clip {} playback rate to {}", uid, rate);
                    let Some((entity, id)) =
                        resolve_clip_entity_and_id(&clip_snapshot, uid, "set-clip-rate")
                    else {
                        continue;
                    };
                    write_timeline_clip_action(
                        &mut ev_clip,
                        &mut timeline_command_origins,
                        ClipAction::SetRate {
                            clip_id: IdExpr::Single(id),
                            rate: *rate,
                        },
                    );
                    track_timeline_clip_navigation_entity(
                        &existing_spawned_entities,
                        &entities_to_untrack,
                        &mut entities_to_track,
                        &mut active_clip_entities,
                        entity,
                        &track.id,
                        &timeline_action.id,
                    );
                }
                ActionKind::JumpToCue { uid, cue_index } => {
                    tracing::debug!("Jumping to cue {} on clip {}", cue_index, uid);
                    let Some((entity, id)) =
                        resolve_clip_entity_and_id(&clip_snapshot, uid, "jump-to-cue")
                    else {
                        continue;
                    };
                    let render_command = clip_state
                        .exec_query
                        .get(entity)
                        .ok()
                        .and_then(|(_, clip)| planned_source_for_clip(clip))
                        .and_then(|source| {
                            planned_intervention_render_target_for_clip_action(
                                &action_positions,
                                &existing_spawned_entities,
                                &entities_to_untrack,
                                &entities_to_track,
                                entity,
                                id,
                                *uid,
                                source,
                                timeline_uid,
                                &track.id,
                                &timeline_action.id,
                                action_kind.clone(),
                                timeline_action.position,
                                current_position,
                                &cue_data_provider,
                                sequence_data_provider.as_deref(),
                                &fixture_data_provider,
                                &selection_resolver,
                                PlannedPlaybackInterventionKind::SequenceGotoCue(*cue_index),
                            )
                        })
                        .map(|render_target| ClipAction::RenderAt {
                            clip_id: IdExpr::Single(id),
                            position: render_target.position,
                            timing: render_target.timing,
                            instance_options: timeline_instance_options,
                        });

                    write_timeline_clip_action(
                        &mut ev_clip,
                        &mut timeline_command_origins,
                        render_command.unwrap_or(ClipAction::Goto {
                            clip_id: IdExpr::Single(id),
                            position: *cue_index,
                            timing: None,
                        }),
                    );
                    track_timeline_clip_navigation_entity(
                        &existing_spawned_entities,
                        &entities_to_untrack,
                        &mut entities_to_track,
                        &mut active_clip_entities,
                        entity,
                        &track.id,
                        &timeline_action.id,
                    );
                }
                ActionKind::DeskEval(command) => {
                    tracing::debug!("Dispatching timeline desk eval action: {}", command);
                    write_timeline_desk_action(
                        &mut ev_desk,
                        &mut timeline_command_origins,
                        command.clone(),
                    );
                    for tracking in desk_eval_clip_tracking(command, &clip_state.exec_query) {
                        match tracking {
                            DeskEvalClipTracking::Track {
                                entity,
                                preserve_existing_origin,
                            } => {
                                if preserve_existing_origin {
                                    track_timeline_clip_navigation_entity(
                                        &existing_spawned_entities,
                                        &entities_to_untrack,
                                        &mut entities_to_track,
                                        &mut active_clip_entities,
                                        entity,
                                        &track.id,
                                        &timeline_action.id,
                                    );
                                } else {
                                    track_timeline_clip_entity(
                                        &mut entities_to_track,
                                        &mut active_clip_entities,
                                        entity,
                                        &track.id,
                                        &timeline_action.id,
                                    );
                                }
                            }
                            DeskEvalClipTracking::Untrack(entity) => {
                                active_clip_entities.remove(&entity);
                                entities_to_track.remove(&entity);
                                entities_to_untrack.insert(entity);
                            }
                        }
                    }
                }
                ActionKind::RegisteredAction(registered_action) => {
                    tracing::debug!(
                        ?registered_action,
                        "Ignoring unsupported registered timeline action"
                    );
                }
            }
        }

        // Apply tracking updates after processing all actions
        for (entity, (track_id, action_id, spawned_type)) in &entities_to_track {
            entities_to_untrack.remove(entity);
            timeline.spawned_entities.insert(
                *entity,
                (track_id.clone(), action_id.clone(), spawned_type.clone()),
            );
        }

        let bounded_cue_lifecycle_updates: Vec<_> = timeline
            .spawned_entities
            .iter()
            .filter_map(|(entity, (track_id, action_id, spawned_type))| {
                if !matches!(spawned_type, SpawnedEntityType::Cue) {
                    return None;
                }
                let action = timeline
                    .timeline
                    .tracks
                    .iter()
                    .find(|track| track.id == *track_id)
                    .and_then(|track| {
                        track.actions.iter().find(|action| action.id == *action_id)
                    })?;
                let ActionKind::FireCue(cue_uid) = &action.action else {
                    return None;
                };
                if action.duration.is_zero() {
                    return None;
                }
                let source = PlannedPlaybackSource::Cue(*cue_uid);
                let planner_resolver = TimelinePlannerResolver {
                    source_by_clip_uid: HashMap::new(),
                    duration_by_source: HashMap::from([(
                        source,
                        playback_duration_profile_for_source(
                            source,
                            &cue_data_provider,
                            None,
                            &fixture_data_provider,
                            &selection_resolver,
                        ),
                    )]),
                };
                let evaluated_timeline_state = plan_timeline_at(
                    timeline_uid,
                    current_position,
                    [TimelinePlanningAction {
                        track_id: track_id.clone(),
                        action_id: action_id.clone(),
                        action: action.action.clone(),
                        position: action.position,
                        duration: action.duration,
                    }],
                    &planner_resolver,
                    None,
                )
                .evaluate();
                let Some(playback) = evaluated_timeline_state.instances.iter().find(|playback| {
                    playback.owner.track_id == *track_id && playback.owner.action_id == *action_id
                }) else {
                    return Some((
                        *entity,
                        PlaybackReleaseTiming {
                            released_at: action.duration,
                        },
                        true,
                    ));
                };
                let released_at = playback.release_snapshot_position?;
                Some((*entity, PlaybackReleaseTiming { released_at }, false))
            })
            .collect();

        for (entity, release_timing, is_complete) in bounded_cue_lifecycle_updates {
            if let Ok(mut mcue) = materialized_cues.get_mut(entity) {
                mcue.release_with_ltp_hold_at_playback_position(
                    &fixture_data_provider,
                    &parameter_query,
                    Some(release_timing.released_at),
                );
            }
            commands
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
}
