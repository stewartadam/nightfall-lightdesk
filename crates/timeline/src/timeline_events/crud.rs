// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::cleanup::release_timeline_owned_entities;
use super::*;
use crate::prelude::TIMELINE_FIRE_CUE_ACTION_ID;

/// Live-relevant identity for an active timeline action.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TimelineActionSignature {
    /// Track ID that owns the action.
    track_id: String,
    /// Action ID within the track.
    action_id: String,
    /// Action position on the timeline.
    position: Duration,
    /// Action duration when it affects live playback semantics.
    duration: Option<Duration>,
    /// Stored action reference; any change to it can change live playback.
    action: ActionReference,
}

/// Returns action duration only when duration affects live playback output.
///
/// Only fired cues last for their action's duration; other actions are instantaneous.
fn timeline_action_relevant_duration(
    action: &ActionReference,
    duration: Duration,
) -> Option<Duration> {
    (action.id.as_str() == TIMELINE_FIRE_CUE_ACTION_ID).then_some(duration)
}

/// Builds active live action signatures for a timeline under current mute and solo state.
fn active_timeline_action_signatures(timeline: &Timeline) -> Vec<TimelineActionSignature> {
    let solo_mode = timeline.tracks.iter().any(|track| track.solo);
    timeline
        .tracks
        .iter()
        .filter(|track| !track.muted && (!solo_mode || track.solo))
        .flat_map(|track| {
            track
                .actions
                .iter()
                .map(|timeline_action| TimelineActionSignature {
                    track_id: track.id.clone(),
                    action_id: timeline_action.id.clone(),
                    position: timeline_action.position,
                    duration: timeline_action_relevant_duration(
                        &timeline_action.action,
                        timeline_action.duration,
                    ),
                    action: timeline_action.action.clone(),
                })
        })
        .collect::<Vec<_>>()
}

/// Returns whether a timeline store changed live-relevant active action state.
fn active_timeline_actions_changed(previous: &Timeline, current: &Timeline) -> bool {
    active_timeline_action_signatures(previous) != active_timeline_action_signatures(current)
}

/// Apply persisted timeline state and report whether live action reconstruction is required.
pub(super) fn apply_stored_timeline_to_materialized(
    materialized_timeline: &mut MaterializedTimeline,
    timeline: &Timeline,
) -> bool {
    let should_reconstruct_live_items = materialized_timeline.is_active
        && active_timeline_actions_changed(&materialized_timeline.timeline, timeline);

    if materialized_timeline.timeline.audio_enabled != timeline.audio_enabled
        || materialized_timeline.timeline.timecode_start != timeline.timecode_start
    {
        materialized_timeline.audio_needs_sync = true;
    }
    materialized_timeline.timeline = timeline.clone();
    should_reconstruct_live_items
}

/// Persist a timeline mutation, synchronize materialized copies, and request reconstruction when needed.
pub(super) fn persist_timeline_mutation(
    timeline: Timeline,
    timeline_id: u32,
    timeline_data_provider: &mut DataProvider<Timeline>,
    timelines: &mut Query<(Entity, &mut MaterializedTimeline)>,
    action_events: Option<&mut MessageWriter<TimelineActionsChanged>>,
    operation: &str,
) -> bool {
    if let Err(error) = timeline_data_provider.add(timeline.clone()) {
        tracing::warn!(
            "Failed to persist {} for timeline {}: {}",
            operation,
            timeline_id,
            error
        );
        return false;
    }

    let mut live_items_changed = false;
    for (_, mut materialized_timeline) in timelines
        .iter_mut()
        .filter(|(_, mtimeline)| mtimeline.timeline.identifiers.id == timeline_id)
    {
        live_items_changed |=
            apply_stored_timeline_to_materialized(&mut materialized_timeline, &timeline);
    }

    if live_items_changed {
        if let Some(action_events) = action_events {
            action_events.write(TimelineActionsChanged { timeline_id });
        }
    }

    true
}

/// Load an owned timeline value for a mutation and log missing targets consistently.
pub(super) fn timeline_by_id(
    timeline_data_provider: &DataProvider<Timeline>,
    timeline_id: u32,
    operation: &str,
) -> Option<Timeline> {
    match timeline_data_provider.from_id(timeline_id) {
        Ok(timeline_ref) => Some((*timeline_ref).clone()),
        Err(error) => {
            tracing::warn!(
                "Failed to {} for timeline {}: {}",
                operation,
                timeline_id,
                error
            );
            None
        }
    }
}

/// Handle timeline storage, rename, and deletion commands.
pub(super) fn handle_command(
    context: &mut TimelineMutationContext<'_, '_>,
    event: &CommandEnvelope<TimelineCommand>,
) {
    let TimelineMutationContext {
        commands,
        timelines,
        clip_query,
        instance_clocks,
        timeline_data_provider,
        recording,
        beatgrid_runtime,
        broadcaster,
        ev_clip,
        timeline_command_origins,
        responder,
        action_events,
        ..
    } = context;

    for event in std::iter::once(event) {
        match &event.command {
            TimelineCommand::StoreTimeline(timeline) => {
                tracing::debug!("Storing timeline with ID: {}", timeline.identifiers.id);
                let existing_timeline = timeline_data_provider
                    .get(timeline.identifiers.uid)
                    .ok()
                    .map(|existing| (*existing).clone());

                // Store in DataProvider
                if let Err(e) = timeline_data_provider.add(timeline.clone()) {
                    tracing::warn!("Failed to store timeline: {}", e);
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Failed to store timeline: {}", e),
                    );
                    continue;
                }

                // Update or create MaterializedTimeline
                let existing: Vec<_> = timelines
                    .iter_mut()
                    .filter(|(_, m_timeline)| {
                        m_timeline.timeline.identifiers.id == timeline.identifiers.id
                    })
                    .collect();

                if !existing.is_empty() {
                    let mut live_items_changed = false;
                    for (_, mut m_timeline) in existing {
                        tracing::debug!(
                            "Updating existing timeline with ID: {}",
                            timeline.identifiers.id
                        );
                        live_items_changed |=
                            apply_stored_timeline_to_materialized(&mut m_timeline, timeline);
                    }
                    if live_items_changed {
                        if let Some(action_events) = action_events.as_mut() {
                            action_events.write(TimelineActionsChanged {
                                timeline_id: timeline.identifiers.id,
                            });
                        }
                    }
                } else {
                    tracing::debug!(
                        "Creating materialized timeline with ID: {}",
                        timeline.identifiers.id
                    );
                    commands.spawn(MaterializedTimeline::new(timeline.clone()));
                }

                let should_auto_detect = existing_timeline
                    .as_ref()
                    .is_none_or(|existing| existing.audio_path != timeline.audio_path)
                    && !timeline.audio_path.trim().is_empty();

                if should_auto_detect {
                    crate::beatgrid_detection::request_detection_for_timeline(
                        beatgrid_runtime,
                        broadcaster,
                        timeline,
                        crate::beatgrid_detection::BeatgridDetectionTrigger::Automatic,
                    );
                }

                succeed_timeline_command(responder, event.command_id);
            }

            TimelineCommand::RenameTimeline { id, new_id } => {
                tracing::debug!("Renaming timeline with ID: {} to {}", id, new_id);

                // Update in DataProvider
                let Ok(mut timeline) = timeline_data_provider.from_id(*id).map(|tl| tl.clone())
                else {
                    tracing::warn!("Failed to rename timeline {} -> {}: not found", id, new_id);
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {id} was not found"),
                    );
                    continue;
                };
                timeline.identifiers.id = *new_id;
                if let Err(error) = timeline_data_provider.add(timeline) {
                    tracing::warn!("Failed to rename timeline {} -> {}: {}", id, new_id, error);
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Failed to rename timeline {id} to {new_id}: {error}"),
                    );
                    continue;
                }

                // Update MaterializedTimeline
                timelines
                    .iter_mut()
                    .filter(|(_, mtimeline)| mtimeline.timeline.identifiers.id == *id)
                    .for_each(|(entity, ref mut mtimeline)| {
                        tracing::trace!(
                            %entity,
                            "Processed rename for materialized timeline"
                        );
                        mtimeline.timeline.identifiers.id = *new_id;
                    });
                succeed_timeline_command(responder, event.command_id);
            }

            TimelineCommand::DeleteTimeline(id) => {
                tracing::debug!("Deleting timeline with ID: {}", id);

                // Remove from DataProvider
                let Ok(uid) = timeline_data_provider
                    .from_id(*id)
                    .map(|tl| tl.identifiers.uid)
                else {
                    tracing::warn!("Failed to delete timeline {}: not found", id);
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {id} was not found"),
                    );
                    continue;
                };
                if let Err(error) = timeline_data_provider.remove(&uid) {
                    tracing::warn!("Failed to delete timeline {}: {}", id, error);
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Failed to delete timeline {id}: {error}"),
                    );
                    continue;
                }
                recording.states.remove(*id);
                recording.sessions.remove(*id);

                // Remove MaterializedTimeline
                timelines
                    .iter_mut()
                    .filter(|(_, mtimeline)| mtimeline.timeline.identifiers.id == *id)
                    .for_each(|(entity, mtimeline)| {
                        release_timeline_owned_entities(
                            commands,
                            clip_query,
                            instance_clocks,
                            ev_clip,
                            timeline_command_origins,
                            &mtimeline,
                        );
                        tracing::trace!(
                            %entity,
                            "Processed delete for materialized timeline"
                        );
                        tracing::debug!(
                            "Timeline {} timecode deleted, removing from materialized",
                            mtimeline.timeline.identifiers.id
                        );
                        commands.entity(entity).despawn();
                    });
                succeed_timeline_command(responder, event.command_id);
            }

            _ => return,
        }
    }
}
