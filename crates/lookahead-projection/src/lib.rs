// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Pure lookahead projection for authored sequence editor previews.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use nightfall::prelude::{
    cue_authored_duration, sequence_timing_summary, CueTriggerType, FixtureRef, PartialTransition,
    SequenceStepTiming, Transition, ValueSource,
};
use nightfall_dmx::prelude::ParameterValue;
use serde::{Deserialize, Serialize};

/// Request for projecting authored lookahead values from one sequence row.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct SequenceLookaheadProjectionRequest {
    /// Numeric ID of the sequence being projected.
    pub sequence_id: u32,
    /// Whether downstream scanning wraps at the end of the sequence.
    #[serde(default)]
    pub wrap: bool,
    /// Cue UID for the row whose lookahead values should be displayed.
    pub target_cue_uid: String,
    /// Setup cue instructions that track into all normal sequence cues.
    #[serde(default)]
    pub setup_instructions: Vec<ProjectionInstruction>,
    /// Ordered cue rows in the sequence.
    pub cues: Vec<ProjectionCue>,
}

/// Cue data needed by the pure lookahead projector.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ProjectionCue {
    /// Cue definition UID.
    pub cue_uid: String,
    /// Operator-facing cue ID.
    pub cue_id: u32,
    /// Whether the top-level cue part owns lookahead values.
    #[serde(default)]
    pub lookahead: bool,
    /// Top-level cue instructions.
    #[serde(default)]
    pub instructions: Vec<ProjectionInstruction>,
    /// Nested cue parts that fire with the top-level cue.
    #[serde(default)]
    pub parts: Vec<ProjectionCuePart>,
}

/// Cue-part data needed by the pure lookahead projector.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ProjectionCuePart {
    /// Part ID scoped to the parent cue.
    pub part_id: u32,
    /// Whether this part owns lookahead values.
    #[serde(default)]
    pub lookahead: bool,
    /// Part instructions.
    #[serde(default)]
    pub instructions: Vec<ProjectionInstruction>,
}

/// One cue instruction with its selection already resolved by the caller.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ProjectionInstruction {
    /// Fixture refs selected by this instruction in resolved selection order.
    #[serde(default)]
    pub fixtures: Vec<FixtureRef>,
    /// Attribute values authored by this instruction.
    #[serde(default)]
    pub values: HashMap<String, ValueSource>,
}

/// One projected authored lookahead value.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ProjectedLookaheadValue {
    /// Fixture or fixture element receiving the projected value.
    pub fixture: FixtureRef,
    /// Normalized attribute name for the projected value.
    pub attribute: String,
    /// Absolute value supplied by lookahead.
    pub value: ParameterValue,
    /// Authored source that contributes the lookahead value.
    pub source: ProjectedLookaheadSource,
}

/// Source metadata for one projected authored lookahead value.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ProjectedLookaheadSource {
    /// Cue definition UID that owns the lookahead value.
    pub cue_uid: String,
    /// Operator-facing cue ID that owns the lookahead value.
    pub cue_id: u32,
    /// Numeric sequence ID containing the source cue.
    pub sequence_id: u32,
    /// Part ID for the source; zero addresses the top-level cue part.
    pub part_id: u32,
    /// Whether the source cue has nested parts.
    pub has_additional_parts: bool,
}

/// Backend-resolved duration profile fields needed by sequence summaries.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct SequenceDurationProfile {
    /// Longest resolved cue-entry transition span.
    pub max_transition_duration: Duration,
}

/// Nested cue-part timing needed to account for authored durations.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct SequenceDurationPart {
    /// Part-authored transitions that inherit cue timing.
    #[serde(default)]
    pub transitions: PartialTransition,
}

/// Cue timing data needed by the sequence duration summary.
#[derive(Clone, Debug, Deserialize)]
pub struct SequenceDurationStep {
    /// Stable cue definition UID used by the UI row model.
    pub cue_uid: String,
    /// Trigger policy on this cue step.
    pub trigger: CueTriggerType,
    /// Cue-level authored transitions.
    #[serde(default)]
    pub transitions: PartialTransition,
    /// Nested cue parts that fire with the cue.
    #[serde(default)]
    pub parts: Vec<SequenceDurationPart>,
    /// Backend-resolved fixture-aware duration profile for this cue definition.
    pub duration_profile: SequenceDurationProfile,
}

/// Request for computing sequence-view start and duration values.
#[derive(Clone, Debug, Deserialize)]
pub struct SequenceDurationSummaryRequest {
    /// Whether the sequence transitions from the last cue back to the first.
    #[serde(default)]
    pub wrap: bool,
    /// Sequence default timing inherited by cues without explicit timing.
    pub default_timing: Transition,
    /// Ordered cue steps to summarize.
    pub steps: Vec<SequenceDurationStep>,
}

/// Computed start and display duration for one cue row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SequenceDurationCueSummary {
    /// Stable cue definition UID used by the UI row model.
    pub cue_uid: String,
    /// Source-local cue start time, absent after manual timing makes it unknowable.
    pub start_time: Option<Duration>,
    /// Displayed retained assertion duration for this cue row, absent across manual boundaries.
    pub duration: Option<Duration>,
}

/// Computed duration summary for a sequence view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SequenceDurationSummary {
    /// Computed values for each cue step in request order.
    pub cues: Vec<SequenceDurationCueSummary>,
    /// Total sequence duration, absent when a manual boundary makes it unknowable.
    pub total: Option<Duration>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ProjectionKey {
    fixture: FixtureRef,
    attribute: String,
}

/// Projects authored lookahead values for a sequence row.
pub fn project_sequence_lookahead(
    request: &SequenceLookaheadProjectionRequest,
) -> Vec<ProjectedLookaheadValue> {
    let Some(target_index) = request
        .cues
        .iter()
        .position(|cue| cue.cue_uid == request.target_cue_uid)
    else {
        return Vec::new();
    };

    let mut tracked_values = TrackedValues::default();
    for instruction in &request.setup_instructions {
        track_instruction_values(&mut tracked_values, instruction);
    }
    for cue in request.cues.iter().take(target_index) {
        track_cue_values(&mut tracked_values, cue);
    }
    track_cue_values(&mut tracked_values, &request.cues[target_index]);

    let mut projected = Vec::new();
    let mut inserted_keys = HashSet::new();
    let mut blocked_fixture_uids = HashSet::new();

    for cue_index in downstream_cue_indices(request.cues.len(), target_index, request.wrap) {
        let cue = &request.cues[cue_index];
        let source_base = ProjectedLookaheadSource {
            cue_uid: cue.cue_uid.clone(),
            cue_id: cue.cue_id,
            sequence_id: request.sequence_id,
            part_id: 0,
            has_additional_parts: !cue.parts.is_empty(),
        };

        if cue.lookahead {
            collect_instruction_lookahead_values(
                &mut projected,
                &mut inserted_keys,
                &tracked_values,
                &blocked_fixture_uids,
                &cue.instructions,
                &source_base,
            );
        }
        for part in &cue.parts {
            if !part.lookahead {
                continue;
            }
            let source = ProjectedLookaheadSource {
                part_id: part.part_id,
                ..source_base.clone()
            };
            collect_instruction_lookahead_values(
                &mut projected,
                &mut inserted_keys,
                &tracked_values,
                &blocked_fixture_uids,
                &part.instructions,
                &source,
            );
        }

        record_visible_cue_fixtures(&mut blocked_fixture_uids, cue);
    }

    projected
}

/// Computes sequence-view cue start offsets, displayed durations, and total duration.
pub fn sequence_duration_summary(
    request: &SequenceDurationSummaryRequest,
) -> SequenceDurationSummary {
    let step_timings = request
        .steps
        .iter()
        .map(|step| SequenceStepTiming {
            trigger: step.trigger,
            assertion_duration: step
                .duration_profile
                .max_transition_duration
                .max(step.authored_duration(&request.default_timing)),
        })
        .collect::<Vec<_>>();
    let timing_summary = sequence_timing_summary(&step_timings, request.wrap);

    SequenceDurationSummary {
        cues: request
            .steps
            .iter()
            .zip(timing_summary.steps)
            .map(|(step, timing)| SequenceDurationCueSummary {
                cue_uid: step.cue_uid.clone(),
                start_time: timing.start_time,
                duration: timing.duration,
            })
            .collect(),
        total: timing_summary.total,
    }
}

/// Returns downstream cue indices in nearest-first order.
fn downstream_cue_indices(cue_count: usize, target_index: usize, wrap: bool) -> Vec<usize> {
    if cue_count == 0 {
        return Vec::new();
    }
    let mut indices = ((target_index + 1)..cue_count).collect::<Vec<_>>();
    if wrap {
        indices.extend(0..target_index);
    }
    indices
}

impl SequenceDurationStep {
    /// Returns the fixture-aware or authored assertion duration for this cue step.
    fn authored_duration(&self, default_timing: &Transition) -> Duration {
        let cue_transition = self.transitions.with_default_timing(default_timing);
        cue_authored_duration(
            &cue_transition,
            self.parts.iter().map(|part| &part.transitions),
        )
    }
}

/// Applies all cue and part instructions to tracked values.
fn track_cue_values(tracked_values: &mut TrackedValues, cue: &ProjectionCue) {
    for instruction in &cue.instructions {
        track_instruction_values(tracked_values, instruction);
    }
    for part in &cue.parts {
        for instruction in &part.instructions {
            track_instruction_values(tracked_values, instruction);
        }
    }
}

/// Applies one instruction to tracked values.
fn track_instruction_values(
    tracked_values: &mut TrackedValues,
    instruction: &ProjectionInstruction,
) {
    for (selection_index, fixture) in instruction.fixtures.iter().enumerate() {
        for (attribute, source) in &instruction.values {
            let attribute = normalize_attribute_name(attribute);
            let key = ProjectionKey {
                fixture: fixture.clone(),
                attribute,
            };
            match source {
                ValueSource::Inline(value) => {
                    tracked_values.insert_value(key, *value);
                }
                ValueSource::Fanned { values } => {
                    let value =
                        resolve_fanned_value(values, selection_index, instruction.fixtures.len());
                    tracked_values.insert_value(key, value);
                }
                ValueSource::Release => {
                    tracked_values.release_value(key);
                }
                ValueSource::HoldPosition => {}
            }
        }
    }
}

/// Collects lookahead values from source instructions.
fn collect_instruction_lookahead_values(
    projected: &mut Vec<ProjectedLookaheadValue>,
    inserted_keys: &mut HashSet<ProjectionKey>,
    tracked_values: &TrackedValues,
    blocked_fixture_uids: &HashSet<String>,
    instructions: &[ProjectionInstruction],
    source: &ProjectedLookaheadSource,
) {
    for instruction in instructions {
        for (selection_index, fixture) in instruction.fixtures.iter().enumerate() {
            if blocked_fixture_uids.contains(&fixture.fixture_uid.to_string())
                || !tracked_values.fixture_is_dark(fixture)
            {
                continue;
            }

            for (attribute, value_source) in &instruction.values {
                let attribute = normalize_attribute_name(attribute);
                if !is_position_attribute(&attribute) {
                    continue;
                }
                let Some(value) =
                    value_for_source(value_source, selection_index, instruction.fixtures.len())
                else {
                    continue;
                };
                if !is_absolute_value(&value) {
                    continue;
                }

                let key = ProjectionKey {
                    fixture: fixture.clone(),
                    attribute: attribute.clone(),
                };
                if !inserted_keys.insert(key) {
                    continue;
                }

                projected.push(ProjectedLookaheadValue {
                    fixture: fixture.clone(),
                    attribute,
                    value,
                    source: source.clone(),
                });
            }
        }
    }
}

/// Records fixtures that become visibly lit before later lookahead targets.
fn record_visible_cue_fixtures(blocked_fixture_uids: &mut HashSet<String>, cue: &ProjectionCue) {
    for instruction in &cue.instructions {
        record_visible_instruction_fixtures(blocked_fixture_uids, instruction);
    }
    for part in &cue.parts {
        for instruction in &part.instructions {
            record_visible_instruction_fixtures(blocked_fixture_uids, instruction);
        }
    }
}

/// Records fixtures made visible by one instruction.
fn record_visible_instruction_fixtures(
    blocked_fixture_uids: &mut HashSet<String>,
    instruction: &ProjectionInstruction,
) {
    for (selection_index, fixture) in instruction.fixtures.iter().enumerate() {
        for (attribute, value_source) in &instruction.values {
            let attribute = normalize_attribute_name(attribute);
            if !is_intensity_attribute(&attribute) {
                continue;
            }
            let Some(value) =
                value_for_source(value_source, selection_index, instruction.fixtures.len())
            else {
                continue;
            };
            if !absolute_value_is_zero_or_less(&value) {
                blocked_fixture_uids.insert(fixture.fixture_uid.to_string());
            }
        }
    }
}

/// Returns the concrete parameter value supplied by one value source.
fn value_for_source(
    source: &ValueSource,
    selection_index: usize,
    selection_size: usize,
) -> Option<ParameterValue> {
    match source {
        ValueSource::Inline(value) => Some(*value),
        ValueSource::Fanned { values } => Some(resolve_fanned_value(
            values,
            selection_index,
            selection_size,
        )),
        ValueSource::Release | ValueSource::HoldPosition => None,
    }
}

/// Resolves a fanned parameter value for a selection offset.
fn resolve_fanned_value(
    values: &[ParameterValue],
    fixture_index: usize,
    total_fixtures: usize,
) -> ParameterValue {
    if values.is_empty() {
        return ParameterValue::AbsolutePercent { value: 0.0.into() };
    }
    if values.len() == 1 || total_fixtures <= 1 {
        return values[0];
    }

    if values.len() == total_fixtures {
        return values[fixture_index];
    }

    let t = fixture_index as f32 / (total_fixtures - 1).max(1) as f32;
    let max_segment = values.len() - 1;
    let segment_position = t * max_segment as f32;
    let segment_idx = (segment_position as usize).min(max_segment - 1);
    let segment_t = segment_position - segment_idx as f32;
    interpolate_parameter_values(values[segment_idx], values[segment_idx + 1], segment_t)
}

/// Interpolates between two parameter values using materialized cue semantics.
fn interpolate_parameter_values(
    start: ParameterValue,
    end: ParameterValue,
    factor: f32,
) -> ParameterValue {
    match (start, end) {
        (
            ParameterValue::AbsolutePercent { value: start_value },
            ParameterValue::AbsolutePercent { value: end_value },
        ) => {
            let start = start_value.as_f32();
            let end = end_value.as_f32();
            ParameterValue::AbsolutePercent {
                value: (start + factor * (end - start)).into(),
            }
        }
        (
            ParameterValue::RelativePercent {
                offset: start_offset,
            },
            ParameterValue::RelativePercent { offset: end_offset },
        ) => {
            let start = start_offset.as_f32();
            let end = end_offset.as_f32();
            ParameterValue::RelativePercent {
                offset: (start + factor * (end - start)).into(),
            }
        }
        (
            ParameterValue::Absolute { value: start_value },
            ParameterValue::Absolute { value: end_value },
        ) => ParameterValue::Absolute {
            value: (start_value + factor * (end_value - start_value)).round(),
        },
        _ => start,
    }
}

/// Returns whether a value is an absolute assertion.
fn is_absolute_value(value: &ParameterValue) -> bool {
    matches!(
        value,
        ParameterValue::Absolute { .. } | ParameterValue::AbsolutePercent { .. }
    )
}

/// Returns whether an absolute/intensity value is numerically zero or lower.
fn absolute_value_is_zero_or_less(value: &ParameterValue) -> bool {
    match value {
        ParameterValue::Absolute { value } => *value <= 0.0,
        ParameterValue::AbsolutePercent { value } => value.as_f32() <= 0.0,
        ParameterValue::Relative { .. } | ParameterValue::RelativePercent { .. } => false,
    }
}

/// Returns whether an attribute can be moved by lookahead.
fn is_position_attribute(attribute: &str) -> bool {
    matches!(attribute, "Pan" | "Tilt")
}

/// Returns whether an attribute represents fixture intensity.
fn is_intensity_attribute(attribute: &str) -> bool {
    matches!(attribute, "Intensity" | "VirtualIntensity")
}

/// Normalizes attribute aliases used by the UI and engine.
fn normalize_attribute_name(attribute: &str) -> String {
    if attribute == "VirtualIntensity" {
        "Intensity".to_owned()
    } else {
        attribute.to_owned()
    }
}

#[derive(Default)]
struct TrackedValues {
    values: HashMap<ProjectionKey, Option<ParameterValue>>,
}

impl TrackedValues {
    /// Inserts a concrete tracked value, removing element values superseded by whole-fixture values.
    fn insert_value(&mut self, key: ProjectionKey, value: ParameterValue) {
        self.delete_element_values_for_whole_fixture(&key);
        self.values.insert(key, Some(value));
    }

    /// Releases a tracked value using whole-fixture and element-specific release semantics.
    fn release_value(&mut self, key: ProjectionKey) {
        self.delete_element_values_for_whole_fixture(&key);
        if key.fixture.index.is_none() {
            self.values.remove(&key);
        } else {
            self.values.insert(key, None);
        }
    }

    /// Returns whether tracked data indicates a fixture is dark.
    fn fixture_is_dark(&self, fixture: &FixtureRef) -> bool {
        let intensity_key = ProjectionKey {
            fixture: fixture.clone(),
            attribute: "Intensity".to_owned(),
        };
        let virtual_intensity_key = ProjectionKey {
            fixture: fixture.clone(),
            attribute: "VirtualIntensity".to_owned(),
        };
        let Some(value) = self
            .values
            .get(&intensity_key)
            .or_else(|| self.values.get(&virtual_intensity_key))
        else {
            return true;
        };
        let Some(value) = value else {
            return true;
        };
        absolute_value_is_zero_or_less(value)
    }

    /// Deletes element-scoped tracked values superseded by a whole-fixture write.
    fn delete_element_values_for_whole_fixture(&mut self, key: &ProjectionKey) {
        if key.fixture.index.is_some() {
            return;
        }
        self.values.retain(|candidate, _| {
            candidate.fixture.index.is_none()
                || candidate.fixture.fixture_uid != key.fixture.fixture_uid
                || candidate.attribute != key.attribute
        });
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nightfall::prelude::{FixtureRef, TransitionMode};
    use nightfall_dmx::prelude::ParameterValue;
    use uuid::Uuid;

    use super::*;

    /// Builds a whole-fixture reference with a stable generated UID.
    fn fixture(seed: u128) -> FixtureRef {
        FixtureRef {
            fixture_uid: Uuid::from_u128(seed),
            index: None,
        }
    }

    /// Builds an inline absolute value source.
    fn absolute(value: f32) -> ValueSource {
        ValueSource::Inline(ParameterValue::Absolute { value })
    }

    /// Builds an instruction for one fixture and one attribute value.
    fn instruction(
        fixture: FixtureRef,
        attribute: &str,
        source: ValueSource,
    ) -> ProjectionInstruction {
        ProjectionInstruction {
            fixtures: vec![fixture],
            values: HashMap::from([(attribute.to_owned(), source)]),
        }
    }

    /// Builds a simple projection cue.
    fn cue(id: u32, lookahead: bool, instructions: Vec<ProjectionInstruction>) -> ProjectionCue {
        ProjectionCue {
            cue_uid: format!("cue-{id}"),
            cue_id: id,
            lookahead,
            instructions,
            parts: Vec::new(),
        }
    }

    /// Builds default sequence timing with the requested fade-in duration.
    fn default_timing(fade_in: Duration) -> Transition {
        Transition {
            fade_in: TransitionMode::Fixed(fade_in),
            ..Default::default()
        }
    }

    /// Builds a duration summary step with only fields relevant to summary tests.
    fn duration_step(
        cue_uid: &str,
        trigger: CueTriggerType,
        cue_authored_duration: Duration,
        profile_duration: Duration,
    ) -> SequenceDurationStep {
        SequenceDurationStep {
            cue_uid: cue_uid.to_owned(),
            trigger,
            transitions: PartialTransition {
                fade_in: Some(TransitionMode::Fixed(cue_authored_duration)),
                ..Default::default()
            },
            parts: Vec::new(),
            duration_profile: SequenceDurationProfile {
                max_transition_duration: profile_duration,
            },
        }
    }

    /// Verifies sequence summaries keep retained cue duration when the next cue starts early.
    #[test]
    fn sequence_duration_summary_uses_profile_duration_for_retained_assertions() {
        let request = SequenceDurationSummaryRequest {
            wrap: true,
            default_timing: default_timing(Duration::ZERO),
            steps: vec![
                duration_step(
                    "cue-1",
                    CueTriggerType::AfterDelay(Duration::from_secs(2)),
                    Duration::ZERO,
                    Duration::from_secs(10),
                ),
                duration_step(
                    "cue-2",
                    CueTriggerType::AfterDelay(Duration::from_secs(5)),
                    Duration::ZERO,
                    Duration::from_secs(1),
                ),
                duration_step(
                    "cue-3",
                    CueTriggerType::AfterDelay(Duration::from_secs(7)),
                    Duration::ZERO,
                    Duration::from_secs(4),
                ),
            ],
        };

        let summary = sequence_duration_summary(&request);

        assert_eq!(
            summary
                .cues
                .iter()
                .map(|cue| (cue.cue_uid.as_str(), cue.start_time, cue.duration))
                .collect::<Vec<_>>(),
            vec![
                ("cue-1", Some(Duration::ZERO), Some(Duration::from_secs(10))),
                (
                    "cue-2",
                    Some(Duration::from_secs(5)),
                    Some(Duration::from_secs(7))
                ),
                (
                    "cue-3",
                    Some(Duration::from_secs(12)),
                    Some(Duration::from_secs(4))
                ),
            ],
        );
        assert_eq!(summary.total, Some(Duration::from_secs(16)));
    }

    /// Verifies sequence summaries include authored default timing when no profile value exists.
    #[test]
    fn sequence_duration_summary_uses_authored_default_timing() {
        let request = SequenceDurationSummaryRequest {
            wrap: false,
            default_timing: default_timing(Duration::from_millis(1500)),
            steps: vec![SequenceDurationStep {
                cue_uid: "cue-1".to_owned(),
                trigger: CueTriggerType::FollowPrevious,
                transitions: PartialTransition::default(),
                parts: Vec::new(),
                duration_profile: SequenceDurationProfile::default(),
            }],
        };

        let summary = sequence_duration_summary(&request);

        assert_eq!(summary.cues.len(), 1);
        assert_eq!(summary.cues[0].start_time, Some(Duration::ZERO));
        assert_eq!(summary.cues[0].duration, Some(Duration::from_millis(1500)));
        assert_eq!(summary.total, Some(Duration::from_millis(1500)));
    }

    /// Verifies sequence summaries stop claiming a total once manual timing is encountered.
    #[test]
    fn sequence_duration_summary_marks_manual_boundaries_unknown() {
        let request = SequenceDurationSummaryRequest {
            wrap: false,
            default_timing: default_timing(Duration::ZERO),
            steps: vec![
                duration_step(
                    "cue-1",
                    CueTriggerType::FollowPrevious,
                    Duration::ZERO,
                    Duration::from_secs(1),
                ),
                duration_step(
                    "cue-2",
                    CueTriggerType::Manual,
                    Duration::ZERO,
                    Duration::from_secs(1),
                ),
            ],
        };

        let summary = sequence_duration_summary(&request);

        assert_eq!(summary.cues[0].start_time, Some(Duration::ZERO));
        assert_eq!(summary.cues[0].duration, None);
        assert_eq!(summary.cues[1].start_time, None);
        assert_eq!(summary.cues[1].duration, Some(Duration::from_secs(1)));
        assert_eq!(summary.total, None);
    }

    /// Verifies cue-authored lookahead projects a downstream dark-fixture position.
    #[test]
    fn projects_downstream_position_for_dark_fixture() {
        let fixture = fixture(1);
        let request = SequenceLookaheadProjectionRequest {
            sequence_id: 9,
            wrap: false,
            target_cue_uid: "cue-1".to_owned(),
            setup_instructions: Vec::new(),
            cues: vec![
                cue(
                    1,
                    false,
                    vec![instruction(fixture.clone(), "Intensity", absolute(0.0))],
                ),
                cue(
                    2,
                    true,
                    vec![instruction(fixture.clone(), "Tilt", absolute(90.0))],
                ),
            ],
        };

        let values = project_sequence_lookahead(&request);

        assert_eq!(values.len(), 1);
        assert_eq!(values[0].fixture, fixture);
        assert_eq!(values[0].attribute, "Tilt");
        assert_eq!(values[0].source.cue_id, 2);
    }

    /// Verifies visible tracked intensity prevents lookahead projection.
    #[test]
    fn skips_projection_for_visible_fixture() {
        let fixture = fixture(2);
        let request = SequenceLookaheadProjectionRequest {
            sequence_id: 9,
            wrap: false,
            target_cue_uid: "cue-1".to_owned(),
            setup_instructions: Vec::new(),
            cues: vec![
                cue(
                    1,
                    false,
                    vec![instruction(fixture.clone(), "Intensity", absolute(255.0))],
                ),
                cue(2, true, vec![instruction(fixture, "Tilt", absolute(90.0))]),
            ],
        };

        assert!(project_sequence_lookahead(&request).is_empty());
    }

    /// Verifies intervening visible cues block farther lookahead sources.
    #[test]
    fn intervening_visible_cue_blocks_later_source() {
        let fixture = fixture(3);
        let request = SequenceLookaheadProjectionRequest {
            sequence_id: 9,
            wrap: false,
            target_cue_uid: "cue-1".to_owned(),
            setup_instructions: Vec::new(),
            cues: vec![
                cue(
                    1,
                    false,
                    vec![instruction(fixture.clone(), "Intensity", absolute(0.0))],
                ),
                cue(
                    2,
                    false,
                    vec![instruction(fixture.clone(), "Intensity", absolute(255.0))],
                ),
                cue(3, true, vec![instruction(fixture, "Tilt", absolute(90.0))]),
            ],
        };

        assert!(project_sequence_lookahead(&request).is_empty());
    }

    /// Verifies part-authored lookahead carries part source metadata.
    #[test]
    fn projects_part_source_metadata() {
        let fixture = fixture(4);
        let mut source_cue = cue(2, false, Vec::new());
        source_cue.parts.push(ProjectionCuePart {
            part_id: 7,
            lookahead: true,
            instructions: vec![instruction(fixture.clone(), "Pan", absolute(45.0))],
        });
        let request = SequenceLookaheadProjectionRequest {
            sequence_id: 9,
            wrap: false,
            target_cue_uid: "cue-1".to_owned(),
            setup_instructions: Vec::new(),
            cues: vec![
                cue(
                    1,
                    false,
                    vec![instruction(fixture, "Intensity", absolute(0.0))],
                ),
                source_cue,
            ],
        };

        let values = project_sequence_lookahead(&request);

        assert_eq!(values.len(), 1);
        assert_eq!(values[0].source.part_id, 7);
        assert!(values[0].source.has_additional_parts);
    }

    /// Verifies fanned values resolve by selection offset before projection.
    #[test]
    fn projects_resolved_fanned_values() {
        let first = fixture(5);
        let second = fixture(6);
        let request = SequenceLookaheadProjectionRequest {
            sequence_id: 9,
            wrap: false,
            target_cue_uid: "cue-1".to_owned(),
            setup_instructions: Vec::new(),
            cues: vec![
                cue(
                    1,
                    false,
                    vec![ProjectionInstruction {
                        fixtures: vec![first.clone(), second.clone()],
                        values: HashMap::from([("Intensity".to_owned(), absolute(0.0))]),
                    }],
                ),
                cue(
                    2,
                    true,
                    vec![ProjectionInstruction {
                        fixtures: vec![first, second],
                        values: HashMap::from([(
                            "Pan".to_owned(),
                            ValueSource::Fanned {
                                values: vec![
                                    ParameterValue::Absolute { value: 10.0 },
                                    ParameterValue::Absolute { value: 20.0 },
                                ],
                            },
                        )]),
                    }],
                ),
            ],
        };

        let values = project_sequence_lookahead(&request);

        assert_eq!(values.len(), 2);
        assert_eq!(values[0].value, ParameterValue::Absolute { value: 10.0 });
        assert_eq!(values[1].value, ParameterValue::Absolute { value: 20.0 });
    }

    /// Verifies wrapped sequences project source values before the target row.
    #[test]
    fn projects_wrapped_downstream_source() {
        let fixture = fixture(7);
        let request = SequenceLookaheadProjectionRequest {
            sequence_id: 9,
            wrap: true,
            target_cue_uid: "cue-2".to_owned(),
            setup_instructions: Vec::new(),
            cues: vec![
                cue(
                    1,
                    true,
                    vec![instruction(fixture.clone(), "Pan", absolute(45.0))],
                ),
                cue(
                    2,
                    false,
                    vec![instruction(fixture.clone(), "Intensity", absolute(0.0))],
                ),
            ],
        };

        let values = project_sequence_lookahead(&request);

        assert_eq!(values.len(), 1);
        assert_eq!(values[0].fixture, fixture);
        assert_eq!(values[0].attribute, "Pan");
        assert_eq!(values[0].source.cue_id, 1);
    }
    /// Keeps each authored value type when a fan has one waypoint per selected target.
    #[test]
    fn exact_fan_waypoints_preserve_mixed_value_types() {
        let values = [
            ParameterValue::AbsolutePercent { value: 0.5.into() },
            ParameterValue::Absolute { value: 25.0 },
            ParameterValue::AbsolutePercent { value: 0.8.into() },
        ];
        for (index, expected) in values.iter().enumerate() {
            assert_eq!(
                resolve_fanned_value(&values, index, values.len()),
                *expected
            );
        }
    }
}
