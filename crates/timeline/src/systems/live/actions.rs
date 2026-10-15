// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Dispatch of individual timeline actions triggered during a live scan.

use nightfall_actions::ActionReference;

use super::*;
use crate::prelude::{Action, Track};

/// A triggered timeline action together with its owning track and resolved kind.
struct TriggeredAction<'a> {
    /// Track that owns the action.
    track: &'a Track,
    /// Stored timeline action.
    action: &'a Action,
    /// Action kind resolved against the action registry.
    kind: &'a ActionKind,
}

/// Sequence navigation requested by an advance, back, or jump-to-cue action.
struct SequenceNavigation {
    /// Clip whose attached sequence navigates.
    clip_uid: Uuid,
    /// Action label logged when the clip cannot be resolved.
    lookup_context: &'static str,
    /// Planner intervention used to reconstruct the navigation's render target.
    intervention: PlannedPlaybackInterventionKind,
}

/// Emits the live effect of one action the timeline playhead just crossed.
///
/// Registered actions the timeline does not handle natively are forwarded as action
/// invocations. Every other kind emits clip, desk, or cue materialization requests and records
/// the playback entities the timeline now owns in `scan`.
pub(super) fn dispatch_triggered_action(
    sources: &TimelineLiveActionSources,
    sinks: &mut TimelineLiveActionSinks,
    scan: &mut TimelineActionScan,
    track: &Track,
    timeline_action: &Action,
) {
    tracing::debug!(
        action_id = %timeline_action.id,
        position = ?scan.current_position,
        "Triggering action"
    );
    let resolved_action = timeline_action.kind(sources.action_registry.as_deref());
    if let ActionKind::RegisteredAction(registered_action) = &resolved_action {
        invoke_registered_action(sinks, scan.timeline_id, timeline_action, registered_action);
        return;
    }
    let triggered = TriggeredAction {
        track,
        action: timeline_action,
        kind: &resolved_action,
    };

    match &resolved_action {
        ActionKind::FireCue(cue_uid) => fire_cue(sources, sinks, scan, &triggered, *cue_uid),
        ActionKind::StartClip(clip_uid) => start_clip(sources, sinks, scan, &triggered, *clip_uid),
        ActionKind::StopClip(clip_uid) => stop_clip(sources, sinks, scan, &triggered, *clip_uid),
        ActionKind::AdvanceSequence(clip_id) => {
            tracing::debug!("Advancing sequence on clip {}", clip_id);
            navigate_sequence(
                sources,
                sinks,
                scan,
                &triggered,
                SequenceNavigation {
                    clip_uid: *clip_id,
                    lookup_context: "advance-sequence",
                    intervention: PlannedPlaybackInterventionKind::SequenceGo,
                },
                |id| ClipOperation::Go(IdExpr::Single(id)),
            );
        }
        ActionKind::BackSequence(clip_id) => {
            tracing::debug!("Going back in sequence on clip {}", clip_id);
            navigate_sequence(
                sources,
                sinks,
                scan,
                &triggered,
                SequenceNavigation {
                    clip_uid: *clip_id,
                    lookup_context: "back-sequence",
                    intervention: PlannedPlaybackInterventionKind::SequenceBack,
                },
                |id| ClipOperation::Back(IdExpr::Single(id)),
            );
        }
        ActionKind::SetClipRate { uid, rate } => {
            set_clip_rate(sinks, scan, &triggered, *uid, *rate);
        }
        ActionKind::JumpToCue { uid, cue_index } => {
            tracing::debug!("Jumping to cue {} on clip {}", cue_index, uid);
            let cue_index = *cue_index;
            navigate_sequence(
                sources,
                sinks,
                scan,
                &triggered,
                SequenceNavigation {
                    clip_uid: *uid,
                    lookup_context: "jump-to-cue",
                    intervention: PlannedPlaybackInterventionKind::SequenceGotoCue(cue_index),
                },
                |id| ClipOperation::Goto {
                    clip_id: IdExpr::Single(id),
                    position: cue_index,
                    timing: None,
                },
            );
        }
        ActionKind::DeskEval(command) => {
            dispatch_desk_eval(sources, sinks, scan, &triggered, command)
        }
        ActionKind::RegisteredAction(registered_action) => {
            tracing::debug!(
                ?registered_action,
                "Ignoring unsupported registered timeline action"
            );
        }
    }
}

/// Forwards a registered domain action as a timeline-surface action invocation.
fn invoke_registered_action(
    sinks: &mut TimelineLiveActionSinks,
    timeline_id: u32,
    timeline_action: &Action,
    registered_action: &ActionReference,
) {
    if let Some(action_invocations) = sinks.action_invocations.as_mut() {
        action_invocations.write(
            ActionInvocation::trigger(registered_action.clone(), ActionSurface::Timeline)
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
}

/// Plans one timeline action in isolation and returns its evaluated playback, if any.
///
/// `source` is the playback the action drives; its duration profile is resolved from the
/// live cue and fixture data. `source_by_clip_uid` maps clip actions to that source.
fn evaluate_isolated_action(
    sources: &TimelineLiveActionSources,
    timeline_uid: Uuid,
    current_position: Duration,
    track_id: &str,
    action: &Action,
    kind: ActionKind,
    source: PlannedPlaybackSource,
    source_by_clip_uid: HashMap<Uuid, PlannedPlaybackSource>,
) -> Option<EvaluatedInstanceState> {
    let planner_resolver = TimelinePlannerResolver {
        source_by_clip_uid,
        duration_by_source: HashMap::from([(
            source,
            playback_duration_profile_for_source(
                source,
                &sources.source_data.cue_data_provider,
                None,
                &sources.source_data.fixture_data_provider,
                &sources.selection_resolver,
            ),
        )]),
    };
    plan_timeline_at(
        timeline_uid,
        current_position,
        [TimelinePlanningAction {
            track_id: track_id.to_owned(),
            action_id: action.id.clone(),
            action: kind,
            position: action.position,
            duration: action.duration,
        }],
        &planner_resolver,
    )
    .evaluate()
    .instances
    .into_iter()
    .find(|playback| playback.owner.track_id == track_id && playback.owner.action_id == action.id)
}

/// Materializes a fired cue at its planned playback position and tracks it as timeline-owned.
fn fire_cue(
    sources: &TimelineLiveActionSources,
    sinks: &mut TimelineLiveActionSinks,
    scan: &mut TimelineActionScan,
    triggered: &TriggeredAction,
    cue_uid: Uuid,
) {
    tracing::debug!("Materializing cue {} from timeline FireCue action", cue_uid);
    let Some(playback) = evaluate_isolated_action(
        sources,
        scan.timeline_uid,
        scan.current_position,
        &triggered.track.id,
        triggered.action,
        triggered.kind.clone(),
        PlannedPlaybackSource::Cue(cue_uid),
        HashMap::new(),
    ) else {
        return;
    };
    let source_data = &sources.source_data;
    if let Some(entity) = materialize_evaluated_fire_cue(
        &mut sinks.commands,
        &playback,
        scan.timeline_uid,
        &source_data.cue_data_provider,
        source_data.color_path_data_provider.as_deref(),
        source_data.blueprint_data_provider.as_deref(),
        &source_data.fixture_data_provider,
        &sources.selection_resolver,
        &sources.parameter_query,
    ) {
        debug_assert!(
            !triggered.track.id.is_empty(),
            "Timeline track id should not be empty when tracking spawned entities"
        );
        scan.entities_to_track.insert(
            entity,
            (
                triggered.track.id.clone(),
                triggered.action.id.clone(),
                SpawnedEntityType::Cue,
            ),
        );
    }
}

/// Starts a clip at the timing planned for the action and tracks it as timeline-owned.
///
/// Clips with a plannable source start at their evaluated reconstruction timing; others start
/// at the action position.
fn start_clip(
    sources: &TimelineLiveActionSources,
    sinks: &mut TimelineLiveActionSinks,
    scan: &mut TimelineActionScan,
    triggered: &TriggeredAction,
    clip_uid: Uuid,
) {
    tracing::debug!("Starting clip {}", clip_uid);
    let Some((entity, id)) =
        resolve_clip_entity_and_id(scan.clip_snapshot, &clip_uid, "start-clip")
    else {
        return;
    };
    let timing = if let Some(source) = sources
        .clip_state
        .exec_query
        .get(entity)
        .ok()
        .and_then(|(_, clip)| planned_source_for_clip(clip))
    {
        let Some(playback) = evaluate_isolated_action(
            sources,
            scan.timeline_uid,
            scan.current_position,
            &triggered.track.id,
            triggered.action,
            triggered.kind.clone(),
            source,
            HashMap::from([(clip_uid, source)]),
        ) else {
            return;
        };
        reconstruction_timing_from_evaluated_instance(&playback, scan.timeline_uid)
    } else {
        PlaybackReconstructionTiming::timeline(
            triggered.action.position,
            scan.current_position,
            scan.timeline_uid,
            triggered.action.position,
        )
    };
    write_timeline_clip_action(
        &mut sinks.ev_clip,
        &mut sinks.timeline_command_origins,
        ClipOperation::StartAtTiming {
            clip_id: IdExpr::Single(id),
            timing,
            instance_options: scan.instance_options,
        },
    );
    track_timeline_clip_entity(
        &mut scan.entities_to_track,
        &mut scan.active_clip_entities,
        entity,
        &triggered.track.id,
        &triggered.action.id,
    );
}

/// Stops a clip, releasing at the planned timing when one exists, and untracks it.
fn stop_clip(
    sources: &TimelineLiveActionSources,
    sinks: &mut TimelineLiveActionSinks,
    scan: &mut TimelineActionScan,
    triggered: &TriggeredAction,
    clip_uid: Uuid,
) {
    tracing::debug!("Stopping clip {}", clip_uid);
    let Some((entity, id)) = resolve_clip_entity_and_id(scan.clip_snapshot, &clip_uid, "stop-clip")
    else {
        return;
    };
    let command = sources
        .clip_state
        .exec_query
        .get(entity)
        .ok()
        .and_then(|(_, clip)| planned_source_for_clip(clip))
        .and_then(|source| {
            planned_release_reconstruction_timing_for_clip_stop(
                &scan.action_positions,
                &scan.existing_spawned_entities,
                &scan.entities_to_untrack,
                &scan.entities_to_track,
                entity,
                clip_uid,
                source,
                scan.timeline_uid,
                &triggered.track.id,
                &triggered.action.id,
                triggered.action.position,
                scan.current_position,
                &sources.source_data.cue_data_provider,
                &sources.source_data.fixture_data_provider,
                &sources.selection_resolver,
            )
        })
        .map(|timing| ClipOperation::StopAtTiming {
            clip_id: IdExpr::Single(id),
            timing,
        })
        .unwrap_or(ClipOperation::Stop(IdExpr::Single(id)));
    write_timeline_clip_action(
        &mut sinks.ev_clip,
        &mut sinks.timeline_command_origins,
        command,
    );
    scan.active_clip_entities.remove(&entity);
    scan.entities_to_track.remove(&entity);
    scan.entities_to_untrack.insert(entity);
}

/// Navigates a clip's sequence, rendering at the planned target when one can be reconstructed.
///
/// Without a plannable target the plain navigation operation built by `fallback` from the clip
/// ID is sent instead. The clip is tracked as timeline-owned without taking over playback the
/// timeline did not start.
fn navigate_sequence(
    sources: &TimelineLiveActionSources,
    sinks: &mut TimelineLiveActionSinks,
    scan: &mut TimelineActionScan,
    triggered: &TriggeredAction,
    navigation: SequenceNavigation,
    fallback: impl FnOnce(u32) -> ClipOperation,
) {
    let Some((entity, id)) = resolve_clip_entity_and_id(
        scan.clip_snapshot,
        &navigation.clip_uid,
        navigation.lookup_context,
    ) else {
        return;
    };
    let render_command = sources
        .clip_state
        .exec_query
        .get(entity)
        .ok()
        .and_then(|(_, clip)| planned_source_for_clip(clip))
        .and_then(|source| {
            planned_intervention_render_target_for_clip_action(
                &scan.planning_actions,
                &scan.action_positions,
                &scan.existing_spawned_entities,
                &scan.entities_to_untrack,
                &scan.entities_to_track,
                entity,
                id,
                navigation.clip_uid,
                source,
                scan.timeline_uid,
                &triggered.track.id,
                &triggered.action.id,
                triggered.kind.clone(),
                triggered.action.position,
                scan.current_position,
                &sources.source_data.cue_data_provider,
                sources.source_data.sequence_data_provider.as_deref(),
                &sources.source_data.fixture_data_provider,
                &sources.selection_resolver,
                navigation.intervention,
            )
        })
        .map(|render_target| ClipOperation::RenderAt {
            clip_id: IdExpr::Single(id),
            position: render_target.position,
            timing: render_target.timing,
            instance_options: scan.instance_options,
        });
    write_timeline_clip_action(
        &mut sinks.ev_clip,
        &mut sinks.timeline_command_origins,
        render_command.unwrap_or_else(|| fallback(id)),
    );
    track_navigated_clip(scan, triggered, entity);
}

/// Tracks a clip the timeline acted on without starting it, preserving an existing owner.
fn track_navigated_clip(
    scan: &mut TimelineActionScan,
    triggered: &TriggeredAction,
    entity: Entity,
) {
    track_timeline_clip_navigation_entity(
        &scan.existing_spawned_entities,
        &scan.entities_to_untrack,
        &mut scan.entities_to_track,
        &mut scan.active_clip_entities,
        entity,
        &triggered.track.id,
        &triggered.action.id,
    );
}

/// Changes a clip's playback rate and tracks the clip as timeline-touched.
fn set_clip_rate(
    sinks: &mut TimelineLiveActionSinks,
    scan: &mut TimelineActionScan,
    triggered: &TriggeredAction,
    clip_uid: Uuid,
    rate: f32,
) {
    tracing::debug!("Setting clip {} playback rate to {}", clip_uid, rate);
    let Some((entity, id)) =
        resolve_clip_entity_and_id(scan.clip_snapshot, &clip_uid, "set-clip-rate")
    else {
        return;
    };
    write_timeline_clip_action(
        &mut sinks.ev_clip,
        &mut sinks.timeline_command_origins,
        ClipOperation::SetRate {
            clip_id: IdExpr::Single(id),
            rate,
        },
    );
    track_navigated_clip(scan, triggered, entity);
}

/// Sends a desk command and updates clip ownership for the clips it starts or stops.
fn dispatch_desk_eval(
    sources: &TimelineLiveActionSources,
    sinks: &mut TimelineLiveActionSinks,
    scan: &mut TimelineActionScan,
    triggered: &TriggeredAction,
    command: &str,
) {
    tracing::debug!("Dispatching timeline desk eval action: {}", command);
    write_timeline_desk_action(
        &mut sinks.ev_desk,
        &mut sinks.timeline_command_origins,
        command.to_owned(),
    );
    for tracking in desk_eval_clip_tracking(command, &sources.clip_state.exec_query) {
        match tracking {
            DeskEvalClipTracking::Track {
                entity,
                preserve_existing_origin,
            } => {
                if preserve_existing_origin {
                    track_navigated_clip(scan, triggered, entity);
                } else {
                    track_timeline_clip_entity(
                        &mut scan.entities_to_track,
                        &mut scan.active_clip_entities,
                        entity,
                        &triggered.track.id,
                        &triggered.action.id,
                    );
                }
            }
            DeskEvalClipTracking::Untrack(entity) => {
                scan.active_clip_entities.remove(&entity);
                scan.entities_to_track.remove(&entity);
                scan.entities_to_untrack.insert(entity);
            }
        }
    }
}

/// Collects release timings for bounded fired cues the timeline still owns.
///
/// Each entry holds the cue entity, its release timing, and whether the cue's playback has
/// fully ended so it can be untracked.
pub(super) fn bounded_cue_releases(
    sources: &TimelineLiveActionSources,
    timeline: &MaterializedTimeline,
    timeline_uid: Uuid,
    current_position: Duration,
) -> Vec<(Entity, PlaybackReleaseTiming, bool)> {
    timeline
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
                .and_then(|track| track.actions.iter().find(|action| action.id == *action_id))?;
            let resolved_action = action.kind(sources.action_registry.as_deref());
            let ActionKind::FireCue(cue_uid) = &resolved_action else {
                return None;
            };
            if action.duration.is_zero() {
                return None;
            }
            let Some(playback) = evaluate_isolated_action(
                sources,
                timeline_uid,
                current_position,
                track_id,
                action,
                resolved_action.clone(),
                PlannedPlaybackSource::Cue(*cue_uid),
                HashMap::new(),
            ) else {
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
        .collect()
}
