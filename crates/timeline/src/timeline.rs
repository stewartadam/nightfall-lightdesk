// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_ecs::prelude::Resource;
use nightfall::prelude::*;
use nightfall_actions::ActionReference;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Scroll behavior mode for timeline playback
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
#[typeshare::typeshare]
pub enum TimelineScrollMode {
    /// Do not auto-scroll during playback
    #[default]
    Free,
    /// Keep playhead centered in view
    Center,
    /// Scroll only when playhead approaches viewport edge
    Follow,
}

/// How a timeline becomes active for playback and trigger processing.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[typeshare::typeshare]
pub enum TimelineTriggerMode {
    /// Timeline starts only from an explicit timeline start command.
    Manual,
    /// Timeline follows start/stop events from its linked timecode.
    #[default]
    FollowTimecode,
}

/// How timeline-owned state is handled when seeking the linked timecode.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[typeshare::typeshare]
pub enum TimelineSeekBehavior {
    /// Move the playhead only and leave timeline-owned playback state untouched.
    MovePlayheadOnly,
    /// Rebuild timeline-owned state from the evaluated timeline plan at the seek target.
    #[default]
    ReconstructState,
}

/// How non-deterministic timeline actions are handled during seek reconstruction.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[typeshare::typeshare]
pub enum TimelineNondeterministicSeekBehavior {
    /// Ignore non-deterministic actions while reconstructing state.
    #[default]
    Ignore,
    /// Dispatch non-deterministic actions when seeking past them.
    Dispatch,
}

/// How timeline-owned state is handled when the linked timecode stops.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[typeshare::typeshare]
pub enum TimelineStopBehavior {
    /// Leave triggered actions and timeline-owned actions as-is.
    KeepState,
    /// Reset trigger state and release timeline-owned actions.
    #[default]
    ResetAndReleaseOwnedActions,
}

/// Timeline-level policy for playback lookahead.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
#[typeshare::typeshare]
pub enum TimelineLookaheadMode {
    /// Preserve source-local lookahead behavior without timeline-level preactivation.
    #[default]
    Inherit,
    /// Enable lookahead for all timeline-owned playback.
    Enabled,
    /// Disable lookahead for all timeline-owned playback.
    Disabled,
}

/// Source of beatgrid detection data
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
#[typeshare::typeshare]
pub enum BeatgridSource {
    /// Beatgrid generated automatically after audio changes
    #[default]
    Auto,
    /// Beatgrid generated from explicit user request
    Manual,
}

/// A detected beat marker on the timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BeatMarker {
    /// Beat position in timeline time.
    pub time: Duration,
    /// Zero-based beat index.
    pub beat_index: u32,
    /// Whether this marker is considered a downbeat (bar start).
    pub is_downbeat: bool,
    /// Optional per-marker confidence score in 0..1.
    pub confidence: Option<f32>,
}

/// Persisted beatgrid analysis data for a timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BeatgridData {
    /// Origin of the currently stored beatgrid.
    pub source: BeatgridSource,
    /// Fingerprint of the audio content used to generate this beatgrid.
    pub audio_fingerprint: String,
    /// Estimated tempo in beats per minute.
    pub bpm: f32,
    /// Beats per bar used for downbeat inference.
    pub beats_per_bar: u8,
    /// Beat and downbeat markers.
    pub markers: Vec<BeatMarker>,
    /// Overall confidence score in 0..1.
    pub confidence: f32,
}

/// Transient beatgrid proposal returned by detector before apply/reject.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BeatgridProposal {
    /// Request identifier for apply/reject.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub request_id: Uuid,
    /// Origin of the proposal.
    pub source: BeatgridSource,
    /// Fingerprint of the analyzed audio.
    pub audio_fingerprint: String,
    /// Estimated tempo in beats per minute.
    pub bpm: f32,
    /// Beats per bar used for downbeat inference.
    pub beats_per_bar: u8,
    /// Proposed beat and downbeat markers.
    pub markers: Vec<BeatMarker>,
    /// Overall confidence score in 0..1.
    pub confidence: f32,
}

/// Notification emitted when a beatgrid detection request starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BeatgridDetectionStarted {
    /// Timeline UID associated with the request.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub timeline_uid: Uuid,
    /// Request identifier.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub request_id: Uuid,
}

/// Notification emitted when beatgrid detection produced a proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BeatgridDetectionReady {
    /// Timeline UID associated with the request.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub timeline_uid: Uuid,
    /// Proposed beatgrid data.
    pub proposal: BeatgridProposal,
}

/// Notification emitted when beatgrid detection fails.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BeatgridDetectionFailed {
    /// Timeline UID associated with the request.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub timeline_uid: Uuid,
    /// Request identifier.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub request_id: Uuid,
    /// Error details.
    pub error: String,
}

/// A labelled point used for timeline navigation and timing references.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelineMarker {
    /// Unique identifier for this marker.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    /// User-facing marker label.
    pub label: String,
    /// Marker position in timeline time.
    pub time: Duration,
    /// Optional CSS color for timeline display.
    pub color: Option<String>,
}

/// A labelled time span used to describe show sections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelineRegion {
    /// Unique identifier for this region.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    /// User-facing region label.
    pub label: String,
    /// Region start in timeline time.
    pub start: Duration,
    /// Region end in timeline time.
    pub end: Duration,
    /// Optional CSS color for timeline display.
    pub color: Option<String>,
}

/// Persisted loop range for a timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelineLoopRange {
    /// Loop start in timeline time.
    pub start: Duration,
    /// Loop end in timeline time.
    pub end: Duration,
    /// Whether UI-side loop behavior is enabled.
    pub enabled: bool,
}

/// Runtime state describing whether a timeline action can currently preactivate.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[typeshare::typeshare]
pub enum TimelineLookaheadActionStatusKind {
    /// The action is safe to preactivate but is not currently asserting lookahead.
    Ready,
    /// The action has at least one assertion in the active timeline lookahead layer.
    Asserted,
    /// An intervening timeline action asserts a fixture needed by this action.
    BlockedByInterveningFixtureAssertions,
}

/// Timeline action that prevents a future action from preactivating lookahead.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct TimelineLookaheadActionBlocker {
    /// Timeline track that owns the blocking action.
    pub track_id: String,
    /// Blocking timeline action identifier.
    pub action_id: String,
}

/// Runtime lookahead status for a single timeline action.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct TimelineLookaheadActionStatus {
    /// Timeline definition UID that owns the action.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub timeline_uid: Uuid,
    /// Timeline track that owns the action.
    pub track_id: String,
    /// Timeline action identifier.
    pub action_id: String,
    /// Current lookahead status.
    pub kind: TimelineLookaheadActionStatusKind,
    /// Intervening timeline actions that currently block this action's lookahead.
    pub blocking_actions: Vec<TimelineLookaheadActionBlocker>,
}

/// Runtime lookahead statuses for timeline actions.
#[derive(Resource, Debug, Clone, Default, PartialEq, Eq)]
pub struct TimelineLookaheadActionStatuses {
    /// Current action statuses.
    pub statuses: Vec<TimelineLookaheadActionStatus>,
}

/// A selected timeline object that can be edited by shared timeline commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum TimelineSelection {
    /// A timeline action.
    Action {
        /// Track identifier containing the action.
        track_id: String,
        /// Action identifier.
        action_id: String,
    },
    /// A marker point.
    Marker {
        /// Marker UID.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        marker_uid: Uuid,
    },
    /// A region body, preserving duration while moving.
    RegionBody {
        /// Region UID.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        region_uid: Uuid,
    },
    /// A region start handle.
    RegionStart {
        /// Region UID.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        region_uid: Uuid,
    },
    /// A region end handle.
    RegionEnd {
        /// Region UID.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        region_uid: Uuid,
    },
}

/// A Timeline connects audio playback with timecode and provides
/// a way to trigger events based on timecode position
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Timeline {
    /// Identifiers for the timeline
    pub identifiers: Identifiers,
    /// The ID of the timecode this timeline is associated with
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub timecode_uid: Uuid,
    /// The time offset in the timecode where the audio should start
    pub timecode_start: Duration,
    /// Path to the audio file
    pub audio_path: String,
    /// Whether audio playback should follow this timeline.
    #[serde(default = "default_audio_enabled")]
    pub audio_enabled: bool,
    /// Optional end duration (if not set, will play until the audio file ends)
    pub end_time: Option<Duration>,
    /// How this timeline becomes active.
    #[serde(default)]
    pub trigger_mode: TimelineTriggerMode,
    /// How seek commands affect timeline-owned state.
    #[serde(default)]
    pub seek_behavior: TimelineSeekBehavior,
    /// How seek reconstruction handles timeline actions that cannot be materialized deterministically.
    #[serde(default)]
    pub nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior,
    /// How stop commands affect timeline-owned state.
    #[serde(default)]
    pub stop_behavior: TimelineStopBehavior,
    /// How timeline-owned playback should apply lookahead.
    #[serde(default)]
    pub lookahead: TimelineLookaheadMode,
    /// Tracks containing actions and parameters that respond to timecode
    pub tracks: Vec<Track>,
    /// Labelled marker points for navigation and timing references.
    #[serde(default)]
    pub markers: Vec<TimelineMarker>,
    /// Labelled region spans for show structure.
    #[serde(default)]
    pub regions: Vec<TimelineRegion>,
    /// Persisted loop range shared by all panels viewing this timeline.
    #[serde(default)]
    pub loop_range: Option<TimelineLoopRange>,
    /// BPM when using beat grid
    pub bpm: f32,
    /// Beats per bar when using beat grid
    pub beats_per_bar: u8,
    /// Whether beat grid mode is enabled
    #[serde(default)]
    pub use_beat_grid: bool,
    /// Persisted detected beatgrid data.
    #[serde(default)]
    pub beatgrid: Option<BeatgridData>,
    /// UI scroll behavior mode for timeline playback
    #[serde(default)]
    pub scroll_mode: TimelineScrollMode,
}

fn default_audio_enabled() -> bool {
    true
}

impl Default for Timeline {
    fn default() -> Self {
        Self {
            identifiers: Identifiers::default(),
            timecode_uid: Uuid::new_v4(),
            timecode_start: Duration::ZERO,
            audio_path: String::new(),
            audio_enabled: true,
            end_time: None,
            trigger_mode: TimelineTriggerMode::FollowTimecode,
            seek_behavior: TimelineSeekBehavior::ReconstructState,
            nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
            stop_behavior: TimelineStopBehavior::ResetAndReleaseOwnedActions,
            lookahead: TimelineLookaheadMode::Inherit,
            tracks: Vec::new(),
            markers: Vec::new(),
            regions: Vec::new(),
            loop_range: None,
            bpm: 120.0,
            beats_per_bar: 4,
            use_beat_grid: false,
            beatgrid: None,
            scroll_mode: TimelineScrollMode::Free,
        }
    }
}

impl HasIdentifiers for Timeline {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

/// A Track contains actions positioned along a timeline
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Track {
    /// Unique identifier for this track
    pub id: String,
    /// Display name of the track
    pub label: String,
    /// Whether the track is muted
    pub muted: bool,
    /// Whether the track is soloed
    pub solo: bool,
    /// Whether the track's parameters are expanded in the UI
    pub expanded: bool,
    /// The list of actions on this track
    pub actions: Vec<Action>,
    /// Optional parameters that can be adjusted over time
    pub automation_lanes: Vec<AutomationLane>,
}

/// An action positioned on a track that triggers an action when timecode reaches its position
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Action {
    /// Unique identifier for this action
    pub id: String,
    /// Display name of the action
    pub label: String,
    /// Position in milliseconds from the start of the timeline
    pub position: Duration,
    /// Duration in milliseconds
    pub duration: Duration,
    /// The action to perform when this action is triggered
    pub action: ActionKind,
}

/// The action kind to invoke when a timeline action is triggered.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ActionKind {
    /// Trigger a cue from the cue library implicitly tied to an transient clip that removes itself when done.
    #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
    FireCue(Uuid),
    /// Start a clip
    #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
    StartClip(Uuid),
    /// Stop a clip
    #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
    StopClip(Uuid),
    /// Advance a sequence on a clip
    #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
    AdvanceSequence(Uuid),
    /// Go back in a sequence on a clip
    #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
    BackSequence(Uuid),
    /// Set the rate multiplier for a clip's active playback.
    SetClipRate {
        /// The unique ID of the clip to control.
        #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
        uid: Uuid,
        /// Playback clock rate multiplier.
        rate: f32,
    },
    /// Jump to a specific cue in a sequence on a clip
    JumpToCue {
        /// The unique ID of the clip to jump to
        #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
        uid: Uuid,
        /// The cue index to jump to (starts counting from 1)
        cue_index: u32,
    },
    /// Dispatch a desk command string through the shared eval path.
    DeskEval(String),
    /// Dispatch a registered action reference.
    RegisteredAction(ActionReference),
}

/// A parameter that can be adjusted over time with a curve of control points
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct AutomationLane {
    /// Unique identifier for this automation lane
    pub id: String,
    /// Display name of the parameter
    pub name: String,
    /// CSS color for display in the UI
    pub color: String,
    /// Control points that define the parameter curve
    pub points: Vec<AutomationPoint>,
    /// The type of parameter and what it controls
    pub parameter_type: ParameterType,
}

/// A point on a parameter curve
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct AutomationPoint {
    /// Time position in milliseconds
    pub position: Duration,
    /// Parameter value (normalized 0-1)
    pub value: f32,
}

/// The type of parameter and what it controls
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ParameterType {
    /// Controls a global variable
    GlobalVariable(String),
    /// Controls the rate master (speed) of a clip
    #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
    RateMaster(Uuid),
}

/// Runtime playback, recording, and cursor state for a timeline.
/// Note: We intentionally don't store current_time here to avoid unnecessary change detection.
/// Current time is derived from the associated timecode when needed.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TimelineState {
    /// The ID of the timeline
    pub timeline_id: u32,
    /// Whether the timeline is currently active
    pub is_active: bool,
}
