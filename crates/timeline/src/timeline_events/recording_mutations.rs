// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::beatgrid::{apply_millis_delta_clamped, apply_millis_delta_preserve_span};
use super::crud::{persist_timeline_mutation, timeline_by_id};
use super::*;

/// Persist actions captured by one completed recording session.
fn insert_recorded_actions(
    timeline_id: u32,
    track_id: &str,
    actions: &[Action],
    timeline_data_provider: &mut DataProvider<Timeline>,
    timelines: &mut Query<(Entity, &mut MaterializedTimeline)>,
    recording_states: &mut TimelineRecordingStates,
    action_events: Option<&mut MessageWriter<TimelineActionsChanged>>,
) -> Result<(), String> {
    if actions.is_empty() {
        return Ok(());
    }

    let mut timeline = timeline_by_id(
        timeline_data_provider,
        timeline_id,
        "insert recorded timeline actions",
    )
    .ok_or_else(|| format!("Timeline {timeline_id} was not found"))?;

    if !timeline.tracks.iter().any(|track| track.id == track_id) {
        timeline.tracks.push(Track {
            id: track_id.to_owned(),
            label: "Recorded Actions".to_string(),
            muted: false,
            solo: false,
            expanded: false,
            actions: Vec::new(),
            automation_lanes: Vec::new(),
        });
        recording_states.set_target_track(timeline_id, Some(track_id.to_owned()));
    }

    let track = timeline
        .tracks
        .iter_mut()
        .find(|track| track.id == track_id)
        .ok_or_else(|| format!("Track {track_id} was not found in timeline {timeline_id}"))?;
    track.actions.extend(actions.iter().cloned());

    persist_timeline_mutation(
        timeline,
        timeline_id,
        timeline_data_provider,
        timelines,
        action_events,
        "recorded timeline actions",
    )
    .then_some(())
    .ok_or_else(|| format!("Failed to persist recorded actions for timeline {timeline_id}"))
}

/// Handle recording state and recorded timeline action mutation commands.
pub(super) fn handle_command(
    context: &mut TimelineMutationContext<'_, '_>,
    event: &CommandEnvelope<TimelineCommand>,
) {
    let TimelineMutationContext {
        timelines,
        timeline_data_provider,
        recording,
        responder,
        action_events,
        ..
    } = context;

    for event in std::iter::once(event) {
        match &event.command {
            TimelineCommand::SetTimelineRecording {
                timeline_id,
                enabled,
                target_track_id,
            } => {
                recording
                    .states
                    .set(*timeline_id, *enabled, target_track_id.clone());
                succeed_timeline_command(responder, event.command_id);
            }

            TimelineCommand::InsertRecordedActions {
                timeline_id,
                track_id,
                actions,
            } => {
                match insert_recorded_actions(
                    *timeline_id,
                    track_id,
                    actions,
                    timeline_data_provider,
                    timelines,
                    &mut recording.states,
                    action_events.as_mut(),
                ) {
                    Ok(()) => succeed_timeline_command(responder, event.command_id),
                    Err(error) => fail_timeline_command(responder, event.command_id, error),
                }
            }

            TimelineCommand::DeleteRecordedActions {
                timeline_id,
                track_id,
                action_ids,
            } => {
                if action_ids.is_empty() {
                    succeed_timeline_command(responder, event.command_id);
                    continue;
                }

                let Some(mut timeline) = timeline_by_id(
                    timeline_data_provider,
                    *timeline_id,
                    "delete recorded timeline actions",
                ) else {
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {timeline_id} was not found"),
                    );
                    continue;
                };

                let Some(track) = timeline
                    .tracks
                    .iter_mut()
                    .find(|track| track.id == *track_id)
                else {
                    tracing::warn!(
                        "Failed to delete recorded actions from timeline {}: track {} not found",
                        timeline_id,
                        track_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Track {track_id} was not found in timeline {timeline_id}"),
                    );
                    continue;
                };

                let action_ids = action_ids.iter().collect::<std::collections::HashSet<_>>();
                let previous_len = track.actions.len();
                track
                    .actions
                    .retain(|action| !action_ids.contains(&action.id));
                if track.actions.len() == previous_len {
                    tracing::warn!(
                        "Failed to delete recorded actions from timeline {}: no actions matched",
                        timeline_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("No requested actions were found in timeline {timeline_id}"),
                    );
                    continue;
                }

                finish_persisted_timeline_command(
                    responder,
                    event.command_id,
                    persist_timeline_mutation(
                        timeline,
                        *timeline_id,
                        timeline_data_provider,
                        timelines,
                        action_events.as_mut(),
                        "delete recorded timeline actions",
                    ),
                    format!("Failed to persist action deletion for timeline {timeline_id}"),
                );
            }

            TimelineCommand::NudgeTimelineSelection {
                timeline_id,
                selection,
                delta_ms,
            } => {
                if *delta_ms == 0 || selection.is_empty() {
                    succeed_timeline_command(responder, event.command_id);
                    continue;
                }

                let Some(mut timeline) = timeline_by_id(
                    timeline_data_provider,
                    *timeline_id,
                    "nudge timeline selection",
                ) else {
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {timeline_id} was not found"),
                    );
                    continue;
                };

                let mut changed = false;
                for target in selection {
                    match target {
                        TimelineSelection::Action {
                            track_id,
                            action_id,
                        } => {
                            let Some(action) = timeline
                                .tracks
                                .iter_mut()
                                .find(|track| track.id == *track_id)
                                .and_then(|track| {
                                    track
                                        .actions
                                        .iter_mut()
                                        .find(|action| action.id == *action_id)
                                })
                            else {
                                continue;
                            };
                            action.position =
                                apply_millis_delta_clamped(action.position, *delta_ms);
                            changed = true;
                        }
                        TimelineSelection::Marker { marker_uid } => {
                            let Some(marker) = timeline
                                .markers
                                .iter_mut()
                                .find(|marker| marker.uid == *marker_uid)
                            else {
                                continue;
                            };
                            marker.time = apply_millis_delta_clamped(marker.time, *delta_ms);
                            changed = true;
                        }
                        TimelineSelection::RegionBody { region_uid } => {
                            let Some(region) = timeline
                                .regions
                                .iter_mut()
                                .find(|region| region.uid == *region_uid)
                            else {
                                continue;
                            };
                            let (start, end) = apply_millis_delta_preserve_span(
                                region.start,
                                region.end,
                                *delta_ms,
                            );
                            region.start = start;
                            region.end = end;
                            changed = true;
                        }
                        TimelineSelection::RegionStart { region_uid } => {
                            let Some(region) = timeline
                                .regions
                                .iter_mut()
                                .find(|region| region.uid == *region_uid)
                            else {
                                continue;
                            };
                            let start = apply_millis_delta_clamped(region.start, *delta_ms);
                            region.start = start.min(region.end);
                            changed = true;
                        }
                        TimelineSelection::RegionEnd { region_uid } => {
                            let Some(region) = timeline
                                .regions
                                .iter_mut()
                                .find(|region| region.uid == *region_uid)
                            else {
                                continue;
                            };
                            let end = apply_millis_delta_clamped(region.end, *delta_ms);
                            region.end = end.max(region.start);
                            changed = true;
                        }
                    }
                }

                if !changed {
                    tracing::warn!(
                        "Failed to nudge selection for timeline {}: no selected targets found",
                        timeline_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("No selected targets were found in timeline {timeline_id}"),
                    );
                    continue;
                }

                finish_persisted_timeline_command(
                    responder,
                    event.command_id,
                    persist_timeline_mutation(
                        timeline,
                        *timeline_id,
                        timeline_data_provider,
                        timelines,
                        action_events.as_mut(),
                        "timeline selection nudge",
                    ),
                    format!("Failed to persist selection nudge for timeline {timeline_id}"),
                );
            }

            _ => return,
        }
    }
}

/// Apply one internally generated recorded-action action to persisted timeline state.
pub(super) fn handle_action(
    context: &mut TimelineMutationContext<'_, '_>,
    event: &EngineActionEnvelope<TimelineAction>,
) {
    let TimelineMutationContext {
        timelines,
        timeline_data_provider,
        recording,
        action_events,
        ..
    } = context;
    let TimelineAction::InsertRecordedActions {
        timeline_id,
        track_id,
        actions,
    } = &event.action
    else {
        return;
    };
    if let Err(error) = insert_recorded_actions(
        *timeline_id,
        track_id,
        actions,
        timeline_data_provider,
        timelines,
        &mut recording.states,
        action_events.as_mut(),
    ) {
        tracing::error!(
            operation_id = %event.operation_id,
            %error,
            "recorded_timeline_items_action_failed"
        );
    }
}
