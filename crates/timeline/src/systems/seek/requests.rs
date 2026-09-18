// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timeline reconstruction request collection and explicit seek precedence.

use super::*;
use crate::timeline_events::TimelineActionsChanged;

/// Internal reason for rebuilding timeline-owned playback at a target position.
#[derive(Clone, Copy, Debug)]
pub(super) enum TimelineReconstructionReason {
    /// User-visible seek command; honor timeline seek behavior.
    Seek,
    /// Timeline action mutation; reconcile active playback without treating it as a seek.
    ActionsChanged,
}

/// Pending reconstruction target for a materialized timeline.
#[derive(Clone, Copy, Debug)]
pub(super) struct TimelineReconstructionRequest {
    /// Timecode position used to derive the timeline-local target position.
    pub(super) timecode_position: Duration,
    /// Why this reconstruction was requested.
    pub(super) reason: TimelineReconstructionReason,
}

/// Tracks whether timeline reconstruction queued commands that must flush before replay handlers.
#[derive(Resource, Default, Debug)]
pub struct TimelineReconstructionDeferredFlush {
    requested: bool,
}

/// Event readers that can request timeline playback reconstruction.
#[derive(SystemParam)]
pub struct TimelineReconstructionEvents<'w, 's> {
    /// Explicit timecode seek commands.
    pub(super) timecode_events: MessageReader<'w, 's, TimecodeEvent>,
    /// Timeline action mutation notifications.
    pub(super) action_events: Option<MessageReader<'w, 's, TimelineActionsChanged>>,
}

/// Returns whether the reconstruction command buffer should be flushed before replay handlers.
pub fn timeline_reconstruction_deferred_flush_requested(
    flag: Res<TimelineReconstructionDeferredFlush>,
) -> bool {
    flag.requested
}

/// Clears the per-frame reconstruction deferred flush request.
pub fn clear_timeline_reconstruction_deferred_flush(
    mut flag: ResMut<TimelineReconstructionDeferredFlush>,
) {
    flag.requested = false;
}

/// Marks whether current timeline reconstruction events need a pre-replay deferred flush.
pub fn mark_timeline_reconstruction_deferred_flush(
    mut reconstruction_events: TimelineReconstructionEvents,
    mut flag: ResMut<TimelineReconstructionDeferredFlush>,
) {
    let seek_requested = reconstruction_events
        .timecode_events
        .read()
        .any(|event| matches!(event, TimecodeEvent::Seeked { .. }));
    let actions_changed = reconstruction_events
        .action_events
        .as_mut()
        .is_some_and(|events| events.read().next().is_some());

    flag.requested = seek_requested || actions_changed;
}

/// Queues a timeline reconstruction request while preserving explicit seek precedence.
fn queue_timeline_reconstruction_request(
    latest_request_by_timeline: &mut HashMap<Entity, TimelineReconstructionRequest>,
    ordered_reconstruction_timeline_entities: &mut Vec<Entity>,
    timeline_entity: Entity,
    request: TimelineReconstructionRequest,
    preserve_existing_seek: bool,
) {
    if preserve_existing_seek
        && matches!(
            (
                latest_request_by_timeline
                    .get(&timeline_entity)
                    .map(|request| request.reason),
                request.reason,
            ),
            (
                Some(TimelineReconstructionReason::Seek),
                TimelineReconstructionReason::ActionsChanged,
            )
        )
    {
        return;
    }

    if latest_request_by_timeline
        .insert(timeline_entity, request)
        .is_some()
    {
        ordered_reconstruction_timeline_entities
            .retain(|ordered_entity| *ordered_entity != timeline_entity);
    }
    ordered_reconstruction_timeline_entities.push(timeline_entity);
}

/// Collects ordered reconstruction requests from seeks and timeline action mutations.
pub(super) fn collect_timeline_reconstruction_requests(
    timeline_query: &mut Query<(Entity, &mut MaterializedTimeline)>,
    timecode_query: &Query<(Entity, &TimecodeGenerator)>,
    reconstruction_events: &mut TimelineReconstructionEvents,
) -> Vec<(Entity, TimelineReconstructionRequest)> {
    let event_count = reconstruction_events.timecode_events.len();
    if event_count > 0 {
        tracing::debug!(
            "handle_timeline_seek_system: processing {} events",
            event_count
        );
    }

    let mut latest_request_by_timeline = HashMap::new();
    let mut ordered_reconstruction_timeline_entities = Vec::new();
    let timecode_uid_by_id = timecode_uid_by_id(timecode_query);
    let timecode_position_by_uid = timecode_query
        .iter()
        .map(|(_, timecode)| {
            (
                timecode.timecode.identifiers.uid,
                timecode.state.current_time,
            )
        })
        .collect::<HashMap<_, _>>();

    for event in reconstruction_events.timecode_events.read() {
        if let TimecodeEvent::Seeked { id, position } = event {
            let Some(timecode_uid) = timecode_uid_by_id.get(id) else {
                continue;
            };
            let matching_timeline_entities = timeline_query
                .iter_mut()
                .filter(|(_, timeline)| timeline.timeline.timecode_uid == *timecode_uid)
                .map(|(entity, _)| entity)
                .collect::<Vec<_>>();

            for timeline_entity in matching_timeline_entities {
                queue_timeline_reconstruction_request(
                    &mut latest_request_by_timeline,
                    &mut ordered_reconstruction_timeline_entities,
                    timeline_entity,
                    TimelineReconstructionRequest {
                        timecode_position: *position,
                        reason: TimelineReconstructionReason::Seek,
                    },
                    true,
                );
            }
        }
    }

    if let Some(action_events) = reconstruction_events.action_events.as_mut() {
        for event in action_events.read() {
            let matching_timeline_entities = timeline_query
                .iter_mut()
                .filter(|(_, timeline)| {
                    timeline.is_active && timeline.timeline.identifiers.id == event.timeline_id
                })
                .filter_map(|(entity, timeline)| {
                    let timecode_position =
                        timecode_position_by_uid.get(&timeline.timeline.timecode_uid)?;
                    let preserve_existing_seek =
                        timeline.timeline.seek_behavior != TimelineSeekBehavior::MovePlayheadOnly;
                    Some((entity, *timecode_position, preserve_existing_seek))
                })
                .collect::<Vec<_>>();

            for (timeline_entity, timecode_position, preserve_existing_seek) in
                matching_timeline_entities
            {
                queue_timeline_reconstruction_request(
                    &mut latest_request_by_timeline,
                    &mut ordered_reconstruction_timeline_entities,
                    timeline_entity,
                    TimelineReconstructionRequest {
                        timecode_position,
                        reason: TimelineReconstructionReason::ActionsChanged,
                    },
                    preserve_existing_seek,
                );
            }
        }
    }

    ordered_reconstruction_timeline_entities
        .into_iter()
        .filter_map(|entity| {
            latest_request_by_timeline
                .remove(&entity)
                .map(|request| (entity, request))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies same-frame mutation events do not downgrade explicit seek reconstruction.
    #[test]
    fn queue_timeline_reconstruction_request_keeps_seek_over_mutation() {
        let timeline_entity = Entity::from_bits(1);
        let mut latest_request_by_timeline = HashMap::new();
        let mut ordered_reconstruction_timeline_entities = Vec::new();

        queue_timeline_reconstruction_request(
            &mut latest_request_by_timeline,
            &mut ordered_reconstruction_timeline_entities,
            timeline_entity,
            TimelineReconstructionRequest {
                timecode_position: Duration::from_secs(10),
                reason: TimelineReconstructionReason::Seek,
            },
            true,
        );
        queue_timeline_reconstruction_request(
            &mut latest_request_by_timeline,
            &mut ordered_reconstruction_timeline_entities,
            timeline_entity,
            TimelineReconstructionRequest {
                timecode_position: Duration::from_secs(3),
                reason: TimelineReconstructionReason::ActionsChanged,
            },
            true,
        );

        let request = latest_request_by_timeline
            .get(&timeline_entity)
            .expect("seek request should remain queued");
        assert!(matches!(request.reason, TimelineReconstructionReason::Seek));
        assert_eq!(request.timecode_position, Duration::from_secs(10));
        assert_eq!(
            ordered_reconstruction_timeline_entities,
            vec![timeline_entity],
            "ignored mutation should not duplicate the queued timeline"
        );
    }

    /// Verifies mutation reconstruction is preserved when a same-frame seek will be ignored.
    #[test]
    fn queue_timeline_reconstruction_request_allows_mutation_over_move_only_seek() {
        let timeline_entity = Entity::from_bits(1);
        let mut latest_request_by_timeline = HashMap::new();
        let mut ordered_reconstruction_timeline_entities = Vec::new();

        queue_timeline_reconstruction_request(
            &mut latest_request_by_timeline,
            &mut ordered_reconstruction_timeline_entities,
            timeline_entity,
            TimelineReconstructionRequest {
                timecode_position: Duration::from_secs(10),
                reason: TimelineReconstructionReason::Seek,
            },
            true,
        );
        queue_timeline_reconstruction_request(
            &mut latest_request_by_timeline,
            &mut ordered_reconstruction_timeline_entities,
            timeline_entity,
            TimelineReconstructionRequest {
                timecode_position: Duration::from_secs(3),
                reason: TimelineReconstructionReason::ActionsChanged,
            },
            false,
        );

        let request = latest_request_by_timeline
            .get(&timeline_entity)
            .expect("mutation request should replace ignored seek");
        assert!(matches!(
            request.reason,
            TimelineReconstructionReason::ActionsChanged
        ));
        assert_eq!(request.timecode_position, Duration::from_secs(3));
        assert_eq!(
            ordered_reconstruction_timeline_entities,
            vec![timeline_entity]
        );
    }
}
