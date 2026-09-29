// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use bevy_ecs::prelude::*;
use enum_dispatch::enum_dispatch;
use nightfall::prelude::*;
use nightfall_dmx::PercentageAsF64;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::DataProvider;
use nightfall_instances::{
    InstanceClock, InstanceControls, InstanceDisplayKind, InstanceId, InstanceKind,
    InstanceMetadata, Owner,
};
use nightfall_selection::{
    SelectionValidatedEntity, SpatialSelectionResolution, selection_validation_warnings,
};
use serde::{Deserialize, Serialize};
use serde_with::serde_as;
use uuid::Uuid;

/// Operator-facing name of the color lane.
pub const COLOR_LANE_NAME: &str = "Color";

/// Canonical timing shared by Step FX tracks unless a lane overrides it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxTiming {
    /// Real time represented by one authored beat.
    pub beat_duration: Duration,
}

impl StepFxTiming {
    /// Builds timing from beats per minute.
    pub fn from_bpm(bpm: f32) -> Option<Self> {
        positive_duration(60.0 / bpm).map(|beat_duration| Self { beat_duration })
    }

    /// Builds timing from beats per second.
    pub fn from_hz(hz: f32) -> Option<Self> {
        positive_duration(1.0 / hz).map(|beat_duration| Self { beat_duration })
    }

    /// Builds timing from seconds per beat.
    pub fn from_seconds(seconds: f32) -> Option<Self> {
        positive_duration(seconds).map(|beat_duration| Self { beat_duration })
    }

    /// Builds timing from milliseconds per beat.
    pub fn from_milliseconds(milliseconds: f32) -> Option<Self> {
        Self::from_seconds(milliseconds / 1_000.0)
    }

    /// Returns the timing as beats per minute.
    pub fn bpm(&self) -> f32 {
        60.0 / self.beat_duration.as_secs_f32()
    }

    /// Returns the timing as beats per second.
    pub fn hz(&self) -> f32 {
        1.0 / self.beat_duration.as_secs_f32()
    }
}

impl Default for StepFxTiming {
    fn default() -> Self {
        Self {
            beat_duration: Duration::from_millis(500),
        }
    }
}

/// Quantization applied while distributing phase across resolved selection indexes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum PhaseGroups {
    /// Give every non-empty selection index its continuously interpolated phase.
    #[default]
    Automatic,
    /// Quantize selection indexes into the requested number of phase groups.
    Explicit(u32),
}

/// Authored phase waypoints distributed across ordered selection indexes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxPhase {
    /// Non-empty unwrapped normalized cycle offsets forming a piecewise-linear envelope.
    pub waypoints: Vec<f32>,
    /// Optional quantization retained for effects authored with explicit phase groups.
    #[serde(default)]
    pub groups: PhaseGroups,
}

impl Default for StepFxPhase {
    fn default() -> Self {
        Self {
            waypoints: vec![0.0, 1.0],
            groups: PhaseGroups::Automatic,
        }
    }
}

/// Optional normalization applied to one authored Step FX pass.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum StepFxCycleScale {
    /// Derive each track's pass beats from its authored step widths.
    #[default]
    Auto,
    /// Fit one authored pass into this positive number of beats.
    Fixed(f32),
}

/// Normalized interval within one step during which its target transition occurs.
#[serde_as]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxTransition {
    /// Fraction of the step width held at the previous target before interpolation begins.
    #[serde_as(as = "PercentageAsF64")]
    pub start: Percentage,
    /// Fraction of the step width at which interpolation reaches the step target.
    #[serde_as(as = "PercentageAsF64")]
    pub end: Percentage,
}

impl StepFxTransition {
    /// Builds a transition window from explicit normalized endpoints.
    pub fn new(start: Percentage, end: Percentage) -> Self {
        Self { start, end }
    }

    /// Builds the legacy start-at-zero transition window ending at `end`.
    pub fn from_end(end: Percentage) -> Self {
        Self {
            start: 0.0.into(),
            end,
        }
    }
}

impl Default for StepFxTransition {
    /// Uses the complete step width as the default interpolation window.
    fn default() -> Self {
        Self::from_end(1.0.into())
    }
}

impl From<Percentage> for StepFxTransition {
    /// Converts a legacy transition duration into a start-at-zero window.
    fn from(end: Percentage) -> Self {
        Self::from_end(end)
    }
}

impl From<f32> for StepFxTransition {
    /// Converts a scalar fraction into a start-at-zero transition window.
    fn from(end: f32) -> Self {
        Self::from_end(end.into())
    }
}

/// One target and its timing and interpolation shape within an FX track.
#[serde_as]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxStep {
    /// Stable identity independent of the step's current position.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    /// Absolute or relative target matching the containing track kind.
    pub target: ParameterValue,
    /// Optional live Blueprint supplying this lane attribute at playback time.
    ///
    /// `target` remains the last resolved scalar value so referenced steps stay
    /// editable and have a deterministic fallback if the Blueprint disappears.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "nightfall::serde_option_uuid_simple"
    )]
    #[typeshare(serialized_as = "Option<String>")]
    pub blueprint_uid: Option<Uuid>,
    /// Time from this step's start to the following step's start, in beats.
    pub width_beats: f32,
    /// Start and end fractions bounding interpolation from the previous target.
    pub transition: StepFxTransition,
    /// Curve used during the transition portion of the step.
    pub curve: CurveType,
}

impl FxStep {
    /// Builds a step with a new stable identity.
    pub fn new(
        target: ParameterValue,
        width_beats: f32,
        transition: StepFxTransition,
        curve: CurveType,
    ) -> Self {
        Self {
            uid: Uuid::new_v4(),
            target,
            blueprint_uid: None,
            width_beats,
            transition,
            curve,
        }
    }
}

/// Ordered absolute or relative contribution for one attribute lane.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxTrack {
    /// Authored steps in forward traversal order.
    pub steps: Vec<FxStep>,
}

impl FxTrack {
    /// Returns the authored one-way traversal width in beats.
    pub fn authored_pass_beats(&self) -> f32 {
        self.steps.iter().map(|step| step.width_beats).sum()
    }
}

/// All authored contributions for one fixture attribute.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxLane {
    /// Logical attribute controlled by the lane.
    pub attribute: Attribute,
    /// Optional timing replacing the effect-wide beat duration for this lane.
    pub timing_override: Option<StepFxTiming>,
    /// Optional phase replacing the effect-wide phase for this lane.
    pub phase_override: Option<StepFxPhase>,
    /// Optional absolute contribution track.
    pub absolute: Option<FxTrack>,
    /// Optional relative contribution track.
    pub relative: Option<FxTrack>,
}

/// One color target and its timing and interpolation shape within the color lane.
#[serde_as]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxColorStep {
    /// Stable identity independent of the step's current position.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    /// Normalized RGB color reached at the end of this step's transition.
    pub color: ColorPathRgb,
    /// Optional live Blueprint whose color values supply this step at playback time.
    ///
    /// `color` remains the last resolved color so referenced steps stay editable and have
    /// a deterministic fallback if the Blueprint disappears or holds no color values.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "nightfall::serde_option_uuid_simple"
    )]
    #[typeshare(serialized_as = "Option<String>")]
    pub blueprint_uid: Option<Uuid>,
    /// Time from this step's start to the following step's start, in beats.
    pub width_beats: f32,
    /// Start and end fractions bounding interpolation from the previous color.
    pub transition: StepFxTransition,
    /// Curve used during the transition portion of the step.
    pub curve: CurveType,
}

impl FxColorStep {
    /// Builds a color step with a new stable identity.
    pub fn new(
        color: ColorPathRgb,
        width_beats: f32,
        transition: StepFxTransition,
        curve: CurveType,
    ) -> Self {
        Self {
            uid: Uuid::new_v4(),
            color,
            blueprint_uid: None,
            width_beats,
            transition,
            curve,
        }
    }
}

/// Absolute color contribution driving every color emitter on each covered fixture element.
///
/// An element is covered when it exposes a complete red/green/blue or cyan/magenta/yellow
/// emitter set. The lane then owns that set, plus any white, warm white, cool white, and
/// amber emitters on RGB elements, which receive the sampled color's decomposition.
/// Attribute lanes still drive those attributes on elements the color lane does not cover.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxColorLane {
    /// Space in which consecutive step colors are interpolated.
    pub interpolation_space: ColorInterpolationSpace,
    /// Hue route used when interpolating in a circular space.
    pub hue_direction: HueDirection,
    /// Optional timing replacing the effect-wide beat duration for this lane.
    pub timing_override: Option<StepFxTiming>,
    /// Optional phase replacing the effect-wide phase for this lane.
    pub phase_override: Option<StepFxPhase>,
    /// Authored color steps in forward traversal order.
    pub steps: Vec<FxColorStep>,
}

impl FxColorLane {
    /// Returns the authored one-way traversal width in beats.
    pub fn authored_pass_beats(&self) -> f32 {
        self.steps.iter().map(|step| step.width_beats).sum()
    }
}

/// Complete stored Step FX definition.
#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFx {
    /// Stable object identifiers.
    pub identifiers: Identifiers,
    /// Fixture membership, order, grouping, and inversion operations.
    pub selection: SpatialSelection,
    /// Canonical effect-wide beat timing.
    pub timing: StepFxTiming,
    /// Effect-wide phase defaults.
    pub phase: StepFxPhase,
    /// Authored traversal direction.
    pub direction: FxDirection,
    /// Optional non-destructive normalization of the complete repeating cycle.
    pub cycle_scale: StepFxCycleScale,
    /// Independent attribute lanes.
    pub lanes: Vec<FxLane>,
    /// Optional color lane that takes precedence over attribute lanes on the elements it covers.
    #[serde(default)]
    pub color: Option<FxColorLane>,
}

impl Default for StepFx {
    /// Builds an empty definition shell for tests and object construction helpers.
    fn default() -> Self {
        Self {
            identifiers: Identifiers::default(),
            selection: SpatialSelection::default(),
            timing: StepFxTiming::default(),
            phase: StepFxPhase::default(),
            direction: FxDirection::default(),
            cycle_scale: StepFxCycleScale::default(),
            lanes: Vec::new(),
            color: None,
        }
    }
}

impl SelectionValidatedEntity for StepFx {
    /// Returns non-fatal warnings produced while resolving the stored selection.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String> {
        selection_validation_warnings(&self.selection, resolver)
    }
}

/// Playback direction shared by all Step FX lanes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum FxDirection {
    /// Traverse steps in authored order.
    #[default]
    Forward,
    /// Traverse steps in reverse authored order.
    Reverse,
    /// Traverse forward and backward without repeating turnaround endpoints.
    Bounce,
}

/// Duration input accepted by command and editor conversion helpers.
#[serde_as]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum DurationInput {
    /// Seconds per beat.
    Seconds(f32),
    /// Beats per minute.
    Bpm(f32),
    /// Beats per second.
    Hz(f32),
    /// Milliseconds per beat.
    Milliseconds(f32),
    /// Fraction of a one-second timing context.
    Percentage(#[serde_as(as = "PercentageAsF64")] Percentage),
}

impl DurationInput {
    /// Converts valid positive input to the canonical duration per beat.
    pub fn to_duration(&self) -> Option<Duration> {
        match self {
            Self::Seconds(seconds) => StepFxTiming::from_seconds(*seconds),
            Self::Bpm(bpm) => StepFxTiming::from_bpm(*bpm),
            Self::Hz(hz) => StepFxTiming::from_hz(*hz),
            Self::Milliseconds(milliseconds) => StepFxTiming::from_milliseconds(*milliseconds),
            Self::Percentage(percentage) => StepFxTiming::from_seconds(percentage.as_f32()),
        }
        .map(|timing| timing.beat_duration)
    }
}

/// One lane's independently sampled absolute and relative contributions.
#[derive(Clone, Debug, PartialEq)]
pub struct FxLaneSample {
    /// Logical lane attribute.
    pub attribute: Attribute,
    /// Sampled absolute contribution, when an absolute track exists.
    pub absolute: Option<ParameterValue>,
    /// Sampled relative contribution, when a relative track exists.
    pub relative: Option<ParameterValue>,
}

/// A localized validation problem that prevents storing or previewing a draft.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxValidationIssue {
    /// Stable model path used by the editor to mark the affected control.
    pub path: String,
    /// Concise operator-facing explanation.
    pub message: String,
}

/// Active Step FX runtime state component.
#[derive(Component, Clone, Debug)]
pub struct ActiveStepFx {
    /// Entity holding the current stored or preview definition.
    pub fx_entity: Entity,
    /// Layer priority for this playback.
    pub priority: Priority,
    /// Playback speed multiplier.
    pub rate: f32,
    /// Whether the runtime should currently evaluate.
    pub is_playing: bool,
}

/// Runtime-only normalized phase corrections for one lane's contribution tracks.
#[derive(Clone, Debug, Default)]
pub struct StepFxTrackPhaseOffsets {
    /// Correction applied to the absolute contribution.
    pub absolute: f32,
    /// Correction applied to the relative contribution.
    pub relative: f32,
}

/// Runtime-only normalized phase corrections retained independently for each track.
#[derive(Component, Clone, Debug, Default)]
pub struct StepFxLanePhaseOffsets {
    /// Corrections keyed by logical lane attribute.
    pub offsets: Vec<(Attribute, StepFxTrackPhaseOffsets)>,
    /// Correction applied to the color lane.
    pub color: f32,
    /// Clock position observed when the corrections were last sampled.
    pub last_clock_position: Duration,
}

impl StepFxLanePhaseOffsets {
    /// Builds attribute-lane corrections anchored to the current playback clock position.
    pub fn new(
        offsets: Vec<(Attribute, StepFxTrackPhaseOffsets)>,
        last_clock_position: Duration,
    ) -> Self {
        Self {
            offsets,
            color: 0.0,
            last_clock_position,
        }
    }

    /// Replaces the color lane correction.
    pub fn with_color(mut self, color: f32) -> Self {
        self.color = color;
        self
    }

    /// Returns the runtime corrections for one logical attribute.
    pub fn get(&self, attribute: &Attribute) -> StepFxTrackPhaseOffsets {
        self.offsets
            .iter()
            .find_map(|(candidate, offsets)| (candidate == attribute).then_some(offsets.clone()))
            .unwrap_or_default()
    }
}

impl Default for ActiveStepFx {
    fn default() -> Self {
        Self {
            fx_entity: Entity::PLACEHOLDER,
            priority: Priority(50),
            rate: 1.0,
            is_playing: false,
        }
    }
}

/// Context from directly materializing a reconstructed Step FX playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaterializedStepFxReconstructionHandle {
    /// Entity containing the reconstructed runtime.
    pub active_entity: Entity,
    /// Runtime playback ID attached to the reconstructed Step FX.
    pub instance_id: InstanceId,
}

/// Directly materializes Step FX playback reconstruction for an clip.
pub fn spawn_reconstructed_step_fx_for_clip(
    commands: &mut Commands,
    clip_uid: Uuid,
    priority: Priority,
    fx_entity: Entity,
    step_fx: &StepFx,
    instance_clock: InstanceClock,
) -> MaterializedStepFxReconstructionHandle {
    let instance_id = InstanceId::new();
    let active_entity = commands
        .spawn((
            ActiveStepFx {
                fx_entity,
                priority,
                rate: 1.0,
                is_playing: true,
            },
            Owner(clip_uid),
            instance_id,
            InstanceMetadata::new(InstanceKind::Fx)
                .with_display_kind(InstanceDisplayKind::StepFx)
                .with_name(step_fx.identifiers.label.clone()),
            InstanceControls::default(),
            instance_clock,
        ))
        .id();

    MaterializedStepFxReconstructionHandle {
        active_entity,
        instance_id,
    }
}

/// Interpolates between compatible parameter values.
pub fn interpolate_parameter_values(
    from: &ParameterValue,
    to: &ParameterValue,
    factor: f32,
) -> ParameterValue {
    let factor = factor.clamp(0.0, 1.0);
    match (from, to) {
        (
            ParameterValue::AbsolutePercent { value: from },
            ParameterValue::AbsolutePercent { value: to },
        ) => ParameterValue::AbsolutePercent {
            value: (from.as_f32() + (to.as_f32() - from.as_f32()) * factor).into(),
        },
        (ParameterValue::Absolute { value: from }, ParameterValue::Absolute { value: to }) => {
            ParameterValue::Absolute {
                value: from + (to - from) * factor,
            }
        }
        (
            ParameterValue::RelativePercent { offset: from },
            ParameterValue::RelativePercent { offset: to },
        ) => ParameterValue::RelativePercent {
            offset: (from.as_f32() + (to.as_f32() - from.as_f32()) * factor).into(),
        },
        (ParameterValue::Relative { offset: from }, ParameterValue::Relative { offset: to }) => {
            ParameterValue::Relative {
                offset: from + (to - from) * factor,
            }
        }
        _ => *to,
    }
}

/// Calculates normalized phase offsets for every non-empty selection index.
pub fn calculate_phase_distribution(phase: &StepFxPhase, selection_index_count: usize) -> Vec<f32> {
    (0..selection_index_count)
        .map(|index| phase_for_selection_index(phase, index, selection_index_count))
        .collect()
}

/// Calculates one selection index's normalized phase using exclusive-end distribution.
pub fn phase_for_selection_index(
    phase: &StepFxPhase,
    selection_index: usize,
    selection_index_count: usize,
) -> f32 {
    let Some(&first) = phase.waypoints.first() else {
        return 0.0;
    };
    if phase.waypoints.len() == 1 || selection_index_count <= 1 {
        return first;
    }

    let index = selection_index.min(selection_index_count - 1);
    let normalized_position = match &phase.groups {
        PhaseGroups::Automatic => index as f32 / selection_index_count as f32,
        PhaseGroups::Explicit(requested) => {
            let groups = (*requested).max(1);
            let group_index = index as u64 * groups as u64 / selection_index_count as u64;
            group_index as f32 / groups as f32
        }
    };
    let position = normalized_position * (phase.waypoints.len() - 1) as f32;
    let segment = (position.floor() as usize).min(phase.waypoints.len() - 2);
    let factor = position - segment as f32;
    let start = phase.waypoints[segment];
    let end = phase.waypoints[segment + 1];
    start + (end - start) * factor
}

impl StepFx {
    /// Enumerates live Blueprint references with the display name of their containing lane.
    pub fn blueprint_references(&self) -> impl Iterator<Item = (Uuid, String)> + '_ {
        let attribute_references = self.lanes.iter().flat_map(|lane| {
            [lane.absolute.as_ref(), lane.relative.as_ref()]
                .into_iter()
                .flatten()
                .flat_map(|track| track.steps.iter())
                .filter_map(move |step| {
                    step.blueprint_uid
                        .map(|uid| (uid, lane.attribute.to_string()))
                })
        });
        let color_references = self
            .color
            .iter()
            .flat_map(|lane| lane.steps.iter())
            .filter_map(|step| {
                step.blueprint_uid
                    .map(|uid| (uid, COLOR_LANE_NAME.to_owned()))
            });
        attribute_references.chain(color_references)
    }

    /// Rewrites mapped Blueprint identities in every lane, preserving unmapped references and targets.
    pub fn remap_blueprint_references(&mut self, remap: &HashMap<Uuid, Uuid>) {
        let remap_uid = |uid: &mut Option<Uuid>| {
            if let Some(replacement) = uid.as_ref().and_then(|uid| remap.get(uid)) {
                *uid = Some(*replacement);
            }
        };
        for lane in &mut self.lanes {
            for track in [lane.absolute.as_mut(), lane.relative.as_mut()]
                .into_iter()
                .flatten()
            {
                for step in &mut track.steps {
                    remap_uid(&mut step.blueprint_uid);
                }
            }
        }
        for step in self.color.iter_mut().flat_map(|lane| lane.steps.iter_mut()) {
            remap_uid(&mut step.blueprint_uid);
        }
    }

    /// Returns all structural errors that prevent persistence or preview updates.
    pub fn validate(&self) -> Vec<StepFxValidationIssue> {
        let mut issues = Vec::new();
        if self.identifiers.id == 0 {
            push_issue(
                &mut issues,
                "identifiers.id",
                "Step FX ID must be greater than zero",
            );
        }
        if self.identifiers.uid.is_nil() {
            push_issue(&mut issues, "identifiers.uid", "Step FX UID must be valid");
        }
        if self.identifiers.label.trim().is_empty() {
            push_issue(&mut issues, "identifiers.label", "Label cannot be empty");
        }
        validate_timing(&self.timing, "timing", &mut issues);
        validate_phase(&self.phase, "phase", &mut issues);
        validate_cycle_scale(&self.cycle_scale, &mut issues);
        if self.lanes.is_empty() && self.color.is_none() {
            push_issue(&mut issues, "lanes", "Add at least one lane");
            return issues;
        }

        let mut attributes = HashSet::new();
        let mut step_uids = HashSet::new();
        let mut has_dynamic_track = false;

        if let Some(color) = &self.color {
            validate_color_lane(color, &mut step_uids, &mut issues);
            has_dynamic_track |= color.steps.len() >= 2;
        }

        for (lane_index, lane) in self.lanes.iter().enumerate() {
            let lane_path = format!("lanes.{lane_index}");
            if !attributes.insert(lane.attribute.clone()) {
                push_issue(
                    &mut issues,
                    format!("{lane_path}.attribute"),
                    "Each attribute may appear in only one lane",
                );
            }
            if let Some(timing) = &lane.timing_override {
                validate_timing(timing, &format!("{lane_path}.timing_override"), &mut issues);
            }
            if let Some(phase) = &lane.phase_override {
                validate_phase(phase, &format!("{lane_path}.phase_override"), &mut issues);
            }
            if lane.absolute.is_none() && lane.relative.is_none() {
                push_issue(
                    &mut issues,
                    lane_path.clone(),
                    "A lane needs an absolute or relative track",
                );
            }

            for (track_name, track, relative) in [
                ("absolute", lane.absolute.as_ref(), false),
                ("relative", lane.relative.as_ref(), true),
            ] {
                let Some(track) = track else { continue };
                let track_path = format!("{lane_path}.{track_name}");
                validate_track(track, relative, &track_path, &mut step_uids, &mut issues);
                has_dynamic_track |= track.steps.len() >= 2;
            }
        }

        if !has_dynamic_track {
            push_issue(
                &mut issues,
                "lanes",
                "At least one track needs two or more steps",
            );
        }
        issues
    }

    /// Returns the representative overall cycle duration for continuity re-anchoring.
    pub fn cycle_duration(&self) -> Option<Duration> {
        self.lanes
            .iter()
            .find_map(|lane| {
                let timing = lane.timing_override.as_ref().unwrap_or(&self.timing);
                [lane.absolute.as_ref(), lane.relative.as_ref()]
                    .into_iter()
                    .flatten()
                    .next()
                    .and_then(|track| {
                        track_cycle_duration(track, timing, &self.cycle_scale, &self.direction)
                    })
            })
            .or_else(|| self.color_cycle_duration())
    }

    /// Returns the color lane's cycle duration, when a color lane exists.
    pub fn color_cycle_duration(&self) -> Option<Duration> {
        self.color.as_ref().and_then(|lane| {
            steps_cycle_duration(
                &lane.steps,
                lane.timing_override.as_ref().unwrap_or(&self.timing),
                &self.cycle_scale,
                &self.direction,
            )
        })
    }

    /// Samples the color lane for one resolved non-empty selection index.
    pub fn sample_color_for_selection_index(
        &self,
        elapsed: Duration,
        selection_index: usize,
        selection_index_count: usize,
        lane_phase_offsets: &StepFxLanePhaseOffsets,
        blueprints: Option<&DataProvider<Blueprint>>,
    ) -> Option<ColorPathRgb> {
        let lane = self.color.as_ref()?;
        let phase = lane.phase_override.as_ref().unwrap_or(&self.phase);
        self.sample_color_with_phase_offset_and_correction(
            elapsed,
            phase_for_selection_index(phase, selection_index, selection_index_count),
            lane_phase_offsets.color,
            blueprints,
        )
    }

    /// Samples the color lane with a direct normalized phase offset for pure graph and unit tests.
    pub fn sample_color_with_phase_offset(
        &self,
        elapsed: Duration,
        phase_offset: f32,
    ) -> Option<ColorPathRgb> {
        self.sample_color_with_phase_offset_and_correction(elapsed, phase_offset, 0.0, None)
    }

    /// Samples the color lane at an authored start position plus a runtime continuity correction.
    fn sample_color_with_phase_offset_and_correction(
        &self,
        elapsed: Duration,
        start_position: f32,
        runtime_phase_offset: f32,
        blueprints: Option<&DataProvider<Blueprint>>,
    ) -> Option<ColorPathRgb> {
        let lane = self.color.as_ref()?;
        let context = StepSampleContext {
            timing: lane.timing_override.as_ref().unwrap_or(&self.timing),
            direction: &self.direction,
            cycle_scale: &self.cycle_scale,
            elapsed,
            start_position,
            runtime_phase_offset,
        };
        sample_color_lane(lane, &context, blueprints)
    }

    /// Returns one lane's absolute and relative cycle durations.
    pub fn lane_cycle_durations(
        &self,
        attribute: &Attribute,
    ) -> (Option<Duration>, Option<Duration>) {
        self.lanes
            .iter()
            .find(|lane| &lane.attribute == attribute)
            .map(|lane| {
                let timing = lane.timing_override.as_ref().unwrap_or(&self.timing);
                (
                    lane.absolute.as_ref().and_then(|track| {
                        track_cycle_duration(track, timing, &self.cycle_scale, &self.direction)
                    }),
                    lane.relative.as_ref().and_then(|track| {
                        track_cycle_duration(track, timing, &self.cycle_scale, &self.direction)
                    }),
                )
            })
            .unwrap_or_default()
    }

    /// Samples all lanes for one resolved non-empty selection index.
    pub fn sample_for_selection_index(
        &self,
        elapsed: Duration,
        selection_index: usize,
        selection_index_count: usize,
    ) -> Vec<FxLaneSample> {
        self.sample_for_selection_index_with_offsets(
            elapsed,
            selection_index,
            selection_index_count,
            &StepFxLanePhaseOffsets::default(),
        )
    }

    /// Samples all lanes while applying runtime-only continuity corrections.
    pub fn sample_for_selection_index_with_offsets(
        &self,
        elapsed: Duration,
        selection_index: usize,
        selection_index_count: usize,
        lane_phase_offsets: &StepFxLanePhaseOffsets,
    ) -> Vec<FxLaneSample> {
        self.sample_for_selection_index_with_offsets_and_blueprints(
            elapsed,
            selection_index,
            selection_index_count,
            lane_phase_offsets,
            None,
        )
    }

    /// Samples all lanes while resolving any live Blueprint-backed targets.
    pub fn sample_for_selection_index_with_offsets_and_blueprints(
        &self,
        elapsed: Duration,
        selection_index: usize,
        selection_index_count: usize,
        lane_phase_offsets: &StepFxLanePhaseOffsets,
        blueprints: Option<&DataProvider<Blueprint>>,
    ) -> Vec<FxLaneSample> {
        self.lanes
            .iter()
            .map(|lane| {
                let timing = lane.timing_override.as_ref().unwrap_or(&self.timing);
                let phase = lane.phase_override.as_ref().unwrap_or(&self.phase);
                let selection_phase =
                    phase_for_selection_index(phase, selection_index, selection_index_count);
                let offsets = lane_phase_offsets.get(&lane.attribute);
                FxLaneSample {
                    attribute: lane.attribute.clone(),
                    absolute: lane.absolute.as_ref().and_then(|track| {
                        sample_track(
                            track,
                            timing,
                            &self.direction,
                            &self.cycle_scale,
                            elapsed,
                            selection_phase,
                            offsets.absolute,
                            &lane.attribute,
                            blueprints,
                        )
                    }),
                    relative: lane.relative.as_ref().and_then(|track| {
                        sample_track(
                            track,
                            timing,
                            &self.direction,
                            &self.cycle_scale,
                            elapsed,
                            selection_phase,
                            offsets.relative,
                            &lane.attribute,
                            blueprints,
                        )
                    }),
                }
            })
            .collect()
    }

    /// Samples lanes with a direct normalized phase offset for pure graph and unit tests.
    pub fn sample_with_phase_offset(
        &self,
        elapsed: Duration,
        phase_offset: f32,
    ) -> Vec<FxLaneSample> {
        self.lanes
            .iter()
            .map(|lane| {
                let timing = lane.timing_override.as_ref().unwrap_or(&self.timing);
                FxLaneSample {
                    attribute: lane.attribute.clone(),
                    absolute: lane.absolute.as_ref().and_then(|track| {
                        sample_track(
                            track,
                            timing,
                            &self.direction,
                            &self.cycle_scale,
                            elapsed,
                            phase_offset,
                            0.0,
                            &lane.attribute,
                            None,
                        )
                    }),
                    relative: lane.relative.as_ref().and_then(|track| {
                        sample_track(
                            track,
                            timing,
                            &self.direction,
                            &self.cycle_scale,
                            elapsed,
                            phase_offset,
                            0.0,
                            &lane.attribute,
                            None,
                        )
                    }),
                }
            })
            .collect()
    }
}

/// Transition curve types supported by the first-release editor.
#[enum_dispatch(TransitionCurve)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum CurveType {
    /// Linear interpolation.
    Linear(Linear),
    /// Cubic Bézier interpolation.
    Bezier(Bezier),
    /// Immediate transition at the transition window's start.
    Snap(Snap),
}

/// Evaluates a normalized transition curve.
#[enum_dispatch]
pub trait TransitionCurve {
    /// Returns the interpolation factor for normalized transition time.
    fn evaluate(&self, t: f32) -> f32;
}

/// Linear interpolation curve.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Linear {}

impl TransitionCurve for Linear {
    fn evaluate(&self, t: f32) -> f32 {
        t
    }
}

/// Normalized two-dimensional point used by Bézier curves.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Point2D {
    /// Horizontal coordinate.
    pub x: f32,
    /// Vertical coordinate.
    pub y: f32,
}

/// Cubic Bézier transition curve.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Bezier {
    /// First control point.
    pub cp1: Point2D,
    /// Second control point.
    pub cp2: Point2D,
}

impl Bezier {
    /// Standard ease-in-out preset.
    pub const EASE: Self = Self {
        cp1: Point2D { x: 0.42, y: 0.0 },
        cp2: Point2D { x: 0.58, y: 1.0 },
    };
    /// Ease-in preset.
    pub const EASE_IN: Self = Self {
        cp1: Point2D { x: 0.42, y: 0.0 },
        cp2: Point2D { x: 1.0, y: 1.0 },
    };
    /// Ease-out preset.
    pub const EASE_OUT: Self = Self {
        cp1: Point2D { x: 0.0, y: 0.0 },
        cp2: Point2D { x: 0.58, y: 1.0 },
    };
}

impl TransitionCurve for Bezier {
    fn evaluate(&self, t: f32) -> f32 {
        evaluate_cubic_bezier(self.cp1.x, self.cp1.y, self.cp2.x, self.cp2.y, t)
    }
}

/// Immediate transition curve.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Snap {}

impl TransitionCurve for Snap {
    fn evaluate(&self, _t: f32) -> f32 {
        1.0
    }
}

/// Converts a finite positive number of seconds to a duration.
fn positive_duration(seconds: f32) -> Option<Duration> {
    (seconds.is_finite() && seconds > 0.0).then(|| Duration::from_secs_f32(seconds))
}

/// Appends one localized validation issue.
fn push_issue(
    issues: &mut Vec<StepFxValidationIssue>,
    path: impl Into<String>,
    message: impl Into<String>,
) {
    issues.push(StepFxValidationIssue {
        path: path.into(),
        message: message.into(),
    });
}

/// Validates a canonical beat timing object.
fn validate_timing(timing: &StepFxTiming, path: &str, issues: &mut Vec<StepFxValidationIssue>) {
    if timing.beat_duration.is_zero() {
        push_issue(
            issues,
            format!("{path}.beat_duration"),
            "Beat duration must be greater than zero",
        );
    }
}

/// Validates a non-empty normalized phase waypoint envelope.
fn validate_phase(phase: &StepFxPhase, path: &str, issues: &mut Vec<StepFxValidationIssue>) {
    if phase.waypoints.is_empty() {
        push_issue(
            issues,
            format!("{path}.waypoints"),
            "Phase requires at least one waypoint",
        );
    }
    for (index, waypoint) in phase.waypoints.iter().enumerate() {
        if !waypoint.is_finite() {
            push_issue(
                issues,
                format!("{path}.waypoints.{index}"),
                "Phase waypoint must be finite",
            );
        }
    }
    if matches!(phase.groups, PhaseGroups::Explicit(0)) {
        push_issue(
            issues,
            format!("{path}.groups"),
            "Explicit phase groups must be at least one",
        );
    }
}

/// Validates an optional fixed complete-cycle beat target.
fn validate_cycle_scale(cycle_scale: &StepFxCycleScale, issues: &mut Vec<StepFxValidationIssue>) {
    if let StepFxCycleScale::Fixed(beats) = cycle_scale
        && (!beats.is_finite() || *beats <= 0.0)
    {
        push_issue(
            issues,
            "cycle_scale.data",
            "Fixed pass beats must be finite and greater than zero",
        );
    }
}

/// Validates one track and its stable step identities.
fn validate_track(
    track: &FxTrack,
    relative: bool,
    path: &str,
    step_uids: &mut HashSet<Uuid>,
    issues: &mut Vec<StepFxValidationIssue>,
) {
    if track.steps.is_empty() {
        push_issue(
            issues,
            format!("{path}.steps"),
            "A track needs at least one step",
        );
    }
    for (step_index, step) in track.steps.iter().enumerate() {
        let step_path = format!("{path}.steps.{step_index}");
        validate_step_shape(step, step.uid, &step_path, step_uids, issues);
        if step.target.is_relative() != relative {
            push_issue(
                issues,
                format!("{step_path}.target"),
                if relative {
                    "Relative tracks require relative targets"
                } else {
                    "Absolute tracks require absolute targets"
                },
            );
        }
    }
}

/// Validates the color lane, its overrides, and every color step.
fn validate_color_lane(
    lane: &FxColorLane,
    step_uids: &mut HashSet<Uuid>,
    issues: &mut Vec<StepFxValidationIssue>,
) {
    if let Some(timing) = &lane.timing_override {
        validate_timing(timing, "color.timing_override", issues);
    }
    if let Some(phase) = &lane.phase_override {
        validate_phase(phase, "color.phase_override", issues);
    }
    if lane.steps.is_empty() {
        push_issue(
            issues,
            "color.steps",
            "A color lane needs at least one step",
        );
    }
    for (step_index, step) in lane.steps.iter().enumerate() {
        let step_path = format!("color.steps.{step_index}");
        validate_step_shape(step, step.uid, &step_path, step_uids, issues);
        let ColorPathRgb { red, green, blue } = step.color;
        for (name, value) in [("red", red), ("green", green), ("blue", blue)] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                push_issue(
                    issues,
                    format!("{step_path}.color.{name}"),
                    "Color components must be between 0% and 100%",
                );
            }
        }
    }
}

/// Validates the identity, width, transition window, and curve shared by every step kind.
fn validate_step_shape(
    step: &impl TimedStep,
    uid: Uuid,
    step_path: &str,
    step_uids: &mut HashSet<Uuid>,
    issues: &mut Vec<StepFxValidationIssue>,
) {
    if uid.is_nil() || !step_uids.insert(uid) {
        push_issue(
            issues,
            format!("{step_path}.uid"),
            "Step identities must be valid and unique",
        );
    }
    let width_beats = step.width_beats();
    if !width_beats.is_finite() || width_beats <= 0.0 {
        push_issue(
            issues,
            format!("{step_path}.width_beats"),
            "Width must be finite and greater than zero",
        );
    }
    let transition_start = step.transition().start.as_f32();
    let transition_end = step.transition().end.as_f32();
    if !transition_start.is_finite() || !(0.0..=1.0).contains(&transition_start) {
        push_issue(
            issues,
            format!("{step_path}.transition.start"),
            "Ramp start must be between 0% and 100%",
        );
    }
    if !transition_end.is_finite() || !(0.0..=1.0).contains(&transition_end) {
        push_issue(
            issues,
            format!("{step_path}.transition.end"),
            "Ramp end must be between 0% and 100%",
        );
    }
    if transition_start.is_finite()
        && transition_end.is_finite()
        && transition_start > transition_end
    {
        push_issue(
            issues,
            format!("{step_path}.transition"),
            "Ramp start must not exceed its end",
        );
    }
    if let CurveType::Bezier(curve) = step.curve() {
        for (name, value) in [
            ("cp1.x", curve.cp1.x),
            ("cp1.y", curve.cp1.y),
            ("cp2.x", curve.cp2.x),
            ("cp2.y", curve.cp2.y),
        ] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                push_issue(
                    issues,
                    format!("{step_path}.curve.{name}"),
                    "Curve control points must be between zero and one",
                );
            }
        }
    }
}

/// Returns the derived cycle duration of one authored step sequence.
fn steps_cycle_duration(
    steps: &[impl TimedStep],
    timing: &StepFxTiming,
    cycle_scale: &StepFxCycleScale,
    direction: &FxDirection,
) -> Option<Duration> {
    let beats = effective_cycle_beats(authored_pass_beats(steps), cycle_scale, direction);
    positive_duration(timing.beat_duration.as_secs_f32() * beats)
}

/// Returns one track's derived cycle duration.
fn track_cycle_duration(
    track: &FxTrack,
    timing: &StepFxTiming,
    cycle_scale: &StepFxCycleScale,
    direction: &FxDirection,
) -> Option<Duration> {
    steps_cycle_duration(&track.steps, timing, cycle_scale, direction)
}

/// Returns the complete cycle after scaling one pass and applying direction traversal count.
fn effective_cycle_beats(
    authored_pass_beats: f32,
    cycle_scale: &StepFxCycleScale,
    direction: &FxDirection,
) -> f32 {
    let pass_beats = match cycle_scale {
        StepFxCycleScale::Auto => authored_pass_beats,
        StepFxCycleScale::Fixed(beats) => *beats,
    };
    pass_beats * direction_pass_count(direction)
}

/// Timing shape shared by attribute and color steps.
trait TimedStep {
    /// Time from this step's start to the following step's start, in beats.
    fn width_beats(&self) -> f32;
    /// Window within the step during which the previous target blends into this one.
    fn transition(&self) -> &StepFxTransition;
    /// Curve shaping the blend inside the transition window.
    fn curve(&self) -> &CurveType;
}

impl TimedStep for FxStep {
    fn width_beats(&self) -> f32 {
        self.width_beats
    }

    fn transition(&self) -> &StepFxTransition {
        &self.transition
    }

    fn curve(&self) -> &CurveType {
        &self.curve
    }
}

impl TimedStep for FxColorStep {
    fn width_beats(&self) -> f32 {
        self.width_beats
    }

    fn transition(&self) -> &StepFxTransition {
        &self.transition
    }

    fn curve(&self) -> &CurveType {
        &self.curve
    }
}

/// Sums the authored widths of a step sequence in beats.
fn authored_pass_beats(steps: &[impl TimedStep]) -> f32 {
    steps.iter().map(TimedStep::width_beats).sum()
}

/// Where one sampled instant falls within an authored step sequence.
#[derive(Clone, Copy, Debug, PartialEq)]
enum StepPosition {
    /// Holding one step's target, outside any transition window.
    At(usize),
    /// Blending from one step's target toward the next by a curved factor.
    Between {
        /// Step whose target is being left.
        from: usize,
        /// Step whose target is being approached.
        to: usize,
        /// Curved blend factor from `from` (0.0) to `to` (1.0).
        factor: f32,
    },
}

/// Shared playback context used to locate a sampled instant within a step sequence.
struct StepSampleContext<'a> {
    /// Beat timing applied to the sequence.
    timing: &'a StepFxTiming,
    /// Traversal direction shared by all lanes.
    direction: &'a FxDirection,
    /// Optional normalization of one authored pass.
    cycle_scale: &'a StepFxCycleScale,
    /// Effective elapsed playback time.
    elapsed: Duration,
    /// Authored normalized start position for this selection index.
    start_position: f32,
    /// Runtime-only continuity correction for this sequence.
    runtime_phase_offset: f32,
}

/// Locates a sampled instant using beat-native variable widths and wrap interpolation.
fn locate_step(steps: &[impl TimedStep], context: &StepSampleContext) -> Option<StepPosition> {
    if steps.is_empty() {
        return None;
    }
    if steps.len() == 1 {
        return Some(StepPosition::At(0));
    }
    let authored_pass_beats = authored_pass_beats(steps);
    let total_beats =
        effective_cycle_beats(authored_pass_beats, context.cycle_scale, context.direction);
    let cycle_seconds = context.timing.beat_duration.as_secs_f32() * total_beats;
    if !cycle_seconds.is_finite() || cycle_seconds <= 0.0 {
        return None;
    }
    let cycle_position = (context.elapsed.as_secs_f32() / cycle_seconds
        + start_cycle_position(context.start_position, context.direction)
        + context.runtime_phase_offset)
        .rem_euclid(1.0);
    let beat_position =
        authored_beat_position(cycle_position, authored_pass_beats, context.direction);
    if beat_position >= authored_pass_beats {
        return Some(StepPosition::At(steps.len() - 1));
    }
    let mut start = 0.0;
    let mut step_index = steps.len() - 1;
    for (index, step) in steps.iter().enumerate() {
        if beat_position < start + step.width_beats() {
            step_index = index;
            break;
        }
        start += step.width_beats();
    }
    let step = &steps[step_index];
    let width_beats = step.width_beats();
    let transition_start = width_beats * step.transition().start.as_f32().clamp(0.0, 1.0);
    let transition_end = width_beats * step.transition().end.as_f32().clamp(0.0, 1.0);
    let transition_beats = transition_end - transition_start;
    let segment_position = (beat_position - start).clamp(0.0, width_beats);
    let previous_index = step_index.checked_sub(1).unwrap_or(steps.len() - 1);
    if segment_position < transition_start {
        return Some(StepPosition::At(previous_index));
    }
    if transition_beats <= 0.0 || segment_position >= transition_end {
        return Some(StepPosition::At(step_index));
    }
    let factor = step
        .curve()
        .evaluate((segment_position - transition_start) / transition_beats);
    Some(StepPosition::Between {
        from: previous_index,
        to: step_index,
        factor,
    })
}

/// Returns the number of complete authored passes in one directional cycle.
fn direction_pass_count(direction: &FxDirection) -> f32 {
    match direction {
        FxDirection::Bounce => 2.0,
        FxDirection::Forward | FxDirection::Reverse => 1.0,
    }
}

/// Samples one track using beat-native variable widths and wrap interpolation.
fn sample_track(
    track: &FxTrack,
    timing: &StepFxTiming,
    direction: &FxDirection,
    cycle_scale: &StepFxCycleScale,
    elapsed: Duration,
    start_position: f32,
    runtime_phase_offset: f32,
    attribute: &Attribute,
    blueprints: Option<&DataProvider<Blueprint>>,
) -> Option<ParameterValue> {
    let context = StepSampleContext {
        timing,
        direction,
        cycle_scale,
        elapsed,
        start_position,
        runtime_phase_offset,
    };
    let target = |index: usize| resolved_step_target(&track.steps[index], attribute, blueprints);
    Some(match locate_step(&track.steps, &context)? {
        StepPosition::At(index) => target(index),
        StepPosition::Between { from, to, factor } => {
            interpolate_parameter_values(&target(from), &target(to), factor)
        }
    })
}

/// Samples the color lane for one start position.
fn sample_color_lane(
    lane: &FxColorLane,
    context: &StepSampleContext,
    blueprints: Option<&DataProvider<Blueprint>>,
) -> Option<ColorPathRgb> {
    let color = |index: usize| resolved_step_color(&lane.steps[index], blueprints);
    Some(match locate_step(&lane.steps, context)? {
        StepPosition::At(index) => color(index),
        StepPosition::Between { from, to, factor } => sample_color(
            lane.interpolation_space,
            lane.hue_direction,
            color(from),
            color(to),
            factor,
        ),
    })
}

/// Resolves one live Blueprint color, falling back to the step's last stored color.
fn resolved_step_color(
    step: &FxColorStep,
    blueprints: Option<&DataProvider<Blueprint>>,
) -> ColorPathRgb {
    step.blueprint_uid
        .and_then(|uid| blueprints.and_then(|provider| provider.get(uid).ok()))
        .and_then(|blueprint| blueprint_color(&blueprint))
        .unwrap_or(step.color)
}

/// Derives a normalized RGB color from a Blueprint's inline red/green/blue or cyan/magenta/yellow values.
///
/// Missing components of a partially specified set are treated as zero emitter output.
pub fn blueprint_color(blueprint: &Blueprint) -> Option<ColorPathRgb> {
    let component = |attribute: Attribute| match blueprint.values.get(&attribute) {
        Some(ValueSource::Inline(value)) => normalized_color_component(value),
        _ => None,
    };
    let rgb = [Attribute::Red, Attribute::Green, Attribute::Blue].map(component);
    if rgb.iter().any(Option::is_some) {
        let [red, green, blue] = rgb.map(|value| value.unwrap_or(0.0));
        return Some(ColorPathRgb { red, green, blue }.clamped());
    }
    let cmy = [Attribute::Cyan, Attribute::Magenta, Attribute::Yellow].map(component);
    if cmy.iter().any(Option::is_some) {
        let [cyan, magenta, yellow] = cmy.map(|value| value.unwrap_or(0.0));
        return Some(
            ColorPathRgb {
                red: 1.0 - cyan,
                green: 1.0 - magenta,
                blue: 1.0 - yellow,
            }
            .clamped(),
        );
    }
    None
}

/// Normalizes one absolute emitter value; raw values assume an 8-bit emitter range.
fn normalized_color_component(value: &ParameterValue) -> Option<f32> {
    match value {
        ParameterValue::AbsolutePercent { value } => Some(value.as_f32()),
        ParameterValue::Absolute { value } => Some(*value / 255.0),
        ParameterValue::Relative { .. } | ParameterValue::RelativePercent { .. } => None,
    }
}

/// Resolves one live Blueprint target, falling back to its last stored scalar value.
fn resolved_step_target(
    step: &FxStep,
    attribute: &Attribute,
    blueprints: Option<&DataProvider<Blueprint>>,
) -> ParameterValue {
    let Some(blueprint_uid) = step.blueprint_uid else {
        return step.target;
    };
    blueprints
        .and_then(|provider| provider.get(blueprint_uid).ok())
        .and_then(|blueprint| match blueprint.values.get(attribute) {
            Some(ValueSource::Inline(value)) => Some(*value),
            Some(ValueSource::Fanned { .. } | ValueSource::Release | ValueSource::HoldPosition)
            | None => None,
        })
        .unwrap_or(step.target)
}

/// Converts one authored start position into the complete directional cycle.
fn start_cycle_position(start_position: f32, direction: &FxDirection) -> f32 {
    (start_position / direction_pass_count(direction)).rem_euclid(1.0)
}

/// Maps one normalized playback cycle onto the fixed forward-authored track shape.
fn authored_beat_position(
    cycle_position: f32,
    authored_pass_beats: f32,
    direction: &FxDirection,
) -> f32 {
    match direction {
        FxDirection::Forward => cycle_position * authored_pass_beats,
        FxDirection::Reverse => (1.0 - cycle_position) * authored_pass_beats,
        FxDirection::Bounce => {
            let traversal = cycle_position * 2.0;
            if traversal <= 1.0 {
                traversal * authored_pass_beats
            } else {
                (2.0 - traversal) * authored_pass_beats
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies discovery and remapping cover both contributions without rewriting direct targets or unmapped identities.
    #[test]
    fn blueprint_references_cover_both_contributions() {
        let original = Uuid::from_u128(1);
        let replacement = Uuid::from_u128(2);
        let unmapped = Uuid::from_u128(3);
        let mut referenced = step(25.0, 1.0, 0.0);
        referenced.blueprint_uid = Some(original);
        let mut other = step(50.0, 1.0, 0.0);
        other.blueprint_uid = Some(unmapped);
        let mut fx = test_fx(FxTrack {
            steps: vec![referenced.clone(), step(75.0, 1.0, 0.0)],
        });
        fx.lanes[0].relative = Some(FxTrack {
            steps: vec![referenced, other],
        });
        assert_eq!(
            fx.blueprint_references().collect::<Vec<_>>(),
            vec![
                (original, "Intensity".to_owned()),
                (original, "Intensity".to_owned()),
                (unmapped, "Intensity".to_owned()),
            ]
        );
        let before = fx.clone();
        fx.remap_blueprint_references(&HashMap::from([(original, replacement)]));
        assert_eq!(
            fx.blueprint_references()
                .map(|(uid, _)| uid)
                .collect::<Vec<_>>(),
            vec![replacement, replacement, unmapped]
        );
        fx.remap_blueprint_references(&HashMap::from([(replacement, original)]));
        assert_eq!(fx, before);
    }

    /// Builds a valid intensity Step FX around the supplied track.
    fn test_fx(track: FxTrack) -> StepFx {
        StepFx {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "Test chase".into(),
            },
            selection: SelectionExpr::default().into(),
            timing: StepFxTiming {
                beat_duration: Duration::from_secs(1),
            },
            phase: StepFxPhase::default(),
            direction: FxDirection::Forward,
            cycle_scale: StepFxCycleScale::Auto,
            lanes: vec![FxLane {
                attribute: Attribute::Intensity,
                timing_override: None,
                phase_override: None,
                absolute: Some(track),
                relative: None,
            }],
            color: None,
        }
    }

    /// Builds one absolute percentage step.
    fn step(value: f32, width_beats: f32, transition: f32) -> FxStep {
        FxStep::new(
            ParameterValue::AbsolutePercent {
                value: value.into(),
            },
            width_beats,
            transition.into(),
            CurveType::Linear(Linear {}),
        )
    }

    /// Builds one relative percentage step.
    fn relative_step(offset: f32, width_beats: f32) -> FxStep {
        FxStep::new(
            ParameterValue::RelativePercent {
                offset: offset.into(),
            },
            width_beats,
            0.0.into(),
            CurveType::Linear(Linear {}),
        )
    }

    /// Reads the sampled intensity absolute percentage.
    fn sampled(fx: &StepFx, seconds: f32) -> f32 {
        sampled_at_start_position(fx, seconds, 0.0)
    }

    /// Reads one intensity sample at an explicit authored start position.
    fn sampled_at_start_position(fx: &StepFx, seconds: f32, start_position: f32) -> f32 {
        let sample = fx.sample_with_phase_offset(Duration::from_secs_f32(seconds), start_position);
        match sample[0].absolute.unwrap() {
            ParameterValue::AbsolutePercent { value } => value.as_f32(),
            value => panic!("expected absolute percentage, got {value:?}"),
        }
    }

    /// Verifies named Bézier presets produce distinct operator-facing timing shapes.
    #[test]
    fn bezier_presets_have_distinct_midpoints() {
        let ease = Bezier::EASE.evaluate(0.5);
        let ease_in = Bezier::EASE_IN.evaluate(0.5);
        let ease_out = Bezier::EASE_OUT.evaluate(0.5);

        assert!((ease - 0.5).abs() < 1e-5);
        assert!(ease_in < ease);
        assert!(ease_out > ease);
    }

    /// Verifies Step FX evaluates both horizontal Bézier control points.
    #[test]
    fn bezier_horizontal_controls_affect_output() {
        let linear = Bezier {
            cp1: Point2D { x: 0.0, y: 0.0 },
            cp2: Point2D { x: 1.0, y: 1.0 },
        };
        let delayed = Bezier {
            cp1: Point2D { x: 0.8, y: 0.0 },
            cp2: Point2D { x: 1.0, y: 1.0 },
        };

        assert!((linear.evaluate(0.5) - delayed.evaluate(0.5)).abs() > 0.1);
    }

    /// Verifies all supported operator speed formats map to one duration per beat.
    #[test]
    fn speed_units_share_canonical_beat_duration() {
        let expected = Duration::from_millis(500);
        assert_eq!(
            StepFxTiming::from_bpm(120.0).unwrap().beat_duration,
            expected
        );
        assert_eq!(StepFxTiming::from_hz(2.0).unwrap().beat_duration, expected);
        assert_eq!(
            StepFxTiming::from_seconds(0.5).unwrap().beat_duration,
            expected
        );
        assert_eq!(
            StepFxTiming::from_milliseconds(500.0)
                .unwrap()
                .beat_duration,
            expected
        );
    }

    /// Verifies continuity has a representative cycle when every lane overrides timing.
    #[test]
    fn cycle_duration_falls_back_to_lane_override_timing() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 0.0), step(0.0, 1.0, 0.0)],
        });
        fx.lanes[0].timing_override = Some(StepFxTiming::from_bpm(60.0).unwrap());

        assert_eq!(fx.cycle_duration(), Some(Duration::from_secs(2)));
    }

    /// Verifies fixed scaling controls one pass and bounce adds an equal return pass.
    #[test]
    fn fixed_cycle_scaling_preserves_authored_widths() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 0.0), step(0.0, 3.0, 0.0)],
        });
        fx.direction = FxDirection::Bounce;
        fx.cycle_scale = StepFxCycleScale::Fixed(6.0);

        assert_eq!(fx.cycle_duration(), Some(Duration::from_secs(12)));
        assert_eq!(
            fx.lanes[0].absolute.as_ref().unwrap().authored_pass_beats(),
            4.0
        );
        assert!((sampled(&fx, 1.5) - 0.0).abs() < 0.001);
    }

    /// Verifies Auto follows each track's widths while Fixed normalizes both tracks.
    #[test]
    fn cycle_scaling_resolves_each_track_independently() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 0.0), step(0.0, 1.0, 0.0)],
        });
        fx.lanes[0].relative = Some(FxTrack {
            steps: vec![relative_step(0.5, 1.0), relative_step(-0.5, 3.0)],
        });

        assert_eq!(
            fx.lane_cycle_durations(&Attribute::Intensity),
            (Some(Duration::from_secs(2)), Some(Duration::from_secs(4)))
        );

        fx.cycle_scale = StepFxCycleScale::Fixed(6.0);
        assert_eq!(
            fx.lane_cycle_durations(&Attribute::Intensity),
            (Some(Duration::from_secs(6)), Some(Duration::from_secs(6)))
        );
    }

    /// Verifies transition time is followed by hold time within a variable-width step.
    #[test]
    fn transition_fraction_leaves_hold_time() {
        let fx = test_fx(FxTrack {
            steps: vec![step(1.0, 2.0, 0.5), step(0.0, 2.0, 0.0)],
        });
        assert!((sampled(&fx, 0.5) - 0.5).abs() < 0.001);
        assert!((sampled(&fx, 1.5) - 1.0).abs() < 0.001);
    }

    /// Verifies an explicit transition start holds the incoming target before interpolation.
    #[test]
    fn transition_window_holds_before_and_after_interpolation() {
        let mut first = step(1.0, 2.0, 1.0);
        first.transition = StepFxTransition::new(0.25.into(), 0.75.into());
        let fx = test_fx(FxTrack {
            steps: vec![first, step(0.0, 2.0, 0.0)],
        });

        assert!((sampled(&fx, 0.25) - 0.0).abs() < 0.001);
        assert!((sampled(&fx, 1.0) - 0.5).abs() < 0.001);
        assert!((sampled(&fx, 1.75) - 1.0).abs() < 0.001);
    }

    /// Verifies interpolation wraps from the final target into the first target.
    #[test]
    fn forward_sampling_interpolates_across_cycle_wrap() {
        let fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 1.0), step(0.0, 1.0, 1.0)],
        });
        assert!((sampled(&fx, 0.5) - 0.5).abs() < 0.001);
    }

    /// Verifies reverse traversal uses reversed authored order and widths.
    #[test]
    fn reverse_sampling_traverses_authored_steps_backwards() {
        let mut fx = test_fx(FxTrack {
            steps: vec![
                step(0.0, 1.0, 0.0),
                step(0.5, 1.0, 0.0),
                step(1.0, 1.0, 0.0),
            ],
        });
        fx.direction = FxDirection::Reverse;
        assert!((sampled(&fx, 0.1) - 1.0).abs() < 0.001);
        assert!((sampled(&fx, 1.1) - 0.5).abs() < 0.001);
        assert!((sampled(&fx, 2.1) - 0.0).abs() < 0.001);
    }

    /// Verifies reverse is a backwards transport over the forward-authored transition shape.
    #[test]
    fn reverse_sampling_retraces_authored_linear_transitions() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(0.0, 1.0, 1.0), step(1.0, 1.0, 1.0)],
        });
        fx.direction = FxDirection::Reverse;

        assert!((sampled(&fx, 0.5) - 0.5).abs() < 0.001);
        assert!((sampled(&fx, 1.5) - 0.5).abs() < 0.001);
    }

    /// Verifies bounce retraces authored steps without duplicating the endpoints.
    #[test]
    fn bounce_sampling_retraces_authored_steps() {
        let mut fx = test_fx(FxTrack {
            steps: vec![
                step(0.0, 1.0, 0.0),
                step(0.5, 1.0, 0.0),
                step(1.0, 1.0, 0.0),
            ],
        });
        fx.direction = FxDirection::Bounce;
        let values = [0.2, 1.2, 2.2, 4.2, 5.8].map(|seconds| sampled(&fx, seconds));
        assert_eq!(values, [0.0, 0.5, 1.0, 0.5, 0.0]);
    }

    /// Verifies Bounce starts at the same authored location as Forward before retracing it.
    #[test]
    fn bounce_start_position_matches_forward() {
        let track = FxTrack {
            steps: vec![
                step(0.0, 1.0, 0.0),
                step(0.25, 1.0, 0.0),
                step(0.5, 1.0, 0.0),
                step(0.75, 1.0, 0.0),
            ],
        };
        let forward = test_fx(track.clone());
        let mut bounce = test_fx(track.clone());
        bounce.direction = FxDirection::Bounce;
        let mut reverse = test_fx(track);
        reverse.direction = FxDirection::Reverse;

        assert_eq!(sampled_at_start_position(&forward, 0.0, 0.25), 0.25);
        assert_eq!(sampled_at_start_position(&bounce, 0.0, 0.25), 0.25);
        assert_eq!(sampled_at_start_position(&reverse, 0.0, 0.25), 0.75);
    }

    /// Verifies bounce keeps interior authored widths instead of normalizing the traversal.
    #[test]
    fn bounce_sampling_preserves_variable_authored_widths() {
        let mut fx = test_fx(FxTrack {
            steps: vec![
                step(0.0, 1.0, 0.0),
                step(0.5, 2.0, 0.0),
                step(1.0, 3.0, 0.0),
            ],
        });
        fx.direction = FxDirection::Bounce;

        let values = [0.4, 1.4, 2.4, 3.4].map(|seconds| sampled(&fx, seconds));
        assert_eq!(values, [0.0, 0.5, 0.5, 1.0]);
    }

    /// Verifies the bounce return pass retraces the same authored linear shape.
    #[test]
    fn bounce_sampling_retraces_authored_linear_transitions() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(0.0, 1.0, 1.0), step(1.0, 1.0, 1.0)],
        });
        fx.direction = FxDirection::Bounce;

        assert!((sampled(&fx, 0.5) - 0.5).abs() < 0.001);
        assert!((sampled(&fx, 3.5) - 0.5).abs() < 0.001);
    }

    /// Verifies bounce cycle length is twice the width sum regardless of step count.
    #[test]
    fn bounce_cycle_duration_is_independent_of_step_count() {
        let mut two_steps = test_fx(FxTrack {
            steps: vec![step(0.0, 1.0, 0.0), step(1.0, 1.0, 0.0)],
        });
        two_steps.direction = FxDirection::Bounce;
        let mut three_steps = test_fx(FxTrack {
            steps: vec![
                step(0.0, 0.5, 0.0),
                step(0.5, 0.5, 0.0),
                step(1.0, 1.0, 0.0),
            ],
        });
        three_steps.direction = FxDirection::Bounce;

        assert_eq!(two_steps.cycle_duration(), Some(Duration::from_secs(4)));
        assert_eq!(three_steps.cycle_duration(), Some(Duration::from_secs(4)));
    }

    /// Verifies half-open phase envelopes preserve scalar and multi-waypoint intent.
    #[test]
    fn phase_distribution_uses_resolved_indexes_and_exclusive_waypoints() {
        let default_phase = StepFxPhase::default();
        assert_eq!(
            calculate_phase_distribution(&default_phase, 2),
            vec![0.0, 0.5]
        );
        let offset = StepFxPhase {
            waypoints: vec![0.25, 1.25],
            ..Default::default()
        };
        assert_eq!(
            calculate_phase_distribution(&offset, 4),
            vec![0.25, 0.5, 0.75, 1.0]
        );
        let scalar = StepFxPhase {
            waypoints: vec![0.5],
            ..Default::default()
        };
        assert_eq!(
            calculate_phase_distribution(&scalar, 4),
            vec![0.5, 0.5, 0.5, 0.5]
        );
        let mirrored = StepFxPhase {
            waypoints: vec![0.0, 1.0, 0.0],
            ..Default::default()
        };
        assert_eq!(
            calculate_phase_distribution(&mirrored, 8),
            vec![0.0, 0.25, 0.5, 0.75, 1.0, 0.75, 0.5, 0.25]
        );
        let grouped = StepFxPhase {
            waypoints: vec![0.0, 1.0],
            groups: PhaseGroups::Explicit(2),
        };
        assert_eq!(
            calculate_phase_distribution(&grouped, 4),
            vec![0.0, 0.0, 0.5, 0.5]
        );
    }

    /// Verifies absolute and relative tracks for one lane are emitted independently.
    #[test]
    fn lane_samples_absolute_and_relative_tracks_together() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 0.0), step(0.0, 1.0, 0.0)],
        });
        fx.lanes[0].relative = Some(FxTrack {
            steps: vec![
                FxStep::new(
                    ParameterValue::RelativePercent { offset: 0.2.into() },
                    1.0,
                    0.0.into(),
                    CurveType::Snap(Snap {}),
                ),
                FxStep::new(
                    ParameterValue::RelativePercent {
                        offset: (-0.2).into(),
                    },
                    1.0,
                    0.0.into(),
                    CurveType::Snap(Snap {}),
                ),
            ],
        });
        let sample = fx.sample_with_phase_offset(Duration::ZERO, 0.0);
        assert!(matches!(
            sample[0].absolute,
            Some(ParameterValue::AbsolutePercent { .. })
        ));
        assert!(matches!(
            sample[0].relative,
            Some(ParameterValue::RelativePercent { .. })
        ));
    }

    /// Keeps payload-free curves aligned with the object shape generated for TypeScript.
    #[test]
    fn payload_free_curves_round_trip_with_empty_object_data() {
        let serialized = serde_json::to_value(CurveType::Snap(Snap {})).unwrap();
        assert_eq!(
            serialized,
            serde_json::json!({ "type": "Snap", "data": {} })
        );
        assert_eq!(
            serde_json::from_value::<CurveType>(serialized).unwrap(),
            CurveType::Snap(Snap {})
        );
    }

    /// Verifies automatic and fixed scaling permit independent authored track lengths.
    #[test]
    fn validation_allows_independent_track_lengths() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 0.0), step(0.0, 1.0, 0.0)],
        });
        fx.lanes.push(FxLane {
            attribute: Attribute::Red,
            timing_override: None,
            phase_override: None,
            absolute: Some(FxTrack {
                steps: vec![step(1.0, 1.0, 0.0)],
            }),
            relative: None,
        });
        assert!(fx.validate().is_empty());

        fx.cycle_scale = StepFxCycleScale::Fixed(4.0);
        assert!(fx.validate().is_empty());
    }

    /// Verifies empty and non-finite authored phase envelopes are rejected precisely.
    #[test]
    fn validation_localizes_phase_waypoint_errors() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 0.0)],
        });
        fx.phase.waypoints.clear();
        let empty_issues = fx.validate();
        assert!(empty_issues.iter().any(|issue| {
            issue.path == "phase.waypoints" && issue.message.contains("at least one")
        }));

        fx.phase.waypoints = vec![0.0, f32::NAN];
        let non_finite_issues = fx.validate();
        assert!(non_finite_issues.iter().any(|issue| {
            issue.path == "phase.waypoints.1" && issue.message.contains("finite")
        }));
    }

    /// Verifies fixed cycle scaling rejects non-positive and non-finite targets.
    #[test]
    fn validation_localizes_fixed_cycle_scale_errors() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 0.0), step(0.0, 1.0, 0.0)],
        });
        fx.cycle_scale = StepFxCycleScale::Fixed(0.0);
        assert!(fx.validate().iter().any(|issue| {
            issue.path == "cycle_scale.data" && issue.message.contains("greater than zero")
        }));

        fx.cycle_scale = StepFxCycleScale::Fixed(f32::NAN);
        assert!(
            fx.validate()
                .iter()
                .any(|issue| issue.path == "cycle_scale.data")
        );
    }

    /// Verifies validation rejects transition windows whose start follows their end.
    #[test]
    fn validation_localizes_reversed_transition_windows() {
        let mut fx = test_fx(FxTrack {
            steps: vec![step(1.0, 1.0, 1.0), step(0.0, 1.0, 1.0)],
        });
        fx.lanes[0].absolute.as_mut().unwrap().steps[0].transition =
            StepFxTransition::new(0.75.into(), 0.25.into());

        assert!(fx.validate().iter().any(|issue| {
            issue.path == "lanes.0.absolute.steps.0.transition"
                && issue.message.contains("must not exceed")
        }));
    }

    /// Builds a color step that fades linearly across its whole width.
    fn color_step(red: f32, green: f32, blue: f32) -> FxColorStep {
        FxColorStep::new(
            ColorPathRgb { red, green, blue },
            1.0,
            1.0.into(),
            CurveType::Linear(Linear {}),
        )
    }

    /// Builds a valid color-only Step FX interpolating in the requested space.
    fn color_fx(space: ColorInterpolationSpace, steps: Vec<FxColorStep>) -> StepFx {
        let mut fx = test_fx(FxTrack { steps: Vec::new() });
        fx.lanes.clear();
        fx.color = Some(FxColorLane {
            interpolation_space: space,
            hue_direction: HueDirection::Shortest,
            timing_override: None,
            phase_override: None,
            steps,
        });
        fx
    }

    /// Verifies RGB color lanes fade each component linearly between consecutive steps.
    #[test]
    fn color_lane_fades_between_steps_in_rgb() {
        let fx = color_fx(
            ColorInterpolationSpace::Rgb,
            vec![color_step(1.0, 0.0, 0.0), color_step(0.0, 0.0, 1.0)],
        );

        let at_second_step_midpoint = fx
            .sample_color_with_phase_offset(Duration::from_millis(1500), 0.0)
            .unwrap();

        assert_eq!(
            at_second_step_midpoint,
            ColorPathRgb {
                red: 0.5,
                green: 0.0,
                blue: 0.5,
            }
        );
    }

    /// Verifies HSV color lanes route the fade around the hue circle instead of through gray.
    #[test]
    fn color_lane_fades_through_hue_in_hsv() {
        let fx = color_fx(
            ColorInterpolationSpace::Hsv,
            vec![color_step(1.0, 0.0, 0.0), color_step(0.0, 1.0, 0.0)],
        );

        let midpoint = fx
            .sample_color_with_phase_offset(Duration::from_millis(1500), 0.0)
            .unwrap();

        assert!((midpoint.red - 1.0).abs() < 1e-5, "{midpoint:?}");
        assert!((midpoint.green - 1.0).abs() < 1e-5, "{midpoint:?}");
        assert!(midpoint.blue.abs() < 1e-5, "{midpoint:?}");
    }

    /// Verifies a color-only definition is valid and contributes the cycle duration.
    #[test]
    fn color_only_definition_validates_and_reports_cycle() {
        let fx = color_fx(
            ColorInterpolationSpace::Rgb,
            vec![color_step(1.0, 0.0, 0.0), color_step(0.0, 0.0, 1.0)],
        );

        assert_eq!(fx.validate(), Vec::new());
        assert_eq!(fx.cycle_duration(), Some(Duration::from_secs(2)));
    }

    /// Verifies color validation localizes out-of-range components and empty color lanes.
    #[test]
    fn color_validation_localizes_component_and_empty_lane_errors() {
        let fx = color_fx(
            ColorInterpolationSpace::Rgb,
            vec![color_step(1.5, 0.0, 0.0), color_step(0.0, 0.0, 1.0)],
        );
        assert!(
            fx.validate()
                .iter()
                .any(|issue| issue.path == "color.steps.0.color.red")
        );

        let empty = color_fx(ColorInterpolationSpace::Rgb, Vec::new());
        assert!(
            empty
                .validate()
                .iter()
                .any(|issue| issue.path == "color.steps")
        );
    }

    /// Verifies Blueprint colors resolve from RGB or CMY values and ignore colorless Blueprints.
    #[test]
    fn blueprint_color_reads_rgb_or_cmy_values() {
        let mut rgb = Blueprint::default();
        rgb.values.insert(
            Attribute::Red,
            ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
        );
        rgb.values.insert(
            Attribute::Blue,
            ValueSource::Inline(ParameterValue::Absolute { value: 127.5 }),
        );
        assert_eq!(
            blueprint_color(&rgb),
            Some(ColorPathRgb {
                red: 1.0,
                green: 0.0,
                blue: 0.5,
            })
        );

        let mut cmy = Blueprint::default();
        cmy.values.insert(
            Attribute::Cyan,
            ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
        );
        assert_eq!(
            blueprint_color(&cmy),
            Some(ColorPathRgb {
                red: 0.0,
                green: 1.0,
                blue: 1.0,
            })
        );

        let mut intensity = Blueprint::default();
        intensity.values.insert(
            Attribute::Intensity,
            ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
        );
        assert_eq!(blueprint_color(&intensity), None);
    }

    /// Verifies color steps participate in Blueprint reference discovery and remapping.
    #[test]
    fn blueprint_references_cover_color_steps() {
        let original = Uuid::from_u128(1);
        let replacement = Uuid::from_u128(2);
        let mut referenced = color_step(1.0, 0.0, 0.0);
        referenced.blueprint_uid = Some(original);
        let mut fx = color_fx(
            ColorInterpolationSpace::Rgb,
            vec![referenced, color_step(0.0, 0.0, 1.0)],
        );

        assert_eq!(
            fx.blueprint_references().collect::<Vec<_>>(),
            vec![(original, COLOR_LANE_NAME.to_owned())]
        );
        fx.remap_blueprint_references(&HashMap::from([(original, replacement)]));
        assert_eq!(
            fx.color.as_ref().unwrap().steps[0].blueprint_uid,
            Some(replacement)
        );
    }

    /// Verifies Blueprint references travel as compact strings and absent ones are omitted.
    #[test]
    fn color_step_blueprint_reference_serializes_as_simple_string() {
        let uid = Uuid::from_u128(0xc0104000000000000000000000000001);
        let mut referenced = color_step(0.0, 1.0, 0.0);
        referenced.blueprint_uid = Some(uid);

        let value = serde_json::to_value(&referenced).unwrap();
        assert_eq!(
            value["blueprint_uid"],
            serde_json::json!("c0104000000000000000000000000001")
        );
        let restored: FxColorStep = serde_json::from_value(value).unwrap();
        assert_eq!(restored.blueprint_uid, Some(uid));

        let unreferenced = serde_json::to_value(color_step(0.0, 0.0, 1.0)).unwrap();
        assert!(unreferenced.get("blueprint_uid").is_none());
        let restored: FxColorStep = serde_json::from_value(unreferenced).unwrap();
        assert_eq!(restored.blueprint_uid, None);
    }
}
