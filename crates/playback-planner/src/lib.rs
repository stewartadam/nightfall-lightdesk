// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared contracts for deterministic playback planning.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Provenance for a playback clock reconstructed from a planned position.
///
/// This source is control metadata used to seed `InstanceClock::source` after
/// materialization. It does not participate in transition interpolation math.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum PlaybackPositionSource {
    /// Playback was reconstructed from an external source without richer provenance.
    #[default]
    ExternalPosition,
    /// Playback was reconstructed from a timeline/timecode position.
    Timeline {
        /// Timeline runtime UID that owns the source position.
        timeline_uid: Uuid,
        /// Timeline position where this playback began.
        started_at_timeline: Duration,
    },
}

/// Transient timing payload for reconstructing playback state from a planner result.
///
/// This is a command/materialization boundary DTO, not an owner of runtime timing state.
/// Callers should consume it to seed `InstanceClock` and materialized instance anchors,
/// then let those runtime components own subsequent evaluation.
///
/// The stored durations are source-local playback positions. `source` carries the
/// authoritative provenance needed to keep the resulting playback clock synchronized
/// with an external owner such as a timeline/timecode source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PlaybackReconstructionTiming {
    /// Source-local playback position where the active reconstructed segment began.
    pub started_at: Duration,
    /// Source-local playback position being reconstructed.
    pub position: Duration,
    /// Authoritative source that owns the reconstructed playback position.
    ///
    /// This is provenance for seeding the runtime playback clock, not a transition
    /// interpolation input.
    #[serde(default)]
    pub source: PlaybackPositionSource,
}

impl PlaybackReconstructionTiming {
    /// Builds reconstruction timing from externally positioned source-local durations.
    pub fn external_position(started_at: Duration, position: Duration) -> Self {
        Self {
            started_at,
            position,
            source: PlaybackPositionSource::ExternalPosition,
        }
    }

    /// Builds reconstruction timing from absolute timeline positions tied to a timeline/timecode source.
    pub fn timeline(
        transition_started_at_timeline: Duration,
        evaluated_at_timeline: Duration,
        timeline_uid: Uuid,
        started_at_timeline: Duration,
    ) -> Self {
        Self::timeline_source_local(
            transition_started_at_timeline.saturating_sub(started_at_timeline),
            evaluated_at_timeline.saturating_sub(started_at_timeline),
            timeline_uid,
            started_at_timeline,
        )
    }

    /// Builds reconstruction timing from source-local playback positions tied to a timeline source.
    pub fn timeline_source_local(
        started_at: Duration,
        position: Duration,
        timeline_uid: Uuid,
        started_at_timeline: Duration,
    ) -> Self {
        Self {
            started_at,
            position,
            source: PlaybackPositionSource::Timeline {
                timeline_uid,
                started_at_timeline,
            },
        }
    }

    /// Returns the elapsed time since the active reconstructed segment began.
    pub fn elapsed(self) -> Duration {
        self.position.saturating_sub(self.started_at)
    }
}

/// Describes whether a playback source has a known duration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "duration")]
pub enum PlaybackExtent {
    /// The playback source has a known finite duration.
    Finite(Duration),
    /// The playback source can continue until an external stop or release.
    Indefinite,
    /// The duration cannot be resolved from the currently available planning context.
    Unknown,
}

impl PlaybackExtent {
    /// Returns the finite duration when this extent is known and finite.
    pub fn as_finite(self) -> Option<Duration> {
        match self {
            Self::Finite(duration) => Some(duration),
            Self::Indefinite | Self::Unknown => None,
        }
    }

    /// Returns true when the extent is known to finish without an external stop.
    pub fn is_finite(self) -> bool {
        matches!(self, Self::Finite(_))
    }

    /// Combines two extents into the longest known playback span.
    pub fn max(self, other: Self) -> Self {
        match (self, other) {
            (Self::Indefinite, _) | (_, Self::Indefinite) => Self::Indefinite,
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Finite(left), Self::Finite(right)) => Self::Finite(left.max(right)),
        }
    }

    /// Adds two extents, preserving non-finite semantics.
    pub fn saturating_add(self, other: Self) -> Self {
        match (self, other) {
            (Self::Indefinite, _) | (_, Self::Indefinite) => Self::Indefinite,
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Finite(left), Self::Finite(right)) => Self::Finite(left.saturating_add(right)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Verifies timeline transition elapsed time is computed in duration space.
    #[test]
    fn playback_reconstruction_timing_elapsed_uses_duration_positions() {
        let timing = PlaybackReconstructionTiming {
            started_at: Duration::from_millis(250),
            position: Duration::from_millis(900),
            source: PlaybackPositionSource::ExternalPosition,
        };

        assert_eq!(timing.elapsed(), Duration::from_millis(650));
    }

    /// Verifies backward or equal reconstructed positions clamp to zero elapsed.
    #[test]
    fn playback_reconstruction_timing_elapsed_saturates_at_zero() {
        let timing = PlaybackReconstructionTiming {
            started_at: Duration::from_millis(900),
            position: Duration::from_millis(250),
            source: PlaybackPositionSource::ExternalPosition,
        };

        assert_eq!(timing.elapsed(), Duration::ZERO);
    }

    /// Verifies timeline construction stores source-local playback positions.
    #[test]
    fn playback_reconstruction_timing_normalizes_timeline_positions() {
        let timeline_uid = Uuid::from_u128(0x1000);
        let timing = PlaybackReconstructionTiming::timeline(
            Duration::from_millis(1_500),
            Duration::from_millis(2_250),
            timeline_uid,
            Duration::from_millis(1_000),
        );

        assert_eq!(timing.started_at, Duration::from_millis(500));
        assert_eq!(timing.position, Duration::from_millis(1_250));
        assert_eq!(timing.elapsed(), Duration::from_millis(750));
        assert_eq!(
            timing.source,
            PlaybackPositionSource::Timeline {
                timeline_uid,
                started_at_timeline: Duration::from_millis(1_000)
            }
        );
    }

    /// Verifies callers with source-local positions can keep them unchanged.
    #[test]
    fn playback_reconstruction_timing_accepts_source_local_positions() {
        let timeline_uid = Uuid::from_u128(0x2000);
        let timing = PlaybackReconstructionTiming::timeline_source_local(
            Duration::from_millis(500),
            Duration::from_millis(1_250),
            timeline_uid,
            Duration::from_millis(1_000),
        );

        assert_eq!(timing.started_at, Duration::from_millis(500));
        assert_eq!(timing.position, Duration::from_millis(1_250));
        assert_eq!(timing.elapsed(), Duration::from_millis(750));
    }
}

/// Planner-facing duration summary for a playback source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PlaybackDurationProfile {
    /// Duration needed for the source to assert its values after activation.
    pub assertion: PlaybackExtent,
    /// Duration needed for the source to release values after stop.
    pub release: PlaybackExtent,
    /// Total source duration when it can be resolved directly.
    pub total: PlaybackExtent,
}

impl PlaybackDurationProfile {
    /// Builds a duration profile from finite assertion and release spans.
    pub fn finite(assertion: Duration, release: Duration) -> Self {
        Self {
            assertion: PlaybackExtent::Finite(assertion),
            release: PlaybackExtent::Finite(release),
            total: PlaybackExtent::Finite(assertion.saturating_add(release)),
        }
    }

    /// Builds a profile for a source that requires an external stop or release.
    pub fn indefinite(assertion: PlaybackExtent, release: PlaybackExtent) -> Self {
        Self {
            assertion,
            release,
            total: PlaybackExtent::Indefinite,
        }
    }

    /// Builds a profile for a source that cannot be planned with current context.
    pub fn unknown() -> Self {
        Self {
            assertion: PlaybackExtent::Unknown,
            release: PlaybackExtent::Unknown,
            total: PlaybackExtent::Unknown,
        }
    }
}

/// Timeline-authored owner for a planned playback interval.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelinePlaybackOwner {
    /// Timeline runtime UID that authored this playback.
    pub timeline_uid: Uuid,
    /// Timeline track ID that owns the authored item.
    pub track_id: String,
    /// Timeline action ID that owns the authored action.
    pub action_id: String,
}

/// Source object addressed by a planned playback interval.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "uid")]
pub enum PlannedPlaybackSource {
    /// Cue source.
    Cue(Uuid),
    /// Cue sequence source.
    Sequence(Uuid),
    /// Classic FX source.
    Fx(Uuid),
    /// Step FX source.
    StepFx(Uuid),
    /// Wasm FX module source.
    FxModule(Uuid),
    /// Flow source.
    Flow(Uuid),
}

/// Closed-world source category used for planner/materializer dispatch.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "snake_case")]
pub enum PlannedPlaybackSourceKind {
    /// Cue source category.
    Cue,
    /// Cue sequence source category.
    Sequence,
    /// Classic FX source category.
    Fx,
    /// Step FX source category.
    StepFx,
    /// Wasm FX module source category.
    FxModule,
    /// Flow source category.
    Flow,
}

impl PlannedPlaybackSource {
    /// Returns the closed-world source kind used for materializer dispatch.
    pub fn kind(self) -> PlannedPlaybackSourceKind {
        match self {
            PlannedPlaybackSource::Cue(_) => PlannedPlaybackSourceKind::Cue,
            PlannedPlaybackSource::Sequence(_) => PlannedPlaybackSourceKind::Sequence,
            PlannedPlaybackSource::Fx(_) => PlannedPlaybackSourceKind::Fx,
            PlannedPlaybackSource::StepFx(_) => PlannedPlaybackSourceKind::StepFx,
            PlannedPlaybackSource::FxModule(_) => PlannedPlaybackSourceKind::FxModule,
            PlannedPlaybackSource::Flow(_) => PlannedPlaybackSourceKind::Flow,
        }
    }

    /// Returns the source UID carried by the planned playback source.
    pub fn uid(self) -> Uuid {
        match self {
            PlannedPlaybackSource::Cue(uid)
            | PlannedPlaybackSource::Sequence(uid)
            | PlannedPlaybackSource::Fx(uid)
            | PlannedPlaybackSource::StepFx(uid)
            | PlannedPlaybackSource::FxModule(uid)
            | PlannedPlaybackSource::Flow(uid) => uid,
        }
    }
}

/// Coarse lifecycle for a planned playback interval at a target time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "snake_case")]
pub enum PlannedPlaybackLifecycle {
    /// Playback is actively asserting source output.
    Active,
    /// Playback has been released but its release tail is still relevant.
    Releasing,
    /// Playback has completed and is an aggregate no-op at the target.
    Complete,
    /// Planner could not determine lifecycle from available context.
    Unknown,
}

/// Authored source intervention inside a planned playback interval.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PlannedPlaybackIntervention {
    /// Timeline action owner for this intervention.
    pub owner: TimelinePlaybackOwner,
    /// Absolute timeline position where the intervention occurs.
    pub timeline_position: Duration,
    /// Source-local playback position where the intervention occurs.
    pub playback_position: Duration,
    /// Intervention kind.
    pub kind: PlannedPlaybackInterventionKind,
}

/// Source intervention kind authored by a timeline action.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum PlannedPlaybackInterventionKind {
    /// Advance an attached sequence.
    SequenceGo,
    /// Move an attached sequence backward.
    SequenceBack,
    /// Jump an attached sequence to a one-based cue position.
    SequenceGotoCue(u32),
    /// Stop or release the attached playback.
    Stop,
}

/// Deterministic timeline meaning supplied by a registered domain action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimelinePlaybackActionPlan {
    /// Stable runtime owner addressed by the action.
    pub owner_uid: Uuid,
    /// Planner operation represented by the registered action.
    pub operation: TimelinePlaybackActionOperation,
}

/// Generic playback operations a registered action can contribute to timeline planning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimelinePlaybackActionOperation {
    /// Start the owner's configured playback source.
    Start,
    /// Stop and release the owner's active playback source.
    Stop,
    /// Apply an intervention to the owner's active playback.
    Intervene(PlannedPlaybackInterventionKind),
}

/// Planned release interval for a source-local playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PlannedReleaseInterval {
    /// Absolute timeline position where release started.
    pub released_at_timeline: Duration,
    /// Absolute timeline position where release completes, when known.
    pub release_completed_at_timeline: Option<Duration>,
    /// Absolute timeline position whose output should be frozen as the release source.
    pub source_snapshot_at_timeline: Duration,
}

impl PlannedReleaseInterval {
    /// Returns true when this release is known to be complete at `target_time`.
    pub fn is_complete_at(self, target_time: Duration) -> bool {
        self.release_completed_at_timeline
            .is_some_and(|completed_at| target_time > completed_at)
    }
}

/// Authored playback-rate change inside a planned playback interval.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PlannedPlaybackRateChange {
    /// Timeline action owner for this rate change.
    pub owner: TimelinePlaybackOwner,
    /// Absolute timeline position where the rate change occurs.
    pub timeline_position: Duration,
    /// Source-local playback position where the rate change occurs.
    pub playback_position: Duration,
    /// Non-negative playback rate multiplier in millionths.
    pub rate_micros: u32,
}

impl PlannedPlaybackRateChange {
    /// Builds a rate change from a user-facing floating-point multiplier.
    pub fn from_multiplier(
        owner: TimelinePlaybackOwner,
        timeline_position: Duration,
        playback_position: Duration,
        rate: f32,
    ) -> Self {
        Self {
            owner,
            timeline_position,
            playback_position,
            rate_micros: playback_rate_micros(rate),
        }
    }

    /// Returns the playback rate multiplier represented by this rate change.
    pub fn rate_multiplier(&self) -> f32 {
        self.rate_micros as f32 / PLAYBACK_RATE_MICROS_PER_UNIT as f32
    }
}

/// Planned playback interval with source identity, ownership, and source-local anchors.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PlannedPlaybackInterval {
    /// Timeline action owner for this playback.
    pub owner: TimelinePlaybackOwner,
    /// Playback source identity.
    pub source: PlannedPlaybackSource,
    /// Absolute timeline position where playback started.
    pub started_at_timeline: Duration,
    /// Absolute timeline position where playback was stopped, if any.
    pub stopped_at_timeline: Option<Duration>,
    /// Source-local position corresponding to `started_at_timeline`.
    pub source_local_start: Duration,
    /// Release interval, if the playback is releasing or complete after release.
    pub release: Option<PlannedReleaseInterval>,
    /// Authored playback-rate changes inside this interval.
    pub rate_changes: Vec<PlannedPlaybackRateChange>,
    /// Explicit authored interventions inside this interval.
    pub explicit_interventions: Vec<PlannedPlaybackIntervention>,
    /// Coarse lifecycle at the plan target.
    pub lifecycle: PlannedPlaybackLifecycle,
}

impl PlannedPlaybackInterval {
    /// Returns the source-local playback position for a target timeline position.
    pub fn playback_position_at(&self, target_time: Duration) -> Duration {
        let mut cursor_timeline = self.started_at_timeline;
        let mut cursor_source = self.source_local_start;
        let mut rate_micros = PLAYBACK_RATE_MICROS_PER_UNIT;
        let mut rate_changes = self
            .rate_changes
            .iter()
            .filter(|change| change.timeline_position <= target_time)
            .collect::<Vec<_>>();
        rate_changes.sort_by_key(|change| change.timeline_position);

        for change in rate_changes {
            if change.timeline_position >= cursor_timeline {
                let computed_source = cursor_source.saturating_add(scale_duration_by_rate(
                    change.timeline_position.saturating_sub(cursor_timeline),
                    rate_micros,
                ));
                debug_assert_eq!(computed_source, change.playback_position);
                cursor_timeline = change.timeline_position;
            }
            cursor_source = change.playback_position;
            rate_micros = change.rate_micros;
        }

        cursor_source.saturating_add(scale_duration_by_rate(
            target_time.saturating_sub(cursor_timeline),
            rate_micros,
        ))
    }

    /// Returns the playback rate multiplier active at a target timeline position.
    pub fn playback_rate_at(&self, target_time: Duration) -> f32 {
        self.rate_changes
            .iter()
            .filter(|change| change.timeline_position <= target_time)
            .max_by_key(|change| change.timeline_position)
            .map_or(1.0, PlannedPlaybackRateChange::rate_multiplier)
    }

    /// Returns true when this interval is known to be an aggregate no-op at `target_time`.
    pub fn is_noop_at(&self, target_time: Duration) -> bool {
        matches!(self.lifecycle, PlannedPlaybackLifecycle::Complete)
            || self
                .release
                .is_some_and(|release| release.is_complete_at(target_time))
    }
}

const PLAYBACK_RATE_MICROS_PER_UNIT: u32 = 1_000_000;

/// Converts a floating-point rate multiplier into finite non-negative millionths.
pub fn playback_rate_micros(rate: f32) -> u32 {
    if !rate.is_finite() {
        return 0;
    }
    (rate.max(0.0) * PLAYBACK_RATE_MICROS_PER_UNIT as f32)
        .round()
        .clamp(0.0, u32::MAX as f32) as u32
}

fn scale_duration_by_rate(duration: Duration, rate_micros: u32) -> Duration {
    let scaled_nanos = duration.as_nanos().saturating_mul(rate_micros as u128)
        / PLAYBACK_RATE_MICROS_PER_UNIT as u128;
    Duration::from_nanos(scaled_nanos.min(u64::MAX as u128) as u64)
}

/// Authored timeline event retained for deterministic ordering and diagnostics.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PlannedTimelineEvent {
    /// Timeline action owner for this event.
    pub owner: TimelinePlaybackOwner,
    /// Absolute timeline position for this event.
    pub timeline_position: Duration,
    /// Event kind.
    pub kind: PlannedTimelineEventKind,
}

/// Source-agnostic timeline event kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum PlannedTimelineEventKind {
    /// Start a source playback.
    Start(PlannedPlaybackSource),
    /// Stop a source playback.
    Stop(PlannedPlaybackSource),
    /// Apply an intervention to an existing source playback.
    Intervene(PlannedPlaybackInterventionKind),
}

/// Planned no-op aggregate retained for diagnostics and materializer reconciliation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PlannedNoOp {
    /// Timeline action owner for the aggregate no-op.
    pub owner: TimelinePlaybackOwner,
    /// Reason why this aggregate does not materialize runtime state.
    pub reason: PlannedNoOpReason,
}

/// Reason a planned aggregate is a no-op at the target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "snake_case")]
pub enum PlannedNoOpReason {
    /// Playback completed before the target position.
    CompletedBeforeTarget,
    /// Release tail completed before the target position.
    ReleaseCompletedBeforeTarget,
    /// Source data was missing and the planner could not materialize state.
    UnresolvedSource,
}

/// Planner diagnostic with source-agnostic context.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelinePlannerDiagnostic {
    /// Optional timeline owner associated with the diagnostic.
    pub owner: Option<TimelinePlaybackOwner>,
    /// Diagnostic severity.
    pub severity: TimelinePlannerDiagnosticSeverity,
    /// Stable diagnostic code.
    pub code: String,
    /// Human-readable diagnostic detail.
    pub message: String,
}

/// Severity for planner diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "snake_case")]
pub enum TimelinePlannerDiagnosticSeverity {
    /// Informational diagnostic.
    Info,
    /// Recoverable unsupported or unresolved state.
    Warning,
    /// Planner could not produce deterministic state for required input.
    Error,
}

/// Source-agnostic timeline plan produced before materialization.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelinePlan {
    /// Timeline runtime UID being planned.
    pub timeline_uid: Uuid,
    /// Target timeline position being planned.
    pub target_time: Duration,
    /// Authored events retained in deterministic order.
    pub events: Vec<PlannedTimelineEvent>,
    /// Playback intervals relevant to planning and reconciliation.
    pub instances: Vec<PlannedPlaybackInterval>,
    /// Aggregate no-ops at the target position.
    pub no_ops: Vec<PlannedNoOp>,
    /// Planner diagnostics.
    pub diagnostics: Vec<TimelinePlannerDiagnostic>,
}

impl TimelinePlan {
    /// Evaluates this source-agnostic plan into playback states relevant at the target time.
    pub fn evaluate(&self) -> EvaluatedTimelineState {
        EvaluatedTimelineState {
            target_time: self.target_time,
            instances: self
                .instances
                .iter()
                .filter(|interval| !interval.is_noop_at(self.target_time))
                .map(|interval| interval.evaluate_at(self.target_time))
                .collect(),
            no_ops: self.no_ops.clone(),
            diagnostics: self.diagnostics.clone(),
        }
    }
}

/// Evaluated instance state that a materializer can turn into a runtime entity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct EvaluatedInstanceState {
    /// Timeline action owner for this instance.
    pub owner: TimelinePlaybackOwner,
    /// Planned source identity.
    pub source: PlannedPlaybackSource,
    /// Source-local playback clock position for evaluation.
    pub instance_clock_position: Duration,
    /// Absolute timeline position where playback started.
    pub started_at_timeline: Duration,
    /// Absolute timeline position where release started, if any.
    pub released_at_timeline: Option<Duration>,
    /// Source-local playback position whose output is the release snapshot, if any.
    pub release_snapshot_position: Option<Duration>,
    /// Evaluated lifecycle at the target.
    pub lifecycle: PlannedPlaybackLifecycle,
}

/// Source-agnostic evaluated timeline state consumed by ECS materialization.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct EvaluatedTimelineState {
    /// Target timeline position being evaluated.
    pub target_time: Duration,
    /// Evaluated instance states.
    pub instances: Vec<EvaluatedInstanceState>,
    /// Aggregate no-ops at the target position.
    pub no_ops: Vec<PlannedNoOp>,
    /// Evaluation diagnostics.
    pub diagnostics: Vec<TimelinePlannerDiagnostic>,
}

impl PlannedPlaybackInterval {
    /// Evaluates this planned interval into a materializer-facing instance state.
    pub fn evaluate_at(&self, target_time: Duration) -> EvaluatedInstanceState {
        let release_snapshot_position = self
            .release
            .map(|release| self.playback_position_at(release.source_snapshot_at_timeline));

        EvaluatedInstanceState {
            owner: self.owner.clone(),
            source: self.source,
            instance_clock_position: self.playback_position_at(target_time),
            started_at_timeline: self.started_at_timeline,
            released_at_timeline: self.release.map(|release| release.released_at_timeline),
            release_snapshot_position,
            lifecycle: self.lifecycle,
        }
    }
}

#[cfg(test)]
mod planning_contract_tests {
    use std::time::Duration;

    use uuid::Uuid;

    use super::*;

    /// Builds a minimal timeline owner for playback-planner contract tests.
    fn owner() -> TimelinePlaybackOwner {
        TimelinePlaybackOwner {
            timeline_uid: Uuid::from_u128(1),
            track_id: "track".to_string(),
            action_id: "item".to_string(),
        }
    }

    /// Builds a planned cue interval with the requested lifecycle and release interval.
    fn interval(
        lifecycle: PlannedPlaybackLifecycle,
        release: Option<PlannedReleaseInterval>,
    ) -> PlannedPlaybackInterval {
        PlannedPlaybackInterval {
            owner: owner(),
            source: PlannedPlaybackSource::Cue(Uuid::from_u128(2)),
            started_at_timeline: Duration::from_millis(250),
            stopped_at_timeline: release.map(|release| release.released_at_timeline),
            source_local_start: Duration::from_millis(10),
            release,
            rate_changes: Vec::new(),
            explicit_interventions: Vec::new(),
            lifecycle,
        }
    }

    /// Verifies planned playback sources expose their dispatch kind and stable UID.
    #[test]
    fn planned_playback_source_exposes_kind_and_uid() {
        let uid = Uuid::from_u128(42);
        let cases = [
            (
                PlannedPlaybackSource::Cue(uid),
                PlannedPlaybackSourceKind::Cue,
            ),
            (
                PlannedPlaybackSource::Sequence(uid),
                PlannedPlaybackSourceKind::Sequence,
            ),
            (
                PlannedPlaybackSource::Fx(uid),
                PlannedPlaybackSourceKind::Fx,
            ),
            (
                PlannedPlaybackSource::StepFx(uid),
                PlannedPlaybackSourceKind::StepFx,
            ),
            (
                PlannedPlaybackSource::FxModule(uid),
                PlannedPlaybackSourceKind::FxModule,
            ),
            (
                PlannedPlaybackSource::Flow(uid),
                PlannedPlaybackSourceKind::Flow,
            ),
        ];

        for (source, expected_kind) in cases {
            assert_eq!(source.kind(), expected_kind);
            assert_eq!(source.uid(), uid);
        }
    }

    /// Verifies planned intervals convert absolute timeline time into source-local playback time.
    #[test]
    fn planned_interval_playback_position_is_source_local() {
        let interval = interval(PlannedPlaybackLifecycle::Active, None);

        assert_eq!(
            interval.playback_position_at(Duration::from_millis(900)),
            Duration::from_millis(660)
        );
        assert_eq!(
            interval.playback_position_at(Duration::from_millis(100)),
            Duration::from_millis(10)
        );
    }

    /// Verifies release intervals become no-ops only after the known release completion time.
    #[test]
    fn planned_interval_noop_waits_for_release_completion() {
        let interval = interval(
            PlannedPlaybackLifecycle::Releasing,
            Some(PlannedReleaseInterval {
                released_at_timeline: Duration::from_millis(500),
                release_completed_at_timeline: Some(Duration::from_millis(800)),
                source_snapshot_at_timeline: Duration::from_millis(500),
            }),
        );

        assert!(!interval.is_noop_at(Duration::from_millis(800)));
        assert!(interval.is_noop_at(Duration::from_millis(801)));
    }

    /// Verifies active evaluated playback states advance to the target position.
    #[test]
    fn timeline_plan_evaluates_active_playback_position_at_target() {
        let plan = TimelinePlan {
            target_time: Duration::from_millis(900),
            instances: vec![interval(PlannedPlaybackLifecycle::Active, None)],
            ..Default::default()
        };

        let evaluated = plan.evaluate();

        assert_eq!(evaluated.instances.len(), 1);
        assert_eq!(
            evaluated.instances[0].instance_clock_position,
            Duration::from_millis(660)
        );
    }

    /// Verifies releasing evaluated playback states keep current clock and source snapshot positions.
    #[test]
    fn timeline_plan_evaluates_releasing_playback_with_source_snapshot() {
        let plan = TimelinePlan {
            target_time: Duration::from_millis(900),
            instances: vec![interval(
                PlannedPlaybackLifecycle::Releasing,
                Some(PlannedReleaseInterval {
                    released_at_timeline: Duration::from_millis(600),
                    release_completed_at_timeline: None,
                    source_snapshot_at_timeline: Duration::from_millis(600),
                }),
            )],
            ..Default::default()
        };

        let evaluated = plan.evaluate();

        assert_eq!(evaluated.instances.len(), 1);
        assert_eq!(
            evaluated.instances[0].instance_clock_position,
            Duration::from_millis(660)
        );
        assert_eq!(
            evaluated.instances[0].release_snapshot_position,
            Some(Duration::from_millis(360))
        );
        assert_eq!(
            evaluated.instances[0].released_at_timeline,
            Some(Duration::from_millis(600))
        );
    }

    /// Verifies direct interval evaluation exposes release progress and snapshot separately.
    #[test]
    fn planned_interval_evaluation_separates_release_progress_from_snapshot() {
        let evaluated = interval(
            PlannedPlaybackLifecycle::Releasing,
            Some(PlannedReleaseInterval {
                released_at_timeline: Duration::from_millis(600),
                release_completed_at_timeline: None,
                source_snapshot_at_timeline: Duration::from_millis(600),
            }),
        )
        .evaluate_at(Duration::from_millis(900));

        assert_eq!(
            evaluated.instance_clock_position,
            Duration::from_millis(660)
        );
        assert_eq!(
            evaluated.release_snapshot_position,
            Some(Duration::from_millis(360))
        );
        assert_eq!(
            evaluated.released_at_timeline,
            Some(Duration::from_millis(600))
        );
    }

    /// Verifies active evaluated playback states have no release snapshot.
    #[test]
    fn timeline_plan_evaluates_active_playback_without_release_snapshot() {
        let plan = TimelinePlan {
            target_time: Duration::from_millis(900),
            instances: vec![interval(PlannedPlaybackLifecycle::Active, None)],
            ..Default::default()
        };

        let evaluated = plan.evaluate();

        assert_eq!(
            evaluated.instances[0].instance_clock_position,
            Duration::from_millis(660)
        );
        assert_eq!(evaluated.instances[0].release_snapshot_position, None);
        assert_eq!(evaluated.instances[0].released_at_timeline, None);
    }

    /// Verifies releasing evaluated playback states expose their release anchor.
    #[test]
    fn timeline_plan_evaluates_releasing_playback_release_anchor() {
        let plan = TimelinePlan {
            target_time: Duration::from_millis(600),
            instances: vec![interval(
                PlannedPlaybackLifecycle::Releasing,
                Some(PlannedReleaseInterval {
                    released_at_timeline: Duration::from_millis(600),
                    release_completed_at_timeline: None,
                    source_snapshot_at_timeline: Duration::from_millis(600),
                }),
            )],
            ..Default::default()
        };

        let evaluated = plan.evaluate();

        assert_eq!(
            evaluated.instances[0].instance_clock_position,
            Duration::from_millis(360)
        );
        assert_eq!(
            evaluated.instances[0].released_at_timeline,
            Some(Duration::from_millis(600))
        );
    }

    /// Verifies completed intervals are omitted from evaluated materializer input.
    #[test]
    fn timeline_plan_filters_completed_instances_from_evaluation() {
        let no_op = PlannedNoOp {
            owner: owner(),
            reason: PlannedNoOpReason::ReleaseCompletedBeforeTarget,
        };
        let plan = TimelinePlan {
            target_time: Duration::from_millis(801),
            instances: vec![interval(
                PlannedPlaybackLifecycle::Complete,
                Some(PlannedReleaseInterval {
                    released_at_timeline: Duration::from_millis(500),
                    release_completed_at_timeline: Some(Duration::from_millis(800)),
                    source_snapshot_at_timeline: Duration::from_millis(500),
                }),
            )],
            no_ops: vec![no_op.clone()],
            ..Default::default()
        };

        let evaluated = plan.evaluate();

        assert!(evaluated.instances.is_empty());
        assert_eq!(evaluated.no_ops, vec![no_op]);
    }
}
