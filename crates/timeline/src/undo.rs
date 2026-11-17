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

impl Undoable for TimelineCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
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
                    }) as Box<dyn Undoable>
                } else {
                    Box::new(TimelineCommand::DeleteTimelineMarker {
                        timeline_id: *timeline_id,
                        marker_uid: marker.uid,
                    }) as Box<dyn Undoable>
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
                            }) as Box<dyn Undoable>
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
                    }) as Box<dyn Undoable>
                } else {
                    Box::new(TimelineCommand::DeleteTimelineRegion {
                        timeline_id: *timeline_id,
                        region_uid: region.uid,
                    }) as Box<dyn Undoable>
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
                            }) as Box<dyn Undoable>
                        })
                }),
            TimelineCommand::SetTimelineLoopRange { timeline_id, .. } => {
                timelines.from_id(*timeline_id).ok().map(|timeline_ref| {
                    Box::new(TimelineCommand::SetTimelineLoopRange {
                        timeline_id: *timeline_id,
                        loop_range: timeline_ref.loop_range.clone(),
                    }) as Box<dyn Undoable>
                })
            }
            TimelineCommand::InsertRecordedActions {
                timeline_id,
                track_id,
                actions,
            } => {
                let timeline = timelines.from_id(*timeline_id).ok()?;
                edit_inverse(
                    *timeline_id,
                    recorded_insert_inverse(&timeline, track_id, actions),
                )
            }
            TimelineCommand::EditTimeline { timeline_id, edit } => {
                // Applying the edit to a copy of the stored timeline yields exactly the edit
                // that undoes it; an edit that would be rejected records no undo step.
                if edit.is_view_only() {
                    return None;
                }
                let mut timeline: Timeline = (*timelines.from_id(*timeline_id).ok()?).clone();
                let inverse = edit.apply_in_place(&mut timeline).ok()?;
                Some(Box::new(TimelineCommand::EditTimeline {
                    timeline_id: *timeline_id,
                    edit: inverse,
                }))
            }
            TimelineCommand::NudgeTimelineSelection {
                timeline_id,
                selection,
                ..
            } => {
                let timeline = timelines.from_id(*timeline_id).ok()?;
                edit_inverse(*timeline_id, nudge_inverse(&timeline, selection))
            }
            TimelineCommand::ApplyBeatgridProposal { timeline_id, .. }
            | TimelineCommand::SetBeatgridStart { timeline_id, .. } => {
                let timeline = timelines.from_id(*timeline_id).ok()?;
                edit_inverse(*timeline_id, Some(beatgrid_inverse(&timeline)))
            }
            TimelineCommand::DeleteTimeline(id) => {
                // Capture full timeline before deletion
                timelines.from_id(*id).ok().map(|timeline_ref| {
                    let timeline: Timeline = (*timeline_ref).clone();
                    Box::new(TimelineCommand::StoreTimeline(timeline)) as Box<dyn Undoable>
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
            | TimelineCommand::PlayTimeline(_)
            | TimelineCommand::PauseTimeline(_)
            | TimelineCommand::TogglePlayback(_)
            | TimelineCommand::SetTimelineRecording { .. }
            | TimelineCommand::RequestBeatgridDetection { .. }
            | TimelineCommand::RejectBeatgridProposal { .. } => None,
        }
    }

    /// Joins repeated beatgrid shifts of one timeline into one undo step; the first shift's
    /// inverse restores the beat grid from before the run, so it undoes the whole run.
    fn coalesce_key(&self) -> Option<UndoCoalesceKey> {
        match self {
            TimelineCommand::SetBeatgridStart { timeline_id, .. } => {
                Some(UndoCoalesceKey::new("timeline.beatgrid_start", timeline_id))
            }
            _ => None,
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
            TimelineCommand::EditTimeline { timeline_id, edit } => {
                format!("{} on Timeline {}", edit.description(), timeline_id)
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
            TimelineCommand::PlayTimeline(id) => format!("Play Timeline {}", id),
            TimelineCommand::PauseTimeline(id) => format!("Pause Timeline {}", id),
            TimelineCommand::TogglePlayback(id) => format!("Toggle Timeline {} Playback", id),
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

/// Wraps a granular edit of one timeline as an undo step, or records none for `None`.
fn edit_inverse(timeline_id: u32, edit: Option<TimelineEdit>) -> Option<Box<dyn Undoable>> {
    edit.map(|edit| Box::new(TimelineCommand::EditTimeline { timeline_id, edit }) as _)
}

/// Returns the edit that removes recorded actions again: the whole track when recording will
/// create it, otherwise just the recorded actions. `None` when nothing will be recorded.
fn recorded_insert_inverse(
    timeline: &Timeline,
    track_id: &str,
    actions: &[Action],
) -> Option<TimelineEdit> {
    if actions.is_empty() {
        return None;
    }
    if !timeline.tracks.iter().any(|track| track.id == track_id) {
        return Some(TimelineEdit::DeleteTrack {
            track_id: track_id.to_owned(),
        });
    }
    Some(TimelineEdit::ChangeActions {
        store: Vec::new(),
        delete: actions
            .iter()
            .map(|action| TimelineActionRef {
                track_id: track_id.to_owned(),
                action_id: action.id.clone(),
            })
            .collect(),
    })
}

/// Returns the edit that puts the nudged actions, markers and regions back at their current
/// times, leaving the rest of the timeline as it is when the nudge is undone. Targets that
/// aren't in the timeline are skipped; `None` when none are.
fn nudge_inverse(timeline: &Timeline, selection: &[TimelineSelection]) -> Option<TimelineEdit> {
    let mut actions: Vec<ActionTime> = Vec::new();
    let mut markers: Vec<MarkerTime> = Vec::new();
    let mut regions: Vec<RegionSpan> = Vec::new();
    for target in selection {
        match target {
            TimelineSelection::Action {
                track_id,
                action_id,
            } => {
                if actions.iter().any(|placed| placed.action_id == *action_id) {
                    continue;
                }
                let Some(action) = timeline
                    .tracks
                    .iter()
                    .find(|track| track.id == *track_id)
                    .and_then(|track| track.actions.iter().find(|action| action.id == *action_id))
                else {
                    continue;
                };
                actions.push(ActionTime {
                    track_id: track_id.clone(),
                    action_id: action_id.clone(),
                    position: action.position,
                });
            }
            TimelineSelection::Marker { marker_uid } => {
                if markers
                    .iter()
                    .any(|placed| placed.marker_uid == *marker_uid)
                {
                    continue;
                }
                if let Some(marker) = timeline.markers.iter().find(|m| m.uid == *marker_uid) {
                    markers.push(MarkerTime {
                        marker_uid: *marker_uid,
                        time: marker.time,
                    });
                }
            }
            TimelineSelection::RegionBody { region_uid }
            | TimelineSelection::RegionStart { region_uid }
            | TimelineSelection::RegionEnd { region_uid } => {
                if regions
                    .iter()
                    .any(|placed| placed.region_uid == *region_uid)
                {
                    continue;
                }
                if let Some(region) = timeline.regions.iter().find(|r| r.uid == *region_uid) {
                    regions.push(RegionSpan {
                        region_uid: *region_uid,
                        start: region.start,
                        end: region.end,
                    });
                }
            }
        }
    }
    if actions.is_empty() && markers.is_empty() && regions.is_empty() {
        return None;
    }
    Some(TimelineEdit::Retime {
        actions,
        markers,
        regions,
    })
}

/// Returns the edit that puts back the tempo, bar length, grid flag and beatgrid that a
/// beatgrid command overwrites, leaving tracks, markers and other settings as they are then.
fn beatgrid_inverse(timeline: &Timeline) -> TimelineEdit {
    TimelineEdit::UpdateSettings {
        settings: vec![
            TimelineSetting::Bpm(timeline.bpm),
            TimelineSetting::BeatsPerBar(timeline.beats_per_bar),
            TimelineSetting::UseBeatGrid(timeline.use_beat_grid),
            TimelineSetting::Beatgrid(timeline.beatgrid.clone()),
        ],
    }
}

impl Undoable for TimelineOperation {
    /// Undoes recorded actions by removing just them, or the track the recording created with
    /// everything on it, so undo keeps edits made elsewhere in the timeline after the recording.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
        let TimelineOperation::InsertRecordedActions {
            timeline_id,
            track_id,
            actions,
        } = self
        else {
            return None;
        };
        let timelines = ctx.world.resource::<DataProvider<Timeline>>();
        let timeline = timelines.from_id(*timeline_id).ok()?;
        edit_inverse(
            *timeline_id,
            recorded_insert_inverse(&timeline, track_id, actions),
        )
    }

    /// Describes the internal mutation in the operator-visible undo stack.
    fn description(&self) -> String {
        match self {
            TimelineOperation::Start(id) => format!("Start Timeline {id}"),
            TimelineOperation::Stop(id) => format!("Stop Timeline {id}"),
            TimelineOperation::InsertRecordedActions { timeline_id, .. } => {
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

    /// Verifies a nudge records an undo step that puts back only the nudged marker's time.
    #[test]
    fn nudge_inverse_restores_only_nudged_times() {
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
            TimelineCommand::EditTimeline {
                timeline_id: 7,
                edit:
                    TimelineEdit::Retime {
                        actions,
                        markers,
                        regions,
                    },
            } => {
                assert!(actions.is_empty() && regions.is_empty());
                assert_eq!(
                    markers,
                    &vec![MarkerTime {
                        marker_uid,
                        time: Duration::from_millis(100),
                    }]
                );
            }
            other => panic!("expected a retime inverse, got {other:?}"),
        }
    }

    /// Verifies a nudge undo puts back only the nudged times: a marker added and a label
    /// changed after the nudge survive undoing it.
    #[test]
    fn nudge_undo_keeps_later_edits() {
        let marker_uid = Uuid::new_v4();
        let mut timeline = Timeline::default();
        timeline.identifiers.id = 7;
        timeline.markers.push(TimelineMarker {
            uid: marker_uid,
            label: "Marker".to_string(),
            time: Duration::from_millis(100),
            color: None,
        });
        let selection = vec![TimelineSelection::Marker { marker_uid }];
        let inverse = nudge_inverse(&timeline, &selection).expect("marker is in the timeline");

        timeline.markers[0].time = Duration::from_millis(350);
        timeline.markers[0].label = "Renamed".to_string();
        timeline.markers.push(TimelineMarker {
            uid: Uuid::new_v4(),
            label: "Later".to_string(),
            time: Duration::from_millis(900),
            color: None,
        });
        inverse.apply(&mut timeline).expect("undo applies");

        assert_eq!(timeline.markers.len(), 2);
        assert_eq!(timeline.markers[0].time, Duration::from_millis(100));
        assert_eq!(timeline.markers[0].label, "Renamed");
        assert!(
            nudge_inverse(
                &timeline,
                &[TimelineSelection::Marker {
                    marker_uid: Uuid::new_v4()
                }]
            )
            .is_none()
        );
    }

    /// Verifies both beatgrid edits undo by restoring the tempo, bar length, grid flag and
    /// beatgrid they overwrite (and nothing else), and only beatgrid shifts coalesce.
    #[test]
    fn beatgrid_edits_restore_only_beatgrid_settings() {
        let mut timeline = Timeline::default();
        timeline.identifiers.id = 9;
        timeline.bpm = 120.0;
        timeline.use_beat_grid = false;
        let mut timelines = DataProvider::<Timeline>::default();
        timelines.add(timeline).expect("timeline should be stored");
        let mut world = World::new();
        world.insert_resource(timelines);
        let ctx = UndoContext { world: &world };

        let apply = TimelineCommand::ApplyBeatgridProposal {
            timeline_id: 9,
            request_id: Uuid::new_v4(),
            beats_per_bar: None,
            downbeat_offset: None,
        };
        let shift = TimelineCommand::SetBeatgridStart {
            timeline_id: 9,
            audio_fingerprint: String::new(),
            first_marker_time: Duration::from_millis(250),
        };

        for command in [&apply, &shift] {
            let inverse = command
                .inverse(&ctx)
                .expect("beatgrid edit should produce an inverse");
            match inverse.as_any().downcast_ref::<TimelineCommand>() {
                Some(TimelineCommand::EditTimeline {
                    timeline_id: 9,
                    edit: TimelineEdit::UpdateSettings { settings },
                }) => {
                    assert_eq!(
                        serde_json::to_value(settings).expect("settings serialize"),
                        serde_json::json!([
                            { "type": "Bpm", "data": 120.0 },
                            { "type": "BeatsPerBar", "data": 4 },
                            { "type": "UseBeatGrid", "data": false },
                            { "type": "Beatgrid", "data": null },
                        ])
                    );
                }
                other => panic!("expected a settings inverse, got {other:?}"),
            }
        }
        assert!(apply.coalesce_key().is_none());
        assert_eq!(
            shift.coalesce_key(),
            Some(UndoCoalesceKey::new("timeline.beatgrid_start", 9))
        );
    }

    /// Verifies recording into a track it creates undoes by removing that track.
    #[test]
    fn recorded_insert_into_new_track_undoes_by_deleting_it() {
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
                action: ActionKind::StartClip(Uuid::new_v4()).to_reference(),
            }],
        }
        .inverse(&UndoContext { world: &world })
        .expect("recorded insert should produce an inverse when the timeline exists");

        let inverse_command = inverse
            .as_any()
            .downcast_ref::<TimelineCommand>()
            .expect("recorded insert inverse should be a timeline command");

        match inverse_command {
            TimelineCommand::EditTimeline {
                timeline_id: 8,
                edit: TimelineEdit::DeleteTrack { track_id },
            } => assert_eq!(
                track_id, "recorded-actions",
                "undo should remove an auto-created recording track"
            ),
            other => panic!("expected a delete-track inverse, got {other:?}"),
        }
    }

    /// Verifies recording into an existing track undoes by deleting only the recorded actions.
    #[test]
    fn recorded_insert_into_existing_track_deletes_only_recorded_actions() {
        let mut timeline = Timeline::default();
        timeline.tracks.push(Track {
            id: "track-1".to_string(),
            label: "Track".to_string(),
            muted: false,
            solo: false,
            actions: Vec::new(),
            automation_lanes: Vec::new(),
        });
        let recorded = Action {
            id: "recorded-1".to_string(),
            label: "Recorded".to_string(),
            position: Duration::from_millis(100),
            duration: Duration::from_millis(1000),
            action: ActionKind::StartClip(Uuid::new_v4()).to_reference(),
        };

        let inverse = recorded_insert_inverse(&timeline, "track-1", &[recorded]);
        let Some(TimelineEdit::ChangeActions { store, delete }) = inverse else {
            panic!("expected a change-actions inverse, got {inverse:?}");
        };
        assert!(store.is_empty());
        assert_eq!(
            delete,
            vec![TimelineActionRef {
                track_id: "track-1".to_string(),
                action_id: "recorded-1".to_string(),
            }]
        );
        assert!(recorded_insert_inverse(&timeline, "track-1", &[]).is_none());
    }
}
