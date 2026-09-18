// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Duration summaries for cue-domain playback planning.

use std::time::Duration;

use nightfall::prelude::{
    AttributeTransitions, FixtureRef, MaterializedTransition, PartialTransition, Transition,
    ValueSource,
};
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_playback_planner::{PlaybackDurationProfile, PlaybackExtent};
use nightfall_selection::filter_existing_selection;
use serde::{Deserialize, Serialize};

use crate::cue::{BoundCueInstruction, Cue};
use crate::materialized_cue::MaterializedCue;

/// Resolved cue timing information needed by playback planners and UI summaries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CueDurationProfile {
    /// Longest delay before a cue value starts asserting.
    pub max_delay_in: Duration,
    /// Longest fade used while a cue value asserts.
    pub max_fade_in: Duration,
    /// Longest delay before a cue value starts releasing.
    pub max_delay_out: Duration,
    /// Longest fade used while a cue value releases.
    pub max_fade_out: Duration,
    /// Longest resolved delay-in plus fade-in across asserted values.
    pub assertion_duration: Duration,
    /// Longest resolved delay-out plus fade-out across releasable values.
    pub release_duration: Duration,
    /// Longest resolved transition span across cue-entry in and out timing.
    pub max_transition_duration: Duration,
}

impl CueDurationProfile {
    /// Builds a profile containing only one materialized transition.
    pub fn from_transition(transition: &MaterializedTransition) -> Self {
        let mut profile = Self::default();
        profile.record_transition(transition);
        profile
    }

    /// Builds a profile by folding over materialized transitions.
    pub fn from_transitions<'a>(
        transitions: impl IntoIterator<Item = &'a MaterializedTransition>,
    ) -> Self {
        let mut profile = Self::default();
        for transition in transitions {
            profile.record_transition(transition);
        }
        profile
    }

    /// Returns the profile accumulated while the cue was materialized.
    pub fn from_materialized_cue(materialized_cue: &MaterializedCue) -> Self {
        materialized_cue.duration_profile
    }

    /// Returns the source-local span occupied by cue-entry transitions.
    pub fn cue_entry_duration(self) -> Duration {
        self.max_transition_duration
    }

    /// Adds one resolved transition to this profile.
    pub fn record_transition(&mut self, transition: &MaterializedTransition) {
        self.max_delay_in = self.max_delay_in.max(transition.delay_in);
        self.max_fade_in = self.max_fade_in.max(transition.fade_in);
        self.max_delay_out = self.max_delay_out.max(transition.delay_out);
        self.max_fade_out = self.max_fade_out.max(transition.fade_out);
        self.assertion_duration = self
            .assertion_duration
            .max(transition.delay_in.saturating_add(transition.fade_in));
        self.release_duration = self
            .release_duration
            .max(transition.delay_out.saturating_add(transition.fade_out));
        self.max_transition_duration = self
            .max_transition_duration
            .max(self.assertion_duration)
            .max(self.release_duration);
    }

    /// Adds one resolved transition definition to this profile.
    pub fn record_transition_definition(
        &mut self,
        transition: &Transition,
        selection_index: usize,
        selection_size: usize,
    ) {
        let delay_in = transition.delay_in.resolve(selection_index, selection_size);
        let fade_in = transition.fade_in.resolve(selection_index, selection_size);
        let delay_out = transition
            .delay_out
            .resolve(selection_index, selection_size);
        let fade_out = transition.fade_out.resolve(selection_index, selection_size);

        self.max_delay_in = self.max_delay_in.max(delay_in);
        self.max_fade_in = self.max_fade_in.max(fade_in);
        self.max_delay_out = self.max_delay_out.max(delay_out);
        self.max_fade_out = self.max_fade_out.max(fade_out);
        self.assertion_duration = self
            .assertion_duration
            .max(delay_in.saturating_add(fade_in));
        self.release_duration = self
            .release_duration
            .max(delay_out.saturating_add(fade_out));
        self.max_transition_duration = self
            .max_transition_duration
            .max(self.assertion_duration)
            .max(self.release_duration);
    }

    /// Converts this cue-domain profile to the generic playback planner contract.
    pub fn to_playback_duration_profile(self) -> PlaybackDurationProfile {
        let assertion_duration = self.cue_entry_duration();
        PlaybackDurationProfile {
            assertion: PlaybackExtent::Finite(assertion_duration),
            release: PlaybackExtent::Finite(self.release_duration),
            total: PlaybackExtent::Finite(assertion_duration.saturating_add(self.release_duration)),
        }
    }
}

/// Resolves cue-definition timing profiles without creating runtime instance entities.
pub trait CueDurationResolver {
    /// Resolves the timing profile for a cue definition.
    fn cue_duration_profile(
        &self,
        cue: &Cue,
        selection_resolver: &SpatialSelectionResolver,
    ) -> CueDurationProfile;
}

impl CueDurationResolver for FixtureDataProviderExt {
    fn cue_duration_profile(
        &self,
        cue: &Cue,
        selection_resolver: &SpatialSelectionResolver,
    ) -> CueDurationProfile {
        resolve_cue_duration_profile(cue, self, selection_resolver)
    }
}

/// Resolves a cue definition into a timing profile without materializing output values.
pub fn resolve_cue_duration_profile(
    cue: &Cue,
    data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
) -> CueDurationProfile {
    let mut profile = CueDurationProfile::default();
    record_instruction_durations(
        &mut profile,
        &cue.instructions,
        &cue.transitions,
        &cue.transitions_by_attribute,
        data_provider,
        selection_resolver,
    );

    for part in &cue.parts {
        let part_transition = MaterializedCue::inherited_part_transition(cue, part);
        let part_attribute_transitions =
            MaterializedCue::inherited_part_attribute_transitions(cue, part);
        record_instruction_durations(
            &mut profile,
            &part.instructions,
            &part_transition,
            &part_attribute_transitions,
            data_provider,
            selection_resolver,
        );
    }

    profile
}

/// Records timing for a set of bound cue instructions.
fn record_instruction_durations(
    profile: &mut CueDurationProfile,
    instructions: &[BoundCueInstruction],
    transitions: &PartialTransition,
    transitions_by_attribute: &AttributeTransitions,
    data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
) {
    for bound_instructions in instructions {
        let selection = filter_existing_selection(
            &selection_resolver
                .resolve(&bound_instructions.selection)
                .into_value(),
            data_provider,
        );
        let total_indexes = selection.iter_non_empty_indexes().count();

        for (selection_index, resolved_index) in selection.iter_non_empty_indexes().enumerate() {
            let fixture_refs: Vec<FixtureRef> = resolved_index
                .members
                .iter()
                .flat_map(|member| {
                    MaterializedCue::resolve_fixture_refs(&member.fixture, data_provider)
                })
                .collect();

            for (attribute, source) in bound_instructions.cue_instruction.values.iter() {
                if matches!(source, ValueSource::Release | ValueSource::HoldPosition) {
                    continue;
                }

                for fixture_ref in &fixture_refs {
                    let Some(resolved_parameter) =
                        data_provider.try_parameter_for_logical_attribute(fixture_ref, attribute)
                    else {
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
                    profile.record_transition_definition(
                        &transition,
                        selection_index,
                        total_indexes,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nightfall::prelude::{FadeCurve, MaterializedTransition, Transition, TransitionMode};
    use nightfall_playback_planner::PlaybackExtent;

    use super::CueDurationProfile;

    /// Builds a transition fixture with explicit timing values.
    fn transition(
        delay_in: Duration,
        fade_in: Duration,
        delay_out: Duration,
        fade_out: Duration,
    ) -> MaterializedTransition {
        MaterializedTransition {
            delay_in,
            fade_in,
            curve_in: FadeCurve::Linear,
            delay_out,
            fade_out,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        }
    }

    /// Verifies profiles track assertion and release duration independently.
    #[test]
    fn cue_duration_profile_records_independent_assertion_and_release_spans() {
        let slow_release = transition(
            Duration::from_millis(100),
            Duration::from_millis(200),
            Duration::from_millis(500),
            Duration::from_millis(600),
        );
        let slow_assertion = transition(
            Duration::from_millis(400),
            Duration::from_millis(100),
            Duration::from_millis(10),
            Duration::from_millis(20),
        );
        let profile = CueDurationProfile::from_transitions([&slow_release, &slow_assertion]);

        assert_eq!(profile.max_delay_in, Duration::from_millis(400));
        assert_eq!(profile.max_fade_in, Duration::from_millis(200));
        assert_eq!(profile.max_delay_out, Duration::from_millis(500));
        assert_eq!(profile.max_fade_out, Duration::from_millis(600));
        assert_eq!(profile.assertion_duration, Duration::from_millis(500));
        assert_eq!(profile.release_duration, Duration::from_millis(1100));
        assert_eq!(profile.max_transition_duration, Duration::from_millis(1100));
    }

    /// Verifies duration profiles resolve fanned transition definitions without runtime anchors.
    #[test]
    fn cue_duration_profile_records_resolved_transition_definitions() {
        fn assert_duration_near(actual: Duration, expected: Duration) {
            let delta = actual.abs_diff(expected);
            assert!(
                delta <= Duration::from_micros(1),
                "expected {actual:?} to be within 1us of {expected:?}"
            );
        }

        let transition = Transition {
            delay_in: TransitionMode::Interpolated {
                start: Duration::from_millis(100),
                end: Duration::from_millis(300),
            },
            fade_in: TransitionMode::Fixed(Duration::from_millis(50)),
            delay_out: TransitionMode::Manual(vec![
                Duration::from_millis(10),
                Duration::from_millis(30),
                Duration::from_millis(50),
            ]),
            fade_out: TransitionMode::Fixed(Duration::from_millis(25)),
            curve_in: FadeCurve::Linear,
            curve_out: FadeCurve::Linear,
        };
        let mut profile = CueDurationProfile::default();

        profile.record_transition_definition(&transition, 1, 3);

        assert_duration_near(profile.max_delay_in, Duration::from_millis(200));
        assert_eq!(profile.max_fade_in, Duration::from_millis(50));
        assert_duration_near(profile.max_delay_out, Duration::from_millis(30));
        assert_eq!(profile.max_fade_out, Duration::from_millis(25));
        assert_duration_near(profile.assertion_duration, Duration::from_millis(250));
        assert_duration_near(profile.release_duration, Duration::from_millis(55));
        assert_duration_near(profile.max_transition_duration, Duration::from_millis(250));
    }

    /// Verifies cue duration profiles can be projected into generic planner contracts.
    #[test]
    fn cue_duration_profile_converts_to_playback_duration_profile() {
        let profile = CueDurationProfile {
            assertion_duration: Duration::from_millis(300),
            max_transition_duration: Duration::from_millis(500),
            release_duration: Duration::from_millis(700),
            ..Default::default()
        };

        let playback_profile = profile.to_playback_duration_profile();

        assert_eq!(
            playback_profile.assertion,
            PlaybackExtent::Finite(Duration::from_millis(500))
        );
        assert_eq!(
            playback_profile.release,
            PlaybackExtent::Finite(Duration::from_millis(700))
        );
        assert_eq!(
            playback_profile.total,
            PlaybackExtent::Finite(Duration::from_millis(1200))
        );
    }
}
