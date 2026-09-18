// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

pub(super) fn write_timeline_desk_action(
    writer: &mut MessageWriter<EngineActionEnvelope<DeskAction>>,
    origins: &mut TimelineCommandOrigins,
    command: String,
) {
    let operation_id = OperationId::new();
    let undo_id = UndoId::new();
    let event = EngineActionEnvelope::with_context(
        operation_id,
        None,
        Some(undo_id),
        DeskAction::Eval(command),
    );
    origins.mark_clip_undo_id(undo_id.into());
    writer.write(event);
}

/// Tracking change inferred from a clip command embedded in a desk eval timeline action.
pub(super) enum DeskEvalClipTracking {
    Track {
        entity: Entity,
        preserve_existing_origin: bool,
    },
    Untrack(Entity),
}

/// Resolve a clip entity by numeric clip ID for parsed desk eval commands.
pub(super) fn clip_entity_for_id(exec_query: &Query<(Entity, &Clip)>, id: u32) -> Option<Entity> {
    exec_query
        .iter()
        .find_map(|(entity, clip)| (clip.identifiers.id == id).then_some(entity))
}

/// Returns whether a sequence replay's auto-end release has completed at the seek target.
pub(super) fn sequence_auto_end_release_completed(
    instance: &SequenceTimelineSeekPlayback,
    timeline_position: Duration,
    exec_query: &Query<(Entity, &Clip)>,
    sequence_data_provider: Option<&DataProvider<Sequence>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
) -> bool {
    let target = instance.target();
    let Some((_, clip)) = exec_query
        .iter()
        .find(|(_, clip)| clip.identifiers.id == target.clip_id)
    else {
        return false;
    };

    instance.auto_end_release_completed_for_clip(
        timeline_position,
        clip,
        sequence_data_provider,
        fixture_data_provider,
        selection_resolver,
    )
}

/// Appends clip ownership changes from an ID expression used inside a desk eval command.
pub(super) fn push_desk_eval_clip_tracking_for_id_expr(
    tracking: &mut Vec<DeskEvalClipTracking>,
    exec_query: &Query<(Entity, &Clip)>,
    id_expr: &IdExpr,
    should_track: bool,
    preserve_existing_origin: bool,
) {
    for id in id_expr.expand() {
        let Some(entity) = clip_entity_for_id(exec_query, id) else {
            tracing::warn!(
                clip_id = id,
                "Skipping timeline desk eval ownership tracking for missing clip"
            );
            continue;
        };
        if should_track {
            tracking.push(DeskEvalClipTracking::Track {
                entity,
                preserve_existing_origin,
            });
        } else {
            tracking.push(DeskEvalClipTracking::Untrack(entity));
        }
    }
}

/// Parse a desk eval command and infer clip ownership changes caused by timeline instance.
pub(super) fn desk_eval_clip_tracking(
    command: &str,
    exec_query: &Query<(Entity, &Clip)>,
) -> Vec<DeskEvalClipTracking> {
    let parsed_commands = match nightfall_engine::parse_command_string(command) {
        Ok(commands) => commands,
        Err(error) => {
            tracing::debug!(
                %command,
                %error,
                "Skipping timeline desk eval ownership tracking for unparseable command"
            );
            return Vec::new();
        }
    };

    let mut tracking = Vec::new();
    for command in parsed_commands {
        let Some(clip_command) = command.as_any().downcast_ref::<ClipCommand>() else {
            continue;
        };
        match clip_command {
            ClipCommand::StartClip(id_expr)
            | ClipCommand::StartClipAtTiming {
                clip_id: id_expr, ..
            } => push_desk_eval_clip_tracking_for_id_expr(
                &mut tracking,
                exec_query,
                id_expr,
                true,
                false,
            ),
            ClipCommand::GoClip(id_expr)
            | ClipCommand::BackClip(id_expr)
            | ClipCommand::SetRate {
                clip_id: id_expr, ..
            }
            | ClipCommand::GotoClip {
                clip_id: id_expr, ..
            }
            | ClipCommand::RenderClipAt {
                clip_id: id_expr, ..
            } => push_desk_eval_clip_tracking_for_id_expr(
                &mut tracking,
                exec_query,
                id_expr,
                true,
                true,
            ),
            ClipCommand::StopClip(id_expr)
            | ClipCommand::StopClipAtTiming {
                clip_id: id_expr, ..
            } => push_desk_eval_clip_tracking_for_id_expr(
                &mut tracking,
                exec_query,
                id_expr,
                false,
                false,
            ),
            _ => {}
        }
    }

    tracking
}

/// Marks a clip as timeline-owned so paused timelines can freeze its instance output.
pub(super) fn track_timeline_clip_entity(
    tracked_spawned_entities: &mut HashMap<Entity, (String, String, SpawnedEntityType)>,
    active_clip_entities: &mut HashSet<Entity>,
    entity: Entity,
    track_id: &str,
    action_id: &str,
) {
    active_clip_entities.insert(entity);
    debug_assert!(
        !track_id.is_empty(),
        "Timeline track id should not be empty when tracking spawned entities"
    );
    tracked_spawned_entities.insert(
        entity,
        (
            track_id.to_owned(),
            action_id.to_owned(),
            SpawnedEntityType::Clip,
        ),
    );
}

/// Marks a sequence navigation action without replacing an existing instance origin.
pub(super) fn track_timeline_clip_navigation_entity(
    existing_spawned_entities: &HashMap<Entity, (String, String, SpawnedEntityType)>,
    untracked_entities: &HashSet<Entity>,
    tracked_spawned_entities: &mut HashMap<Entity, (String, String, SpawnedEntityType)>,
    active_clip_entities: &mut HashSet<Entity>,
    entity: Entity,
    track_id: &str,
    action_id: &str,
) {
    active_clip_entities.insert(entity);
    if (existing_spawned_entities.contains_key(&entity) && !untracked_entities.contains(&entity))
        || tracked_spawned_entities.contains_key(&entity)
    {
        return;
    }

    track_timeline_clip_entity(
        tracked_spawned_entities,
        active_clip_entities,
        entity,
        track_id,
        action_id,
    );
}

pub(super) fn timecode_uid_by_id(
    timecode_query: &Query<(Entity, &TimecodeGenerator)>,
) -> HashMap<u32, Uuid> {
    timecode_query
        .iter()
        .map(|(_, timecode)| {
            (
                timecode.timecode.identifiers.id,
                timecode.timecode.identifiers.uid,
            )
        })
        .collect()
}

/// Finds the timeline position of a tracked action by its stored track and action IDs.
pub(super) fn tracked_action_position(
    timeline: &MaterializedTimeline,
    track_id: &str,
    action_id: &str,
) -> Option<Duration> {
    timeline
        .timeline
        .tracks
        .iter()
        .find(|track| track.id == track_id)?
        .actions
        .iter()
        .find(|action| action.id == action_id)
        .map(|action| action.position)
}

/// Builds a lookup of timeline action positions keyed by track and action ID.
pub(super) fn timeline_action_positions(
    timeline: &MaterializedTimeline,
) -> HashMap<(String, String), Duration> {
    timeline
        .timeline
        .tracks
        .iter()
        .flat_map(|track| {
            track
                .actions
                .iter()
                .map(|action| ((track.id.clone(), action.id.clone()), action.position))
        })
        .collect()
}

/// Finds the position of a tracked action from a precomputed action-position lookup.
pub(super) fn tracked_action_position_in(
    action_positions: &HashMap<(String, String), Duration>,
    track_id: &str,
    action_id: &str,
) -> Option<Duration> {
    action_positions
        .get(&(track_id.to_owned(), action_id.to_owned()))
        .copied()
}

/// Builds the instance clock source for an action owned by a timeline.
pub(super) fn timeline_instance_clock_source(
    timeline_uid: Uuid,
    action_position: Duration,
) -> InstanceClockSource {
    InstanceClockSource::Timeline {
        timeline_uid,
        started_at_timeline: action_position,
    }
}

pub(super) fn reconstruction_timing_from_evaluated_instance(
    instance: &EvaluatedInstanceState,
    timeline_uid: Uuid,
) -> PlaybackReconstructionTiming {
    PlaybackReconstructionTiming::timeline(
        instance.started_at_timeline,
        instance
            .started_at_timeline
            .saturating_add(instance.instance_clock_position),
        timeline_uid,
        instance.started_at_timeline,
    )
}

pub(super) fn release_reconstruction_timing_from_evaluated_instance(
    instance: &EvaluatedInstanceState,
    timeline_uid: Uuid,
) -> Option<PlaybackReconstructionTiming> {
    Some(PlaybackReconstructionTiming::timeline_source_local(
        instance.release_snapshot_position?,
        instance.instance_clock_position,
        timeline_uid,
        instance.started_at_timeline,
    ))
}

/// Builds command-adapter timing for a source intervention inside an evaluated instance.
pub(super) fn intervention_reconstruction_timing_from_evaluated_instance(
    instance: &EvaluatedInstanceState,
    intervention: &PlannedPlaybackIntervention,
    timeline_uid: Uuid,
) -> PlaybackReconstructionTiming {
    PlaybackReconstructionTiming::timeline_source_local(
        intervention.playback_position,
        instance.instance_clock_position,
        timeline_uid,
        instance.started_at_timeline,
    )
}

pub(super) fn planned_release_reconstruction_timing_for_clip_stop(
    action_positions: &HashMap<(String, String), Duration>,
    existing_spawned_entities: &HashMap<Entity, (String, String, SpawnedEntityType)>,
    untracked_entities: &HashSet<Entity>,
    tracked_spawned_entities: &HashMap<Entity, (String, String, SpawnedEntityType)>,
    entity: Entity,
    clip_uid: Uuid,
    source: PlannedPlaybackSource,
    timeline_uid: Uuid,
    stop_track_id: &str,
    stop_action_id: &str,
    stop_position: Duration,
    current_position: Duration,
    cue_data_provider: &DataProvider<Cue>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver<'_>,
) -> Option<PlaybackReconstructionTiming> {
    let (origin_track_id, origin_action_id, origin_position) = tracked_spawned_entities
        .get(&entity)
        .or_else(|| {
            (!untracked_entities.contains(&entity))
                .then(|| existing_spawned_entities.get(&entity))
                .flatten()
        })
        .and_then(|(track_id, action_id, spawned_type)| match spawned_type {
            SpawnedEntityType::Clip => {
                tracked_action_position_in(action_positions, track_id, action_id)
                    .map(|position| (track_id.clone(), action_id.clone(), position))
            }
            SpawnedEntityType::Cue | SpawnedEntityType::Instance => None,
        })?;

    let planner_resolver = TimelinePlannerResolver {
        source_by_clip_uid: HashMap::from([(clip_uid, source)]),
        duration_by_source: HashMap::from([(
            source,
            playback_duration_profile_for_source(
                source,
                cue_data_provider,
                None,
                fixture_data_provider,
                selection_resolver,
            ),
        )]),
    };
    let evaluated_timeline_state = plan_timeline_at(
        timeline_uid,
        current_position,
        [
            TimelinePlanningAction {
                track_id: origin_track_id,
                action_id: origin_action_id,
                action: ActionKind::StartClip(clip_uid),
                position: origin_position,
                duration: Duration::ZERO,
            },
            TimelinePlanningAction {
                track_id: stop_track_id.to_owned(),
                action_id: stop_action_id.to_owned(),
                action: ActionKind::StopClip(clip_uid),
                position: stop_position,
                duration: Duration::ZERO,
            },
        ],
        &planner_resolver,
        None,
    )
    .evaluate();

    evaluated_timeline_state
        .instances
        .iter()
        .find(|instance| instance.source == source)
        .and_then(|instance| {
            release_reconstruction_timing_from_evaluated_instance(instance, timeline_uid)
        })
}

/// Planner-derived sequence render state for a timeline-authored intervention.
pub(super) struct PlannedClipRenderTarget {
    /// One-based cue position to render.
    pub position: u32,
    /// Source-local timing for the active cue and instance clock.
    pub timing: PlaybackReconstructionTiming,
}

/// Derives the sequence render target for a timeline-authored instance intervention.
pub(super) fn planned_intervention_render_target_for_clip_action(
    action_positions: &HashMap<(String, String), Duration>,
    existing_spawned_entities: &HashMap<Entity, (String, String, SpawnedEntityType)>,
    untracked_entities: &HashSet<Entity>,
    tracked_spawned_entities: &HashMap<Entity, (String, String, SpawnedEntityType)>,
    entity: Entity,
    clip_id: u32,
    clip_uid: Uuid,
    source: PlannedPlaybackSource,
    timeline_uid: Uuid,
    intervention_track_id: &str,
    intervention_action_id: &str,
    intervention_action: ActionKind,
    intervention_position: Duration,
    current_position: Duration,
    cue_data_provider: &DataProvider<Cue>,
    sequence_data_provider: Option<&DataProvider<Sequence>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver<'_>,
    intervention_kind: PlannedPlaybackInterventionKind,
) -> Option<PlannedClipRenderTarget> {
    let (origin_track_id, origin_action_id, origin_position) = tracked_spawned_entities
        .get(&entity)
        .or_else(|| {
            (!untracked_entities.contains(&entity))
                .then(|| existing_spawned_entities.get(&entity))
                .flatten()
        })
        .and_then(|(track_id, action_id, spawned_type)| match spawned_type {
            SpawnedEntityType::Clip => {
                tracked_action_position_in(action_positions, track_id, action_id)
                    .map(|position| (track_id.clone(), action_id.clone(), position))
            }
            SpawnedEntityType::Cue | SpawnedEntityType::Instance => None,
        })?;

    let planner_resolver = TimelinePlannerResolver {
        source_by_clip_uid: HashMap::from([(clip_uid, source)]),
        duration_by_source: HashMap::from([(
            source,
            playback_duration_profile_for_source(
                source,
                cue_data_provider,
                sequence_data_provider,
                fixture_data_provider,
                selection_resolver,
            ),
        )]),
    };
    let plan = plan_timeline_at(
        timeline_uid,
        current_position,
        [
            TimelinePlanningAction {
                track_id: origin_track_id,
                action_id: origin_action_id,
                action: ActionKind::StartClip(clip_uid),
                position: origin_position,
                duration: Duration::ZERO,
            },
            TimelinePlanningAction {
                track_id: intervention_track_id.to_owned(),
                action_id: intervention_action_id.to_owned(),
                action: intervention_action,
                position: intervention_position,
                duration: Duration::ZERO,
            },
        ],
        &planner_resolver,
        None,
    );
    let interval = plan
        .instances
        .iter()
        .find(|instance| instance.source == source)?;
    let sequence_uid = match source {
        PlannedPlaybackSource::Sequence(sequence_uid) => sequence_uid,
        _ => return None,
    };
    let sequence_data_provider = sequence_data_provider?;
    let sequence = sequence_data_provider.get(sequence_uid).ok()?;
    let steps = sequence
        .steps
        .iter()
        .map(|cue_uid| cue_data_provider.get(cue_uid.0).map(|cue| cue.clone()))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let mut sequence_playback = SequenceTimelineSeekPlayback::from_sequence_steps(
        clip_id,
        &sequence,
        &steps,
        fixture_data_provider,
        selection_resolver,
        origin_position,
    )?;
    sequence_playback.apply_planned_interval_until(interval, current_position);
    let intervention = interval
        .explicit_interventions
        .iter()
        .find(|intervention| {
            intervention.owner.track_id == intervention_track_id
                && intervention.owner.action_id == intervention_action_id
                && intervention.kind == intervention_kind
        })?;
    let instance = interval.evaluate_at(current_position);
    Some(PlannedClipRenderTarget {
        position: sequence_playback.target().position,
        timing: intervention_reconstruction_timing_from_evaluated_instance(
            &instance,
            intervention,
            timeline_uid,
        ),
    })
}

pub(super) struct TimelinePlannerResolver {
    pub(super) source_by_clip_uid: HashMap<Uuid, PlannedPlaybackSource>,
    pub(super) duration_by_source: HashMap<PlannedPlaybackSource, PlaybackDurationProfile>,
}

impl TimelinePlaybackSourceResolver for TimelinePlannerResolver {
    fn clip_source(&self, clip_uid: Uuid) -> Option<PlannedPlaybackSource> {
        self.source_by_clip_uid.get(&clip_uid).copied()
    }

    fn duration_profile(&self, source: PlannedPlaybackSource) -> PlaybackDurationProfile {
        self.duration_by_source
            .get(&source)
            .copied()
            .unwrap_or_else(PlaybackDurationProfile::unknown)
    }
}

pub(super) fn planned_source_for_clip(clip: &Clip) -> Option<PlannedPlaybackSource> {
    match clip.source.as_ref()? {
        Source::Sequence(uid) => Some(PlannedPlaybackSource::Sequence(*uid)),
        Source::Fx(uid) => Some(PlannedPlaybackSource::Fx(*uid)),
        Source::Flow(uid) => Some(PlannedPlaybackSource::Flow(*uid)),
        Source::StepFx(uid) => Some(PlannedPlaybackSource::StepFx(*uid)),
        Source::FxModule(uid) => Some(PlannedPlaybackSource::FxModule(*uid)),
    }
}

pub(super) fn playback_duration_profile_for_source(
    source: PlannedPlaybackSource,
    cue_data_provider: &DataProvider<Cue>,
    sequence_data_provider: Option<&DataProvider<Sequence>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver<'_>,
) -> PlaybackDurationProfile {
    match source {
        PlannedPlaybackSource::Cue(cue_uid) => cue_data_provider
            .get(cue_uid)
            .ok()
            .map(|cue| {
                fixture_data_provider
                    .cue_duration_profile(&cue, selection_resolver)
                    .to_playback_duration_profile()
            })
            .unwrap_or_else(PlaybackDurationProfile::unknown),
        PlannedPlaybackSource::Sequence(sequence_uid) => sequence_playback_duration_profile(
            sequence_uid,
            sequence_data_provider,
            fixture_data_provider,
            selection_resolver,
        )
        .unwrap_or_else(PlaybackDurationProfile::unknown),
        PlannedPlaybackSource::Fx(_) => PlaybackDurationProfile::indefinite(
            PlaybackExtent::Indefinite,
            PlaybackExtent::Finite(Duration::ZERO),
        ),
        PlannedPlaybackSource::StepFx(_)
        | PlannedPlaybackSource::FxModule(_)
        | PlannedPlaybackSource::Flow(_) => PlaybackDurationProfile::unknown(),
    }
}
