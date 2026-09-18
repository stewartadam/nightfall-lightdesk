// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Contract types for runtime instance identity, clocks, controls, and status.
//!
//! This crate intentionally owns only shared playback contracts and pure helper
//! logic. It must not register Bevy plugins, websocket handlers, clip
//! storage, persistence handlers, or domain materialization systems.

use bevy_ecs::prelude::*;
use nightfall::engine::{EngineAction, EngineIngressMeta, EnginePayload, IngressCommand};
use nightfall::prelude::{IdExpr, Priority};
use nightfall_playback_planner::{PlaybackPositionSource, PlaybackReconstructionTiming};
use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;
use uuid::Uuid;
use web_time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Request emitted by deterministic seek for domain-owned playback reconstruction.
#[derive(Debug, Clone, Message)]
pub struct DomainInstanceReconstructionRequest {
    /// Source whose owning domain should reconstruct runtime instance.
    pub source: nightfall_playback_planner::PlannedPlaybackSource,
    /// Clip UID that owns the reconstructed playback.
    pub clip_uid: Uuid,
    /// Playback clock to install on the restored playback.
    pub clock: InstanceClock,
}

impl DomainInstanceReconstructionRequest {
    /// Creates a domain reconstruction request from a deterministic playback plan.
    pub fn new(
        source: nightfall_playback_planner::PlannedPlaybackSource,
        clip_uid: Uuid,
        clock: InstanceClock,
    ) -> Self {
        Self {
            source,
            clip_uid,
            clock,
        }
    }
}

/// Scope for playback actions that can address all output or one selection.
#[derive(Debug, Clone, PartialEq)]
pub enum PlaybackScope {
    /// Apply to every active output parameter.
    All,
    /// Apply only to the supplied selection.
    Selection(nightfall::prelude::SelectionExpr),
}

/// Runtime actions owned by the playback domain.
#[derive(Debug, Clone, PartialEq)]
pub enum PlaybackAction {
    /// Release output parameters according to scope.
    ReleaseParameters {
        /// Scope to release.
        scope: PlaybackScope,
    },
}

impl EnginePayload for PlaybackAction {}
impl EngineAction for PlaybackAction {}

/// Marks an instance as an editor-owned preview rather than a live show playback.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct EditorPreviewInstance;

/// Component marking the source object that owns a runtime instance entity.
#[derive(Clone, Component, Serialize, Deserialize)]
pub struct Owner(pub Uuid);

/// Universal identifier for any running instance.
///
/// This is a runtime identifier, distinct from source IDs (Sequence/FX asset UUIDs).
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InstanceId(#[serde(with = "nightfall::serde_uuid_simple")] pub Uuid);

impl InstanceId {
    /// Creates a fresh runtime instance identifier.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for InstanceId {
    fn default() -> Self {
        Self::new()
    }
}

/// The kind of source that was materialized.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum InstanceKind {
    Cue,
    Sequence,
    Fx,
    Flow,
    Programmer,
}

/// Operator-facing instance category for status displays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum InstanceDisplayKind {
    Cue,
    Sequence,
    Fx,
    StepFx,
    FlowFx,
    ModuleFx,
    Programmer,
}

impl From<&InstanceKind> for InstanceDisplayKind {
    fn from(kind: &InstanceKind) -> Self {
        match kind {
            InstanceKind::Cue => Self::Cue,
            InstanceKind::Sequence => Self::Sequence,
            InstanceKind::Fx => Self::Fx,
            InstanceKind::Flow => Self::FlowFx,
            InstanceKind::Programmer => Self::Programmer,
        }
    }
}

/// Metadata making instances addressable and inspectable.
#[derive(Component, Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InstanceMetadata {
    pub name: Option<String>,
    pub kind: InstanceKind,
    pub display_kind: InstanceDisplayKind,
    pub tags: Vec<String>,
}

impl InstanceMetadata {
    /// Builds instance metadata for a source kind using the default display category.
    pub fn new(kind: InstanceKind) -> Self {
        let display_kind = InstanceDisplayKind::from(&kind);
        Self {
            name: None,
            kind,
            display_kind,
            tags: Vec::new(),
        }
    }

    /// Returns metadata with an operator-facing display name.
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Returns metadata with operator/search tags.
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }

    /// Returns metadata with a source-specific display category.
    pub fn with_display_kind(mut self, display_kind: InstanceDisplayKind) -> Self {
        self.display_kind = display_kind;
        self
    }
}

/// Runtime control factors applied pre-merge. Lives on the instance entity.
#[derive(Component, Clone, Debug, SmartDefault)]
#[typeshare::typeshare]
pub struct InstanceControls {
    /// Intensity scaling factor (0.0-1.0), multiplicative. Default 1.0.
    #[default(1.0)]
    pub intensity_scale: f32,
    /// Operator-authored playback speed multiplier. Default 1.0.
    #[default(1.0)]
    pub rate: f32,
    /// Runtime master scale applied on top of the authored rate. Default 1.0.
    #[default(1.0)]
    pub rate_master_scale: f32,
}

impl InstanceControls {
    /// Sets the playback speed multiplier to a finite non-negative value.
    pub fn set_rate(&mut self, value: f32) {
        self.rate = normalized_playback_rate(value);
    }

    /// Sets the master rate scale to a finite non-negative value.
    pub fn set_rate_master_scale(&mut self, value: f32) {
        self.rate_master_scale = normalized_playback_rate(value);
    }

    /// Returns the sanitized rate multiplier used by playback clocks.
    pub fn effective_rate(&self) -> f64 {
        f64::from(
            normalized_playback_rate(self.rate) * normalized_playback_rate(self.rate_master_scale),
        )
    }
}

/// Runtime options resolved when an instance is materialized.
#[derive(Component, Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InstanceOptions {
    /// Timeline/playback-wide lookahead override. `None` preserves source-local authored behavior.
    pub lookahead_enabled: Option<bool>,
}

/// Applies playback option overrides to a materialized instance entity.
///
/// `None` removes stale overrides from reused instance entities so ordinary
/// starts return to source-authored behavior.
pub fn reconcile_instance_options(
    entity_commands: &mut EntityCommands,
    instance_options: Option<InstanceOptions>,
) {
    if let Some(instance_options) = instance_options {
        entity_commands.insert(instance_options);
    } else {
        entity_commands.remove::<InstanceOptions>();
    }
}

/// Read-only clip playback binding exported by the desk-owned resolver.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipInstanceBinding {
    /// Numeric clip ID that owns the playback slot.
    pub clip_id: u32,
    /// Runtime playback attached to the clip.
    pub instance_id: InstanceId,
}

/// Domain result emitted after an instance action creates or reuses playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipInstanceAttachment {
    /// Numeric clip ID whose slot should attach to the playback.
    pub clip_id: u32,
    /// Runtime playback created or reused by the domain.
    pub instance_id: InstanceId,
    /// Whether the desk should release parameters after this playback despawns.
    pub auto_release_on_stop: bool,
}

/// Shared clip metadata supplied when routing an instance start into a source domain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipInstanceStartContext {
    /// Numeric clip ID whose playback slot requested the action.
    pub clip_id: u32,
    /// Stable clip UID used as the instance owner.
    pub clip_uid: Uuid,
    /// Layer priority for source domains that materialize compositor layers.
    pub priority: Priority,
    /// Optional source-local reconstruction timing.
    pub timing: Option<PlaybackReconstructionTiming>,
    /// Optional playback behavior overrides supplied by the caller.
    pub instance_options: Option<InstanceOptions>,
    /// Existing playback currently attached to the clip, when any.
    pub attached_instance: Option<InstanceId>,
    /// Whether the desk should release parameters after stop.
    pub auto_release_on_stop: bool,
}

/// Narrow clip playback request consumed by the desk-owned resolver.
#[derive(Clone, Debug, PartialEq)]
pub enum ClipInstanceRequest {
    /// Start clip playback for the addressed clip IDs.
    Start(IdExpr),
    /// Stop clip playback for the addressed clip IDs.
    Stop(IdExpr),
    /// Advance clip playback for the addressed clip IDs.
    Go(IdExpr),
}

/// Normalizes playback rates before they reach timing math.
fn normalized_playback_rate(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

/// Indicates whether an instance clock update represents continuous playback or a reposition.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InstanceClockDiscontinuity {
    /// The playback position advanced normally from its configured source.
    #[default]
    Continuous,
    /// The playback position was assigned by seek, reconstruction, or external sync.
    Discontinuous,
}

/// Describes the authoritative source used to update an instance clock.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InstanceClockSource {
    /// Free-running instance advanced from wall-clock frame deltas.
    #[default]
    Realtime,
    /// Playback derived from a timeline/timecode position.
    Timeline {
        /// Timeline runtime UID that owns the source position.
        timeline_uid: Uuid,
        /// Timeline position where this playback began.
        started_at_timeline: Duration,
    },
    /// Playback derived directly from an external authoritative position.
    ExternalPosition,
    /// Playback advanced only by explicit commands or tests.
    Manual,
}

impl From<PlaybackPositionSource> for InstanceClockSource {
    fn from(source: PlaybackPositionSource) -> Self {
        match source {
            PlaybackPositionSource::ExternalPosition => Self::ExternalPosition,
            PlaybackPositionSource::Timeline {
                timeline_uid,
                started_at_timeline,
            } => Self::Timeline {
                timeline_uid,
                started_at_timeline,
            },
        }
    }
}

/// Builds an instance clock positioned from reconstruction timing.
pub fn instance_clock_from_reconstruction_timing(
    timing: PlaybackReconstructionTiming,
) -> InstanceClock {
    instance_clock_from_reconstruction_timing_with_rate(timing, 1.0)
}

/// Builds an instance clock positioned from reconstruction timing with an explicit rate.
pub fn instance_clock_from_reconstruction_timing_with_rate(
    timing: PlaybackReconstructionTiming,
    rate: f32,
) -> InstanceClock {
    let mut clock = InstanceClock {
        source: timing.source.into(),
        ..Default::default()
    };
    clock.set_rate(f64::from(rate));
    clock.seek_to(timing.position);
    clock
}

/// Runtime source-local clock for one instance entity.
#[derive(Component, Clone, Debug, PartialEq)]
pub struct InstanceClock {
    /// Effective source-local playback position used for evaluation.
    pub position: Duration,
    /// Previous effective source-local playback position.
    pub previous_position: Duration,
    /// Effective source-local advancement in the current engine tick.
    pub delta: Duration,
    /// Playback speed multiplier applied when this clock accumulates real time.
    pub rate: f64,
    /// Whether position is intentionally frozen.
    pub frozen: bool,
    /// Whether this update was a normal tick or an explicit reposition.
    pub discontinuity: InstanceClockDiscontinuity,
    /// Source used to update the clock position.
    pub source: InstanceClockSource,
    /// Optional wall-clock epoch for UI display only, not transition math.
    pub activation_epoch_ms: Option<f64>,
}

impl Default for InstanceClock {
    fn default() -> Self {
        Self {
            position: Duration::ZERO,
            previous_position: Duration::ZERO,
            delta: Duration::ZERO,
            rate: 1.0,
            frozen: false,
            discontinuity: InstanceClockDiscontinuity::Continuous,
            source: InstanceClockSource::Realtime,
            activation_epoch_ms: None,
        }
    }
}

impl InstanceClock {
    /// Builds a real-time playback clock with a UI-only activation epoch.
    pub fn realtime_with_activation_epoch(activation_epoch_ms: Option<f64>) -> Self {
        Self {
            activation_epoch_ms,
            ..Default::default()
        }
    }

    /// Advances from a real elapsed duration, applying rate and freeze policy.
    pub fn advance_by_realtime_delta(&mut self, real_delta: Duration) {
        self.advance_by_source_delta(real_delta);
    }

    /// Advances from a source elapsed delta, applying rate and freeze policy.
    pub fn advance_by_source_delta(&mut self, source_delta: Duration) {
        self.previous_position = self.position;
        self.discontinuity = InstanceClockDiscontinuity::Continuous;

        if self.frozen {
            self.delta = Duration::ZERO;
            return;
        }

        let scaled_delta = if self.rate == 1.0 {
            source_delta
        } else {
            source_delta.mul_f64(self.rate)
        };
        self.position = self.position.saturating_add(scaled_delta);
        self.delta = self.position.saturating_sub(self.previous_position);
    }

    /// Sets the clock rate and updates freeze state for zero-rate playback.
    pub fn set_rate(&mut self, rate: f64) {
        self.rate = if rate.is_finite() { rate.max(0.0) } else { 0.0 };
        if self.rate == 0.0 {
            self.freeze();
        } else if self.frozen {
            self.unfreeze();
        }
    }

    /// Assigns an authoritative source position, such as audio or timecode output.
    pub fn sync_to_external_position(&mut self, position: Duration) {
        self.previous_position = self.position;
        self.position = position;
        self.delta = if self.frozen {
            Duration::ZERO
        } else {
            self.position.saturating_sub(self.previous_position)
        };
        self.discontinuity = InstanceClockDiscontinuity::Discontinuous;
    }

    /// Repositions the playback for seek or reconstruction without treating the jump as a frame.
    pub fn seek_to(&mut self, position: Duration) {
        self.previous_position = position;
        self.position = position;
        self.delta = Duration::ZERO;
        self.discontinuity = InstanceClockDiscontinuity::Discontinuous;
    }

    /// Freezes position and forces subsequent ordinary updates to report zero delta.
    pub fn freeze(&mut self) {
        self.frozen = true;
        self.previous_position = self.position;
        self.delta = Duration::ZERO;
    }

    /// Resumes ordinary source-driven advancement.
    pub fn unfreeze(&mut self) {
        self.frozen = false;
        self.previous_position = self.position;
        self.delta = Duration::ZERO;
    }
}

/// Source-specific runtime position for an active instance.
#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum InstancePosition {
    /// Cue stack position for sequence instances.
    Sequence {
        /// Sequence source object UUID.
        sequence_uid: Uuid,
        /// Current 1-based cue position.
        current_position: u32,
        /// Number of cues in the sequence.
        cue_count: u32,
        /// Current cue source object UUID, if a cue is active.
        current_cue_uid: Option<Uuid>,
        /// Display label for the current cue, if available.
        current_label: Option<String>,
        /// Number of parts in the current cue.
        current_part_count: u32,
        /// Next 1-based cue position, if the sequence can advance.
        next_position: Option<u32>,
        /// Next cue source object UUID, if a cue can advance.
        next_cue_uid: Option<Uuid>,
        /// Display label for the next cue, if available.
        next_label: Option<String>,
        /// Number of parts in the next cue, if the sequence can advance.
        next_part_count: Option<u32>,
        /// Retained cue instances still contributing assertion transitions.
        retained_cues: Vec<InstanceSequenceCueStatus>,
    },
    /// Elapsed runtime for time-based playback sources.
    Time {
        /// Elapsed playback duration after rate scaling where applicable.
        elapsed: Duration,
    },
    /// Playback has no inspectable position.
    None,
}

/// Runtime status for one retained sequence cue instance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InstanceSequenceCueStatus {
    /// 1-based cue position.
    pub position: u32,
    /// Cue source object UUID.
    pub cue_uid: Uuid,
    /// Source-local elapsed duration for this retained cue's assertion transitions.
    pub transition_elapsed: Option<Duration>,
}

/// Inspectable runtime status for an active instance.
#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InstanceStatus {
    /// Current source-specific position.
    pub position: InstancePosition,
    /// Wall-clock timestamp when the currently visible source segment was activated.
    pub source_activation_epoch_ms: Option<f64>,
    /// Source-local elapsed duration for the currently visible transition segment.
    pub transition_elapsed: Option<Duration>,
}

impl Default for InstanceStatus {
    fn default() -> Self {
        Self {
            position: InstancePosition::None,
            source_activation_epoch_ms: None,
            transition_elapsed: None,
        }
    }
}

/// Converts an `Instant` activation point to an epoch timestamp for UI progress clocks.
pub fn activation_epoch_ms(activation: Instant) -> f64 {
    let started_at = SystemTime::now()
        .checked_sub(activation.elapsed())
        .unwrap_or(UNIX_EPOCH);
    started_at
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

/// Commands for controlling running instances by `InstanceId`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum InstanceCommand {
    /// Advance a running instance, such as to the next cue in a sequence.
    Go(InstanceId),
    /// Jump to a specific position in an instance.
    Goto {
        instance_id: InstanceId,
        position: u32,
    },
    /// Stop a running instance.
    Stop(InstanceId),
    /// Stop all running instances.
    StopAll,
    /// Spawn a new instance from a sequence source.
    StartSequence {
        #[serde(with = "nightfall::serde_uuid_simple")]
        sequence_id: Uuid,
        priority: Priority,
    },
    /// Spawn a new instance from an FX source.
    StartFx {
        #[serde(with = "nightfall::serde_uuid_simple")]
        fx_id: Uuid,
        priority: Priority,
    },
    /// Stop all instances matching a tag.
    StopByTag(String),
    /// Stop all instances of a specific kind.
    StopByKind(InstanceKind),
}

impl EnginePayload for InstanceCommand {}

impl EngineIngressMeta for InstanceCommand {
    const COMMAND_MODULE: &'static str = "InstanceCommand";
}

impl IngressCommand for InstanceCommand {}

/// Concrete internal work that releases one or more running instances.
#[derive(Debug, Clone)]
pub enum PlaybackReleaseAction {
    /// Release one instance by runtime identity.
    One(InstanceId),
    /// Release every running instance.
    All,
    /// Release instances with a matching source kind.
    ByKind(InstanceKind),
    /// Release instances carrying a matching tag.
    ByTag(String),
}

impl EnginePayload for PlaybackReleaseAction {}

impl EngineIngressMeta for PlaybackReleaseAction {
    const COMMAND_MODULE: &'static str = "PlaybackReleaseAction";
}

impl EngineAction for PlaybackReleaseAction {}

/// High-frequency updates applied to `InstanceControls` without a user-command lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum InstanceControlUpdate {
    /// Set the intensity scale for a playback.
    SetIntensityScale { instance_id: InstanceId, value: f32 },
    /// Set the rate multiplier for a playback.
    SetRate { instance_id: InstanceId, value: f32 },
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Verifies generated instance IDs do not collide in ordinary construction.
    #[test]
    fn instance_id_uniqueness() {
        let id1 = InstanceId::new();
        let id2 = InstanceId::new();
        assert_ne!(id1, id2);
    }

    /// Verifies instance metadata builders keep kind and display kind consistent.
    #[test]
    fn instance_metadata_builder() {
        let metadata = InstanceMetadata::new(InstanceKind::Sequence)
            .with_name("Test Sequence")
            .with_tags(vec!["show".to_string(), "main".to_string()]);

        assert_eq!(metadata.name, Some("Test Sequence".to_string()));
        assert_eq!(metadata.kind, InstanceKind::Sequence);
        assert_eq!(metadata.display_kind, InstanceDisplayKind::Sequence);
        assert_eq!(metadata.tags.len(), 2);
    }

    /// Verifies source-specific display categories can refine broad instance kinds.
    #[test]
    fn instance_metadata_allows_source_specific_display_kind() {
        let metadata =
            InstanceMetadata::new(InstanceKind::Fx).with_display_kind(InstanceDisplayKind::StepFx);

        assert_eq!(metadata.kind, InstanceKind::Fx);
        assert_eq!(metadata.display_kind, InstanceDisplayKind::StepFx);
    }

    /// Verifies playback controls default to neutral runtime factors.
    #[test]
    fn instance_controls_defaults() {
        let controls = InstanceControls::default();
        assert_eq!(controls.intensity_scale, 1.0);
        assert_eq!(controls.rate, 1.0);
        assert_eq!(controls.rate_master_scale, 1.0);
    }

    /// Verifies mastered playback rate multiplies the authored base rate.
    #[test]
    fn instance_controls_effective_rate_multiplies_master_scale() {
        let mut controls = InstanceControls::default();
        controls.set_rate(0.5);
        controls.set_rate_master_scale(2.0);

        assert_eq!(controls.effective_rate(), 1.0);
    }

    /// Verifies real-time clock advancement applies playback rate to the source delta.
    #[test]
    fn instance_clock_advances_realtime_delta_with_rate() {
        let mut clock = InstanceClock {
            rate: 2.0,
            ..Default::default()
        };

        clock.advance_by_realtime_delta(Duration::from_millis(250));

        assert_eq!(clock.previous_position, Duration::ZERO);
        assert_eq!(clock.position, Duration::from_millis(500));
        assert_eq!(clock.delta, Duration::from_millis(500));
        assert_eq!(clock.discontinuity, InstanceClockDiscontinuity::Continuous);
    }

    /// Verifies frozen clocks preserve position and report no frame advancement.
    #[test]
    fn instance_clock_freeze_holds_position_and_zeroes_delta() {
        let mut clock = InstanceClock::default();
        clock.seek_to(Duration::from_secs(3));
        clock.freeze();

        clock.advance_by_realtime_delta(Duration::from_secs(2));

        assert_eq!(clock.position, Duration::from_secs(3));
        assert_eq!(clock.previous_position, Duration::from_secs(3));
        assert_eq!(clock.delta, Duration::ZERO);
        assert!(clock.frozen);
    }

    /// Verifies seek assigns an arbitrary position without exposing it as an ordinary delta.
    #[test]
    fn instance_clock_seek_marks_discontinuity_and_zeroes_delta() {
        let mut clock = InstanceClock::default();
        clock.advance_by_realtime_delta(Duration::from_secs(5));

        clock.seek_to(Duration::from_secs(1));

        assert_eq!(clock.position, Duration::from_secs(1));
        assert_eq!(clock.previous_position, Duration::from_secs(1));
        assert_eq!(clock.delta, Duration::ZERO);
        assert_eq!(
            clock.discontinuity,
            InstanceClockDiscontinuity::Discontinuous
        );
    }

    /// Verifies external source sync can move the clock without using wall-clock deltas.
    #[test]
    fn instance_clock_external_sync_assigns_source_position() {
        let mut clock = InstanceClock::default();
        clock.advance_by_realtime_delta(Duration::from_secs(2));

        clock.sync_to_external_position(Duration::from_secs(10));

        assert_eq!(clock.previous_position, Duration::from_secs(2));
        assert_eq!(clock.position, Duration::from_secs(10));
        assert_eq!(clock.delta, Duration::from_secs(8));
        assert_eq!(
            clock.discontinuity,
            InstanceClockDiscontinuity::Discontinuous
        );
    }

    /// Verifies runtime status starts without a source-specific position.
    #[test]
    fn playback_runtime_status_defaults_to_no_position() {
        let status = InstanceStatus::default();
        assert_eq!(status.position, InstancePosition::None);
        assert_eq!(status.source_activation_epoch_ms, None);
        assert_eq!(status.transition_elapsed, None);
    }

    /// Verifies runtime status uses the existing tagged JSON shape for time positions.
    #[test]
    fn playback_runtime_position_serializes_tagged_time_position() {
        let status = InstanceStatus {
            position: InstancePosition::Time {
                elapsed: Duration::from_millis(1500),
            },
            source_activation_epoch_ms: Some(42.0),
            transition_elapsed: Some(Duration::from_millis(1500)),
        };

        let json = serde_json::to_value(status).expect("status should serialize");
        assert_eq!(json["position"]["type"], "Time");
        assert_eq!(json["position"]["data"]["elapsed"]["secs"], 1);
        assert_eq!(json["position"]["data"]["elapsed"]["nanos"], 500_000_000);
        assert_eq!(json["source_activation_epoch_ms"], 42.0);
        assert_eq!(json["transition_elapsed"]["secs"], 1);
        assert_eq!(json["transition_elapsed"]["nanos"], 500_000_000);
    }
}
