// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Resolve a materialized timecode UID from its operator-facing numeric ID.
fn timecode_uid_for_id(
    timecode_query: &Query<(Entity, &TimecodeGenerator)>,
    timecode_id: u32,
) -> Option<Uuid> {
    timecode_query.iter().find_map(|(_, timecode)| {
        (timecode.timecode.identifiers.id == timecode_id)
            .then_some(timecode.timecode.identifiers.uid)
    })
}

/// Apply timecode lifecycle signals to timelines that follow the affected source.
pub fn handle_timecode_events(
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    mut event_reader: MessageReader<TimecodeEvent>,
    mut timeline_actions: MessageWriter<EngineActionEnvelope<TimelineAction>>,
) {
    for event in event_reader.read() {
        match event {
            TimecodeEvent::Started(id) => {
                let Some(timecode_uid) = timecode_uid_for_id(&timecode_query, *id) else {
                    continue;
                };
                tracing::debug!(
                    "Activating timelines associated to timecode with ID: {}",
                    id
                );
                // Find and activate all timelines associated with this timecode
                for (_, mut timeline) in timeline_query.iter_mut().filter(|(_, tl)| {
                    tl.timeline.timecode_uid == timecode_uid
                        && tl.timeline.trigger_mode == TimelineTriggerMode::FollowTimecode
                }) {
                    // If timeline is already active, just mark it for audio sync
                    // This handles resuming after a pause
                    if timeline.is_active {
                        tracing::debug!(
                            "Resuming timeline {} associated with timecode {}",
                            timeline.timeline.identifiers.id,
                            id
                        );
                        timeline.audio_needs_sync = true;
                    } else {
                        // Otherwise fully activate the timeline
                        tracing::debug!(
                            "Auto-starting timeline {} associated with timecode {}",
                            timeline.timeline.identifiers.id,
                            id
                        );
                        timeline.activate();
                    }
                    // Audio handling is done in handle_timeline_audio_system
                }
            }

            TimecodeEvent::Paused(id) => {
                let Some(timecode_uid) = timecode_uid_for_id(&timecode_query, *id) else {
                    continue;
                };
                tracing::debug!("Pausing timelines associated to timecode with ID: {}", id);
                // Find and pause audio for all timelines associated with this timecode
                for (_, mut timeline) in timeline_query.iter_mut().filter(|(_, tl)| {
                    tl.timeline.timecode_uid == timecode_uid
                        && tl.timeline.trigger_mode == TimelineTriggerMode::FollowTimecode
                        && tl.is_active
                }) {
                    tracing::debug!(
                        "Auto-pausing timeline {} associated with timecode {}",
                        timeline.timeline.identifiers.id,
                        id
                    );
                    // We keep timeline active but trigger audio sync - the audio system
                    // will check the timecode state to determine if audio should play
                    timeline.audio_needs_sync = true;
                }
            }

            TimecodeEvent::Stopped(id) => {
                let Some(timecode_uid) = timecode_uid_for_id(&timecode_query, *id) else {
                    continue;
                };
                tracing::debug!("Stopping timelines associated to timecode with ID: {}", id);
                // Find and stop all timelines associated with this timecode
                for (_, mut timeline) in timeline_query.iter_mut().filter(|(_, tl)| {
                    tl.timeline.timecode_uid == timecode_uid
                        && tl.timeline.trigger_mode == TimelineTriggerMode::FollowTimecode
                        && tl.is_active
                }) {
                    tracing::debug!(
                        "Auto-stopping timeline {} associated with timecode {}",
                        timeline.timeline.identifiers.id,
                        id
                    );
                    timeline.deactivate();
                }
            }

            TimecodeEvent::Deleted(id) => {
                let Some(timecode_uid) = timecode_uid_for_id(&timecode_query, *id) else {
                    continue;
                };
                for (_, timeline) in timeline_query
                    .iter_mut()
                    .filter(|(_, tl)| tl.timeline.timecode_uid == timecode_uid && tl.is_active)
                {
                    let timeline_id = timeline.timeline.identifiers.id;
                    tracing::debug!(
                        "Issuing StopTimeline for timeline {} associated with deleted timecode {}",
                        timeline_id,
                        id
                    );
                    timeline_actions.write(EngineActionEnvelope::detached(TimelineAction::Stop(
                        timeline_id,
                    )));
                }
            }

            TimecodeEvent::Seeked { .. } => {}
        }
    }
}
