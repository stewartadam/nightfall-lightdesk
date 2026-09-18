// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_dmx::prelude::AttributeCategory;

use super::*;
use crate::cue::BoundCueInstruction;

/// Returns whether an instruction currently resolves any position-category values.
fn instruction_has_position_values(
    instruction: &BoundCueInstruction,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
) -> bool {
    let values = if let Some(application) = &instruction.cue_instruction.blueprint_application {
        let Some(provider) = blueprint_data_provider else {
            return false;
        };
        let Ok(blueprint) = provider.get(application.blueprint_uid) else {
            return false;
        };
        blueprint.selected_values(&application.selector)
    } else {
        instruction.cue_instruction.values.clone()
    };
    values
        .keys()
        .any(|attribute| attribute.category() == AttributeCategory::Position)
}

/// Returns whether a cue contains any position-category values eligible for lookahead.
fn cue_has_position_values(
    cue: &Cue,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
) -> bool {
    cue.instructions
        .iter()
        .chain(cue.parts.iter().flat_map(|part| part.instructions.iter()))
        .any(|instruction| instruction_has_position_values(instruction, blueprint_data_provider))
}

/// Returns whether authored lookahead flags select position values from a cue.
fn cue_has_authored_lookahead_position_values(
    cue: &Cue,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
) -> bool {
    let cue_lookahead = cue.lookahead.unwrap_or_default();
    let cue_instructions_have_position = cue
        .instructions
        .iter()
        .any(|instruction| instruction_has_position_values(instruction, blueprint_data_provider));
    (cue_lookahead && cue_instructions_have_position)
        || cue.parts.iter().any(|part| {
            part.lookahead.unwrap_or_default()
                && part.instructions.iter().any(|instruction| {
                    instruction_has_position_values(instruction, blueprint_data_provider)
                })
        })
}

/// Builds the partial timing overlay represented by a sequence's default timing.
fn partial_transition_from_sequence_default(default_timing: &Transition) -> PartialTransition {
    PartialTransition {
        delay_in: Some(default_timing.delay_in.clone()),
        fade_in: Some(default_timing.fade_in.clone()),
        curve_in: Some(default_timing.curve_in),
        delay_out: Some(default_timing.delay_out.clone()),
        fade_out: Some(default_timing.fade_out.clone()),
        curve_out: Some(default_timing.curve_out),
    }
}

/// Applies sequence default timing beneath a cue's explicit timing overrides.
pub(super) fn cue_with_sequence_default_timing(cue: &Cue, default_timing: &Transition) -> Cue {
    let mut cue_with_defaults = cue.clone();
    cue_with_defaults.transitions = partial_transition_from_sequence_default(default_timing);
    cue_with_defaults
        .transitions
        .apply_some(cue.transitions.clone());
    cue_with_defaults
}

/// Returns whether the cue has instructions that scope its output to selected fixtures.
pub(super) fn cue_has_scoped_instructions(cue: &Cue) -> bool {
    !cue.instructions.is_empty() || cue.parts.iter().any(|part| !part.instructions.is_empty())
}

impl MaterializedSequence {
    /// Applies sequence priority to a materialized cue and all of its part layers.
    pub(super) fn set_cue_priority(mcue: &mut MaterializedCue, priority: Priority) {
        mcue.priority = priority;
        for part_layer in &mut mcue.part_layers {
            part_layer.values.priority = priority;
        }
    }

    /// Sets the sequence layer priority across all materialized sequence state.
    pub fn set_priority(&mut self, priority: Priority) {
        self.priority = priority;
        Self::set_cue_priority(&mut self.setup_cue, priority);
        Self::set_cue_priority(&mut self.release_cue, priority);
        for mcue in &mut self.mcues {
            Self::set_cue_priority(mcue, priority);
        }
        if let Some(release_layer) = &mut self.release_layer {
            release_layer.priority = priority;
        }
        self.invalidate_render_prefix_cache();
    }

    /// Materializes a sequence from explicit cue snapshots instead of the persisted cue store.
    pub fn materialize_from_steps(
        sequence: &Sequence,
        steps: Vec<Cue>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        Self::materialize_from_steps_with_color_paths(
            sequence,
            steps,
            None,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        )
    }

    /// Materializes a sequence from cue snapshots using optional showfile color path definitions.
    pub fn materialize_from_steps_with_color_paths(
        sequence: &Sequence,
        steps: Vec<Cue>,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        Self::materialize_from_steps_with_sources(
            sequence,
            steps,
            color_path_data_provider,
            None,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        )
    }

    /// Materializes cue snapshots using optional color path and Blueprint definitions.
    pub fn materialize_from_steps_with_sources(
        sequence: &Sequence,
        steps: Vec<Cue>,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        let step_count = steps.len();
        Self::materialize_from_steps_through_with_sources(
            sequence,
            steps,
            step_count,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        )
    }

    /// Materializes a sequence from cue snapshots through a contiguous step prefix.
    fn materialize_from_steps_through_with_sources(
        sequence: &Sequence,
        steps: Vec<Cue>,
        materialized_step_count: usize,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        let activation_time = Instant::now();
        let mut msequence = Self {
            sequence: sequence.clone(),
            priority: Default::default(),
            steps,
            wrap: sequence.wrap,
            mcues: Default::default(),
            setup_cue: MaterializedCue::materialize_with_sources(
                &sequence.setup_cue,
                color_path_data_provider,
                blueprint_data_provider,
                fixture_data_provider,
                parameter_query,
                selection_resolver,
            ),
            release_cue: MaterializedCue::materialize_with_sources(
                &sequence.release_cue,
                color_path_data_provider,
                blueprint_data_provider,
                fixture_data_provider,
                parameter_query,
                selection_resolver,
            ),
            release_layer: None,
            release_started_position: None,
            release_duration_floor: Duration::ZERO,
            position_index: 0,
            last_rendered_layer: None,
            render_prefix_cache: None,
            composition_order: Vec::new(),
            transition_source_layers: Vec::new(),
            cue_activation_positions: Vec::new(),
            activation_time,
            playback_start_position: Duration::ZERO,
            last_activation_position: Duration::ZERO,
        };

        msequence.setup_cue.set_activation_time(activation_time);
        msequence.setup_cue.set_start_position(Duration::ZERO);
        msequence.materialize_through_step_count_with_sources(
            materialized_step_count,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        );

        msequence
    }

    /// Extends the contiguous materialized cue prefix to the requested step count.
    fn materialize_through_step_count_with_sources(
        &mut self,
        requested_step_count: usize,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) {
        let target_step_count = requested_step_count.min(self.steps.len());
        while self.mcues.len() < target_step_count {
            let index = self.mcues.len();
            let cue = &self.steps[index];
            let cue_with_defaults =
                cue_with_sequence_default_timing(cue, &self.sequence.default_timing);
            let mut mcue = MaterializedCue::materialize_with_sources(
                &cue_with_defaults,
                color_path_data_provider,
                blueprint_data_provider,
                fixture_data_provider,
                parameter_query,
                selection_resolver,
            );
            mcue.record_implicit_htp_assertion_timing_with_blueprints(
                cue,
                blueprint_data_provider,
                fixture_data_provider,
                parameter_query,
                selection_resolver,
            );
            Self::set_cue_priority(&mut mcue, self.priority);
            self.mcues.push(mcue);
            self.transition_source_layers.push(None);
            self.cue_activation_positions.push(None);

            if index == 0 {
                let mcue = &mut self.mcues[0];
                mcue.set_activation_time(self.activation_time);
                mcue.set_start_position(self.playback_start_position);
                self.composition_order = vec![0];
                self.cue_activation_positions[0] = Some(self.playback_start_position);
            }
        }
    }

    /// Returns whether the contiguous prefix includes a one-based sequence position.
    pub(super) fn position_is_materialized(&self, position: u32) -> bool {
        position as usize > self.steps.len() || position as usize <= self.mcues.len()
    }

    /// Returns whether the cue targeted by forward navigation is materialized.
    pub(super) fn next_step_is_materialized(&self) -> bool {
        if self.steps.is_empty() {
            return true;
        }
        let next_position = if self.position() == self.steps.len() as u32 {
            1
        } else {
            self.position() + 1
        };
        self.position_is_materialized(next_position)
    }

    /// Returns whether the cue targeted by backward navigation is materialized.
    pub(super) fn previous_step_is_materialized(&self) -> bool {
        if self.steps.is_empty() || (self.position() == 1 && !self.wrap) {
            return true;
        }
        let previous_position = if self.position() == 1 {
            self.steps.len() as u32
        } else {
            self.position() - 1
        };
        self.position_is_materialized(previous_position)
    }

    /// Returns whether every authored cue has been materialized.
    pub(super) fn is_fully_materialized(&self) -> bool {
        self.mcues.len() >= self.steps.len()
    }

    /// Materializes through a position while resolving optional live Blueprint sources.
    pub(crate) fn materialize_through_position_with_sources(
        &mut self,
        position: u32,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) {
        self.materialize_through_step_count_with_sources(
            position as usize,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        );
    }

    /// Materializes all steps while resolving optional live Blueprint sources.
    pub(crate) fn materialize_all_steps_with_sources(
        &mut self,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) {
        self.materialize_through_step_count_with_sources(
            self.steps.len(),
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        );
    }

    /// Materializes the next step while resolving optional live Blueprint sources.
    pub(crate) fn materialize_next_step_with_sources(
        &mut self,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) {
        if self.steps.is_empty() {
            return;
        }
        let next_position = if self.position() == self.steps.len() as u32 {
            1
        } else {
            self.position() + 1
        };
        self.materialize_through_position_with_sources(
            next_position,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        );
    }

    /// Materializes the previous step while resolving optional live Blueprint sources.
    pub(crate) fn materialize_previous_step_with_sources(
        &mut self,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) {
        if self.steps.is_empty() || (self.position() == 1 && !self.wrap) {
            return;
        }
        let previous_position = if self.position() == 1 {
            self.steps.len() as u32
        } else {
            self.position() - 1
        };
        self.materialize_through_position_with_sources(
            previous_position,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        );
    }

    /// Returns whether runtime lookahead requires materializing the unvisited cue suffix.
    pub(crate) fn requires_full_materialization_for_lookahead(
        &self,
        instance_options: InstanceOptions,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    ) -> bool {
        match instance_options.lookahead_enabled {
            Some(false) => false,
            Some(true) => self
                .steps
                .iter()
                .skip(self.mcues.len())
                .any(|cue| cue_has_position_values(cue, blueprint_data_provider)),
            None => self.steps.iter().skip(self.mcues.len()).any(|cue| {
                cue_has_authored_lookahead_position_values(cue, blueprint_data_provider)
            }),
        }
    }

    /// Materializes a sequence into a materialized sequence
    pub fn materialize(
        sequence: &Sequence,
        cue_data_provider: &Res<DataProvider<Cue>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        Self::materialize_with_color_paths(
            sequence,
            cue_data_provider,
            None,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        )
    }

    /// Materializes a sequence into a materialized sequence using showfile color paths.
    pub fn materialize_with_color_paths(
        sequence: &Sequence,
        cue_data_provider: &Res<DataProvider<Cue>>,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        Self::materialize_with_sources(
            sequence,
            cue_data_provider,
            color_path_data_provider,
            None,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        )
    }

    /// Materializes a sequence using optional color path and Blueprint definitions.
    pub fn materialize_with_sources(
        sequence: &Sequence,
        cue_data_provider: &Res<DataProvider<Cue>>,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        let mut steps: Vec<Cue> = Vec::new();
        for cue_uid in &sequence.steps {
            let cue_id: uuid::Uuid = (*cue_uid).into();
            match cue_data_provider.get(cue_id) {
                Ok(cue_ref) => steps.push((*cue_ref).clone()),
                Err(err) => {
                    tracing::warn!(
                        uid = %sequence.identifiers.uid,
                        cue_uid = %cue_id,
                        "Skipping missing cue while materializing sequence '{}': {}",
                        sequence.identifiers.label,
                        err
                    );
                }
            }
        }

        Self::materialize_from_steps_with_sources(
            sequence,
            steps,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        )
    }

    /// Materializes the initial playback prefix while resolving live Blueprint sources.
    pub(crate) fn materialize_initial_with_sources(
        sequence: &Sequence,
        cue_data_provider: &Res<DataProvider<Cue>>,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        let mut steps = Vec::with_capacity(sequence.steps.len());
        for cue_uid in &sequence.steps {
            let cue_id: uuid::Uuid = (*cue_uid).into();
            match cue_data_provider.get(cue_id) {
                Ok(cue_ref) => steps.push((*cue_ref).clone()),
                Err(err) => {
                    tracing::warn!(
                        uid = %sequence.identifiers.uid,
                        cue_uid = %cue_id,
                        "Skipping missing cue while materializing sequence '{}': {}",
                        sequence.identifiers.label,
                        err
                    );
                }
            }
        }

        Self::materialize_from_steps_through_with_sources(
            sequence,
            steps,
            1,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use nightfall_dmx::prelude::Attribute;

    use super::*;
    use crate::cue::{BoundCueInstruction, CueInstruction};

    /// Builds a cue containing one absolute value for lookahead predicate tests.
    fn cue_with_attribute(attribute: Attribute, lookahead: Option<bool>) -> Cue {
        Cue {
            lookahead,
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::default(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        attribute,
                        ValueSource::Inline(ParameterValue::Absolute { value: 1.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        }
    }

    /// Builds a cue whose values are resolved from one live Blueprint application.
    fn cue_with_blueprint_application(
        blueprint_uid: uuid::Uuid,
        selector: BlueprintSelector,
        lookahead: Option<bool>,
    ) -> Cue {
        Cue {
            lookahead,
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::default(),
                cue_instruction: CueInstruction {
                    blueprint_application: Some(BlueprintApplication {
                        blueprint_uid,
                        selector,
                    }),
                    ..Default::default()
                },
            }],
            ..Default::default()
        }
    }

    /// Verifies forced lookahead does not expand downstream intensity-only cues.
    #[test]
    fn forced_lookahead_skips_non_position_suffix() {
        let sequence = MaterializedSequence {
            steps: vec![cue_with_attribute(Attribute::Intensity, None)],
            ..Default::default()
        };

        assert!(!sequence.requires_full_materialization_for_lookahead(
            InstanceOptions {
                lookahead_enabled: Some(true),
            },
            None,
        ));
    }

    /// Verifies forced lookahead expands a suffix containing position values.
    #[test]
    fn forced_lookahead_expands_position_suffix() {
        let sequence = MaterializedSequence {
            steps: vec![cue_with_attribute(Attribute::Pan, None)],
            ..Default::default()
        };

        assert!(sequence.requires_full_materialization_for_lookahead(
            InstanceOptions {
                lookahead_enabled: Some(true),
            },
            None,
        ));
    }

    /// Verifies forced lookahead inspects the current values behind a live Blueprint row.
    #[test]
    fn forced_lookahead_expands_referenced_position_suffix() {
        let blueprint_uid = uuid::Uuid::new_v4();
        let mut blueprints = DataProvider::<Blueprint>::default();
        blueprints
            .add(Blueprint {
                identifiers: Identifiers {
                    id: 5,
                    uid: blueprint_uid,
                    label: "Position".to_owned(),
                },
                values: HashMap::from([(
                    Attribute::Pan,
                    ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
                )]),
                ..Default::default()
            })
            .expect("Blueprint should be insertable");
        let sequence = MaterializedSequence {
            steps: vec![cue_with_blueprint_application(
                blueprint_uid,
                BlueprintSelector::Category(AttributeCategory::Position),
                None,
            )],
            ..Default::default()
        };

        assert!(sequence.requires_full_materialization_for_lookahead(
            InstanceOptions {
                lookahead_enabled: Some(true),
            },
            Some(&blueprints),
        ));
    }

    /// Verifies inherited lookahead expands only authored position lookahead.
    #[test]
    fn inherited_lookahead_requires_authored_position_values() {
        let mut sequence = MaterializedSequence {
            steps: vec![
                cue_with_attribute(Attribute::Pan, Some(false)),
                cue_with_attribute(Attribute::Intensity, Some(true)),
            ],
            ..Default::default()
        };
        assert!(!sequence.requires_full_materialization_for_lookahead(
            InstanceOptions {
                lookahead_enabled: None,
            },
            None,
        ));

        sequence
            .steps
            .push(cue_with_attribute(Attribute::Tilt, Some(true)));
        assert!(sequence.requires_full_materialization_for_lookahead(
            InstanceOptions {
                lookahead_enabled: None,
            },
            None,
        ));
    }
}
