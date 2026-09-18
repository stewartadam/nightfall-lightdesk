// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Sequence-owned helpers for deterministic playback planning.

use std::collections::HashMap;
use std::time::Duration;

use nightfall::prelude::{
    AttributeTransitions, CueTriggerType, FixtureRef, MaterializedTransition, PartialTransition,
    SequenceStepTiming, Transition, sequence_activation_interval,
    sequence_next_activation_position,
};
use nightfall_clips::{Clip, Source};
use nightfall_dmx::prelude::Attribute;
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::prelude::{
    FixtureDataProviderExt, MergeStrategy, ParameterMetadata, ResolvedElementParameter,
};
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_playback_planner::{
    PlannedPlaybackInterval, PlannedPlaybackInterventionKind, PlaybackDurationProfile,
    PlaybackExtent, PlaybackReconstructionTiming,
};
use nightfall_selection::filter_existing_selection;
use partially::Partial;
use uuid::Uuid;

use crate::cue::{BoundCueInstruction, Cue, Sequence};
use crate::duration::CueDurationResolver;
use crate::materialized_cue::MaterializedCue;

/// Safety cap for autonomous sequence seek derivation.
const MAX_AUTONOMOUS_SEEK_ADVANCES: usize = 10_000;

/// Resolved timing for one sequence step used by deterministic seek replay.
pub type SequenceTimelineStepTiming = SequenceStepTiming;

/// Final sequence cue target to materialize for a timeline seek position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SequenceTimelineSeekTarget {
    /// Clip ID whose sequence playback should be positioned.
    pub clip_id: u32,
    /// Cue position to materialize; zero denotes setup-only playback.
    pub position: u32,
    /// Source-local playback position where the current cue transition began.
    pub started_at: Duration,
}

impl SequenceTimelineSeekTarget {
    /// Builds reconstruction timing for evaluating this target at a source-local playback position.
    pub fn reconstruction_timing(self, position: Duration) -> PlaybackReconstructionTiming {
        PlaybackReconstructionTiming::external_position(self.started_at, position)
    }
}

/// Sequence-domain replay state used while reducing timeline navigation actions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SequenceTimelineSeekPlayback {
    clip_id: u32,
    position: u32,
    playback_started_at_timeline: Duration,
    started_at: Duration,
    step_count: u32,
    wrap: bool,
    clamp_jumps: bool,
    step_timings: Vec<SequenceTimelineStepTiming>,
    step_started_at: Vec<Option<Duration>>,
}

impl SequenceTimelineSeekPlayback {
    /// Builds seek playback state from a stored sequence definition.
    pub fn from_sequence(clip_id: u32, sequence: &Sequence, started_at: Duration) -> Option<Self> {
        Self::new(
            clip_id,
            sequence.steps.len() as u32,
            sequence.wrap,
            started_at,
        )
    }

    /// Builds seek playback state from a sequence and its resolved cue steps.
    pub fn from_sequence_steps(
        clip_id: u32,
        sequence: &Sequence,
        steps: &[Cue],
        fixture_data_provider: &FixtureDataProviderExt,
        selection_resolver: &SpatialSelectionResolver,
        started_at: Duration,
    ) -> Option<Self> {
        let step_timings =
            sequence_step_timings(sequence, steps, fixture_data_provider, selection_resolver);
        Self::from_step_timings(clip_id, sequence.wrap, started_at, step_timings)
    }

    /// Builds seek playback state for a sequence clip from available domain data.
    pub fn from_clip(
        clip_id: u32,
        clip: &Clip,
        sequence_data_provider: Option<&DataProvider<Sequence>>,
        cue_data_provider: &DataProvider<Cue>,
        fixture_data_provider: &FixtureDataProviderExt,
        selection_resolver: &SpatialSelectionResolver<'_>,
        started_at: Duration,
    ) -> Option<Self> {
        let Some(Source::Sequence(sequence_uid)) = &clip.source else {
            return None;
        };
        let sequence_data_provider = sequence_data_provider?;
        let Ok(sequence) = sequence_data_provider.get(*sequence_uid) else {
            return None;
        };
        let steps = sequence
            .steps
            .iter()
            .map(|cue_uid| cue_data_provider.get(cue_uid.0).map(|cue| cue.clone()))
            .collect::<Result<Vec<_>, _>>();
        let Ok(steps) = steps else {
            return None;
        };
        Self::from_sequence_steps(
            clip_id,
            &sequence,
            &steps,
            fixture_data_provider,
            selection_resolver,
            started_at,
        )
    }

    /// Builds seek playback state from already resolved step timings.
    pub fn from_step_timings(
        clip_id: u32,
        wrap: bool,
        started_at: Duration,
        step_timings: Vec<SequenceTimelineStepTiming>,
    ) -> Option<Self> {
        Self::new_with_step_timings(clip_id, wrap, started_at, step_timings)
    }

    /// Advances to the next cue when sequence rules allow it.
    pub fn advance(&mut self, transition_started_at_timeline: Duration) {
        self.advance_at_source_position(
            self.source_position_at_timeline(transition_started_at_timeline),
        );
    }

    /// Advances to the next cue at a source-local playback position.
    fn advance_at_source_position(&mut self, started_at: Duration) {
        if self.step_count == 0 || (!self.wrap && self.position >= self.step_count) {
            return;
        }

        self.position = if self.position == self.step_count {
            1
        } else {
            self.position + 1
        };
        self.started_at = started_at;
        self.record_step_start(self.position, started_at);
    }

    /// Moves to the previous cue when sequence rules allow it.
    pub fn back(&mut self, transition_started_at_timeline: Duration) {
        self.back_at_source_position(
            self.source_position_at_timeline(transition_started_at_timeline),
        );
    }

    /// Moves to the previous cue at a source-local playback position.
    fn back_at_source_position(&mut self, started_at: Duration) {
        if self.step_count == 0 || (!self.wrap && self.position <= 1) {
            return;
        }

        self.position = if self.position == 1 {
            self.step_count
        } else {
            self.position - 1
        };
        self.started_at = started_at;
        self.reconstruct_step_starts_to_current(started_at);
    }

    /// Jumps to an explicit cue position and records the transition anchor.
    pub fn jump_to(&mut self, position: u32, transition_started_at_timeline: Duration) {
        self.jump_to_source_position(
            position,
            self.source_position_at_timeline(transition_started_at_timeline),
        );
    }

    /// Jumps to an explicit cue position at a source-local playback position.
    fn jump_to_source_position(&mut self, position: u32, started_at: Duration) {
        if self.step_count == 0 {
            self.position = 0;
            return;
        }

        self.position = if self.clamp_jumps {
            position.clamp(1, self.step_count.max(1))
        } else {
            position.max(1)
        };
        self.started_at = started_at;
        self.reconstruct_step_starts_to_current(started_at);
    }

    /// Applies autonomous sequence rules up to a timeline evaluation position.
    pub fn advance_autonomous_until(&mut self, evaluated_at_timeline: Duration) {
        let target_position = self.source_position_at_timeline(evaluated_at_timeline);
        self.advance_autonomous_until_source_position(target_position);
    }

    /// Applies autonomous sequence rules up to a source-local evaluation position.
    fn advance_autonomous_until_source_position(&mut self, target_position: Duration) {
        let mut advance_count = 0;

        while advance_count < MAX_AUTONOMOUS_SEEK_ADVANCES {
            let Some((next_position, next_transition_started_at)) =
                self.next_autonomous_transition(target_position)
            else {
                break;
            };

            self.position = next_position;
            self.started_at = next_transition_started_at;
            self.record_step_start(next_position, next_transition_started_at);
            advance_count += 1;
        }
    }

    /// Applies a planned playback interval's sequence interventions up to an evaluation position.
    pub fn apply_planned_interval_until(
        &mut self,
        interval: &PlannedPlaybackInterval,
        evaluated_at_timeline: Duration,
    ) {
        let mut interventions = interval
            .explicit_interventions
            .iter()
            .filter(|intervention| intervention.timeline_position <= evaluated_at_timeline)
            .collect::<Vec<_>>();
        interventions.sort_by_key(|intervention| intervention.timeline_position);

        for intervention in interventions {
            self.advance_autonomous_until_source_position(intervention.playback_position);
            match intervention.kind {
                PlannedPlaybackInterventionKind::SequenceGo => {
                    self.advance_at_source_position(intervention.playback_position);
                }
                PlannedPlaybackInterventionKind::SequenceBack => {
                    self.back_at_source_position(intervention.playback_position);
                }
                PlannedPlaybackInterventionKind::SequenceGotoCue(position) => {
                    self.jump_to_source_position(position, intervention.playback_position);
                }
                PlannedPlaybackInterventionKind::Stop => {}
            }
        }

        self.advance_autonomous_until_source_position(
            interval.playback_position_at(evaluated_at_timeline),
        );
    }

    /// Returns the current seek target for materialization.
    pub fn target(&self) -> SequenceTimelineSeekTarget {
        SequenceTimelineSeekTarget {
            clip_id: self.clip_id,
            position: self.position,
            started_at: self.started_at,
        }
    }

    /// Builds reconstruction timing for evaluating this playback at a timeline position.
    pub fn reconstruction_timing(
        &self,
        evaluated_at_timeline: Duration,
    ) -> PlaybackReconstructionTiming {
        self.target()
            .reconstruction_timing(self.source_position_at_timeline(evaluated_at_timeline))
    }

    /// Builds timeline-sourced reconstruction timing for evaluating this playback at a timeline position.
    pub fn timeline_reconstruction_timing(
        &self,
        evaluated_at_timeline: Duration,
        timeline_uid: Uuid,
    ) -> PlaybackReconstructionTiming {
        PlaybackReconstructionTiming::timeline_source_local(
            self.started_at,
            self.source_position_at_timeline(evaluated_at_timeline),
            timeline_uid,
            self.playback_started_at_timeline,
        )
    }

    /// Returns the source-local position where a non-wrapping playback has completed.
    pub fn completed_at(&self) -> Option<Duration> {
        if !self.is_at_non_wrapping_final_step() {
            return None;
        }

        self.retained_assertion_completion_position()
    }

    /// Returns the latest assertion completion point across retained planned cue instances.
    fn retained_assertion_completion_position(&self) -> Option<Duration> {
        self.step_started_at
            .iter()
            .zip(self.step_timings.iter())
            .filter_map(|(started_at, timing)| {
                started_at.map(|started_at| started_at.saturating_add(timing.assertion_duration))
            })
            .max()
    }

    /// Records the source-local activation position for a retained cue step.
    fn record_step_start(&mut self, position: u32, started_at: Duration) {
        let index = position.saturating_sub(1) as usize;
        if let Some(step_started_at) = self.step_started_at.get_mut(index) {
            *step_started_at = Some(started_at);
        }
    }

    /// Rebuilds retained activation positions for the current target position.
    fn reconstruct_step_starts_to_current(&mut self, started_at: Duration) {
        self.step_started_at.fill(None);
        self.record_step_start(self.position, started_at);

        let active_index = self.position.saturating_sub(1) as usize;
        let mut next_activation = started_at;
        for index in (0..active_index).rev() {
            let Some(due_after) =
                self.autonomous_due_after_for_step(index, index + 1, next_activation)
            else {
                break;
            };
            let current_activation = next_activation.saturating_sub(due_after);
            if let Some(step_started_at) = self.step_started_at.get_mut(index) {
                *step_started_at = Some(current_activation);
            }
            next_activation = current_activation;
        }
    }

    /// Returns whether sequence-end release behavior is allowed for the current planned step.
    fn is_at_non_wrapping_final_step(&self) -> bool {
        !self.wrap && self.step_count > 0 && self.position == self.step_count
    }

    /// Returns whether the clip's sequence auto-end release is complete at a timeline position.
    pub fn auto_end_release_completed_for_clip(
        &self,
        timeline_position: Duration,
        clip: &Clip,
        sequence_data_provider: Option<&DataProvider<Sequence>>,
        fixture_data_provider: &FixtureDataProviderExt,
        selection_resolver: &SpatialSelectionResolver<'_>,
    ) -> bool {
        let Some(completed_at) = self.completed_at() else {
            return false;
        };
        if !clip.options.deactivate_on_sequence_end || !clip.options.auto_release {
            return false;
        }
        let Some(release_duration) = sequence_release_duration_for_clip(
            clip,
            sequence_data_provider,
            fixture_data_provider,
            selection_resolver,
        ) else {
            return false;
        };

        let position = self.reconstruction_timing(timeline_position).position;
        position > completed_at.saturating_add(release_duration)
    }

    /// Builds seek playback state with explicit sequence metadata.
    fn new(clip_id: u32, step_count: u32, wrap: bool, started_at: Duration) -> Option<Self> {
        Some(Self {
            clip_id,
            position: initial_position_for_step_count(step_count),
            playback_started_at_timeline: started_at,
            started_at: Duration::ZERO,
            step_count,
            wrap,
            clamp_jumps: true,
            step_timings: vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::ZERO,
                };
                step_count as usize
            ],
            step_started_at: {
                let mut step_started_at = vec![None; step_count as usize];
                if let Some(first_step_started_at) = step_started_at.first_mut() {
                    *first_step_started_at = Some(Duration::ZERO);
                }
                step_started_at
            },
        })
    }

    /// Builds seek playback state with resolved sequence step timings.
    fn new_with_step_timings(
        clip_id: u32,
        wrap: bool,
        started_at: Duration,
        step_timings: Vec<SequenceTimelineStepTiming>,
    ) -> Option<Self> {
        let step_count = step_timings.len() as u32;

        Some(Self {
            clip_id,
            position: initial_position_for_step_count(step_count),
            playback_started_at_timeline: started_at,
            started_at: Duration::ZERO,
            step_count,
            wrap,
            clamp_jumps: true,
            step_timings,
            step_started_at: {
                let mut step_started_at = vec![None; step_count as usize];
                if let Some(first_step_started_at) = step_started_at.first_mut() {
                    *first_step_started_at = Some(Duration::ZERO);
                }
                step_started_at
            },
        })
    }

    /// Returns the next autonomous transition that is due before the target position.
    fn next_autonomous_transition(&self, target_position: Duration) -> Option<(u32, Duration)> {
        if self.step_count == 0 || (!self.wrap && self.position >= self.step_count) {
            return None;
        }

        let current_index = self.position.saturating_sub(1) as usize;
        let next_position = if self.position == self.step_count {
            1
        } else {
            self.position + 1
        };
        let next_index = next_position.saturating_sub(1) as usize;
        let is_wraparound = self.wrap && next_position == 1 && self.position == self.step_count;
        let next_transition_started_at = sequence_next_activation_position(
            *self.step_timings.get(current_index)?,
            *self.step_timings.get(next_index)?,
            self.started_at,
            Duration::ZERO,
            is_wraparound,
        )?;

        (target_position >= next_transition_started_at)
            .then_some((next_position, next_transition_started_at))
    }

    /// Returns the autonomous delay from one retained cue step to the next.
    fn autonomous_due_after_for_step(
        &self,
        current_index: usize,
        next_index: usize,
        next_activation: Duration,
    ) -> Option<Duration> {
        let current_timing = self.step_timings.get(current_index)?;
        let next_timing = self.step_timings.get(next_index)?;
        if matches!(next_timing.trigger, CueTriggerType::At(_)) {
            self.reconstructed_activation_position_for_step(current_index)
                .map(|current_activation| next_activation.saturating_sub(current_activation))
        } else {
            sequence_activation_interval(
                *current_timing,
                *next_timing,
                Duration::ZERO,
                Duration::ZERO,
                false,
            )
        }
    }

    /// Replays trigger timing from sequence start to derive one retained step anchor.
    fn reconstructed_activation_position_for_step(&self, target_index: usize) -> Option<Duration> {
        if target_index >= self.step_timings.len() {
            return None;
        }

        let mut activation = Duration::ZERO;
        for next_index in 1..=target_index {
            let current_index = next_index - 1;
            let current_timing = self.step_timings.get(current_index)?;
            let next_timing = self.step_timings.get(next_index)?;
            activation = sequence_next_activation_position(
                *current_timing,
                *next_timing,
                activation,
                Duration::ZERO,
                false,
            )?;
        }
        Some(activation)
    }

    /// Converts an absolute timeline position into this sequence playback's source-local position.
    fn source_position_at_timeline(&self, timeline_position: Duration) -> Duration {
        timeline_position.saturating_sub(self.playback_started_at_timeline)
    }
}

/// Returns the initial sequence seek target position for a step count.
fn initial_position_for_step_count(step_count: u32) -> u32 {
    if step_count == 0 { 0 } else { 1 }
}

/// Resolves the release duration for a sequence clip.
pub fn sequence_release_duration_for_clip(
    clip: &Clip,
    sequence_data_provider: Option<&DataProvider<Sequence>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver<'_>,
) -> Option<Duration> {
    let Some(Source::Sequence(sequence_uid)) = clip.source else {
        return None;
    };
    let sequence = sequence_data_provider?.get(sequence_uid).ok()?;
    Some(sequence_release_duration(
        &sequence,
        fixture_data_provider,
        selection_resolver,
    ))
}

/// Resolves the generic playback duration profile for a sequence definition.
pub fn sequence_playback_duration_profile(
    sequence_uid: Uuid,
    sequence_data_provider: Option<&DataProvider<Sequence>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver<'_>,
) -> Option<PlaybackDurationProfile> {
    let sequence = sequence_data_provider?.get(sequence_uid).ok()?;
    let release_duration =
        sequence_release_duration(&sequence, fixture_data_provider, selection_resolver);
    Some(PlaybackDurationProfile::indefinite(
        PlaybackExtent::Indefinite,
        PlaybackExtent::Finite(release_duration),
    ))
}

/// Resolves sequence release duration from release cue timing and HTP-first release holds.
fn sequence_release_duration(
    sequence: &Sequence,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver<'_>,
) -> Duration {
    let profile =
        fixture_data_provider.cue_duration_profile(&sequence.release_cue, selection_resolver);
    let release_cue_duration = profile
        .cue_entry_duration()
        .max(sequence.release_cue.authored_duration());
    release_cue_duration.max(release_cue_htp_gated_duration(
        &sequence.release_cue,
        fixture_data_provider,
        selection_resolver,
    ))
}

/// Resolved LTP release timing for one fixture parameter.
#[derive(Clone, Debug, PartialEq, Eq)]
struct LtpReleaseTiming {
    /// Fixture whose LTP release timing was resolved.
    fixture_uid: Uuid,
    /// Delay before this LTP value starts moving during release.
    delay: Duration,
    /// Fade duration for this LTP value during release.
    fade: Duration,
}

/// Resolves the release duration introduced by holding LTP parameters for HTP fade-down.
fn release_cue_htp_gated_duration(
    release_cue: &Cue,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver<'_>,
) -> Duration {
    let mut htp_release_by_fixture_uid: HashMap<Uuid, Duration> = HashMap::new();
    let mut ltp_release_timings = Vec::new();

    record_global_release_timings(
        release_cue,
        fixture_data_provider,
        &mut htp_release_by_fixture_uid,
        &mut ltp_release_timings,
    );

    record_release_instruction_timings(
        &release_cue.instructions,
        &release_cue.transitions,
        &release_cue.transitions_by_attribute,
        fixture_data_provider,
        selection_resolver,
        &mut htp_release_by_fixture_uid,
        &mut ltp_release_timings,
    );

    for part in &release_cue.parts {
        let part_transition = MaterializedCue::inherited_part_transition(release_cue, part);
        let part_attribute_transitions =
            MaterializedCue::inherited_part_attribute_transitions(release_cue, part);
        record_release_instruction_timings(
            &part.instructions,
            &part_transition,
            &part_attribute_transitions,
            fixture_data_provider,
            selection_resolver,
            &mut htp_release_by_fixture_uid,
            &mut ltp_release_timings,
        );
    }

    ltp_release_timings
        .iter()
        .map(|timing| {
            let htp_duration = htp_release_by_fixture_uid
                .get(&timing.fixture_uid)
                .copied()
                .unwrap_or_default();
            htp_duration
                .saturating_add(timing.delay)
                .saturating_add(timing.fade)
        })
        .max()
        .unwrap_or_default()
}

/// Records unscoped global release timing for fixture parameters it can affect.
fn record_global_release_timings(
    release_cue: &Cue,
    fixture_data_provider: &FixtureDataProviderExt,
    htp_release_by_fixture_uid: &mut HashMap<Uuid, Duration>,
    ltp_release_timings: &mut Vec<LtpReleaseTiming>,
) {
    if cue_has_scoped_release_instructions(release_cue) {
        return;
    }

    let out_timing_is_explicit = selected_out_timing_is_explicit(&release_cue.transitions);
    let in_timing_is_explicit = selected_in_timing_is_explicit(&release_cue.transitions);
    if !out_timing_is_explicit && !in_timing_is_explicit {
        return;
    }

    let mut transition = Transition::default();
    transition.apply_some(release_cue.transitions.clone());
    let timing = MaterializedTransition::from_transition(&transition, 0, 1);

    for fixture in fixture_data_provider.inner.iter() {
        let fixture = fixture.value();
        for (element_index, element) in fixture.elements.iter().enumerate() {
            let fixture_ref = FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(element_index as u32 + 1),
            };

            for parameter in &element.parameters {
                if matches!(parameter.merge_type, MergeStrategy::HTP) && !out_timing_is_explicit {
                    continue;
                }
                if matches!(parameter.merge_type, MergeStrategy::LTP) && !in_timing_is_explicit {
                    continue;
                }
                record_selected_release_timing(
                    &fixture_ref,
                    parameter,
                    &timing,
                    htp_release_by_fixture_uid,
                    ltp_release_timings,
                );
            }
        }
    }
}

/// Records selected-side release timing for scoped release cue instructions.
fn record_release_instruction_timings(
    instructions: &[BoundCueInstruction],
    transitions: &PartialTransition,
    transitions_by_attribute: &AttributeTransitions,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver<'_>,
    htp_release_by_fixture_uid: &mut HashMap<Uuid, Duration>,
    ltp_release_timings: &mut Vec<LtpReleaseTiming>,
) {
    for bound_instructions in instructions {
        let selection = filter_existing_selection(
            &selection_resolver
                .resolve(&bound_instructions.selection)
                .into_value(),
            fixture_data_provider,
        );
        let total_indexes = selection.iter_non_empty_indexes().count();

        for (selection_index, resolved_index) in selection.iter_non_empty_indexes().enumerate() {
            let fixture_refs = resolved_index
                .members
                .iter()
                .flat_map(|member| {
                    MaterializedCue::resolve_fixture_refs(&member.fixture, fixture_data_provider)
                })
                .collect::<Vec<_>>();

            let release_timing_attributes = MaterializedCue::release_timing_override_attributes(
                transitions,
                transitions_by_attribute,
                &bound_instructions.cue_instruction,
            );
            for attribute in &release_timing_attributes {
                for fixture_ref in &fixture_refs {
                    let Some(resolved_parameter) = fixture_data_provider
                        .try_parameter_for_logical_attribute(fixture_ref, attribute)
                    else {
                        continue;
                    };
                    let Some(metadata) = resolved_parameter_metadata(
                        fixture_data_provider,
                        fixture_ref,
                        &resolved_parameter,
                    ) else {
                        continue;
                    };
                    let transition = MaterializedCue::resolve_transition_definition(
                        transitions,
                        transitions_by_attribute,
                        &bound_instructions.cue_instruction,
                        fixture_ref,
                        attribute,
                        &resolved_parameter.attribute,
                    );
                    let timing = MaterializedTransition::from_transition(
                        &transition,
                        selection_index,
                        total_indexes,
                    );
                    record_selected_release_timing(
                        fixture_ref,
                        &metadata,
                        &timing,
                        htp_release_by_fixture_uid,
                        ltp_release_timings,
                    );
                }
            }
        }
    }
}

/// Returns whether the release cue has fixture-scoped instructions.
fn cue_has_scoped_release_instructions(cue: &Cue) -> bool {
    !cue.instructions.is_empty() || cue.parts.iter().any(|part| !part.instructions.is_empty())
}

/// Returns fixture metadata for a resolved parameter from persisted fixture data.
fn resolved_parameter_metadata(
    fixture_data_provider: &FixtureDataProviderExt,
    fixture_ref: &FixtureRef,
    resolved_parameter: &ResolvedElementParameter,
) -> Option<ParameterMetadata> {
    let element_index = fixture_ref.index?.checked_sub(1)? as usize;
    let fixture = fixture_data_provider
        .inner
        .get(fixture_ref.fixture_uid)
        .ok()?;
    let element = fixture.elements.get(element_index)?;
    element
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == resolved_parameter.attribute)
        .cloned()
}

/// Records the timing side that applies to one release-layer parameter.
fn record_selected_release_timing(
    fixture_ref: &FixtureRef,
    metadata: &ParameterMetadata,
    timing: &MaterializedTransition,
    htp_release_by_fixture_uid: &mut HashMap<Uuid, Duration>,
    ltp_release_timings: &mut Vec<LtpReleaseTiming>,
) {
    if matches!(metadata.merge_type, MergeStrategy::HTP)
        && matches!(
            metadata.attribute,
            Attribute::Intensity | Attribute::VirtualIntensity
        )
    {
        let release_duration = timing.delay_out.saturating_add(timing.fade_out);
        let entry = htp_release_by_fixture_uid
            .entry(fixture_ref.fixture_uid)
            .or_default();
        *entry = (*entry).max(release_duration);
    } else if matches!(metadata.merge_type, MergeStrategy::LTP) {
        ltp_release_timings.push(LtpReleaseTiming {
            fixture_uid: fixture_ref.fixture_uid,
            delay: timing.delay_in,
            fade: timing.fade_in,
        });
    }
}

/// Returns whether the release cue explicitly authored in-side timing.
fn selected_in_timing_is_explicit(transition: &PartialTransition) -> bool {
    transition.delay_in.is_some() || transition.fade_in.is_some() || transition.curve_in.is_some()
}

/// Returns whether the release cue explicitly authored out-side timing.
fn selected_out_timing_is_explicit(transition: &PartialTransition) -> bool {
    transition.delay_out.is_some()
        || transition.fade_out.is_some()
        || transition.curve_out.is_some()
}

/// Resolves the deterministic timing profile for each cue in a sequence.
fn sequence_step_timings(
    sequence: &Sequence,
    steps: &[Cue],
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
) -> Vec<SequenceTimelineStepTiming> {
    steps
        .iter()
        .map(|cue| {
            let cue_with_defaults = cue_with_sequence_default_timing(cue, &sequence.default_timing);
            let profile =
                fixture_data_provider.cue_duration_profile(&cue_with_defaults, selection_resolver);
            SequenceTimelineStepTiming {
                trigger: cue.trigger,
                assertion_duration: profile
                    .cue_entry_duration()
                    .max(cue_with_defaults.authored_duration()),
            }
        })
        .collect()
}

/// Applies a sequence's default timing beneath a cue's explicit timing overrides.
fn cue_with_sequence_default_timing(cue: &Cue, default_timing: &Transition) -> Cue {
    let mut cue_with_defaults = cue.clone();
    cue_with_defaults.transitions = cue.transitions.with_default_timing(default_timing);
    cue_with_defaults
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use bevy_app::App;
    use bevy_ecs::prelude::{Res, World};
    use bevy_ecs::system::SystemState;
    use moonshine_kind::Instance;
    use nightfall::prelude::{
        CueTriggerType, FixtureRef, Group, Identifiers, PartialTransition, SelectionExpr,
        SimpleUuid, TransitionMode, ValueSource,
    };
    use nightfall_dmx::prelude::{Attribute, DmxValueResolution, ParameterValue};
    use nightfall_engine::prelude::DataProvider;
    use nightfall_fixtures::prelude::{
        Fixture, FixtureDataProviderExt, FixtureElement, MergeStrategy, Parameter,
        ParameterMetadata, ParameterValues,
    };
    use nightfall_fixtures::selection::SpatialSelectionResolver;
    use nightfall_playback_planner::PlaybackPositionSource;
    use nightfall_playback_planner::{
        PlannedPlaybackInterval, PlannedPlaybackIntervention, PlannedPlaybackInterventionKind,
        PlannedPlaybackLifecycle, PlannedPlaybackRateChange, PlannedPlaybackSource,
        TimelinePlaybackOwner,
    };

    use super::{SequenceTimelineSeekPlayback, SequenceTimelineStepTiming};
    use crate::cue::{BoundCueInstruction, Cue, CueInstruction, Sequence};

    /// Builds a sequence fixture with the requested number of steps and wrap mode.
    fn sequence(step_count: usize, wrap: bool) -> Sequence {
        Sequence {
            identifiers: Identifiers {
                id: 1,
                label: "test sequence".to_owned(),
                ..Default::default()
            },
            steps: (0..step_count)
                .map(|_| SimpleUuid(uuid::Uuid::new_v4()))
                .collect(),
            wrap,
            ..Default::default()
        }
    }

    /// Adds a fixture with HTP intensity and LTP red parameters.
    fn add_intensity_and_red_fixture(
        world: &mut World,
        fixture_id: u32,
    ) -> (FixtureRef, Instance<Parameter>, Instance<Parameter>) {
        let fixture_uid = uuid::Uuid::new_v4();
        let fixture_ref = FixtureRef {
            fixture_uid,
            index: Some(1),
        };
        world
            .resource_mut::<FixtureDataProviderExt>()
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id: fixture_id,
                    uid: fixture_uid,
                    label: format!("fixture-{fixture_id}"),
                },
                elements: vec![FixtureElement {
                    label: "element-1".to_owned(),
                    parameters: vec![
                        ParameterMetadata {
                            attribute: Attribute::Intensity,
                            resolution: DmxValueResolution::Coarse,
                            merge_type: MergeStrategy::HTP,
                            ..Default::default()
                        },
                        ParameterMetadata {
                            attribute: Attribute::Red,
                            resolution: DmxValueResolution::Coarse,
                            merge_type: MergeStrategy::LTP,
                            ..Default::default()
                        },
                    ],
                }],
                ..Default::default()
            })
            .expect("fixture should be stored");

        let intensity = spawn_parameter(world, Attribute::Intensity, MergeStrategy::HTP);
        let red = spawn_parameter(world, Attribute::Red, MergeStrategy::LTP);
        world.resource::<FixtureDataProviderExt>().add_parameter(
            fixture_ref.clone(),
            Attribute::Intensity,
            intensity,
        );
        world.resource::<FixtureDataProviderExt>().add_parameter(
            fixture_ref.clone(),
            Attribute::Red,
            red,
        );

        (fixture_ref, intensity, red)
    }

    /// Spawns one parameter with merge metadata used by fixture duration tests.
    fn spawn_parameter(
        world: &mut World,
        attribute: Attribute,
        merge_type: MergeStrategy,
    ) -> Instance<Parameter> {
        let entity = world
            .spawn(Parameter {
                metadata: ParameterMetadata {
                    attribute,
                    resolution: DmxValueResolution::Coarse,
                    merge_type,
                    ..Default::default()
                },
                values: ParameterValues::default(),
            })
            .id();

        // SAFETY: entity was spawned in this world with a Parameter component.
        unsafe { Instance::from_entity_unchecked(entity) }
    }

    /// Verifies auto-end release duration is the release cue's entry span.
    #[test]
    fn sequence_release_duration_includes_release_cue_entry_span() {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        let mut system_state =
            SystemState::<(Res<FixtureDataProviderExt>, SpatialSelectionResolver)>::new(
                app.world_mut(),
            );
        let (fixture_data_provider, selection_resolver) = system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");

        let mut sequence = sequence(1, false);
        sequence.release_cue = Cue {
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                fade_in: Some(TransitionMode::Fixed(Duration::from_millis(400))),
                delay_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
                fade_out: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                ..Default::default()
            },
            ..Default::default()
        };

        assert_eq!(
            super::sequence_release_duration(
                &sequence,
                &fixture_data_provider,
                &selection_resolver,
            ),
            Duration::from_millis(2500)
        );
    }

    /// Verifies HTP fade-down extends same-fixture LTP release duration.
    #[test]
    fn sequence_release_duration_includes_htp_held_ltp_release_span() {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        let (fixture_ref, _intensity, _red) = add_intensity_and_red_fixture(app.world_mut(), 71);
        let mut system_state =
            SystemState::<(Res<FixtureDataProviderExt>, SpatialSelectionResolver)>::new(
                app.world_mut(),
            );
        let (fixture_data_provider, selection_resolver) = system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");

        let mut sequence = sequence(1, false);
        sequence.release_cue = Cue {
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
                fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                ..Default::default()
            },
            instructions: vec![BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([
                        (
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                        ),
                        (
                            Attribute::Red,
                            ValueSource::Inline(ParameterValue::Absolute { value: 128.0 }),
                        ),
                    ]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        };

        assert_eq!(
            super::sequence_release_duration(
                &sequence,
                &fixture_data_provider,
                &selection_resolver,
            ),
            Duration::from_millis(3500)
        );
    }

    /// Verifies global release timing includes the HTP-held LTP release span.
    #[test]
    fn sequence_release_duration_includes_global_htp_held_ltp_release_span() {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        add_intensity_and_red_fixture(app.world_mut(), 72);
        let mut system_state =
            SystemState::<(Res<FixtureDataProviderExt>, SpatialSelectionResolver)>::new(
                app.world_mut(),
            );
        let (fixture_data_provider, selection_resolver) = system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");

        let mut sequence = sequence(1, false);
        sequence.release_cue = Cue {
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
                fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                ..Default::default()
            },
            ..Default::default()
        };

        assert_eq!(
            super::sequence_release_duration(
                &sequence,
                &fixture_data_provider,
                &selection_resolver,
            ),
            Duration::from_millis(3500)
        );
    }

    /// Verifies sequence step timing uses the cue-entry span across in and out timing.
    #[test]
    fn sequence_step_timings_use_full_cue_entry_duration() {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        let mut system_state =
            SystemState::<(Res<FixtureDataProviderExt>, SpatialSelectionResolver)>::new(
                app.world_mut(),
            );
        let (fixture_data_provider, selection_resolver) = system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");
        let sequence = sequence(1, false);
        let cue = Cue {
            transitions: PartialTransition {
                fade_in: Some(TransitionMode::Fixed(Duration::from_millis(100))),
                delay_out: Some(TransitionMode::Fixed(Duration::from_millis(250))),
                fade_out: Some(TransitionMode::Fixed(Duration::from_millis(750))),
                ..Default::default()
            },
            ..Default::default()
        };

        let timings = super::sequence_step_timings(
            &sequence,
            &[cue],
            &fixture_data_provider,
            &selection_resolver,
        );

        assert_eq!(timings.len(), 1);
        assert_eq!(
            timings[0].assertion_duration,
            Duration::from_millis(1000),
            "cue entry duration should be max(delay in + fade in, delay out + fade out)"
        );
    }

    /// Builds an instance owner for sequence planning tests.
    fn owner(action_id: &str) -> TimelinePlaybackOwner {
        TimelinePlaybackOwner {
            timeline_uid: uuid::Uuid::from_u128(0x1000),
            track_id: "track".to_owned(),
            action_id: action_id.to_owned(),
        }
    }

    /// Builds an active planned sequence interval for sequence planning tests.
    fn planned_sequence_interval(
        started_at_timeline: Duration,
        interventions: Vec<PlannedPlaybackIntervention>,
    ) -> PlannedPlaybackInterval {
        PlannedPlaybackInterval {
            owner: owner("start"),
            source: PlannedPlaybackSource::Sequence(uuid::Uuid::from_u128(0x2000)),
            started_at_timeline,
            stopped_at_timeline: None,
            source_local_start: Duration::ZERO,
            release: None,
            rate_changes: Vec::new(),
            explicit_interventions: interventions,
            lifecycle: PlannedPlaybackLifecycle::Active,
        }
    }

    /// Builds a planned sequence intervention at the requested timeline position.
    fn intervention(
        action_id: &str,
        timeline_position: Duration,
        playback_position: Duration,
        kind: PlannedPlaybackInterventionKind,
    ) -> PlannedPlaybackIntervention {
        PlannedPlaybackIntervention {
            owner: owner(action_id),
            timeline_position,
            playback_position,
            kind,
        }
    }

    /// Verifies setup-only sequences remain plannable with a setup-cue target position.
    #[test]
    fn setup_only_seek_playback_targets_setup_position() {
        let mut playback = SequenceTimelineSeekPlayback::from_sequence(
            6,
            &sequence(0, false),
            Duration::from_millis(100),
        )
        .expect("setup-only sequence should be plannable");

        playback.advance(Duration::from_millis(200));
        playback.jump_to(3, Duration::from_millis(300));
        let target = playback.target();
        let timing = playback.timeline_reconstruction_timing(
            Duration::from_millis(450),
            uuid::Uuid::from_u128(0x4400),
        );

        assert_eq!(target.clip_id, 6);
        assert_eq!(target.position, 0);
        assert_eq!(target.started_at, Duration::ZERO);
        assert_eq!(playback.completed_at(), None);
        assert_eq!(timing.started_at, Duration::ZERO);
        assert_eq!(timing.position, Duration::from_millis(350));
    }

    /// Verifies non-wrapping playback advances until the final cue and then holds.
    #[test]
    fn non_wrapping_seek_playback_holds_at_final_step() {
        let mut playback = SequenceTimelineSeekPlayback::from_sequence(
            7,
            &sequence(2, false),
            Duration::from_millis(100),
        )
        .expect("sequence should be plannable");

        playback.advance(Duration::from_millis(200));
        playback.advance(Duration::from_millis(300));
        let target = playback.target();

        assert_eq!(target.clip_id, 7);
        assert_eq!(target.position, 2);
        assert_eq!(target.started_at, Duration::from_millis(100));
    }

    /// Verifies seek reconstruction includes an autonomous cue due exactly at the target position.
    #[test]
    fn seek_playback_advances_autonomous_cue_at_exact_boundary() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            11,
            false,
            Duration::ZERO,
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_secs(2)),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.advance_autonomous_until_source_position(Duration::from_secs(2));
        let target = playback.target();

        assert_eq!(target.position, 2);
        assert_eq!(target.started_at, Duration::from_secs(2));
    }

    /// Verifies wrapping playback cycles through the first cue after the final cue.
    #[test]
    fn wrapping_seek_playback_cycles_to_first_step() {
        let mut playback = SequenceTimelineSeekPlayback::from_sequence(
            9,
            &sequence(2, true),
            Duration::from_millis(100),
        )
        .expect("sequence should be plannable");

        playback.advance(Duration::from_millis(200));
        playback.advance(Duration::from_millis(300));
        let target = playback.target();

        assert_eq!(target.position, 1);
        assert_eq!(target.started_at, Duration::from_millis(200));
    }

    /// Verifies wrapped seek playback waits for the current fade before applying a short wrap delay.
    #[test]
    fn wrapping_seek_playback_waits_for_current_assertion_before_after_delay_wrap() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            9,
            true,
            Duration::ZERO,
            vec![SequenceTimelineStepTiming {
                trigger: CueTriggerType::AfterDelay(Duration::from_millis(1)),
                assertion_duration: Duration::from_secs(1),
            }],
        )
        .expect("sequence should be plannable");

        playback.advance_autonomous_until_source_position(Duration::from_millis(999));
        assert_eq!(
            playback.target().started_at,
            Duration::ZERO,
            "single-cue wrap should not restart before the assertion transition completes"
        );

        playback.advance_autonomous_until_source_position(Duration::from_secs(1));
        let target = playback.target();

        assert_eq!(target.position, 1);
        assert_eq!(target.started_at, Duration::from_secs(1));
    }

    /// Verifies deterministic seek treats cue 1 AfterDelay as wrap delay only.
    #[test]
    fn seek_playback_uses_first_cue_after_delay_only_for_wraparound() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            33,
            true,
            Duration::ZERO,
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(100)),
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(500)),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.advance_autonomous_until_source_position(Duration::from_millis(200));
        assert_eq!(
            playback.target().position,
            1,
            "cue 1 AfterDelay should not delay or retrigger the initial cue"
        );

        playback.advance_autonomous_until_source_position(Duration::from_millis(501));
        assert_eq!(playback.target().position, 2);
        assert_eq!(playback.target().started_at, Duration::from_millis(500));

        playback.advance_autonomous_until_source_position(Duration::from_millis(550));
        assert_eq!(
            playback.target().position,
            2,
            "wrapping should wait for cue 1's AfterDelay from the final cue activation"
        );

        playback.advance_autonomous_until_source_position(Duration::from_millis(601));
        assert_eq!(playback.target().position, 1);
        assert_eq!(playback.target().started_at, Duration::from_millis(600));
    }

    /// Verifies wrapped playback never reports a sequence completion anchor after cycling.
    #[test]
    fn wrapping_seek_playback_does_not_complete_after_wraparound() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            10,
            true,
            Duration::from_millis(100),
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::from_millis(500),
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::from_millis(700),
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.advance(Duration::from_millis(200));
        playback.advance(Duration::from_millis(300));

        assert_eq!(playback.target().position, 1);
        assert_eq!(
            playback.completed_at(),
            None,
            "wrapped playback should not report completion after cycling to the first cue"
        );
    }

    /// Verifies explicit jumps clamp to known sequence bounds.
    #[test]
    fn seek_playback_jump_clamps_to_sequence_bounds() {
        let mut playback = SequenceTimelineSeekPlayback::from_sequence(
            11,
            &sequence(3, false),
            Duration::from_millis(100),
        )
        .expect("sequence should be plannable");

        playback.jump_to(99, Duration::from_millis(500));
        let target = playback.target();

        assert_eq!(target.position, 3);
        assert_eq!(target.started_at, Duration::from_millis(400));
    }

    /// Verifies explicit jumps retain reconstructed prefix transition completion.
    #[test]
    fn seek_playback_jump_reconstructs_retained_prefix_completion() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            12,
            false,
            Duration::ZERO,
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::from_secs(1),
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(100)),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.jump_to(2, Duration::from_millis(100));
        let target = playback.target();

        assert_eq!(target.position, 2);
        assert_eq!(target.started_at, Duration::from_millis(100));
        assert_eq!(
            playback.completed_at(),
            Some(Duration::from_secs(1)),
            "completion should wait for the reconstructed retained prefix transition"
        );
    }

    /// Verifies direct jumps preserve retained absolute At-trigger anchors.
    #[test]
    fn seek_playback_jump_preserves_prior_at_trigger_anchor() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            12,
            false,
            Duration::ZERO,
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::At(Duration::from_secs(10)),
                    assertion_duration: Duration::from_secs(30),
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::At(Duration::from_secs(20)),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.jump_to(3, Duration::from_secs(20));

        assert_eq!(
            playback.completed_at(),
            Some(Duration::from_secs(40)),
            "cue 2 should be retained from its 10s At anchor, not backdated to sequence start"
        );
    }

    /// Verifies direct jumps do not retain cues before a manual boundary.
    #[test]
    fn seek_playback_jump_stops_prefix_reconstruction_at_manual_boundary() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            12,
            false,
            Duration::ZERO,
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::from_secs(30),
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::ZERO),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.jump_to(3, Duration::from_secs(20));

        assert_eq!(
            playback.completed_at(),
            Some(Duration::from_secs(20)),
            "cue 1 should not remain retained across cue 2's manual trigger"
        );
    }

    /// Verifies timeline evaluation positions are converted to source-local timing.
    #[test]
    fn seek_playback_reconstruction_timing_is_source_local() {
        let mut playback = SequenceTimelineSeekPlayback::from_sequence(
            17,
            &sequence(3, false),
            Duration::from_millis(100),
        )
        .expect("sequence should be plannable");

        playback.jump_to(2, Duration::from_millis(350));
        let timing = playback.reconstruction_timing(Duration::from_millis(900));

        assert_eq!(timing.started_at, Duration::from_millis(250));
        assert_eq!(timing.position, Duration::from_millis(800));
    }

    /// Verifies timeline-sourced transition timing records the owning timeline start position.
    #[test]
    fn seek_playback_timeline_reconstruction_timing_preserves_source() {
        let timeline_uid = uuid::Uuid::from_u128(0x4400);
        let mut playback = SequenceTimelineSeekPlayback::from_sequence(
            17,
            &sequence(3, false),
            Duration::from_millis(100),
        )
        .expect("sequence should be plannable");

        playback.jump_to(2, Duration::from_millis(350));
        let timing =
            playback.timeline_reconstruction_timing(Duration::from_millis(900), timeline_uid);

        assert_eq!(timing.started_at, Duration::from_millis(250));
        assert_eq!(timing.position, Duration::from_millis(800));
        assert_eq!(
            timing.source,
            PlaybackPositionSource::Timeline {
                timeline_uid,
                started_at_timeline: Duration::from_millis(100)
            }
        );
    }

    /// Verifies non-wrapping playback reports source-local completion after the final cue.
    #[test]
    fn seek_playback_reports_non_wrapping_completion_position() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            18,
            false,
            Duration::from_millis(100),
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::from_millis(500),
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(200)),
                    assertion_duration: Duration::from_millis(700),
                },
            ],
        )
        .expect("sequence should be plannable");

        assert_eq!(playback.completed_at(), None);
        playback.advance_autonomous_until(Duration::from_millis(299));

        assert_eq!(playback.target().position, 1);
        assert_eq!(playback.completed_at(), None);

        playback.advance_autonomous_until(Duration::from_millis(601));

        assert_eq!(playback.target().position, 2);
        assert_eq!(playback.completed_at(), Some(Duration::from_millis(900)));
    }

    /// Verifies AfterDelay triggers derive autonomous sequence movement before the seek target.
    #[test]
    fn seek_playback_autonomously_advances_after_delay_steps() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            19,
            false,
            Duration::from_millis(100),
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(200)),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.advance_autonomous_until(Duration::from_millis(350));
        let target = playback.target();

        assert_eq!(target.position, 2);
        assert_eq!(target.started_at, Duration::from_millis(200));
    }

    /// Verifies AfterDelay starts from the current cue start while retained assertions complete.
    #[test]
    fn seek_playback_after_delay_allows_overlapping_assertion_transition() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            19,
            false,
            Duration::from_millis(100),
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::from_secs(1),
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(200)),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.advance_autonomous_until(Duration::from_millis(900));
        let target = playback.target();

        assert_eq!(target.position, 2);
        assert_eq!(target.started_at, Duration::from_millis(200));
        assert_eq!(
            playback.completed_at(),
            Some(Duration::from_secs(1)),
            "planned completion should wait for the retained prior assertion transition"
        );
    }

    /// Verifies planned interventions reduce into a final sequence seek target.
    #[test]
    fn planned_interval_interventions_reduce_to_seek_target() {
        let mut playback = SequenceTimelineSeekPlayback::from_sequence(
            29,
            &sequence(4, false),
            Duration::from_millis(100),
        )
        .expect("sequence should be plannable");
        let interval = planned_sequence_interval(
            Duration::from_millis(100),
            vec![
                intervention(
                    "go",
                    Duration::from_millis(250),
                    Duration::from_millis(150),
                    PlannedPlaybackInterventionKind::SequenceGo,
                ),
                intervention(
                    "goto",
                    Duration::from_millis(350),
                    Duration::from_millis(250),
                    PlannedPlaybackInterventionKind::SequenceGotoCue(4),
                ),
                intervention(
                    "back",
                    Duration::from_millis(450),
                    Duration::from_millis(350),
                    PlannedPlaybackInterventionKind::SequenceBack,
                ),
            ],
        );

        playback.apply_planned_interval_until(&interval, Duration::from_millis(700));
        let target = playback.target();

        assert_eq!(target.clip_id, 29);
        assert_eq!(target.position, 3);
        assert_eq!(target.started_at, Duration::from_millis(350));
    }

    /// Verifies planned interval reduction applies autonomous movement around interventions.
    #[test]
    fn planned_interval_interventions_include_autonomous_progression() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            31,
            false,
            Duration::from_millis(100),
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(200)),
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(200)),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");
        let interval = planned_sequence_interval(
            Duration::from_millis(100),
            vec![intervention(
                "go",
                Duration::from_millis(450),
                Duration::from_millis(350),
                PlannedPlaybackInterventionKind::SequenceGo,
            )],
        );

        playback.apply_planned_interval_until(&interval, Duration::from_millis(800));
        let target = playback.target();

        assert_eq!(target.position, 3);
        assert_eq!(target.started_at, Duration::from_millis(350));
    }

    /// Verifies planned rate changes affect autonomous sequence progression.
    #[test]
    fn planned_interval_rate_changes_accelerate_autonomous_progression() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            32,
            false,
            Duration::ZERO,
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(200)),
                    assertion_duration: Duration::ZERO,
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::AfterDelay(Duration::from_millis(200)),
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");
        let mut interval = planned_sequence_interval(Duration::ZERO, Vec::new());
        interval
            .rate_changes
            .push(PlannedPlaybackRateChange::from_multiplier(
                owner("rate"),
                Duration::from_millis(100),
                Duration::from_millis(100),
                2.0,
            ));

        playback.apply_planned_interval_until(&interval, Duration::from_millis(251));
        let target = playback.target();

        assert_eq!(target.position, 3);
        assert_eq!(target.started_at, Duration::from_millis(400));
    }

    /// Verifies FollowPrevious triggers use the previous cue assertion duration.
    #[test]
    fn seek_playback_autonomously_advances_follow_previous_steps() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            23,
            false,
            Duration::from_millis(100),
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::from_millis(500),
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::FollowPrevious,
                    assertion_duration: Duration::ZERO,
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.advance_autonomous_until(Duration::from_millis(600));
        let target = playback.target();

        assert_eq!(target.position, 2);
        assert_eq!(target.started_at, Duration::from_millis(500));

        playback.advance_autonomous_until(Duration::from_millis(650));
        let target = playback.target();

        assert_eq!(target.position, 2);
        assert_eq!(target.started_at, Duration::from_millis(500));
    }

    /// Verifies non-wrapping completion waits for the final cue's full transition span.
    #[test]
    fn seek_playback_completion_uses_final_cue_transition_span() {
        let mut playback = SequenceTimelineSeekPlayback::from_step_timings(
            23,
            false,
            Duration::ZERO,
            vec![
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::Manual,
                    assertion_duration: Duration::from_millis(200),
                },
                SequenceTimelineStepTiming {
                    trigger: CueTriggerType::FollowPrevious,
                    assertion_duration: Duration::from_secs(1),
                },
            ],
        )
        .expect("sequence should be plannable");

        playback.advance_autonomous_until(Duration::from_millis(250));

        assert_eq!(playback.target().position, 2);
        assert_eq!(
            playback.completed_at(),
            Some(Duration::from_millis(1200)),
            "completion should include cue 1's follow delay and cue 2's transition span"
        );
    }
}
