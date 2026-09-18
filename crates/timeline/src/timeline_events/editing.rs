// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::crud::{persist_timeline_mutation, timeline_by_id};
use super::*;

/// Handle timeline marker, region, and loop-range editing commands.
pub(super) fn handle_command(
    context: &mut TimelineMutationContext<'_, '_>,
    event: &CommandEnvelope<TimelineCommand>,
) {
    let TimelineMutationContext {
        timelines,
        timeline_data_provider,
        responder,
        action_events,
        ..
    } = context;

    for event in std::iter::once(event) {
        match &event.command {
            TimelineCommand::StoreTimelineMarker {
                timeline_id,
                marker,
            } => {
                let Some(mut timeline) = timeline_by_id(
                    timeline_data_provider,
                    *timeline_id,
                    "store timeline marker",
                ) else {
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {timeline_id} was not found"),
                    );
                    continue;
                };

                match timeline
                    .markers
                    .iter_mut()
                    .find(|existing| existing.uid == marker.uid)
                {
                    Some(existing) => *existing = marker.clone(),
                    None => timeline.markers.push(marker.clone()),
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
                        "timeline marker",
                    ),
                    format!("Failed to persist marker for timeline {timeline_id}"),
                );
            }

            TimelineCommand::DeleteTimelineMarker {
                timeline_id,
                marker_uid,
            } => {
                let Some(mut timeline) = timeline_by_id(
                    timeline_data_provider,
                    *timeline_id,
                    "delete timeline marker",
                ) else {
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {timeline_id} was not found"),
                    );
                    continue;
                };

                let previous_len = timeline.markers.len();
                timeline.markers.retain(|marker| marker.uid != *marker_uid);
                if timeline.markers.len() == previous_len {
                    tracing::warn!(
                        "Failed to delete marker {} from timeline {}: marker not found",
                        marker_uid,
                        timeline_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Marker {marker_uid} was not found in timeline {timeline_id}"),
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
                        "timeline marker delete",
                    ),
                    format!("Failed to persist marker deletion for timeline {timeline_id}"),
                );
            }

            TimelineCommand::StoreTimelineRegion {
                timeline_id,
                region,
            } => {
                if region.end < region.start {
                    tracing::warn!(
                        "Failed to store region {} for timeline {}: region end is before start",
                        region.uid,
                        timeline_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Region {} ends before it starts", region.uid),
                    );
                    continue;
                }

                let Some(mut timeline) = timeline_by_id(
                    timeline_data_provider,
                    *timeline_id,
                    "store timeline region",
                ) else {
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {timeline_id} was not found"),
                    );
                    continue;
                };

                match timeline
                    .regions
                    .iter_mut()
                    .find(|existing| existing.uid == region.uid)
                {
                    Some(existing) => *existing = region.clone(),
                    None => timeline.regions.push(region.clone()),
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
                        "timeline region",
                    ),
                    format!("Failed to persist region for timeline {timeline_id}"),
                );
            }

            TimelineCommand::DeleteTimelineRegion {
                timeline_id,
                region_uid,
            } => {
                let Some(mut timeline) = timeline_by_id(
                    timeline_data_provider,
                    *timeline_id,
                    "delete timeline region",
                ) else {
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {timeline_id} was not found"),
                    );
                    continue;
                };

                let previous_len = timeline.regions.len();
                timeline.regions.retain(|region| region.uid != *region_uid);
                if timeline.regions.len() == previous_len {
                    tracing::warn!(
                        "Failed to delete region {} from timeline {}: region not found",
                        region_uid,
                        timeline_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Region {region_uid} was not found in timeline {timeline_id}"),
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
                        "timeline region delete",
                    ),
                    format!("Failed to persist region deletion for timeline {timeline_id}"),
                );
            }

            TimelineCommand::SetTimelineLoopRange {
                timeline_id,
                loop_range,
            } => {
                if let Some(loop_range) = loop_range {
                    if loop_range.end < loop_range.start {
                        tracing::warn!(
                            "Failed to set loop range for timeline {}: loop end is before start",
                            timeline_id
                        );
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            "Timeline loop range ends before it starts".to_owned(),
                        );
                        continue;
                    }
                }

                let Some(mut timeline) = timeline_by_id(
                    timeline_data_provider,
                    *timeline_id,
                    "set timeline loop range",
                ) else {
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {timeline_id} was not found"),
                    );
                    continue;
                };
                timeline.loop_range = loop_range.clone();

                finish_persisted_timeline_command(
                    responder,
                    event.command_id,
                    persist_timeline_mutation(
                        timeline,
                        *timeline_id,
                        timeline_data_provider,
                        timelines,
                        action_events.as_mut(),
                        "timeline loop range",
                    ),
                    format!("Failed to persist loop range for timeline {timeline_id}"),
                );
            }

            _ => return,
        }
    }
}
