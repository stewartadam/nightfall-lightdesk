// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Components for timeline functionality
use std::collections::HashMap;
use std::time::Duration;

use bevy_ecs::prelude::*;
#[cfg(feature = "audio")]
use nightfall_audio::AudioSinkId;
#[cfg(not(feature = "audio"))]
type AudioSinkId = ();
use uuid::Uuid;

use crate::prelude::*;

/// Tracks the type of entity spawned by a timeline
#[derive(Clone, Debug)]
pub enum SpawnedEntityType {
    /// A clip started by the timeline
    Clip,
    /// A standalone cue materialized by the timeline
    Cue,
    /// An instance entity directly materialized by the timeline planner.
    Instance,
}

/// Component for an active timeline in the ECS
#[derive(Component, Debug, Clone)]
pub struct MaterializedTimeline {
    /// Unique ID for this materialized timeline
    pub owner_uuid: Uuid,
    /// The timeline data
    pub timeline: Timeline,
    /// If this timeline should respond to its associated timecode
    pub is_active: bool,
    /// Whether the timeline has had a significant state change that should trigger audio changes
    pub audio_needs_sync: bool,
    /// Whether the previous timecode update had reached this timeline's start.
    audio_start_reached: bool,
    /// Current parameter values (track_id, parameter_id) -> current_value
    pub parameter_values: HashMap<(String, String), f32>,
    /// Action trigger state (action_id -> triggered_at)
    pub triggered_actions: HashMap<(String, String), Duration>,
    /// The audio sink ID associated with this timeline
    pub audio_sink_id: Option<AudioSinkId>,
    /// Entities spawned by this timeline's track actions, maps entity to (track_id, action_id, type)
    pub spawned_entities: HashMap<Entity, (String, String, SpawnedEntityType)>,
}

/// Implementation of MaterializedTimeline
impl MaterializedTimeline {
    /// Create a new materialized timeline from a Timeline
    pub fn new(timeline: Timeline) -> Self {
        Self {
            owner_uuid: Uuid::new_v4(),
            timeline,
            is_active: false,
            audio_needs_sync: false,
            audio_start_reached: false,
            parameter_values: HashMap::new(),
            triggered_actions: HashMap::new(),
            audio_sink_id: None,
            spawned_entities: HashMap::new(),
        }
    }

    /// Activate the timeline, which begins audio playback
    pub fn activate(&mut self) {
        tracing::debug!("Activating timeline {}", self.timeline.identifiers.id);
        // Make sure this component gets marked as changed
        self.is_active = true;
        self.audio_needs_sync = true;
    }

    /// Deactivate the timeline, which stops audio playback
    pub fn deactivate(&mut self) {
        tracing::debug!("De-activating timeline {}", self.timeline.identifiers.id);
        // Make sure this component gets marked as changed
        self.is_active = false;
        self.audio_needs_sync = true;
    }

    /// Update the timeline's state based on the associated timecode's current time
    pub fn update_with_timecode(&mut self, timecode_time: Duration) {
        if self.is_active {
            // Compute the timeline time based on the timecode time and our start time
            let timeline_time = if timecode_time >= self.timeline.timecode_start {
                timecode_time - self.timeline.timecode_start
            } else {
                Duration::ZERO
            };

            // Check if we've reached the end time
            if let Some(end_time) = self.timeline.end_time
                && timeline_time >= end_time
            {
                self.deactivate();
                // deactivate() already sets significant_change and updates last_update
                return;
            }

            // Detect transport transitions independently of the host's audio resources.
            let start_reached = timecode_time >= self.timeline.timecode_start;
            if start_reached != self.audio_start_reached {
                self.audio_start_reached = start_reached;
                self.audio_needs_sync = true;
            }
        }
    }

    /// Get the current playback position (computed from timecode and start offset)
    pub fn get_playback_position(&self, timecode_time: Duration) -> Duration {
        if !self.is_active || timecode_time < self.timeline.timecode_start {
            return Duration::ZERO;
        }

        timecode_time - self.timeline.timecode_start
    }

    /// Process track actions based on the current timeline position
    /// Returns a list of `(track, action)` pairs that should be triggered
    pub fn process_actions(
        &mut self,
        last_processed: Duration,
        current_position: Duration,
    ) -> Vec<(&Track, &Action)> {
        let timeline = &self.timeline;
        let triggered_actions = &mut self.triggered_actions;
        let solo_mode = timeline.tracks.iter().any(|track| track.solo);
        let mut eligible_actions = Vec::new();
        let mut actions_to_trigger = Vec::new();

        for (track_index, track) in timeline.tracks.iter().enumerate() {
            if track.muted {
                continue;
            }
            if solo_mode && !track.solo {
                continue;
            }
            for (action_index, action) in track.actions.iter().enumerate() {
                if action.position > last_processed && action.position <= current_position {
                    eligible_actions.push((track_index, action_index));
                }
            }
        }
        eligible_actions.sort_by_key(|(track_index, action_index)| {
            (
                timeline.tracks[*track_index].actions[*action_index].position,
                *track_index,
                *action_index,
            )
        });

        for (track_index, action_index) in eligible_actions {
            let track = &timeline.tracks[track_index];
            let action = &track.actions[action_index];
            tracing::debug!(
                action_id = %action.id,
                position = ?action.position,
                "Processing action"
            );
            if let std::collections::hash_map::Entry::Vacant(entry) =
                triggered_actions.entry((track.id.clone(), action.id.clone()))
            {
                entry.insert(action.position);
                actions_to_trigger.push((track, action));
            }
        }

        actions_to_trigger
    }

    /// Process automation lanes and calculate current values based on timeline position
    /// Returns a map of all parameters that changed value
    pub fn process_parameters(
        &mut self,
        timeline_time: Duration,
    ) -> HashMap<(String, String), f32> {
        let mut changed_parameters = HashMap::new();

        // Process each track
        for track in self.timeline.tracks.iter().filter(|t| !t.muted) {
            // Skip if track is muted or we're in solo mode and this track isn't soloed
            let solo_mode = self.timeline.tracks.iter().any(|t| t.solo);
            if solo_mode && !track.solo {
                continue;
            }

            // Process parameters for this track
            for param in &track.automation_lanes {
                // Skip if there are no points
                if param.points.is_empty() {
                    continue;
                }

                // Convert to sorted duration points for easier interpolation
                let mut sorted_points: Vec<(Duration, f32)> =
                    param.points.iter().map(|p| (p.position, p.value)).collect();

                sorted_points.sort_by_key(|(pos, _)| *pos);

                // Find the surrounding points for the current time
                let value = if timeline_time <= sorted_points[0].0 {
                    // Before first point, use first point value
                    sorted_points[0].1
                } else if timeline_time >= sorted_points.last().unwrap().0 {
                    // After last point, use last point value
                    sorted_points.last().unwrap().1
                } else {
                    // Find the points that surround the current time
                    let mut prev_point = &sorted_points[0];
                    let mut next_point = prev_point;

                    for points in sorted_points.windows(2) {
                        if points[0].0 <= timeline_time && timeline_time <= points[1].0 {
                            prev_point = &points[0];
                            next_point = &points[1];
                            break;
                        }
                    }

                    // Linear interpolation between points
                    if prev_point.0 == next_point.0 {
                        prev_point.1
                    } else {
                        let time_range =
                            next_point.0.as_millis() as f32 - prev_point.0.as_millis() as f32;
                        let time_progress =
                            timeline_time.as_millis() as f32 - prev_point.0.as_millis() as f32;
                        let t = time_progress / time_range;
                        prev_point.1 + t * (next_point.1 - prev_point.1)
                    }
                };

                // Check if the value has changed significantly
                let param_key = (track.id.clone(), param.id.clone());
                let previous_value = self
                    .parameter_values
                    .get(&param_key)
                    .copied()
                    .unwrap_or(0.0);

                // If the value changed by more than a small threshold, consider it changed
                // This prevents tiny floating point changes from triggering updates
                if (previous_value - value).abs() > 0.001 {
                    self.parameter_values.insert(param_key.clone(), value);
                    changed_parameters.insert(param_key, value);
                }
            }
        }

        changed_parameters
    }

    /// Reset action triggers - used when seeking to a new position
    pub fn reset_action_triggers(&mut self) {
        self.triggered_actions.clear();
    }

    /// Collect all track actions that occur within a time range, in order
    pub fn collect_actions_in_range(
        &self,
        start: Duration,
        end: Duration,
    ) -> Vec<(&Action, &Track)> {
        let mut actions = Vec::new();

        for track in self.timeline.tracks.iter().filter(|t| !t.muted) {
            // Skip if in solo mode and track not soloed
            let solo_mode = self.timeline.tracks.iter().any(|t| t.solo);
            if solo_mode && !track.solo {
                continue;
            }

            for action in &track.actions {
                if action.position > start && action.position <= end {
                    actions.push((action, track));
                }
            }
        }

        // Sort by position
        actions.sort_by_key(|(action, _)| action.position);
        actions
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use nightfall::prelude::Identifiers;
    use uuid::Uuid;

    use super::*;

    #[test]
    fn process_actions_preserves_track_identity() {
        let clip_a = Uuid::new_v4();
        let clip_b = Uuid::new_v4();
        let action_id = "action-1".to_string();

        let timeline = Timeline {
            identifiers: Identifiers {
                id: 1,
                ..Identifiers::default()
            },
            tracks: vec![
                Track {
                    id: "track-a".to_string(),
                    label: "Track A".to_string(),
                    muted: false,
                    solo: false,
                    expanded: false,
                    actions: vec![Action {
                        id: action_id.clone(),
                        label: "Start A".to_string(),
                        position: Duration::from_millis(100),
                        duration: Duration::from_millis(200),
                        action: ActionKind::StartClip(clip_a),
                    }],
                    automation_lanes: Vec::new(),
                },
                Track {
                    id: "track-b".to_string(),
                    label: "Track B".to_string(),
                    muted: false,
                    solo: false,
                    expanded: false,
                    actions: vec![Action {
                        id: action_id.clone(),
                        label: "Start B".to_string(),
                        position: Duration::from_millis(100),
                        duration: Duration::from_millis(200),
                        action: ActionKind::StartClip(clip_b),
                    }],
                    automation_lanes: Vec::new(),
                },
            ],
            ..Timeline::default()
        };
        let mut materialized = MaterializedTimeline::new(timeline);

        let triggered = materialized.process_actions(Duration::ZERO, Duration::from_millis(150));
        assert_eq!(triggered.len(), 2);

        let triggered_pairs: HashSet<(String, String)> = triggered
            .iter()
            .map(|(track, action)| (track.id.clone(), action.id.clone()))
            .collect();
        assert!(triggered_pairs.contains(&("track-a".to_string(), action_id.clone())));
        assert!(triggered_pairs.contains(&("track-b".to_string(), action_id.clone())));

        assert!(
            materialized
                .triggered_actions
                .contains_key(&("track-a".to_string(), action_id.clone()))
        );
        assert!(
            materialized
                .triggered_actions
                .contains_key(&("track-b".to_string(), action_id))
        );
    }

    /// Verifies cross-track track actions are emitted in timeline-position order.
    #[test]
    fn process_actions_orders_actions_by_position() {
        let clip_a = Uuid::new_v4();
        let clip_b = Uuid::new_v4();

        let timeline = Timeline {
            identifiers: Identifiers {
                id: 2,
                ..Identifiers::default()
            },
            tracks: vec![
                Track {
                    id: "track-a".to_string(),
                    label: "Track A".to_string(),
                    muted: false,
                    solo: false,
                    expanded: false,
                    actions: vec![Action {
                        id: "late-start".to_string(),
                        label: "Late start".to_string(),
                        position: Duration::from_millis(300),
                        duration: Duration::ZERO,
                        action: ActionKind::StartClip(clip_a),
                    }],
                    automation_lanes: Vec::new(),
                },
                Track {
                    id: "track-b".to_string(),
                    label: "Track B".to_string(),
                    muted: false,
                    solo: false,
                    expanded: false,
                    actions: vec![Action {
                        id: "early-start".to_string(),
                        label: "Early start".to_string(),
                        position: Duration::from_millis(100),
                        duration: Duration::ZERO,
                        action: ActionKind::StartClip(clip_b),
                    }],
                    automation_lanes: Vec::new(),
                },
            ],
            ..Timeline::default()
        };
        let mut materialized = MaterializedTimeline::new(timeline);

        let triggered = materialized.process_actions(Duration::ZERO, Duration::from_millis(500));

        assert_eq!(
            triggered
                .iter()
                .map(|(track, action)| (track.id.as_str(), action.id.as_str()))
                .collect::<Vec<_>>(),
            vec![("track-b", "early-start"), ("track-a", "late-start")]
        );
    }
}
