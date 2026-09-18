// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo implementations for timeline commands.

use nightfall_engine::prelude::*;
use nightfall_timecode::prelude::Timecode;
use nightfall_undo::prelude::*;

use crate::prelude::*;

impl UndoableOperation for TimelineCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let timelines = ctx.world.resource::<DataProvider<Timeline>>();
        match self {
            // CRUD operations
            TimelineCommand::StoreTimeline(timeline) => {
                // Check if this is update vs create
                match timelines.get(timeline.identifiers.uid) {
                    Ok(existing) => {
                        // Update: restore old version
                        let old_timeline: Timeline = (*existing).clone();
                        Some(Box::new(TimelineCommand::StoreTimeline(old_timeline)))
                    }
                    Err(_) => {
                        // Create: inverse is delete
                        Some(Box::new(TimelineCommand::DeleteTimeline(
                            timeline.identifiers.id,
                        )))
                    }
                }
            }
            TimelineCommand::CreateTimeline { timeline, timecode } => {
                let timecodes = ctx.world.resource::<DataProvider<Timecode>>();
                if timelines.from_id(timeline.identifiers.id).is_ok()
                    || timelines.get(timeline.identifiers.uid).is_ok()
                {
                    return None;
                }

                let owned_timecode_uid = if timecodes.from_id(timecode.identifiers.id).is_ok() {
                    None
                } else if timecodes.get(timecode.identifiers.uid).is_ok() {
                    return None;
                } else {
                    Some(timecode.identifiers.uid)
                };
                Some(Box::new(TimelineCommand::DeleteCreatedTimeline {
                    timeline_uid: timeline.identifiers.uid,
                    owned_timecode_uid,
                }))
            }
            TimelineCommand::RestoreTimelineCreation {
                timeline,
                owned_timecode,
            } => {
                let timecodes = ctx.world.resource::<DataProvider<Timecode>>();
                if timelines.from_id(timeline.identifiers.id).is_ok()
                    || timelines.get(timeline.identifiers.uid).is_ok()
                {
                    return None;
                }

                let owned_timecode_uid = match owned_timecode {
                    Some(timecode)
                        if timecodes.from_id(timecode.identifiers.id).is_err()
                            && timecodes.get(timecode.identifiers.uid).is_err() =>
                    {
                        Some(timecode.identifiers.uid)
                    }
                    Some(_) => return None,
                    None if timecodes.get(timeline.timecode_uid).is_ok() => None,
                    None => return None,
                };
                Some(Box::new(TimelineCommand::DeleteCreatedTimeline {
                    timeline_uid: timeline.identifiers.uid,
                    owned_timecode_uid,
                }))
            }
            TimelineCommand::DeleteCreatedTimeline {
                timeline_uid,
                owned_timecode_uid,
            } => {
                let timecodes = ctx.world.resource::<DataProvider<Timecode>>();
                let timeline = timelines
                    .get(*timeline_uid)
                    .ok()
                    .map(|stored| (*stored).clone())?;
                let owned_timecode = if let Some(timecode_uid) = owned_timecode_uid {
                    if timeline.timecode_uid != *timecode_uid
                        || timelines.iter().any(|other| {
                            other.identifiers.uid != *timeline_uid
                                && other.timecode_uid == *timecode_uid
                        })
                    {
                        return None;
                    }
                    Some(
                        timecodes
                            .get(*timecode_uid)
                            .ok()
                            .map(|stored| (*stored).clone())?,
                    )
                } else {
                    timecodes.get(timeline.timecode_uid).ok()?;
                    None
                };
                Some(Box::new(TimelineCommand::RestoreTimelineCreation {
                    timeline,
                    owned_timecode,
                }))
            }
            TimelineCommand::StoreTimelineMarker {
                timeline_id,
                marker,
            } => timelines.from_id(*timeline_id).ok().map(|timeline_ref| {
                if let Some(existing_marker) = timeline_ref
                    .markers
                    .iter()
                    .find(|existing| existing.uid == marker.uid)
                {
                    Box::new(TimelineCommand::StoreTimelineMarker {
                        timeline_id: *timeline_id,
                        marker: existing_marker.clone(),
                    }) as Box<dyn UndoableOperation>
                } else {
                    Box::new(TimelineCommand::DeleteTimelineMarker {
                        timeline_id: *timeline_id,
                        marker_uid: marker.uid,
                    }) as Box<dyn UndoableOperation>
                }
            }),
            TimelineCommand::DeleteTimelineMarker {
                timeline_id,
                marker_uid,
            } => timelines
                .from_id(*timeline_id)
                .ok()
                .and_then(|timeline_ref| {
                    timeline_ref
                        .markers
                        .iter()
                        .find(|marker| marker.uid == *marker_uid)
                        .cloned()
                        .map(|marker| {
                            Box::new(TimelineCommand::StoreTimelineMarker {
                                timeline_id: *timeline_id,
                                marker,
                            }) as Box<dyn UndoableOperation>
                        })
                }),
            TimelineCommand::StoreTimelineRegion {
                timeline_id,
                region,
            } => timelines.from_id(*timeline_id).ok().map(|timeline_ref| {
                if let Some(existing_region) = timeline_ref
                    .regions
                    .iter()
                    .find(|existing| existing.uid == region.uid)
                {
                    Box::new(TimelineCommand::StoreTimelineRegion {
                        timeline_id: *timeline_id,
                        region: existing_region.clone(),
                    }) as Box<dyn UndoableOperation>
                } else {
                    Box::new(TimelineCommand::DeleteTimelineRegion {
                        timeline_id: *timeline_id,
                        region_uid: region.uid,
                    }) as Box<dyn UndoableOperation>
                }
            }),
            TimelineCommand::DeleteTimelineRegion {
                timeline_id,
                region_uid,
            } => timelines
                .from_id(*timeline_id)
                .ok()
                .and_then(|timeline_ref| {
                    timeline_ref
                        .regions
                        .iter()
                        .find(|region| region.uid == *region_uid)
                        .cloned()
                        .map(|region| {
                            Box::new(TimelineCommand::StoreTimelineRegion {
                                timeline_id: *timeline_id,
                                region,
                            }) as Box<dyn UndoableOperation>
                        })
                }),
            TimelineCommand::SetTimelineLoopRange { timeline_id, .. } => {
                timelines.from_id(*timeline_id).ok().map(|timeline_ref| {
                    Box::new(TimelineCommand::SetTimelineLoopRange {
                        timeline_id: *timeline_id,
                        loop_range: timeline_ref.loop_range.clone(),
                    }) as Box<dyn UndoableOperation>
                })
            }
            TimelineCommand::InsertRecordedActions { timeline_id, .. } => {
                timelines.from_id(*timeline_id).ok().map(|timeline_ref| {
                    let timeline: Timeline = (*timeline_ref).clone();
                    Box::new(TimelineCommand::StoreTimeline(timeline)) as Box<dyn UndoableOperation>
                })
            }
            TimelineCommand::DeleteRecordedActions { timeline_id, .. } => {
                timelines.from_id(*timeline_id).ok().map(|timeline_ref| {
                    let timeline: Timeline = (*timeline_ref).clone();
                    Box::new(TimelineCommand::StoreTimeline(timeline)) as Box<dyn UndoableOperation>
                })
            }
            TimelineCommand::NudgeTimelineSelection { timeline_id, .. } => {
                timelines.from_id(*timeline_id).ok().map(|timeline_ref| {
                    let timeline: Timeline = (*timeline_ref).clone();
                    Box::new(TimelineCommand::StoreTimeline(timeline)) as Box<dyn UndoableOperation>
                })
            }
            TimelineCommand::DeleteTimeline(id) => {
                // Capture full timeline before deletion
                timelines.from_id(*id).ok().map(|timeline_ref| {
                    let timeline: Timeline = (*timeline_ref).clone();
                    Box::new(TimelineCommand::StoreTimeline(timeline)) as Box<dyn UndoableOperation>
                })
            }
            TimelineCommand::RenameTimeline { id, new_id } => {
                Some(Box::new(TimelineCommand::RenameTimeline {
                    id: *new_id,
                    new_id: *id,
                }))
            }

            // Runtime operations - not undoable
            // Starting a timeline could theoretically be undone by stopping it,
            // but the timeline state (position, triggers fired, etc.) is transient
            TimelineCommand::StartTimeline(_)
            | TimelineCommand::StopTimeline(_)
            | TimelineCommand::SetTimelineRecording { .. }
            | TimelineCommand::RequestBeatgridDetection { .. }
            | TimelineCommand::ApplyBeatgridProposal { .. }
            | TimelineCommand::RejectBeatgridProposal { .. }
            | TimelineCommand::SetBeatgridStart { .. } => None,
        }
    }

    fn description(&self) -> String {
        match self {
            TimelineCommand::StoreTimeline(t) => format!("Store Timeline {}", t.identifiers.id),
            TimelineCommand::CreateTimeline { timeline, .. } => {
                format!("Create Timeline {}", timeline.identifiers.id)
            }
            TimelineCommand::RestoreTimelineCreation { timeline, .. } => {
                format!("Restore Timeline {}", timeline.identifiers.id)
            }
            TimelineCommand::DeleteCreatedTimeline { timeline_uid, .. } => {
                format!("Delete Created Timeline {}", timeline_uid)
            }
            TimelineCommand::StoreTimelineMarker {
                timeline_id,
                marker,
            } => {
                format!(
                    "Store Timeline Marker {} on Timeline {}",
                    marker.label, timeline_id
                )
            }
            TimelineCommand::DeleteTimelineMarker {
                timeline_id,
                marker_uid,
            } => {
                format!(
                    "Delete Timeline Marker {} on Timeline {}",
                    marker_uid, timeline_id
                )
            }
            TimelineCommand::StoreTimelineRegion {
                timeline_id,
                region,
            } => {
                format!(
                    "Store Timeline Region {} on Timeline {}",
                    region.label, timeline_id
                )
            }
            TimelineCommand::DeleteTimelineRegion {
                timeline_id,
                region_uid,
            } => {
                format!(
                    "Delete Timeline Region {} on Timeline {}",
                    region_uid, timeline_id
                )
            }
            TimelineCommand::SetTimelineLoopRange { timeline_id, .. } => {
                format!("Set Timeline Loop Range {}", timeline_id)
            }
            TimelineCommand::SetTimelineRecording {
                timeline_id,
                enabled,
                ..
            } => {
                let action = if *enabled { "Arm" } else { "Disarm" };
                format!("{} Timeline Recording {}", action, timeline_id)
            }
            TimelineCommand::InsertRecordedActions {
                timeline_id,
                actions,
                ..
            } => {
                format!(
                    "Insert {} Recorded Timeline Action(s) on Timeline {}",
                    actions.len(),
                    timeline_id
                )
            }
            TimelineCommand::DeleteRecordedActions {
                timeline_id,
                action_ids,
                ..
            } => {
                format!(
                    "Delete {} Recorded Timeline Action(s) on Timeline {}",
                    action_ids.len(),
                    timeline_id
                )
            }
            TimelineCommand::NudgeTimelineSelection {
                timeline_id,
                selection,
                delta_ms,
            } => format!(
                "Nudge {} Timeline Selection(s) on Timeline {} by {}ms",
                selection.len(),
                timeline_id,
                delta_ms
            ),
            TimelineCommand::DeleteTimeline(id) => format!("Delete Timeline {}", id),
            TimelineCommand::RenameTimeline { id, new_id } => {
                format!("Rename Timeline {} → {}", id, new_id)
            }
            TimelineCommand::StartTimeline(id) => format!("Start Timeline {}", id),
            TimelineCommand::StopTimeline(id) => format!("Stop Timeline {}", id),
            TimelineCommand::RequestBeatgridDetection { timeline_id } => {
                format!("Request Beatgrid Detection {}", timeline_id)
            }
            TimelineCommand::ApplyBeatgridProposal {
                timeline_id,
                request_id,
                ..
            } => format!("Apply Beatgrid Proposal {} ({})", timeline_id, request_id),
            TimelineCommand::RejectBeatgridProposal {
                timeline_id,
                request_id,
            } => format!("Reject Beatgrid Proposal {} ({})", timeline_id, request_id),
            TimelineCommand::SetBeatgridStart { timeline_id, .. } => {
                format!("Set Beatgrid Start {}", timeline_id)
            }
        }
    }
}

impl UndoableOperation for TimelineAction {
    /// Captures persisted timeline state before an undoable internal mutation.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let TimelineAction::InsertRecordedActions { timeline_id, .. } = self else {
            return None;
        };
        let timelines = ctx.world.resource::<DataProvider<Timeline>>();
        timelines.from_id(*timeline_id).ok().map(|timeline_ref| {
            Box::new(TimelineCommand::StoreTimeline((*timeline_ref).clone()))
                as Box<dyn UndoableOperation>
        })
    }

    /// Describes the internal mutation in the operator-visible undo stack.
    fn description(&self) -> String {
        match self {
            TimelineAction::Start(id) => format!("Start Timeline {id}"),
            TimelineAction::Stop(id) => format!("Stop Timeline {id}"),
            TimelineAction::InsertRecordedActions { timeline_id, .. } => {
                format!("Insert Recorded Timeline Actions {timeline_id}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy_ecs::prelude::World;
    use uuid::Uuid;

    use super::*;

    /// Verifies timeline creation undo preserves an existing same-numbered timecode.
    #[test]
    fn create_timeline_inverse_does_not_own_reused_timecode() {
        let mut timecodes = DataProvider::<Timecode>::default();
        let mut existing_timecode = Timecode::default();
        existing_timecode.identifiers.id = 7;
        timecodes
            .add(existing_timecode)
            .expect("existing timecode should be stored");
        let mut proposed_timecode = Timecode::default();
        proposed_timecode.identifiers.id = 7;
        let mut timeline = Timeline::default();
        timeline.identifiers.id = 7;
        timeline.timecode_uid = proposed_timecode.identifiers.uid;
        let timeline_uid = timeline.identifiers.uid;
        let mut world = World::new();
        world.insert_resource(DataProvider::<Timeline>::default());
        world.insert_resource(timecodes);

        let inverse = TimelineCommand::CreateTimeline {
            timeline,
            timecode: proposed_timecode,
        }
        .inverse(&UndoContext { world: &world })
        .expect("creation should produce an inverse");

        assert!(matches!(
            inverse.as_any().downcast_ref::<TimelineCommand>(),
            Some(TimelineCommand::DeleteCreatedTimeline {
                timeline_uid: inverse_timeline_uid,
                owned_timecode_uid: None,
            }) if *inverse_timeline_uid == timeline_uid
        ));
    }

    /// Verifies timeline creation undo owns a newly proposed timecode by exact UID.
    #[test]
    fn create_timeline_inverse_owns_new_timecode_uid() {
        let mut proposed_timecode = Timecode::default();
        proposed_timecode.identifiers.id = 8;
        let proposed_timecode_uid = proposed_timecode.identifiers.uid;
        let mut timeline = Timeline::default();
        timeline.identifiers.id = 8;
        timeline.timecode_uid = proposed_timecode_uid;
        let timeline_uid = timeline.identifiers.uid;
        let mut world = World::new();
        world.insert_resource(DataProvider::<Timeline>::default());
        world.insert_resource(DataProvider::<Timecode>::default());

        let inverse = TimelineCommand::CreateTimeline {
            timeline,
            timecode: proposed_timecode,
        }
        .inverse(&UndoContext { world: &world })
        .expect("creation should produce an inverse");

        assert!(matches!(
            inverse.as_any().downcast_ref::<TimelineCommand>(),
            Some(TimelineCommand::DeleteCreatedTimeline {
                timeline_uid: inverse_timeline_uid,
                owned_timecode_uid: Some(inverse_timecode_uid),
            }) if *inverse_timeline_uid == timeline_uid
                && *inverse_timecode_uid == proposed_timecode_uid
        ));
    }

    /// Verifies a rejected numeric timeline collision does not enter undo history.
    #[test]
    fn create_timeline_collision_has_no_inverse() {
        let mut stored_timeline = Timeline::default();
        stored_timeline.identifiers.id = 9;
        let mut timelines = DataProvider::<Timeline>::default();
        timelines
            .add(stored_timeline)
            .expect("existing timeline should be stored");
        let mut proposed_timeline = Timeline::default();
        proposed_timeline.identifiers.id = 9;
        let mut proposed_timecode = Timecode::default();
        proposed_timecode.identifiers.id = 9;
        proposed_timeline.timecode_uid = proposed_timecode.identifiers.uid;
        let mut world = World::new();
        world.insert_resource(timelines);
        world.insert_resource(DataProvider::<Timecode>::default());

        let inverse = TimelineCommand::CreateTimeline {
            timeline: proposed_timeline,
            timecode: proposed_timecode,
        }
        .inverse(&UndoContext { world: &world });

        assert!(inverse.is_none());
    }

    #[test]
    fn nudge_inverse_captures_original_timeline_state() {
        let marker_uid = Uuid::new_v4();
        let mut timeline = Timeline::default();
        timeline.identifiers.id = 7;
        timeline.markers.push(TimelineMarker {
            uid: marker_uid,
            label: "Marker".to_string(),
            time: Duration::from_millis(100),
            color: Some("#ffffff".to_string()),
        });

        let mut timelines = DataProvider::<Timeline>::default();
        timelines
            .add(timeline.clone())
            .expect("timeline should be stored");

        let mut world = World::new();
        world.insert_resource(timelines);

        let inverse = TimelineCommand::NudgeTimelineSelection {
            timeline_id: 7,
            selection: vec![TimelineSelection::Marker { marker_uid }],
            delta_ms: -250,
        }
        .inverse(&UndoContext { world: &world })
        .expect("nudge should produce an inverse when the timeline exists");

        let inverse_command = inverse
            .as_any()
            .downcast_ref::<TimelineCommand>()
            .expect("nudge inverse should be a timeline command");

        match inverse_command {
            TimelineCommand::StoreTimeline(restored) => {
                assert_eq!(restored.identifiers.id, 7);
                assert_eq!(restored.markers[0].time, Duration::from_millis(100));
            }
            other => panic!("expected StoreTimeline inverse, got {other:?}"),
        }
    }

    #[test]
    fn recorded_insert_inverse_restores_original_timeline() {
        let mut timeline = Timeline::default();
        timeline.identifiers.id = 8;
        timeline.tracks = Vec::new();

        let mut timelines = DataProvider::<Timeline>::default();
        timelines
            .add(timeline.clone())
            .expect("timeline should be stored");

        let mut world = World::new();
        world.insert_resource(timelines);

        let inverse = TimelineCommand::InsertRecordedActions {
            timeline_id: 8,
            track_id: "recorded-actions".to_string(),
            actions: vec![Action {
                id: "recorded-1".to_string(),
                label: "Recorded".to_string(),
                position: Duration::from_millis(100),
                duration: Duration::from_millis(1000),
                action: ActionKind::StartClip(Uuid::new_v4()),
            }],
        }
        .inverse(&UndoContext { world: &world })
        .expect("recorded insert should produce an inverse when the timeline exists");

        let inverse_command = inverse
            .as_any()
            .downcast_ref::<TimelineCommand>()
            .expect("recorded insert inverse should be a timeline command");

        match inverse_command {
            TimelineCommand::StoreTimeline(restored) => {
                assert_eq!(restored.identifiers.id, 8);
                assert!(
                    restored.tracks.is_empty(),
                    "undo should remove an auto-created recording track"
                );
            }
            other => panic!("expected StoreTimeline inverse, got {other:?}"),
        }
    }
}
