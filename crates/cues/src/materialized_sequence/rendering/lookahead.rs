// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Sequence lookahead candidate projection and darkness filtering.

use std::collections::HashSet;

use nightfall_dmx::prelude::{Attribute, AttributeCategory};
use nightfall_lookahead::Lookahead;

use super::super::*;

/// A precomputed lookahead assertion candidate before current-output darkness filtering.
#[derive(Clone, Debug, PartialEq)]
pub struct LookaheadCandidateAssertion {
    /// Parameter that should receive the lookahead value if its fixture is dark.
    pub parameter: Instance<Parameter>,
    /// Absolute value to assert.
    pub value: ParameterValue,
    /// Fixture or element whose current intensity controls whether this candidate is safe.
    pub fixture_ref: FixtureRef,
}

impl MaterializedSequence {
    /// Builds lookahead position assertions for this rendered sequence layer.
    pub fn lookahead_lookahead_assertions(
        &self,
        seq_layer: &Layer,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
    ) -> LookaheadAssertions {
        self.lookahead_lookahead_assertions_for_darkness(
            fixture_data_provider,
            param_query,
            instance_options,
            |fixture_ref, fixture_data_provider, param_query| {
                fixture_ref_is_dark_in_layer(
                    seq_layer,
                    fixture_ref,
                    fixture_data_provider,
                    param_query,
                )
            },
        )
    }

    /// Builds lookahead position assertions using the current global parameter output.
    pub fn lookahead_lookahead_assertions_for_global_output(
        &self,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
    ) -> LookaheadAssertions {
        self.lookahead_lookahead_assertions_for_darkness(
            fixture_data_provider,
            param_query,
            instance_options,
            fixture_ref_is_dark_in_global_output,
        )
    }

    /// Builds lookahead assertions for a sequence that has not started playback yet.
    pub fn preactivation_lookahead_assertions_for_global_output(
        &self,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
    ) -> LookaheadAssertions {
        let param_query_readonly = param_query.as_readonly();
        let candidates = self.preactivation_lookahead_candidates(
            fixture_data_provider,
            &param_query_readonly,
            instance_options,
        );

        lookahead_assertions_for_dark_global_candidates(
            &candidates,
            fixture_data_provider,
            param_query,
        )
    }

    /// Builds preactivation lookahead candidates without reading current output darkness.
    pub fn preactivation_lookahead_candidates(
        &self,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceRef<Parameter>>,
        instance_options: InstanceOptions,
    ) -> Vec<LookaheadCandidateAssertion> {
        let mut candidates = Vec::new();
        let mut inserted_parameters = HashSet::new();
        let mut blocked_fixtures = HashSet::new();

        self.collect_lookahead_candidates_for_mcue(
            &self.setup_cue,
            fixture_data_provider,
            param_query,
            instance_options,
            &mut inserted_parameters,
            &mut blocked_fixtures,
            &mut candidates,
            false,
        );
        if let Some(first_mcue) = self.mcues.first() {
            self.collect_lookahead_candidates_for_mcue(
                first_mcue,
                fixture_data_provider,
                param_query,
                instance_options,
                &mut inserted_parameters,
                &mut blocked_fixtures,
                &mut candidates,
                false,
            );
        }
        record_visible_intensity_fixtures_readonly(
            &self.setup_cue.values,
            fixture_data_provider,
            param_query,
            &mut blocked_fixtures,
        );
        if let Some(first_mcue) = self.mcues.first() {
            record_visible_intensity_fixtures_readonly(
                &first_mcue.values,
                fixture_data_provider,
                param_query,
                &mut blocked_fixtures,
            );
        }
        for mcue in self.mcues.iter().skip(1) {
            self.collect_lookahead_candidates_for_mcue(
                mcue,
                fixture_data_provider,
                param_query,
                instance_options,
                &mut inserted_parameters,
                &mut blocked_fixtures,
                &mut candidates,
                true,
            );
        }

        candidates
    }

    /// Builds lookahead assertions using the provided fixture darkness predicate.
    fn lookahead_lookahead_assertions_for_darkness(
        &self,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
        fixture_is_dark: impl Fn(
            &FixtureRef,
            &FixtureDataProviderExt,
            &Query<InstanceMut<Parameter>>,
        ) -> bool,
    ) -> LookaheadAssertions {
        let mut assertions = LookaheadAssertions::default();
        if self.mcues.len() <= 1 {
            return assertions;
        }

        let mut inserted_parameters = HashSet::new();
        let mut blocked_fixtures = HashSet::new();

        for index in self.lookahead_lookahead_indices() {
            let Some(mcue) = self.mcues.get(index) else {
                continue;
            };

            self.collect_lookahead_assertions_for_mcue(
                mcue,
                fixture_data_provider,
                param_query,
                instance_options,
                &fixture_is_dark,
                &mut inserted_parameters,
                &mut blocked_fixtures,
                &mut assertions,
            );
        }

        assertions
    }

    /// Collects lookahead assertions from one materialized cue into the provided accumulator.
    fn collect_lookahead_assertions_for_mcue(
        &self,
        mcue: &MaterializedCue,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
        fixture_is_dark: &impl Fn(
            &FixtureRef,
            &FixtureDataProviderExt,
            &Query<InstanceMut<Parameter>>,
        ) -> bool,
        inserted_parameters: &mut HashSet<ParameterRef>,
        blocked_fixtures: &mut HashSet<uuid::Uuid>,
        assertions: &mut LookaheadAssertions,
    ) {
        if mcue.part_layers.is_empty() {
            Self::collect_lookahead_assertions_for_layer(
                &mcue.values,
                &mcue.lookahead_parameters,
                fixture_data_provider,
                param_query,
                instance_options,
                fixture_is_dark,
                inserted_parameters,
                blocked_fixtures,
                assertions,
            );
            record_visible_intensity_fixtures(
                &mcue.values,
                fixture_data_provider,
                param_query,
                blocked_fixtures,
            );
            return;
        }

        for part_layer in &mcue.part_layers {
            Self::collect_lookahead_assertions_for_layer(
                &part_layer.values,
                &part_layer.lookahead_parameters,
                fixture_data_provider,
                param_query,
                instance_options,
                fixture_is_dark,
                inserted_parameters,
                blocked_fixtures,
                assertions,
            );
            record_visible_intensity_fixtures(
                &part_layer.values,
                fixture_data_provider,
                param_query,
                blocked_fixtures,
            );
        }
    }

    /// Collects lookahead assertions from one materialized cue-part layer.
    fn collect_lookahead_assertions_for_layer(
        layer: &Layer,
        lookahead_parameters: &HashSet<ParameterRef>,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
        fixture_is_dark: &impl Fn(
            &FixtureRef,
            &FixtureDataProviderExt,
            &Query<InstanceMut<Parameter>>,
        ) -> bool,
        inserted_parameters: &mut HashSet<ParameterRef>,
        blocked_fixtures: &mut HashSet<uuid::Uuid>,
        assertions: &mut LookaheadAssertions,
    ) {
        for (parameter, (value, _)) in layer.absolute.iter() {
            match instance_options.lookahead_enabled {
                Some(false) => continue,
                Some(true) => {}
                None if !lookahead_parameters.contains(&parameter) => continue,
                None => {}
            }
            if inserted_parameters.contains(&parameter) {
                continue;
            }
            let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
                continue;
            };
            if parameter_ref.metadata.attribute.category() != AttributeCategory::Position {
                continue;
            }
            let Some(fixture_ref) =
                fixture_data_provider.try_fixture_ref_for_parameter(&parameter_ref.instance())
            else {
                continue;
            };
            if blocked_fixtures.contains(&fixture_ref.fixture_uid) {
                continue;
            }
            if !fixture_is_dark(&fixture_ref, fixture_data_provider, param_query) {
                continue;
            }

            assertions.assertions.push(LookaheadAssertion {
                parameter: parameter_ref.instance(),
                value: *value,
                reason: LookaheadReason::Lookahead,
            });
            inserted_parameters.insert(parameter);
        }
    }

    /// Collects preactivation lookahead candidates from one materialized cue.
    fn collect_lookahead_candidates_for_mcue(
        &self,
        mcue: &MaterializedCue,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceRef<Parameter>>,
        instance_options: InstanceOptions,
        inserted_parameters: &mut HashSet<ParameterRef>,
        blocked_fixtures: &mut HashSet<uuid::Uuid>,
        candidates: &mut Vec<LookaheadCandidateAssertion>,
        record_visible_after: bool,
    ) {
        if mcue.part_layers.is_empty() {
            Self::collect_lookahead_candidates_for_layer(
                &mcue.values,
                &mcue.lookahead_parameters,
                fixture_data_provider,
                param_query,
                instance_options,
                inserted_parameters,
                blocked_fixtures,
                candidates,
            );
            if record_visible_after {
                record_visible_intensity_fixtures_readonly(
                    &mcue.values,
                    fixture_data_provider,
                    param_query,
                    blocked_fixtures,
                );
            }
            return;
        }

        for part_layer in &mcue.part_layers {
            Self::collect_lookahead_candidates_for_layer(
                &part_layer.values,
                &part_layer.lookahead_parameters,
                fixture_data_provider,
                param_query,
                instance_options,
                inserted_parameters,
                blocked_fixtures,
                candidates,
            );
            if record_visible_after {
                record_visible_intensity_fixtures_readonly(
                    &part_layer.values,
                    fixture_data_provider,
                    param_query,
                    blocked_fixtures,
                );
            }
        }
    }

    /// Collects preactivation lookahead candidates from one materialized cue-part layer.
    fn collect_lookahead_candidates_for_layer(
        layer: &Layer,
        lookahead_parameters: &HashSet<ParameterRef>,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceRef<Parameter>>,
        instance_options: InstanceOptions,
        inserted_parameters: &mut HashSet<ParameterRef>,
        blocked_fixtures: &mut HashSet<uuid::Uuid>,
        candidates: &mut Vec<LookaheadCandidateAssertion>,
    ) {
        for (parameter, (value, _)) in layer.absolute.iter() {
            match instance_options.lookahead_enabled {
                Some(false) => continue,
                Some(true) => {}
                None if !lookahead_parameters.contains(&parameter) => continue,
                None => {}
            }
            if inserted_parameters.contains(&parameter) {
                continue;
            }
            let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
                continue;
            };
            if parameter_ref.metadata.attribute.category() != AttributeCategory::Position {
                continue;
            }
            let Some(fixture_ref) =
                fixture_data_provider.try_fixture_ref_for_parameter(&parameter_ref.instance())
            else {
                continue;
            };
            if blocked_fixtures.contains(&fixture_ref.fixture_uid) {
                continue;
            }

            candidates.push(LookaheadCandidateAssertion {
                parameter: parameter_ref.instance(),
                value: *value,
                fixture_ref,
            });
            inserted_parameters.insert(parameter);
        }
    }

    /// Returns downstream cue IDs that can provide lookahead source values from this position.
    pub fn lookahead_source_cue_ids_for_all_dark_fixtures(
        &self,
        fixture_data_provider: &FixtureDataProviderExt,
        param_query: &Query<InstanceRef<Parameter>>,
        instance_options: InstanceOptions,
    ) -> Vec<u32> {
        if self.mcues.len() <= 1 {
            return Vec::new();
        }

        let mut source_cue_ids = Vec::new();
        let mut inserted_parameters = HashSet::new();
        let mut blocked_fixtures = HashSet::new();
        let mut candidates = Vec::new();

        for index in self.lookahead_lookahead_indices() {
            let Some(mcue) = self.mcues.get(index) else {
                continue;
            };

            let previous_candidate_count = candidates.len();
            self.collect_lookahead_candidates_for_mcue(
                mcue,
                fixture_data_provider,
                param_query,
                instance_options,
                &mut inserted_parameters,
                &mut blocked_fixtures,
                &mut candidates,
                true,
            );
            if candidates.len() > previous_candidate_count {
                if let Some(source_cue) = self.steps.get(index) {
                    source_cue_ids.push(source_cue.identifiers.id);
                }
            }
        }

        source_cue_ids
    }

    /// Returns downstream cue indices in nearest-first lookahead order.
    fn lookahead_lookahead_indices(&self) -> Vec<usize> {
        if self.mcues.is_empty() {
            return Vec::new();
        }

        let mut indices = ((self.position_index + 1)..self.mcues.len()).collect::<Vec<_>>();
        if self.wrap {
            indices.extend(0..self.position_index);
        }
        indices
    }
}

impl Lookahead for MaterializedSequence {
    /// Builds runtime lookahead assertions from rendered or global output state.
    fn lookahead_assertions(
        &self,
        rendered_layer: Option<&Layer>,
        fixture_data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
    ) -> LookaheadAssertions {
        match rendered_layer {
            Some(layer) => self.lookahead_lookahead_assertions(
                layer,
                fixture_data_provider,
                parameter_query,
                instance_options,
            ),
            None => self.lookahead_lookahead_assertions_for_global_output(
                fixture_data_provider,
                parameter_query,
                instance_options,
            ),
        }
    }
}

/// Converts an erased compositor parameter reference for fixture data-provider lookup.
pub(super) fn parameter_instance(parameter: ParameterRef) -> Instance<Parameter> {
    // SAFETY: This helper only creates a key for a fallible fixture data-provider lookup.
    // Missing or non-parameter entities are handled by the caller receiving `None`.
    unsafe { Instance::from_entity_unchecked(parameter.entity()) }
}

/// Returns whether a fixture element is currently dark in a rendered layer.
fn fixture_ref_is_dark_in_layer(
    layer: &Layer,
    fixture_ref: &FixtureRef,
    fixture_data_provider: &FixtureDataProviderExt,
    param_query: &Query<InstanceMut<Parameter>>,
) -> bool {
    let Some(intensity_parameter) = fixture_data_provider
        .try_parameter_for_logical_attribute(fixture_ref, &Attribute::Intensity)
    else {
        return true;
    };
    let intensity_parameter = intensity_parameter.instance;
    if layer.relative.contains_key(intensity_parameter) {
        return false;
    }
    let Ok(parameter_ref) = param_query.get(intensity_parameter.entity()) else {
        return false;
    };
    let Some((value, _)) = layer.absolute.get(intensity_parameter) else {
        return true;
    };
    let intensity = parameter_ref.resolve_value(value);

    intensity <= 0.0
}

/// Returns whether a fixture element is currently dark in the global output.
fn fixture_ref_is_dark_in_global_output(
    fixture_ref: &FixtureRef,
    fixture_data_provider: &FixtureDataProviderExt,
    param_query: &Query<InstanceMut<Parameter>>,
) -> bool {
    let Some(intensity_parameter) = fixture_data_provider
        .try_parameter_for_logical_attribute(fixture_ref, &Attribute::Intensity)
    else {
        return true;
    };
    let Ok(parameter_ref) = param_query.get(intensity_parameter.instance.entity()) else {
        return false;
    };

    parameter_ref.values.current_value <= 0.0
}

/// Filters precomputed lookahead candidates against current global output darkness.
pub fn lookahead_assertions_for_dark_global_candidates(
    candidates: &[LookaheadCandidateAssertion],
    fixture_data_provider: &FixtureDataProviderExt,
    param_query: &Query<InstanceMut<Parameter>>,
) -> LookaheadAssertions {
    let mut assertions = LookaheadAssertions::default();
    for candidate in candidates {
        if !fixture_ref_is_dark_in_global_output(
            &candidate.fixture_ref,
            fixture_data_provider,
            param_query,
        ) {
            continue;
        }
        assertions.assertions.push(LookaheadAssertion {
            parameter: candidate.parameter,
            value: candidate.value,
            reason: LookaheadReason::Lookahead,
        });
    }
    assertions
}

/// Records fixtures that a cue would make visibly lit before a later lookahead target.
fn record_visible_intensity_fixtures(
    layer: &Layer,
    fixture_data_provider: &FixtureDataProviderExt,
    param_query: &Query<InstanceMut<Parameter>>,
    blocked_fixtures: &mut HashSet<uuid::Uuid>,
) {
    for (parameter, (value, _)) in layer.absolute.iter() {
        let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
            continue;
        };
        if parameter_ref.metadata.attribute.category() != AttributeCategory::Dimmer {
            continue;
        }
        if parameter_ref.resolve_value(value) <= 0.0 {
            continue;
        }
        if let Some(fixture_ref) =
            fixture_data_provider.try_fixture_ref_for_parameter(&parameter_ref.instance())
        {
            blocked_fixtures.insert(fixture_ref.fixture_uid);
        }
    }

    for (parameter, _) in layer.relative.iter() {
        let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
            continue;
        };
        if parameter_ref.metadata.attribute.category() != AttributeCategory::Dimmer {
            continue;
        }
        if let Some(fixture_ref) =
            fixture_data_provider.try_fixture_ref_for_parameter(&parameter_ref.instance())
        {
            blocked_fixtures.insert(fixture_ref.fixture_uid);
        }
    }
}

/// Records fixtures that a cue would make visibly lit using read-only parameter access.
fn record_visible_intensity_fixtures_readonly(
    layer: &Layer,
    fixture_data_provider: &FixtureDataProviderExt,
    param_query: &Query<InstanceRef<Parameter>>,
    blocked_fixtures: &mut HashSet<uuid::Uuid>,
) {
    for (parameter, (value, _)) in layer.absolute.iter() {
        let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
            continue;
        };
        if parameter_ref.metadata.attribute.category() != AttributeCategory::Dimmer {
            continue;
        }
        if parameter_ref.resolve_value(value) <= 0.0 {
            continue;
        }
        if let Some(fixture_ref) =
            fixture_data_provider.try_fixture_ref_for_parameter(&parameter_ref.instance())
        {
            blocked_fixtures.insert(fixture_ref.fixture_uid);
        }
    }

    for (parameter, _) in layer.relative.iter() {
        let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
            continue;
        };
        if parameter_ref.metadata.attribute.category() != AttributeCategory::Dimmer {
            continue;
        }
        if let Some(fixture_ref) =
            fixture_data_provider.try_fixture_ref_for_parameter(&parameter_ref.instance())
        {
            blocked_fixtures.insert(fixture_ref.fixture_uid);
        }
    }
}
