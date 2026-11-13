// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Components for timeline functionality
use std::collections::HashMap;
use std::time::Duration;

use bevy_ecs::lifecycle::HookContext;
use bevy_ecs::prelude::*;
use bevy_ecs::world::DeferredWorld;
#[cfg(feature = "audio")]
use nightfall_audio::AudioSinkId;
#[cfg(not(feature = "audio"))]
type AudioSinkId = ();
use nightfall_timecode::external::POSITION_JUMP_THRESHOLD;
use uuid::Uuid;

use crate::prelude::*;

/// Timeline playback between timecode reports that keep playing audio on the timecode.
pub const AUDIO_CLOCK_REPORT_INTERVAL: Duration = Duration::from_secs(1);

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

/// Where a range of timeline actions begins.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ActionRangeStart {
    /// From the timeline start, including actions placed exactly at zero.
    #[default]
    Beginning,
    /// After this position, excluding actions placed exactly on it because an earlier range
    /// already covered them.
    After(Duration),
}

impl ActionRangeStart {
    /// Returns whether an action at `position` lies at or after this start.
    pub fn admits(self, position: Duration) -> bool {
        match self {
            Self::Beginning => true,
            Self::After(start) => position > start,
        }
    }
}

/// Position up to which live playback has triggered a timeline's actions.
///
/// Render passes advance it as playback moves. Seeks and action edits move it when they are
/// handled, so the next render scans actions from the right place.
#[derive(Component, Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TimelineActionCursor {
    /// Where the next live action scan starts.
    position: ActionRangeStart,
    /// Skips the next live scan, so the render after a seek does not trigger actions that the
    /// seek reconstruction already applied.
    skip_next_scan: bool,
    /// Holds scans until the timecode runs again, after a stop that reset the timeline.
    wait_for_playback: bool,
}

impl TimelineActionCursor {
    /// Moves the cursor to a seek target and skips the next scan.
    pub fn seek_to(&mut self, position: Duration) {
        self.position = ActionRangeStart::After(position);
        self.skip_next_scan = true;
        self.wait_for_playback = false;
    }

    /// Moves the cursor to the timeline start, so the next scan re-evaluates every action up to
    /// the playback position.
    pub fn rewind(&mut self) {
        self.position = ActionRangeStart::Beginning;
        self.skip_next_scan = false;
        self.wait_for_playback = false;
    }

    /// Rewinds the cursor after a reset stop and holds scans until the timecode runs again,
    /// so a timeline that stays active does not replay its opening actions while stopped.
    pub fn rewind_for_next_play(&mut self) {
        self.rewind();
        self.wait_for_playback = true;
    }

    /// Returns whether scanning should wait, given whether the timecode is running. Releases
    /// the hold once it runs.
    pub fn holds_scan(&mut self, timecode_running: bool) -> bool {
        if timecode_running {
            self.wait_for_playback = false;
        }
        self.wait_for_playback
    }

    /// Returns whether a seek is waiting for the next scan to be skipped.
    pub fn seek_pending(&self) -> bool {
        self.skip_next_scan
    }

    /// Returns the start of the next live scan, or `None` when this scan is skipped. Clears the
    /// skip.
    pub fn take_scan_start(&mut self) -> Option<ActionRangeStart> {
        (!std::mem::take(&mut self.skip_next_scan)).then_some(self.position)
    }

    /// Records that a live scan reached `position`.
    pub fn advance_to(&mut self, position: Duration) {
        self.position = ActionRangeStart::After(position);
    }
}

/// Component for an active timeline in the ECS
#[derive(Component, Debug, Clone)]
#[require(TimelineActionCursor)]
#[component(on_remove = release_timeline_audio)]
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
    /// Timecode-derived offset last reported to this timeline's playing audio, or `None`
    /// while its audio is not playing.
    pub audio_clock_reported_offset: Option<Duration>,
    /// Entities spawned by this timeline's track actions, maps entity to (track_id, action_id, type)
    pub spawned_entities: HashMap<Entity, (String, String, SpawnedEntityType)>,
    /// The driving timecode's transport when this active timeline last observed it. `None`
    /// while inactive.
    observed_transport: Option<TimecodeTransport>,
}

/// What a timeline sees of its timecode's transport each render, to notice changes that no
/// timeline event announces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimecodeTransport {
    /// Whether the timecode follows an external source.
    pub external: bool,
    /// Whether the timecode is running.
    pub running: bool,
    /// How many times the running timecode has jumped to a new position.
    pub position_jumps: u64,
    /// The timecode's position.
    pub position: Duration,
}

impl TimecodeTransport {
    /// Returns whether audio must resync between two observations: the timecode started,
    /// stopped or jumped, or switched between the engine clock and an external source.
    fn changed_from(&self, previous: &Self) -> bool {
        (previous.external, previous.running, previous.position_jumps)
            != (self.external, self.running, self.position_jumps)
    }

    /// Returns whether an external source moved the timecode somewhere new since `previous`:
    /// it jumped while running, or it started running away from where it had stopped.
    fn relocated_from(&self, previous: &Self) -> bool {
        if !(previous.external && self.external && self.running) {
            return false;
        }
        if previous.running {
            previous.position_jumps != self.position_jumps
        } else {
            previous.position.abs_diff(self.position) > POSITION_JUMP_THRESHOLD
        }
    }
}

/// Stops the audio of a timeline whose entity is going away, such as when the timeline is
/// deleted or another show loads, because no later audio sync visits a despawned timeline.
fn release_timeline_audio(mut world: DeferredWorld, context: HookContext) {
    let Some(timeline) = world.get::<MaterializedTimeline>(context.entity) else {
        return;
    };
    let timeline_uid = timeline.timeline.identifiers.uid;
    // A timeline stopped earlier in the same frame has not sent its stop to browsers yet.
    let release_browser = timeline.is_active || timeline.audio_needs_sync;
    #[cfg(feature = "audio")]
    let sink_id = timeline.audio_sink_id;
    #[cfg(feature = "audio")]
    if let Some(sink_id) = sink_id
        && let Some(mut audio) = world.get_resource_mut::<nightfall_audio::AudioController>()
    {
        audio.stop(sink_id);
        audio.destroy_sink(sink_id);
    }
    if release_browser {
        crate::browser_audio::release_browser_audio(&mut world, timeline_uid);
    }
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
            audio_clock_reported_offset: None,
            spawned_entities: HashMap::new(),
            observed_transport: None,
        }
    }

    /// Resyncs audio when the timecode driving this timeline starts or stops running or jumps
    /// while running because an external source said so, or when the timecode switches between
    /// the engine clock and an external source. Returns whether an external source relocated
    /// the timecode, which the caller handles as a seek.
    ///
    /// An external sender, not a transport command, decides when such a timecode plays, so no
    /// timeline event marks those moments; switching a playing timecode to an external source
    /// stops it the same way. Audio plays along on its own clock and must follow the timecode,
    /// so each change re-seeks it to the timecode's position. Changes while the timecode stays on
    /// the engine clock come from transport commands, which already resync audio.
    pub fn follow_timecode_transport(&mut self, observed: TimecodeTransport) -> bool {
        if !self.is_active {
            self.observed_transport = None;
            return false;
        }
        let mut relocated = false;
        let mut recorded = observed;
        if let Some(previous) = self.observed_transport {
            if observed.changed_from(&previous) && (previous.external || observed.external) {
                self.audio_needs_sync = true;
            }
            relocated = observed.relocated_from(&previous);
            // While stopped, keep the position playback stopped at, so a locate made before
            // play resumes still reads as a relocation when it does.
            if !previous.running && !observed.running {
                recorded.position = previous.position;
            }
        }
        self.observed_transport = Some(recorded);
        relocated
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

    /// Anchor the clock that keeps this timeline's audio on the timecode after a full audio
    /// sync: audio that is `playing` from `offset` is due its first report one
    /// [`AUDIO_CLOCK_REPORT_INTERVAL`] later, and audio that is not playing gets none.
    pub fn anchor_audio_clock(&mut self, playing: bool, offset: Duration) {
        self.audio_clock_reported_offset = playing.then_some(offset);
    }

    /// Decide whether playing audio is due a timecode report at `offset`, so the audio
    /// output can snap back to the timecode. A report is due every
    /// [`AUDIO_CLOCK_REPORT_INTERVAL`] of playback, or after the timecode jumps that far,
    /// and only once a play has anchored the clock. Audio that stopped `playing` releases it.
    pub fn take_audio_clock_report(&mut self, playing: bool, offset: Duration) -> bool {
        if !playing {
            self.audio_clock_reported_offset = None;
            return false;
        }
        let due = self
            .audio_clock_reported_offset
            .is_some_and(|reported| offset.abs_diff(reported) >= AUDIO_CLOCK_REPORT_INTERVAL);
        if due {
            self.audio_clock_reported_offset = Some(offset);
        }
        due
    }

    /// Get the current playback position (computed from timecode and start offset)
    pub fn get_playback_position(&self, timecode_time: Duration) -> Duration {
        if !self.is_active || timecode_time < self.timeline.timecode_start {
            return Duration::ZERO;
        }

        timecode_time - self.timeline.timecode_start
    }

    /// Whether the timeline's transport has its audio playing: the timeline is active, its
    /// timecode is running, and the timecode has reached the timeline's `timecode_start`.
    /// During pre-roll the audio stays paused at its start; reaching the start flips
    /// `audio_start_reached`, whose resync begins playback in step with the timecode.
    pub fn audio_transport_playing(&self, timecode_time: Duration, timecode_running: bool) -> bool {
        self.is_active && timecode_running && timecode_time >= self.timeline.timecode_start
    }

    /// Process track actions based on the current timeline position
    /// Returns a list of `(track, action)` pairs that should be triggered
    pub fn process_actions(
        &mut self,
        scan_start: ActionRangeStart,
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
                if scan_start.admits(action.position) && action.position <= current_position {
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
    /// Returns changed values and active speed lanes, which must also reach newly started clips.
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
                let previous_value = self.parameter_values.get(&param_key).copied();

                // If the value changed by more than a small threshold, consider it changed
                // This prevents tiny floating point changes from triggering updates
                if previous_value.is_none_or(|previous| (previous - value).abs() > 0.001)
                    || matches!(param.parameter_type, ParameterType::ClipSpeed(_))
                {
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
        start: ActionRangeStart,
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
                if start.admits(action.position) && action.position <= end {
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

    /// Builds a transport observation at the timecode's start.
    fn transport(external: bool, running: bool, position_jumps: u64) -> TimecodeTransport {
        TimecodeTransport {
            external,
            running,
            position_jumps,
            position: Duration::ZERO,
        }
    }

    /// Audio stays paused during pre-roll before `timecode_start` and plays once the running
    /// timecode reaches it, and reaching the start requests the resync that begins playback.
    #[test]
    fn audio_waits_for_the_timeline_start() {
        let mut timeline = MaterializedTimeline::new(Timeline {
            timecode_start: Duration::from_secs(10),
            ..Default::default()
        });
        timeline.activate();
        timeline.update_with_timecode(Duration::from_secs(8));
        timeline.audio_needs_sync = false;

        assert!(!timeline.audio_transport_playing(Duration::from_secs(8), true));

        timeline.update_with_timecode(Duration::from_secs(10));
        assert!(timeline.audio_needs_sync);
        assert!(timeline.audio_transport_playing(Duration::from_secs(10), true));
        assert!(!timeline.audio_transport_playing(Duration::from_secs(10), false));

        timeline.deactivate();
        assert!(!timeline.audio_transport_playing(Duration::from_secs(12), true));
    }

    /// An active timeline resyncs audio when its external timecode starts, stops, or jumps,
    /// but not on the first observation after activation or while nothing changes.
    #[test]
    fn external_transport_changes_resync_audio() {
        let mut timeline = MaterializedTimeline::new(Timeline::default());
        timeline.activate();
        timeline.audio_needs_sync = false;

        timeline.follow_timecode_transport(transport(true, false, 0));
        assert!(!timeline.audio_needs_sync);

        timeline.follow_timecode_transport(transport(true, true, 0));
        assert!(timeline.audio_needs_sync);
        timeline.audio_needs_sync = false;

        timeline.follow_timecode_transport(transport(true, true, 0));
        assert!(!timeline.audio_needs_sync);

        timeline.follow_timecode_transport(transport(true, true, 1));
        assert!(timeline.audio_needs_sync);
        timeline.audio_needs_sync = false;

        timeline.follow_timecode_transport(transport(true, false, 1));
        assert!(timeline.audio_needs_sync);
    }

    /// An external timecode that jumps while running, or starts running away from where it
    /// stopped, relocates the timeline; resuming in place or engine-clock changes do not.
    #[test]
    fn external_locates_relocate_the_timeline() {
        let at = |external, running, position_jumps, secs| TimecodeTransport {
            external,
            running,
            position_jumps,
            position: Duration::from_secs(secs),
        };
        let mut timeline = MaterializedTimeline::new(Timeline::default());
        timeline.activate();

        assert!(!timeline.follow_timecode_transport(at(true, false, 0, 0)));
        assert!(
            timeline.follow_timecode_transport(at(true, true, 0, 1800)),
            "a sender starting mid-show is a locate"
        );
        assert!(!timeline.follow_timecode_transport(at(true, true, 0, 1801)));
        assert!(
            timeline.follow_timecode_transport(at(true, true, 1, 60)),
            "a rewind while running is a locate"
        );
        assert!(!timeline.follow_timecode_transport(at(true, false, 1, 61)));
        assert!(
            !timeline.follow_timecode_transport(at(true, true, 1, 61)),
            "resuming where the sender stopped is not a locate"
        );
        assert!(!timeline.follow_timecode_transport(at(true, false, 1, 62)));
        assert!(!timeline.follow_timecode_transport(at(true, false, 1, 900)));
        assert!(!timeline.follow_timecode_transport(at(true, false, 1, 900)));
        assert!(
            timeline.follow_timecode_transport(at(true, true, 1, 900)),
            "a locate made while stopped is a locate when play resumes"
        );
        assert!(!timeline.follow_timecode_transport(at(false, false, 1, 0)));
        assert!(!timeline.follow_timecode_transport(at(false, true, 1, 30)));
    }

    /// An action placed exactly at the timeline start fires on the first scan from the start,
    /// but not again on a later scan that resumes after zero.
    #[test]
    fn action_at_zero_fires_from_the_beginning() {
        let timeline = Timeline {
            tracks: vec![Track {
                id: "track".to_owned(),
                label: "Track".to_owned(),
                muted: false,
                solo: false,
                expanded: false,
                actions: vec![Action {
                    id: "at-zero".to_owned(),
                    label: "At zero".to_owned(),
                    position: Duration::ZERO,
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(Uuid::new_v4()).to_reference(),
                }],
                automation_lanes: Vec::new(),
            }],
            ..Default::default()
        };
        let mut materialized = MaterializedTimeline::new(timeline);

        let first = materialized
            .process_actions(
                TimelineActionCursor::default().position,
                Duration::from_millis(16),
            )
            .into_iter()
            .map(|(_, action)| action.id.clone())
            .collect::<Vec<_>>();
        assert_eq!(first, ["at-zero"]);

        materialized.reset_action_triggers();
        let resumed = materialized.process_actions(
            ActionRangeStart::After(Duration::ZERO),
            Duration::from_millis(32),
        );
        assert!(resumed.is_empty());
        assert_eq!(
            materialized
                .collect_actions_in_range(ActionRangeStart::Beginning, Duration::ZERO)
                .len(),
            1,
            "seek reconstruction to the start includes the action"
        );
    }

    /// Switching a playing engine-clock timecode to an external source resyncs audio, so audio
    /// stops with the now-waiting timecode; engine-clock transport changes leave audio to the
    /// transport commands that caused them.
    #[test]
    fn switching_to_external_source_resyncs_audio() {
        let mut timeline = MaterializedTimeline::new(Timeline::default());
        timeline.activate();
        timeline.audio_needs_sync = false;

        timeline.follow_timecode_transport(transport(false, true, 0));
        timeline.follow_timecode_transport(transport(false, false, 0));
        assert!(!timeline.audio_needs_sync);
        timeline.follow_timecode_transport(transport(false, true, 0));
        assert!(!timeline.audio_needs_sync);

        timeline.follow_timecode_transport(transport(true, false, 0));
        assert!(timeline.audio_needs_sync);
        timeline.audio_needs_sync = false;

        timeline.follow_timecode_transport(transport(false, false, 0));
        assert!(timeline.audio_needs_sync);
    }

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
                        action: ActionKind::StartClip(clip_a).to_reference(),
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
                        action: ActionKind::StartClip(clip_b).to_reference(),
                    }],
                    automation_lanes: Vec::new(),
                },
            ],
            ..Timeline::default()
        };
        let mut materialized = MaterializedTimeline::new(timeline);

        let triggered =
            materialized.process_actions(ActionRangeStart::Beginning, Duration::from_millis(150));
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

    /// Verifies timecode reports for playing audio wait for a play to anchor them, fall due
    /// once per report interval of playback or after a jump back in the timecode, and stop
    /// once the audio is no longer playing.
    #[test]
    fn audio_clock_reports_follow_playback_progress() {
        let mut materialized = MaterializedTimeline::new(Timeline::default());
        assert!(!materialized.take_audio_clock_report(true, Duration::from_secs(5)));

        materialized.anchor_audio_clock(true, Duration::from_secs(1));
        assert!(!materialized.take_audio_clock_report(true, Duration::from_millis(1_900)));
        assert!(materialized.take_audio_clock_report(true, Duration::from_secs(2)));
        assert_eq!(
            materialized.audio_clock_reported_offset,
            Some(Duration::from_secs(2))
        );
        assert!(!materialized.take_audio_clock_report(true, Duration::from_millis(2_500)));
        assert!(materialized.take_audio_clock_report(true, Duration::from_millis(500)));
        assert!(!materialized.take_audio_clock_report(false, Duration::from_secs(9)));
        assert_eq!(materialized.audio_clock_reported_offset, None);
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
                        action: ActionKind::StartClip(clip_a).to_reference(),
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
                        action: ActionKind::StartClip(clip_b).to_reference(),
                    }],
                    automation_lanes: Vec::new(),
                },
            ],
            ..Timeline::default()
        };
        let mut materialized = MaterializedTimeline::new(timeline);

        let triggered =
            materialized.process_actions(ActionRangeStart::Beginning, Duration::from_millis(500));

        assert_eq!(
            triggered
                .iter()
                .map(|(track, action)| (track.id.as_str(), action.id.as_str()))
                .collect::<Vec<_>>(),
            vec![("track-b", "early-start"), ("track-a", "late-start")]
        );
    }
}
