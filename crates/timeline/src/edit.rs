// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Granular edits to one stored timeline.
//!
//! Each [`TimelineEdit`] names the tracks, actions, automation lanes or settings it changes and
//! leaves everything else in the timeline as stored. Two clients editing different parts of the
//! same timeline therefore never overwrite each other's changes, unlike a whole-timeline store.
//! Applying an edit returns the edit that undoes it, so undo restores only what changed.

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::timeline::{
    Action, AutomationLane, BeatgridData, Timeline, TimelineLookaheadMode,
    TimelineNondeterministicSeekBehavior, TimelineScrollMode, TimelineSeekBehavior,
    TimelineStopBehavior, TimelineTriggerMode, Track,
};

/// One granular change to a stored timeline's tracks, actions, automation lanes or settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum TimelineEdit {
    /// Add a track, with any actions and automation lanes it already holds.
    InsertTrack {
        /// Track to add. Its ID must not be in use in the timeline.
        track: Track,
        /// Track the new track goes in front of, or `None` to add it last.
        before_track_id: Option<String>,
    },
    /// Remove a track with all its actions and automation lanes.
    DeleteTrack {
        /// ID of the track to remove.
        track_id: String,
    },
    /// Move a track to another place in the track list.
    MoveTrack {
        /// ID of the track to move.
        track_id: String,
        /// Track to move in front of, or `None` to move it last.
        before_track_id: Option<String>,
    },
    /// Change some of a track's own settings, leaving its actions and lanes as they are.
    UpdateTrack {
        /// ID of the track to change.
        track_id: String,
        /// Settings to change, applied in order.
        settings: Vec<TrackSetting>,
    },
    /// Add an automation lane to a track, or replace the lane with the same ID.
    StoreAutomationLane {
        /// ID of the track that holds the lane.
        track_id: String,
        /// Lane to store, points included.
        lane: AutomationLane,
        /// Lane a new lane goes in front of, or `None` to add it last. Ignored when the lane
        /// already exists.
        before_lane_id: Option<String>,
    },
    /// Remove an automation lane from a track.
    DeleteAutomationLane {
        /// ID of the track that holds the lane.
        track_id: String,
        /// ID of the lane to remove.
        lane_id: String,
    },
    /// Add, replace and remove actions in one step.
    ChangeActions {
        /// Actions to add, or to replace when their ID is already on the named track.
        store: Vec<TrackAction>,
        /// Actions to remove. Actions that are already gone are skipped.
        delete: Vec<TimelineActionRef>,
    },
    /// Move actions to new positions, and optionally onto other tracks.
    MoveActions {
        /// Moves to apply, in order. Each action may appear only once; a move whose action or
        /// track is gone is skipped.
        moves: Vec<TimelineActionMove>,
    },
    /// Change some of the timeline's own settings, leaving tracks, markers and regions as they
    /// are.
    UpdateSettings {
        /// Settings to change, applied in order.
        settings: Vec<TimelineSetting>,
    },
    /// Put actions, markers and regions at new times, leaving everything else about them as
    /// stored. Undoing a nudge uses it to put back only the times the nudge changed.
    Retime {
        /// Actions to place, each at most once.
        actions: Vec<ActionTime>,
        /// Markers to place, each at most once.
        markers: Vec<MarkerTime>,
        /// Regions to place, each at most once.
        regions: Vec<RegionSpan>,
    },
}

/// The time of one action on its track.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct ActionTime {
    /// ID of the track that holds the action.
    pub track_id: String,
    /// ID of the action.
    pub action_id: String,
    /// Position from the start of the timeline.
    pub position: Duration,
}

/// The time of one marker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct MarkerTime {
    /// UID of the marker.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub marker_uid: Uuid,
    /// Time of the marker from the start of the timeline.
    pub time: Duration,
}

/// The start and end of one region.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct RegionSpan {
    /// UID of the region.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub region_uid: Uuid,
    /// Start of the region from the start of the timeline.
    pub start: Duration,
    /// End of the region from the start of the timeline.
    pub end: Duration,
}

/// One setting of a track, with its new value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum TrackSetting {
    /// Display name of the track.
    Label(String),
    /// Whether the track is muted.
    Muted(bool),
    /// Whether the track is soloed.
    Solo(bool),
    /// Whether the track's automation lanes are shown expanded.
    Expanded(bool),
}

/// One setting of a timeline, with its new value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum TimelineSetting {
    /// Display name of the timeline.
    Label(String),
    /// Timecode the timeline follows.
    #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
    #[typeshare(serialized_as = "String")]
    TimecodeUid(Uuid),
    /// Offset in the timecode where the timeline starts.
    TimecodeStart(Duration),
    /// Path of the timeline's audio file, or an empty string for none.
    AudioPath(String),
    /// Whether audio playback follows the timeline.
    AudioEnabled(bool),
    /// Time the timeline ends at, or `None` to end with its audio.
    EndTime(Option<Duration>),
    /// How the timeline becomes active.
    TriggerMode(TimelineTriggerMode),
    /// How seeking affects timeline-owned state.
    SeekBehavior(TimelineSeekBehavior),
    /// How seeking handles actions that can't be reconstructed deterministically.
    NondeterministicSeekBehavior(TimelineNondeterministicSeekBehavior),
    /// How stopping affects timeline-owned state.
    StopBehavior(TimelineStopBehavior),
    /// How timeline-owned playback applies lookahead.
    Lookahead(TimelineLookaheadMode),
    /// Tempo of the beat grid, in beats per minute.
    Bpm(f32),
    /// Beats in one bar of the beat grid.
    BeatsPerBar(u8),
    /// Whether the beat grid is on.
    UseBeatGrid(bool),
    /// Detected beat grid, or `None` to clear it.
    Beatgrid(Option<BeatgridData>),
    /// How the timeline view scrolls during playback.
    ScrollMode(TimelineScrollMode),
}

/// An action together with the track it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TrackAction {
    /// ID of the track that holds the action.
    pub track_id: String,
    /// The action.
    pub action: Action,
}

/// Names one action on one track.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[typeshare::typeshare]
pub struct TimelineActionRef {
    /// ID of the track that holds the action.
    pub track_id: String,
    /// ID of the action.
    pub action_id: String,
}

/// Moves one action to a new position, and optionally onto another track.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelineActionMove {
    /// ID of the track that holds the action now.
    pub track_id: String,
    /// ID of the action to move.
    pub action_id: String,
    /// New position from the start of the timeline.
    pub position: Duration,
    /// Track to move the action onto, or `None` to keep it on its track.
    pub to_track_id: Option<String>,
}

impl TimelineEdit {
    /// Applies the edit to `timeline` and returns the edit that undoes it.
    ///
    /// The edit applies as a whole: when a track or lane it changes is missing, or a value is
    /// invalid, the timeline is left unchanged and the error describes the problem. Deletes,
    /// moves and retimes skip actions, markers and regions that are already gone, and a missing
    /// neighbor puts an inserted or moved track or lane last, so undo keeps working after
    /// another client removed something.
    pub fn apply(&self, timeline: &mut Timeline) -> Result<TimelineEdit, String> {
        let mut edited = timeline.clone();
        let inverse = self.apply_in_place(&mut edited)?;
        *timeline = edited;
        Ok(inverse)
    }

    /// Applies the edit to a copy of a timeline that the caller discards on error, saving the
    /// extra clone [`Self::apply`] makes.
    pub(crate) fn apply_in_place(&self, timeline: &mut Timeline) -> Result<TimelineEdit, String> {
        match self {
            TimelineEdit::InsertTrack {
                track,
                before_track_id,
            } => {
                if track_index(timeline, &track.id).is_ok() {
                    return Err(format!("Track {} already exists", track.id));
                }
                let index = insertion_index(timeline, before_track_id.as_deref());
                timeline.tracks.insert(index, track.clone());
                Ok(TimelineEdit::DeleteTrack {
                    track_id: track.id.clone(),
                })
            }
            TimelineEdit::DeleteTrack { track_id } => {
                let index = track_index(timeline, track_id)?;
                let track = timeline.tracks.remove(index);
                Ok(TimelineEdit::InsertTrack {
                    track,
                    before_track_id: timeline.tracks.get(index).map(|next| next.id.clone()),
                })
            }
            TimelineEdit::MoveTrack {
                track_id,
                before_track_id,
            } => {
                if before_track_id.as_deref() == Some(track_id.as_str()) {
                    return Err(format!("Track {track_id} can't move in front of itself"));
                }
                let index = track_index(timeline, track_id)?;
                let track = timeline.tracks.remove(index);
                let previous_next = timeline.tracks.get(index).map(|next| next.id.clone());
                let target = insertion_index(timeline, before_track_id.as_deref());
                timeline.tracks.insert(target, track);
                Ok(TimelineEdit::MoveTrack {
                    track_id: track_id.clone(),
                    before_track_id: previous_next,
                })
            }
            TimelineEdit::UpdateTrack { track_id, settings } => {
                let index = track_index(timeline, track_id)?;
                let track = &mut timeline.tracks[index];
                let mut previous = settings
                    .iter()
                    .map(|setting| apply_track_setting(track, setting))
                    .collect::<Vec<_>>();
                previous.reverse();
                Ok(TimelineEdit::UpdateTrack {
                    track_id: track_id.clone(),
                    settings: previous,
                })
            }
            TimelineEdit::StoreAutomationLane {
                track_id,
                lane,
                before_lane_id,
            } => {
                let index = track_index(timeline, track_id)?;
                let lanes = &mut timeline.tracks[index].automation_lanes;
                if let Some(existing) = lanes.iter_mut().find(|existing| existing.id == lane.id) {
                    let previous = std::mem::replace(existing, lane.clone());
                    return Ok(TimelineEdit::StoreAutomationLane {
                        track_id: track_id.clone(),
                        lane: previous,
                        before_lane_id: None,
                    });
                }
                // A missing neighbor puts the lane last, as for tracks.
                let target = before_lane_id
                    .as_ref()
                    .and_then(|before| lanes.iter().position(|existing| existing.id == *before))
                    .unwrap_or(lanes.len());
                lanes.insert(target, lane.clone());
                Ok(TimelineEdit::DeleteAutomationLane {
                    track_id: track_id.clone(),
                    lane_id: lane.id.clone(),
                })
            }
            TimelineEdit::DeleteAutomationLane { track_id, lane_id } => {
                let index = track_index(timeline, track_id)?;
                let lanes = &mut timeline.tracks[index].automation_lanes;
                let lane_index = lanes
                    .iter()
                    .position(|lane| lane.id == *lane_id)
                    .ok_or_else(|| {
                        format!("Automation lane {lane_id} was not found on track {track_id}")
                    })?;
                let lane = lanes.remove(lane_index);
                Ok(TimelineEdit::StoreAutomationLane {
                    track_id: track_id.clone(),
                    before_lane_id: lanes.get(lane_index).map(|next| next.id.clone()),
                    lane,
                })
            }
            TimelineEdit::ChangeActions { store, delete } => {
                change_actions(timeline, store, delete)
            }
            TimelineEdit::MoveActions { moves } => move_actions(timeline, moves),
            TimelineEdit::UpdateSettings { settings } => {
                let mut previous = settings
                    .iter()
                    .map(|setting| apply_timeline_setting(timeline, setting))
                    .collect::<Result<Vec<_>, _>>()?;
                previous.reverse();
                Ok(TimelineEdit::UpdateSettings { settings: previous })
            }
            TimelineEdit::Retime {
                actions,
                markers,
                regions,
            } => retime(timeline, actions, markers, regions),
        }
    }

    /// Returns the actions this edit adds to the timeline or whose action reference it changes,
    /// with their track IDs, so command ingress can check they are runnable.
    pub(crate) fn actions_to_validate<'a>(
        &'a self,
        timeline: Option<&Timeline>,
    ) -> Vec<(&'a str, &'a Action)> {
        match self {
            TimelineEdit::InsertTrack { track, .. } => track
                .actions
                .iter()
                .map(|action| (track.id.as_str(), action))
                .collect(),
            TimelineEdit::ChangeActions { store, .. } => store
                .iter()
                .filter(|entry| {
                    timeline.is_none_or(|timeline| {
                        !timeline.tracks.iter().any(|track| {
                            track.id == entry.track_id
                                && track.actions.iter().any(|existing| {
                                    existing.id == entry.action.id
                                        && existing.action == entry.action.action
                                })
                        })
                    })
                })
                .map(|entry| (entry.track_id.as_str(), &entry.action))
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Returns whether the edit only changes how the timeline is viewed (a track expanded or
    /// collapsed, the scroll mode), which is saved with the show but isn't an undo step.
    pub fn is_view_only(&self) -> bool {
        match self {
            TimelineEdit::UpdateTrack { settings, .. } => settings
                .iter()
                .all(|setting| matches!(setting, TrackSetting::Expanded(_))),
            TimelineEdit::UpdateSettings { settings } => settings
                .iter()
                .all(|setting| matches!(setting, TimelineSetting::ScrollMode(_))),
            _ => false,
        }
    }

    /// Short operator-facing description of the edit, used in the undo history.
    pub fn description(&self) -> String {
        match self {
            TimelineEdit::InsertTrack { track, .. } => format!("Add Track {}", track.label),
            // Track and lane IDs are generated, so they would mean nothing in the history.
            TimelineEdit::DeleteTrack { .. } => "Delete Track".to_owned(),
            TimelineEdit::MoveTrack { .. } => "Move Track".to_owned(),
            TimelineEdit::UpdateTrack { .. } => "Edit Track".to_owned(),
            TimelineEdit::StoreAutomationLane { lane, .. } => {
                format!("Edit Automation Lane {}", lane.name)
            }
            TimelineEdit::DeleteAutomationLane { .. } => "Delete Automation Lane".to_owned(),
            TimelineEdit::ChangeActions { store, delete } => match (store.len(), delete.len()) {
                (stored, 0) => format!("Store {stored} Timeline Action(s)"),
                (0, deleted) => format!("Delete {deleted} Timeline Action(s)"),
                (stored, deleted) => {
                    format!("Store {stored} and Delete {deleted} Timeline Action(s)")
                }
            },
            TimelineEdit::MoveActions { moves } => {
                format!("Move {} Timeline Action(s)", moves.len())
            }
            TimelineEdit::UpdateSettings { .. } => "Edit Timeline Settings".to_owned(),
            TimelineEdit::Retime {
                actions,
                markers,
                regions,
            } => format!(
                "Move {} Timeline Item(s)",
                actions.len() + markers.len() + regions.len()
            ),
        }
    }
}

/// Places actions, markers and regions at the given times and returns the edit that puts them
/// back. Targets that are no longer in the timeline are skipped, so undoing a nudge still works
/// after another client deleted one of the nudged items. Fails when a target is named twice or
/// a region would end before it starts.
fn retime(
    timeline: &mut Timeline,
    actions: &[ActionTime],
    markers: &[MarkerTime],
    regions: &[RegionSpan],
) -> Result<TimelineEdit, String> {
    let mut seen_actions = HashSet::new();
    let mut previous_actions = Vec::with_capacity(actions.len());
    for placement in actions {
        if !seen_actions.insert(&placement.action_id) {
            return Err(format!(
                "Action {} is placed more than once",
                placement.action_id
            ));
        }
        let Ok(track) = track_index(timeline, &placement.track_id) else {
            continue;
        };
        let Some(action) = timeline.tracks[track]
            .actions
            .iter_mut()
            .find(|action| action.id == placement.action_id)
        else {
            continue;
        };
        previous_actions.push(ActionTime {
            position: std::mem::replace(&mut action.position, placement.position),
            ..placement.clone()
        });
    }

    let mut seen_markers = HashSet::new();
    let mut previous_markers = Vec::with_capacity(markers.len());
    for placement in markers {
        if !seen_markers.insert(placement.marker_uid) {
            return Err(format!(
                "Marker {} is placed more than once",
                placement.marker_uid
            ));
        }
        let Some(marker) = timeline
            .markers
            .iter_mut()
            .find(|marker| marker.uid == placement.marker_uid)
        else {
            continue;
        };
        previous_markers.push(MarkerTime {
            marker_uid: placement.marker_uid,
            time: std::mem::replace(&mut marker.time, placement.time),
        });
    }

    let mut seen_regions = HashSet::new();
    let mut previous_regions = Vec::with_capacity(regions.len());
    for placement in regions {
        if !seen_regions.insert(placement.region_uid) {
            return Err(format!(
                "Region {} is placed more than once",
                placement.region_uid
            ));
        }
        if placement.end < placement.start {
            return Err(format!(
                "Region {} would end before it starts",
                placement.region_uid
            ));
        }
        let Some(region) = timeline
            .regions
            .iter_mut()
            .find(|region| region.uid == placement.region_uid)
        else {
            continue;
        };
        previous_regions.push(RegionSpan {
            region_uid: placement.region_uid,
            start: std::mem::replace(&mut region.start, placement.start),
            end: std::mem::replace(&mut region.end, placement.end),
        });
    }

    Ok(TimelineEdit::Retime {
        actions: previous_actions,
        markers: previous_markers,
        regions: previous_regions,
    })
}

/// Returns the index of a track, or an error naming the missing track.
fn track_index(timeline: &Timeline, track_id: &str) -> Result<usize, String> {
    timeline
        .tracks
        .iter()
        .position(|track| track.id == track_id)
        .ok_or_else(|| format!("Track {track_id} was not found"))
}

/// Returns where a track goes when inserted in front of `before`, or last for `None`.
/// Also last when `before` is no longer in the timeline, so undoing a delete or move still
/// restores the track after another client removed its old neighbor.
fn insertion_index(timeline: &Timeline, before: Option<&str>) -> usize {
    before
        .and_then(|before| track_index(timeline, before).ok())
        .unwrap_or(timeline.tracks.len())
}

/// Applies one track setting and returns the setting holding its previous value.
fn apply_track_setting(track: &mut Track, setting: &TrackSetting) -> TrackSetting {
    match setting {
        TrackSetting::Label(label) => {
            TrackSetting::Label(std::mem::replace(&mut track.label, label.clone()))
        }
        TrackSetting::Muted(muted) => {
            TrackSetting::Muted(std::mem::replace(&mut track.muted, *muted))
        }
        TrackSetting::Solo(solo) => TrackSetting::Solo(std::mem::replace(&mut track.solo, *solo)),
        TrackSetting::Expanded(expanded) => {
            TrackSetting::Expanded(std::mem::replace(&mut track.expanded, *expanded))
        }
    }
}

/// Applies one timeline setting and returns the setting holding its previous value.
///
/// Rejects a tempo that isn't a positive finite number and a bar without beats, which would
/// break beat-grid math everywhere the timeline is drawn or played.
fn apply_timeline_setting(
    timeline: &mut Timeline,
    setting: &TimelineSetting,
) -> Result<TimelineSetting, String> {
    use std::mem::replace;
    Ok(match setting {
        TimelineSetting::Label(label) => {
            TimelineSetting::Label(replace(&mut timeline.identifiers.label, label.clone()))
        }
        TimelineSetting::TimecodeUid(uid) => {
            TimelineSetting::TimecodeUid(replace(&mut timeline.timecode_uid, *uid))
        }
        TimelineSetting::TimecodeStart(start) => {
            TimelineSetting::TimecodeStart(replace(&mut timeline.timecode_start, *start))
        }
        TimelineSetting::AudioPath(path) => {
            TimelineSetting::AudioPath(replace(&mut timeline.audio_path, path.clone()))
        }
        TimelineSetting::AudioEnabled(enabled) => {
            TimelineSetting::AudioEnabled(replace(&mut timeline.audio_enabled, *enabled))
        }
        TimelineSetting::EndTime(end) => {
            TimelineSetting::EndTime(replace(&mut timeline.end_time, *end))
        }
        TimelineSetting::TriggerMode(mode) => {
            TimelineSetting::TriggerMode(replace(&mut timeline.trigger_mode, *mode))
        }
        TimelineSetting::SeekBehavior(behavior) => {
            TimelineSetting::SeekBehavior(replace(&mut timeline.seek_behavior, *behavior))
        }
        TimelineSetting::NondeterministicSeekBehavior(behavior) => {
            TimelineSetting::NondeterministicSeekBehavior(replace(
                &mut timeline.nondeterministic_seek_behavior,
                *behavior,
            ))
        }
        TimelineSetting::StopBehavior(behavior) => {
            TimelineSetting::StopBehavior(replace(&mut timeline.stop_behavior, *behavior))
        }
        TimelineSetting::Lookahead(mode) => {
            TimelineSetting::Lookahead(replace(&mut timeline.lookahead, *mode))
        }
        TimelineSetting::Bpm(bpm) => {
            if !bpm.is_finite() || *bpm <= 0.0 {
                return Err(format!("Tempo {bpm} must be a positive number"));
            }
            TimelineSetting::Bpm(replace(&mut timeline.bpm, *bpm))
        }
        TimelineSetting::BeatsPerBar(beats) => {
            if *beats == 0 {
                return Err("A bar needs at least one beat".to_owned());
            }
            TimelineSetting::BeatsPerBar(replace(&mut timeline.beats_per_bar, *beats))
        }
        TimelineSetting::UseBeatGrid(enabled) => {
            TimelineSetting::UseBeatGrid(replace(&mut timeline.use_beat_grid, *enabled))
        }
        TimelineSetting::Beatgrid(beatgrid) => {
            TimelineSetting::Beatgrid(replace(&mut timeline.beatgrid, beatgrid.clone()))
        }
        TimelineSetting::ScrollMode(mode) => {
            TimelineSetting::ScrollMode(replace(&mut timeline.scroll_mode, *mode))
        }
    })
}

/// Finds the track holding an action ID, if any track does.
fn track_holding_action(timeline: &Timeline, action_id: &str) -> Option<usize> {
    timeline
        .tracks
        .iter()
        .position(|track| track.actions.iter().any(|action| action.id == action_id))
}

/// Removes the named actions, then stores the given ones, and returns the edit undoing both.
///
/// Action IDs are unique within a timeline: storing an ID that another track holds is
/// rejected, so a stale client can't duplicate an action that was moved elsewhere. New actions
/// are added at the end of their track; playback orders actions by position.
fn change_actions(
    timeline: &mut Timeline,
    store: &[TrackAction],
    delete: &[TimelineActionRef],
) -> Result<TimelineEdit, String> {
    let mut seen = HashSet::new();
    for action_id in store
        .iter()
        .map(|entry| &entry.action.id)
        .chain(delete.iter().map(|target| &target.action_id))
    {
        if !seen.insert(action_id) {
            return Err(format!("Action {action_id} is named more than once"));
        }
    }

    let mut restore = Vec::new();
    for target in delete {
        // An action that is already gone needs no deleting, and nothing to restore on undo.
        let Ok(index) = track_index(timeline, &target.track_id) else {
            continue;
        };
        let actions = &mut timeline.tracks[index].actions;
        let Some(action_index) = actions
            .iter()
            .position(|action| action.id == target.action_id)
        else {
            continue;
        };
        restore.push(TrackAction {
            track_id: target.track_id.clone(),
            action: actions.remove(action_index),
        });
    }

    let mut remove = Vec::new();
    for entry in store {
        let index = track_index(timeline, &entry.track_id)?;
        if let Some(holder) = track_holding_action(timeline, &entry.action.id)
            && holder != index
        {
            return Err(format!(
                "Action {} is on track {}, not {}",
                entry.action.id, timeline.tracks[holder].id, entry.track_id
            ));
        }
        let actions = &mut timeline.tracks[index].actions;
        match actions
            .iter_mut()
            .find(|existing| existing.id == entry.action.id)
        {
            Some(existing) => restore.push(TrackAction {
                track_id: entry.track_id.clone(),
                action: std::mem::replace(existing, entry.action.clone()),
            }),
            None => {
                actions.push(entry.action.clone());
                remove.push(TimelineActionRef {
                    track_id: entry.track_id.clone(),
                    action_id: entry.action.id.clone(),
                });
            }
        }
    }

    Ok(TimelineEdit::ChangeActions {
        store: restore,
        delete: remove,
    })
}

/// Moves actions to new positions and tracks, and returns the moves that put them back.
fn move_actions(
    timeline: &mut Timeline,
    moves: &[TimelineActionMove],
) -> Result<TimelineEdit, String> {
    let mut seen = HashSet::new();
    let mut undo = Vec::with_capacity(moves.len());
    for movement in moves {
        if !seen.insert(&movement.action_id) {
            return Err(format!(
                "Action {} is moved more than once",
                movement.action_id
            ));
        }
        // A move whose action or track is gone is skipped, so undoing a move still puts the
        // remaining actions back after another client deleted one of them.
        let Ok(source) = track_index(timeline, &movement.track_id) else {
            continue;
        };
        let target = match &movement.to_track_id {
            Some(to_track_id) => match track_index(timeline, to_track_id) {
                Ok(target) => target,
                Err(_) => continue,
            },
            None => source,
        };
        let source_actions = &mut timeline.tracks[source].actions;
        let Some(action_index) = source_actions
            .iter()
            .position(|action| action.id == movement.action_id)
        else {
            continue;
        };
        let previous_position = source_actions[action_index].position;
        if target == source {
            source_actions[action_index].position = movement.position;
        } else {
            let mut action = source_actions.remove(action_index);
            action.position = movement.position;
            timeline.tracks[target].actions.push(action);
        }
        undo.push(TimelineActionMove {
            track_id: timeline.tracks[target].id.clone(),
            action_id: movement.action_id.clone(),
            position: previous_position,
            to_track_id: (target != source).then(|| movement.track_id.clone()),
        });
    }
    undo.reverse();
    Ok(TimelineEdit::MoveActions { moves: undo })
}

#[cfg(test)]
mod tests {
    use nightfall_actions::ActionReference;

    use super::*;
    use crate::timeline::{ParameterType, TimelineMarker};

    /// Builds an empty track with the given ID.
    fn track(id: &str) -> Track {
        Track {
            id: id.to_owned(),
            label: format!("Track {id}"),
            muted: false,
            solo: false,
            expanded: false,
            actions: Vec::new(),
            automation_lanes: Vec::new(),
        }
    }

    /// Builds an action at a position in milliseconds.
    fn action(id: &str, position_ms: u64) -> Action {
        Action {
            id: id.to_owned(),
            label: format!("Action {id}"),
            position: Duration::from_millis(position_ms),
            duration: Duration::from_millis(500),
            action: ActionReference::new("test.action", serde_json::Value::Null),
        }
    }

    /// Builds a timeline holding tracks a, b and c, with actions on a.
    fn timeline() -> Timeline {
        let mut timeline = Timeline::default();
        let mut a = track("a");
        a.actions = vec![action("x", 100), action("y", 200)];
        timeline.tracks = vec![a, track("b"), track("c")];
        timeline
    }

    /// Lists the timeline's track IDs in order.
    fn track_ids(timeline: &Timeline) -> Vec<&str> {
        timeline
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect()
    }

    /// Applies an edit, then its inverse, and returns the timeline after each step.
    fn round_trip(edit: TimelineEdit, timeline: &Timeline) -> (Timeline, Timeline) {
        let mut edited = timeline.clone();
        let inverse = edit.apply(&mut edited).expect("edit applies");
        let mut restored = edited.clone();
        inverse.apply(&mut restored).expect("inverse applies");
        (edited, restored)
    }

    /// Serializes a timeline so tests can compare whole timelines without `PartialEq`.
    fn json(timeline: &Timeline) -> serde_json::Value {
        serde_json::to_value(timeline).expect("timeline serializes")
    }

    /// Inserting a track in front of another puts it there, and undo removes it again.
    #[test]
    fn insert_track_before_neighbor_and_undo() {
        let original = timeline();
        let (edited, restored) = round_trip(
            TimelineEdit::InsertTrack {
                track: track("n"),
                before_track_id: Some("b".to_owned()),
            },
            &original,
        );
        assert_eq!(track_ids(&edited), ["a", "n", "b", "c"]);
        assert_eq!(json(&restored), json(&original));
    }

    /// A track ID already in use is rejected and the timeline stays unchanged.
    #[test]
    fn insert_track_rejects_duplicate_id() {
        let original = timeline();
        let mut edited = original.clone();
        let error = TimelineEdit::InsertTrack {
            track: track("b"),
            before_track_id: None,
        }
        .apply(&mut edited)
        .unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(json(&edited), json(&original));
    }

    /// Deleting a track and undoing it restores the track, its actions and its place.
    #[test]
    fn delete_track_undo_restores_actions_and_position() {
        let original = timeline();
        let (edited, restored) = round_trip(
            TimelineEdit::DeleteTrack {
                track_id: "a".to_owned(),
            },
            &original,
        );
        assert_eq!(track_ids(&edited), ["b", "c"]);
        assert_eq!(json(&restored), json(&original));
    }

    /// Moving a track last and undoing it returns it to its old place.
    #[test]
    fn move_track_and_undo() {
        let original = timeline();
        let (edited, restored) = round_trip(
            TimelineEdit::MoveTrack {
                track_id: "a".to_owned(),
                before_track_id: None,
            },
            &original,
        );
        assert_eq!(track_ids(&edited), ["b", "c", "a"]);
        assert_eq!(track_ids(&restored), ["a", "b", "c"]);
    }

    /// Updating a track changes only the named settings, and undo restores their old values.
    #[test]
    fn update_track_changes_only_named_settings() {
        let original = timeline();
        let (edited, restored) = round_trip(
            TimelineEdit::UpdateTrack {
                track_id: "b".to_owned(),
                settings: vec![
                    TrackSetting::Muted(true),
                    TrackSetting::Label("Bass".into()),
                ],
            },
            &original,
        );
        assert!(edited.tracks[1].muted);
        assert_eq!(edited.tracks[1].label, "Bass");
        assert!(!edited.tracks[1].solo);
        assert_eq!(json(&restored), json(&original));
    }

    /// Expanding a track or changing the scroll mode is view-only; anything else is not.
    #[test]
    fn view_only_edits() {
        let expand = TimelineEdit::UpdateTrack {
            track_id: "a".to_owned(),
            settings: vec![TrackSetting::Expanded(true)],
        };
        let expand_and_mute = TimelineEdit::UpdateTrack {
            track_id: "a".to_owned(),
            settings: vec![TrackSetting::Expanded(true), TrackSetting::Muted(true)],
        };
        let scroll = TimelineEdit::UpdateSettings {
            settings: vec![TimelineSetting::ScrollMode(TimelineScrollMode::Follow)],
        };
        assert!(expand.is_view_only());
        assert!(!expand_and_mute.is_view_only());
        assert!(scroll.is_view_only());
    }

    /// An edit to one track keeps a concurrent change elsewhere, such as a new marker.
    #[test]
    fn track_edit_keeps_concurrent_marker() {
        let mut stored = timeline();
        let edit = TimelineEdit::UpdateTrack {
            track_id: "a".to_owned(),
            settings: vec![TrackSetting::Solo(true)],
        };
        stored.markers.push(TimelineMarker {
            uid: uuid::Uuid::new_v4(),
            label: "Drop".to_owned(),
            time: Duration::from_secs(4),
            color: None,
        });
        let inverse = edit.apply(&mut stored).expect("edit applies");
        assert_eq!(stored.markers.len(), 1);
        inverse.apply(&mut stored).expect("inverse applies");
        assert_eq!(stored.markers.len(), 1);
        assert!(!stored.tracks[0].solo);
    }

    /// Storing a new lane adds it, storing it again replaces it, and both undo cleanly.
    #[test]
    fn store_and_replace_automation_lane() {
        let original = timeline();
        let lane = AutomationLane {
            id: "dimmer".to_owned(),
            name: "Dimmer".to_owned(),
            color: "#fff".to_owned(),
            points: Vec::new(),
            parameter_type: ParameterType::GlobalVariable("dimmer".to_owned()),
        };
        let (added, restored) = round_trip(
            TimelineEdit::StoreAutomationLane {
                track_id: "b".to_owned(),
                lane: lane.clone(),
                before_lane_id: None,
            },
            &original,
        );
        assert_eq!(added.tracks[1].automation_lanes.len(), 1);
        assert_eq!(json(&restored), json(&original));

        let mut renamed = lane;
        renamed.name = "Intensity".to_owned();
        let (replaced, restored) = round_trip(
            TimelineEdit::StoreAutomationLane {
                track_id: "b".to_owned(),
                lane: renamed,
                before_lane_id: None,
            },
            &added,
        );
        assert_eq!(replaced.tracks[1].automation_lanes[0].name, "Intensity");
        assert_eq!(json(&restored), json(&added));
    }

    /// Adding, replacing and deleting actions in one change undoes as one change.
    #[test]
    fn change_actions_round_trip() {
        let original = timeline();
        let mut renamed = action("x", 100);
        renamed.label = "Renamed".to_owned();
        let (edited, restored) = round_trip(
            TimelineEdit::ChangeActions {
                store: vec![
                    TrackAction {
                        track_id: "a".to_owned(),
                        action: renamed,
                    },
                    TrackAction {
                        track_id: "b".to_owned(),
                        action: action("z", 300),
                    },
                ],
                delete: vec![TimelineActionRef {
                    track_id: "a".to_owned(),
                    action_id: "y".to_owned(),
                }],
            },
            &original,
        );
        assert_eq!(edited.tracks[0].actions.len(), 1);
        assert_eq!(edited.tracks[0].actions[0].label, "Renamed");
        assert_eq!(edited.tracks[1].actions[0].id, "z");
        let restored_ids = restored.tracks[0]
            .actions
            .iter()
            .map(|action| (action.id.as_str(), action.label.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(restored_ids, [("x", "Action x"), ("y", "Action y")]);
        assert!(restored.tracks[1].actions.is_empty());
    }

    /// Storing an action ID that another track holds is rejected.
    #[test]
    fn change_actions_rejects_id_on_other_track() {
        let original = timeline();
        let mut edited = original.clone();
        let error = TimelineEdit::ChangeActions {
            store: vec![TrackAction {
                track_id: "b".to_owned(),
                action: action("x", 0),
            }],
            delete: Vec::new(),
        }
        .apply(&mut edited)
        .unwrap_err();
        assert!(error.contains("is on track a"), "{error}");
        assert_eq!(json(&edited), json(&original));
    }

    /// Moving actions within and across tracks undoes back to the old positions and tracks.
    #[test]
    fn move_actions_round_trip() {
        let original = timeline();
        let (edited, restored) = round_trip(
            TimelineEdit::MoveActions {
                moves: vec![
                    TimelineActionMove {
                        track_id: "a".to_owned(),
                        action_id: "x".to_owned(),
                        position: Duration::from_millis(900),
                        to_track_id: Some("c".to_owned()),
                    },
                    TimelineActionMove {
                        track_id: "a".to_owned(),
                        action_id: "y".to_owned(),
                        position: Duration::from_millis(250),
                        to_track_id: None,
                    },
                ],
            },
            &original,
        );
        assert_eq!(
            edited.tracks[0].actions[0].position,
            Duration::from_millis(250)
        );
        assert_eq!(edited.tracks[2].actions[0].id, "x");
        assert_eq!(
            edited.tracks[2].actions[0].position,
            Duration::from_millis(900)
        );
        assert_eq!(restored.tracks[0].actions.len(), 2);
        assert!(restored.tracks[2].actions.is_empty());
        let x = restored.tracks[0]
            .actions
            .iter()
            .find(|action| action.id == "x")
            .expect("x is back on track a");
        assert_eq!(x.position, Duration::from_millis(100));
    }

    /// A move naming a missing action fails without moving any other action.
    #[test]
    fn move_actions_is_all_or_nothing() {
        let original = timeline();
        let mut edited = original.clone();
        let error = TimelineEdit::MoveActions {
            moves: vec![
                TimelineActionMove {
                    track_id: "a".to_owned(),
                    action_id: "x".to_owned(),
                    position: Duration::from_millis(900),
                    to_track_id: None,
                },
                TimelineActionMove {
                    track_id: "a".to_owned(),
                    action_id: "x".to_owned(),
                    position: Duration::ZERO,
                    to_track_id: None,
                },
            ],
        }
        .apply(&mut edited)
        .unwrap_err();
        assert!(error.contains("more than once"), "{error}");
        assert_eq!(json(&edited), json(&original));
    }

    /// Edits skip actions and neighbors that another client already removed, so undoing a
    /// delete, move or nudge still applies what it can.
    #[test]
    fn edits_skip_targets_that_are_gone() {
        let original = timeline();

        let mut edited = original.clone();
        let inverse = TimelineEdit::ChangeActions {
            store: Vec::new(),
            delete: vec![
                TimelineActionRef {
                    track_id: "a".to_owned(),
                    action_id: "x".to_owned(),
                },
                TimelineActionRef {
                    track_id: "a".to_owned(),
                    action_id: "gone".to_owned(),
                },
            ],
        }
        .apply(&mut edited)
        .expect("a missing action is skipped");
        assert_eq!(edited.tracks[0].actions.len(), 1);
        let TimelineEdit::ChangeActions { store, .. } = inverse else {
            panic!("expected change-actions inverse");
        };
        assert_eq!(store.len(), 1, "only the deleted action is restored");

        let mut edited = original.clone();
        TimelineEdit::MoveActions {
            moves: vec![
                TimelineActionMove {
                    track_id: "a".to_owned(),
                    action_id: "x".to_owned(),
                    position: Duration::from_millis(900),
                    to_track_id: Some("gone".to_owned()),
                },
                TimelineActionMove {
                    track_id: "a".to_owned(),
                    action_id: "y".to_owned(),
                    position: Duration::from_millis(50),
                    to_track_id: None,
                },
            ],
        }
        .apply(&mut edited)
        .expect("a move onto a missing track is skipped");
        assert_eq!(
            edited.tracks[0].actions[0].position,
            Duration::from_millis(100)
        );
        assert_eq!(
            edited.tracks[0].actions[1].position,
            Duration::from_millis(50)
        );

        let mut edited = original.clone();
        TimelineEdit::InsertTrack {
            track: track("d"),
            before_track_id: Some("gone".to_owned()),
        }
        .apply(&mut edited)
        .expect("a missing neighbor puts the track last");
        assert_eq!(track_ids(&edited), vec!["a", "b", "c", "d"]);
    }

    /// A cleared optional setting arrives from the web UI without a value, or with `null`, and
    /// both clear the setting.
    #[test]
    fn optional_setting_without_value_clears_it() {
        for json in [r#"{"type":"EndTime"}"#, r#"{"type":"EndTime","data":null}"#] {
            let setting: TimelineSetting = serde_json::from_str(json).expect(json);
            assert!(matches!(setting, TimelineSetting::EndTime(None)), "{json}");
        }
    }

    /// Retiming places actions, markers and regions and undo puts them back; a region ending
    /// before it starts is refused, and a missing target is skipped.
    #[test]
    fn retime_round_trip_and_validation() {
        let mut original = timeline();
        let marker_uid = Uuid::new_v4();
        let region_uid = Uuid::new_v4();
        original.markers.push(TimelineMarker {
            uid: marker_uid,
            label: "Drop".to_owned(),
            time: Duration::from_millis(500),
            color: None,
        });
        original.regions.push(crate::timeline::TimelineRegion {
            uid: region_uid,
            label: "Verse".to_owned(),
            start: Duration::from_millis(1000),
            end: Duration::from_millis(2000),
            color: None,
        });
        let edit = TimelineEdit::Retime {
            actions: vec![ActionTime {
                track_id: "a".to_owned(),
                action_id: "y".to_owned(),
                position: Duration::from_millis(250),
            }],
            markers: vec![MarkerTime {
                marker_uid,
                time: Duration::from_millis(750),
            }],
            regions: vec![RegionSpan {
                region_uid,
                start: Duration::from_millis(1500),
                end: Duration::from_millis(2500),
            }],
        };

        let (edited, restored) = round_trip(edit, &original);
        assert_eq!(
            edited.tracks[0].actions[1].position,
            Duration::from_millis(250)
        );
        assert_eq!(edited.markers[0].time, Duration::from_millis(750));
        assert_eq!(edited.regions[0].start, Duration::from_millis(1500));
        assert_eq!(edited.regions[0].end, Duration::from_millis(2500));
        assert_eq!(json(&restored), json(&original));

        let mut unchanged = original.clone();
        let backwards = TimelineEdit::Retime {
            actions: vec![ActionTime {
                track_id: "a".to_owned(),
                action_id: "x".to_owned(),
                position: Duration::from_millis(50),
            }],
            markers: Vec::new(),
            regions: vec![RegionSpan {
                region_uid,
                start: Duration::from_millis(3000),
                end: Duration::from_millis(2000),
            }],
        };
        assert!(backwards.apply(&mut unchanged).is_err());
        let missing = TimelineEdit::Retime {
            actions: Vec::new(),
            markers: vec![MarkerTime {
                marker_uid: Uuid::new_v4(),
                time: Duration::ZERO,
            }],
            regions: Vec::new(),
        };
        let skipped = missing
            .apply(&mut unchanged)
            .expect("a missing marker is skipped");
        assert!(matches!(skipped, TimelineEdit::Retime { markers, .. } if markers.is_empty()));
        assert_eq!(json(&unchanged), json(&original));
    }

    /// Settings change only the named fields, undo restores them, and a zero tempo is refused.
    #[test]
    fn update_settings_round_trip_and_validation() {
        let original = timeline();
        let (edited, restored) = round_trip(
            TimelineEdit::UpdateSettings {
                settings: vec![
                    TimelineSetting::Bpm(128.0),
                    TimelineSetting::UseBeatGrid(true),
                    TimelineSetting::EndTime(Some(Duration::from_secs(60))),
                ],
            },
            &original,
        );
        assert_eq!(edited.bpm, 128.0);
        assert!(edited.use_beat_grid);
        assert_eq!(edited.end_time, Some(Duration::from_secs(60)));
        assert_eq!(edited.tracks.len(), 3);
        assert_eq!(json(&restored), json(&original));

        let mut rejected = timeline();
        let error = TimelineEdit::UpdateSettings {
            settings: vec![
                TimelineSetting::UseBeatGrid(true),
                TimelineSetting::Bpm(0.0),
            ],
        }
        .apply(&mut rejected)
        .unwrap_err();
        assert!(error.contains("positive"), "{error}");
        assert!(!rejected.use_beat_grid);
    }
}
