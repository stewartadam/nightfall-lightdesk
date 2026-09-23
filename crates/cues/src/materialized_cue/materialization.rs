// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_engine::prelude::DataProvider;

use super::*;

impl MaterializedCue {
    /// Records transition duration information in the existing compatibility fields.
    fn record_transition_duration(&mut self, transition: &MaterializedTransition) {
        self.duration_profile.record_transition(transition);
        let profile = self.duration_profile;
        self.max_delay_in = self.max_delay_in.max(profile.max_delay_in);
        self.max_fade_in = self.max_fade_in.max(profile.max_fade_in);
        self.max_fade_out = self.max_fade_out.max(profile.max_fade_out);
        self.max_assertion_duration = self
            .max_assertion_duration
            .max(profile.cue_entry_duration());
    }

    /// Returns direct values or the current values selected by a live Blueprint application.
    fn resolved_instruction_values(
        instruction: &CueInstruction,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    ) -> HashMap<Attribute, ValueSource> {
        let Some(application) = &instruction.blueprint_application else {
            return instruction.values.clone();
        };
        let Some(provider) = blueprint_data_provider else {
            tracing::warn!(
                blueprint_uid = %application.blueprint_uid,
                "Blueprint application could not materialize without a Blueprint provider"
            );
            return HashMap::new();
        };
        let Ok(blueprint) = provider.get(application.blueprint_uid) else {
            tracing::warn!(
                blueprint_uid = %application.blueprint_uid,
                "Blueprint application references a missing definition"
            );
            return HashMap::new();
        };
        blueprint.selected_values(&application.selector)
    }

    /// Resolves a single fixture reference into potentially multiple fixture references.
    /// If the reference has no index, it expands to all elements of the fixture.
    pub(crate) fn resolve_fixture_refs(
        fixture_ref: &FixtureRef,
        data_provider: &FixtureDataProviderExt,
    ) -> Vec<FixtureRef> {
        match data_provider.inner.get(fixture_ref.fixture_uid) {
            Ok(fixture) => match fixture_ref.index {
                None => (1..=fixture.elements.len() as u32)
                    .map(|i| FixtureRef {
                        fixture_uid: fixture.identifiers.uid,
                        index: Some(i),
                    })
                    .collect(),
                Some(_) => vec![fixture_ref.clone()],
            },
            Err(e) => {
                tracing::error!("Failed to resolve fixture reference: {}", e);
                vec![]
            }
        }
    }

    /// Resolves the transition for a given attribute and instruction.
    pub(crate) fn resolve_transition(
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        attribute: &Attribute,
        concrete_attribute: &Attribute,
        selection_index: usize,
        selection_size: usize,
        start_position: Duration,
    ) -> MaterializedTransition {
        let transition = Self::resolve_transition_definition(
            transitions,
            transitions_by_attribute,
            cue_instruction,
            fixture_ref,
            attribute,
            concrete_attribute,
        );

        MaterializedTransition::from_transition_at_position(
            &transition,
            selection_index,
            selection_size,
            start_position,
        )
    }

    /// Resolves the merged transition definition for a given attribute and instruction.
    pub(crate) fn resolve_transition_definition(
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        attribute: &Attribute,
        concrete_attribute: &Attribute,
    ) -> Transition {
        let authored_transition = Self::resolve_partial_transition_definition(
            transitions,
            transitions_by_attribute,
            cue_instruction,
            fixture_ref,
            attribute,
            concrete_attribute,
        );

        let mut transition = Transition::default();
        if Self::attribute_uses_assertion_in_timing(concrete_attribute) {
            if authored_transition.fade_in.is_none() {
                transition.fade_in = authored_transition.fade_out.clone().unwrap_or_default();
            }
            if authored_transition.delay_in.is_none() {
                transition.delay_in = authored_transition.delay_out.clone().unwrap_or_default();
            }
        }
        transition.apply_some(authored_transition);
        transition
    }

    /// Returns whether assertion fades for an attribute should use transition-in timing.
    fn attribute_uses_assertion_in_timing(attribute: &Attribute) -> bool {
        !matches!(
            attribute,
            Attribute::Intensity | Attribute::VirtualIntensity
        )
    }

    /// Resolves the merged authored transition overlays for a fixture attribute.
    fn resolve_partial_transition_definition(
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        attribute: &Attribute,
        concrete_attribute: &Attribute,
    ) -> PartialTransition {
        let cue_attribute_transition = Self::resolve_attribute_transition(
            transitions_by_attribute,
            attribute,
            concrete_attribute,
        );

        let cue_instruction_attribute_transition = Self::resolve_attribute_transition(
            &cue_instruction.transitions_by_attribute,
            attribute,
            concrete_attribute,
        );
        let fixture_attribute_transition = Self::resolve_fixture_attribute_transition(
            cue_instruction,
            fixture_ref,
            attribute,
            concrete_attribute,
        );

        let mut transition = PartialTransition::default();
        transition.apply_some(transitions.clone());
        transition.apply_some(cue_attribute_transition);
        transition.apply_some(cue_instruction.transitions.clone());
        transition.apply_some(cue_instruction_attribute_transition);
        transition.apply_some(fixture_attribute_transition);
        transition
    }

    fn resolve_attribute_transition(
        transitions_by_attribute: &AttributeTransitions,
        attribute: &Attribute,
        concrete_attribute: &Attribute,
    ) -> PartialTransition {
        let mut transition = PartialTransition::default();
        if let Some(attribute_transition) = transitions_by_attribute.get(attribute) {
            transition.apply_some(attribute_transition.clone());
        }
        if concrete_attribute != attribute {
            if let Some(attribute_transition) = transitions_by_attribute.get(concrete_attribute) {
                transition.apply_some(attribute_transition.clone());
            }
        }
        transition
    }

    fn resolve_fixture_attribute_transition(
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        attribute: &Attribute,
        concrete_attribute: &Attribute,
    ) -> PartialTransition {
        let mut transition = PartialTransition::default();

        for entry in &cue_instruction.transitions_by_fixture_attribute {
            let matches_fixture_wide = entry.fixture.fixture_uid == fixture_ref.fixture_uid
                && entry.fixture.index.is_none();
            if matches_fixture_wide {
                transition.apply_some(Self::resolve_attribute_transition(
                    &entry.transitions_by_attribute,
                    attribute,
                    concrete_attribute,
                ));
            }
        }

        for entry in &cue_instruction.transitions_by_fixture_attribute {
            let matches_exact = entry.fixture == *fixture_ref;
            if !matches_exact {
                continue;
            }
            transition.apply_some(Self::resolve_attribute_transition(
                &entry.transitions_by_attribute,
                attribute,
                concrete_attribute,
            ));
        }

        transition
    }

    /// Returns whether a partial transition contains release-side timing fields.
    fn partial_transition_has_release_fields(transition: &PartialTransition) -> bool {
        transition.delay_out.is_some()
            || transition.fade_out.is_some()
            || transition.curve_out.is_some()
    }

    /// Collects attributes with explicit release-side timing but not necessarily values.
    pub(crate) fn release_timing_override_attributes(
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        cue_instruction: &CueInstruction,
    ) -> Vec<Attribute> {
        let mut attributes = HashSet::new();
        if Self::partial_transition_has_release_fields(transitions)
            || Self::partial_transition_has_release_fields(&cue_instruction.transitions)
        {
            attributes.extend(cue_instruction.values.keys().cloned());
            attributes.insert(Attribute::Intensity);
        }
        attributes.extend(
            transitions_by_attribute
                .iter()
                .filter_map(|(attribute, transition)| {
                    Self::partial_transition_has_release_fields(transition)
                        .then_some(attribute.clone())
                }),
        );
        attributes.extend(cue_instruction.transitions_by_attribute.iter().filter_map(
            |(attribute, transition)| {
                Self::partial_transition_has_release_fields(transition).then_some(attribute.clone())
            },
        ));
        for fixture_transition in &cue_instruction.transitions_by_fixture_attribute {
            attributes.extend(
                fixture_transition
                    .transitions_by_attribute
                    .iter()
                    .filter_map(|(attribute, transition)| {
                        Self::partial_transition_has_release_fields(transition)
                            .then_some(attribute.clone())
                    }),
            );
        }
        attributes.into_iter().collect()
    }

    /// Returns whether this materialized cue already has an output value for a parameter.
    fn has_value_for_parameter(&self, parameter: &Instance<Parameter>) -> bool {
        self.values.absolute.contains_key(parameter) || self.values.relative.contains_key(parameter)
    }

    /// Materializes release-side timing for a selected fixture attribute without adding output values.
    fn materialize_release_timing_for_fixture(
        &mut self,
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        attribute: &Attribute,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        offset: usize,
        total: usize,
    ) {
        let Some(resolved_parameter) =
            data_provider.try_parameter_for_logical_attribute(fixture_ref, attribute)
        else {
            return;
        };
        let concrete_attribute = resolved_parameter.attribute;
        let parameter_entity = resolved_parameter.instance;
        let Ok(parameter) = parameter_query.get(parameter_entity.entity()) else {
            tracing::warn!(
                attribute = ?concrete_attribute,
                "Failed to find parameter for release timing"
            );
            return;
        };
        if self.has_value_for_parameter(&parameter.instance()) {
            return;
        }

        let transition = Self::resolve_transition(
            transitions,
            transitions_by_attribute,
            cue_instruction,
            fixture_ref,
            attribute,
            &concrete_attribute,
            offset,
            total,
            self.start_position,
        );
        self.release_timing_overrides
            .insert(parameter.instance(), transition);
    }

    /// Resolves a fanned value for a specific fixture position.
    /// Interpolates between waypoints based on fixture position in the selection.
    pub(super) fn resolve_fanned_value(
        values: &[ParameterValue],
        fixture_index: usize,
        total_fixtures: usize,
    ) -> ParameterValue {
        if values.is_empty() {
            // Default to 0% absolute
            return ParameterValue::AbsolutePercent { value: 0.0.into() };
        }
        if values.len() == 1 || total_fixtures <= 1 {
            return values[0];
        }

        // Calculate the position in the range [0.0, 1.0]
        if values.len() == total_fixtures {
            return values[fixture_index];
        }

        let t = fixture_index as f64 / (total_fixtures - 1).max(1) as f64;

        // Map t to a position in the values array
        let max_segment = values.len() - 1;
        let segment_position = t * max_segment as f64;
        let segment_idx = (segment_position as usize).min(max_segment - 1);
        let segment_t = segment_position - segment_idx as f64;

        // Interpolate between values[segment_idx] and values[segment_idx + 1]
        let start = &values[segment_idx];
        let end = &values[segment_idx + 1];

        // Extract percentages for interpolation
        match (start, end) {
            (
                ParameterValue::AbsolutePercent { value: start_val },
                ParameterValue::AbsolutePercent { value: end_val },
            ) => {
                let start_f = start_val.as_f64();
                let end_f = end_val.as_f64();
                let interpolated = start_f + segment_t * (end_f - start_f);
                ParameterValue::AbsolutePercent {
                    value: interpolated.into(),
                }
            }
            (
                ParameterValue::RelativePercent { offset: start_off },
                ParameterValue::RelativePercent { offset: end_off },
            ) => {
                let start_f = start_off.as_f64();
                let end_f = end_off.as_f64();
                let interpolated = start_f + segment_t * (end_f - start_f);
                ParameterValue::RelativePercent {
                    offset: interpolated.into(),
                }
            }
            (
                ParameterValue::Absolute { value: start_val },
                ParameterValue::Absolute { value: end_val },
            ) => {
                let interpolated = *start_val + segment_t * (*end_val - *start_val);
                ParameterValue::Absolute {
                    value: interpolated.round(),
                }
            }
            // Mixed types: just use the start value
            _ => *start,
        }
    }

    /// Processes a single value source and adds it to the materialized cue.
    fn process_values_for_fixture(
        &mut self,
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        cue_instruction: &CueInstruction,
        selection: &ResolvedSelection,
        invert: bool,
        fixture_ref: &FixtureRef,
        attribute: &Attribute,
        source: &ValueSource,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        offset: usize,
        total: usize,
        lookahead_enabled: bool,
    ) {
        let Some(resolved_parameter) =
            data_provider.try_parameter_for_logical_attribute(fixture_ref, attribute)
        else {
            // Skip fixtures that don't have this attribute
            return;
        };
        let concrete_attribute = resolved_parameter.attribute;
        let parameter_entity = resolved_parameter.instance;
        let Ok(parameter) = parameter_query.get(parameter_entity.entity()) else {
            tracing::warn!(
                attribute = ?concrete_attribute,
                "Failed to find parameter"
            );
            return;
        };
        let parameter_instance = parameter.instance();

        match source {
            ValueSource::Release => {
                let transition = Self::resolve_transition(
                    transitions,
                    transitions_by_attribute,
                    cue_instruction,
                    fixture_ref,
                    attribute,
                    &concrete_attribute,
                    offset,
                    total,
                    self.start_position,
                );
                self.record_transition_duration(&transition);
                self.release_values.insert(parameter_instance.into());
                self.release_value_transitions
                    .insert(parameter_instance, transition);
                return;
            }
            ValueSource::HoldPosition => {
                self.hold_position_values.insert(parameter_instance.into());
                return;
            }
            ValueSource::Inline(_) | ValueSource::Fanned { .. } => {}
        }
        self.release_values
            .remove(&ParameterRef::from(parameter_instance));
        self.release_value_transitions
            .remove(ParameterRef::from(parameter_instance));

        let parameter_value = match source {
            ValueSource::Inline(value) => *value,
            ValueSource::Fanned { values } => Self::resolve_fanned_value(values, offset, total),
            ValueSource::Release | ValueSource::HoldPosition => {
                return;
            }
        };
        let parameter_value = if invert && selection.should_invert_attribute(&concrete_attribute) {
            parameter_value.inverted(
                parameter.metadata.logical_min(),
                parameter.metadata.logical_max(),
                parameter.metadata.value_polarity,
            )
        } else {
            parameter_value
        };

        let transition = Self::resolve_transition(
            transitions,
            transitions_by_attribute,
            cue_instruction,
            fixture_ref,
            attribute,
            &concrete_attribute,
            offset,
            total,
            self.start_position,
        );

        self.record_transition_duration(&transition);

        // We must start a span for each log because field filters can only be applied to spans.
        // See: https://github.com/tokio-rs/tracing/issues/2843#issuecomment-1884545840
        let _span =
        tracing::trace_span!("materialized_transitions", entity = %parameter_entity.entity(), attribute = ?parameter.metadata.attribute).entered();

        tracing::trace!(
            uid=%self.cue.identifiers().uid,
            entity = %parameter_entity,
            attribute=?parameter.metadata.attribute,
            value=%parameter_value,
            transition = ?transition,
            cue_label = %self.identifiers().label,
            "Setting parameter with transition for cue"
        );

        if parameter_value.is_relative() {
            self.values
                .relative
                .insert(parameter_instance, (parameter_value, Some(transition)));
        } else {
            if lookahead_enabled {
                self.lookahead_parameters.insert(parameter_instance.into());
            } else {
                self.lookahead_parameters
                    .remove(&ParameterRef::from(parameter_instance));
            }
            self.values
                .absolute
                .insert(parameter_instance, (parameter_value, Some(transition)));
        }
    }

    /// Records implicit HTP timing after resolving any live Blueprint applications.
    pub(crate) fn record_implicit_htp_assertion_timing_with_blueprints(
        &mut self,
        cue: &Cue,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) {
        self.record_implicit_htp_assertion_timing_for_instructions(
            &cue.instructions,
            &cue.transitions,
            &cue.transitions_by_attribute,
            blueprint_data_provider,
            data_provider,
            parameter_query,
            selection_resolver,
        );

        for part in &cue.parts {
            let part_transition = Self::inherited_part_transition(cue, part);
            let part_attribute_transitions = Self::inherited_part_attribute_transitions(cue, part);
            self.record_implicit_htp_assertion_timing_for_instructions(
                &part.instructions,
                &part_transition,
                &part_attribute_transitions,
                blueprint_data_provider,
                data_provider,
                parameter_query,
                selection_resolver,
            );
        }
    }

    /// Records implicit HTP assertion timing for a cue or cue part instruction list.
    fn record_implicit_htp_assertion_timing_for_instructions(
        &mut self,
        instructions: &[BoundCueInstruction],
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) {
        for bound_instructions in instructions {
            let selection = filter_existing_selection(
                &selection_resolver
                    .resolve(&bound_instructions.selection)
                    .into_value(),
                data_provider,
            );
            for resolved_index in selection.iter_non_empty_indexes() {
                let fixture_refs: Vec<FixtureRef> = resolved_index
                    .members
                    .iter()
                    .flat_map(|member| Self::resolve_fixture_refs(&member.fixture, data_provider))
                    .collect();

                let values = Self::resolved_instruction_values(
                    &bound_instructions.cue_instruction,
                    blueprint_data_provider,
                );
                for (attribute, source) in &values {
                    if !matches!(source, ValueSource::Inline(_) | ValueSource::Fanned { .. }) {
                        continue;
                    }
                    for fixture_ref in &fixture_refs {
                        self.record_implicit_htp_assertion_timing_for_fixture(
                            transitions,
                            transitions_by_attribute,
                            &bound_instructions.cue_instruction,
                            fixture_ref,
                            attribute,
                            data_provider,
                            parameter_query,
                        );
                    }
                }
            }
        }
    }

    /// Records implicit HTP assertion timing for one resolved fixture attribute.
    fn record_implicit_htp_assertion_timing_for_fixture(
        &mut self,
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        attribute: &Attribute,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
    ) {
        let Some(resolved_parameter) =
            data_provider.try_parameter_for_logical_attribute(fixture_ref, attribute)
        else {
            return;
        };
        let concrete_attribute = resolved_parameter.attribute;
        let parameter_entity = resolved_parameter.instance;
        let Ok(parameter) = parameter_query.get(parameter_entity.entity()) else {
            return;
        };
        let parameter_instance = parameter.instance();
        let authored_transition = Self::resolve_partial_transition_definition(
            transitions,
            transitions_by_attribute,
            cue_instruction,
            fixture_ref,
            attribute,
            &concrete_attribute,
        );

        if !Self::partial_transition_has_release_fields(&authored_transition) {
            self.implicit_htp_assertion_timing
                .insert(parameter_instance.into());
        } else {
            self.implicit_htp_assertion_timing
                .remove(&ParameterRef::from(parameter_instance));
        }
    }

    /// Materializes cue instructions into output values and timing-only release overrides.
    fn materialize_instructions(
        &mut self,
        instructions: &[BoundCueInstruction],
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
        lookahead_enabled: bool,
    ) {
        for bound_instructions in instructions {
            let selection = filter_existing_selection(
                &selection_resolver
                    .resolve(&bound_instructions.selection)
                    .into_value(),
                data_provider,
            );
            let total_indexes = selection.iter_non_empty_indexes().count();

            for (selection_index, resolved_index) in selection.iter_non_empty_indexes().enumerate()
            {
                let fixture_refs: Vec<FixtureRef> = resolved_index
                    .members
                    .iter()
                    .flat_map(|member| Self::resolve_fixture_refs(&member.fixture, data_provider))
                    .collect();

                for fixture_ref in &fixture_refs {
                    self.materialize_color_path_group_for_fixture(
                        &bound_instructions.cue_instruction,
                        fixture_ref,
                        color_path_data_provider,
                        data_provider,
                        parameter_query,
                    );
                }

                let values = Self::resolved_instruction_values(
                    &bound_instructions.cue_instruction,
                    blueprint_data_provider,
                );
                for (attribute, source) in &values {
                    for fixture_ref in &fixture_refs {
                        self.process_values_for_fixture(
                            transitions,
                            transitions_by_attribute,
                            &bound_instructions.cue_instruction,
                            &selection,
                            resolved_index.invert,
                            fixture_ref,
                            attribute,
                            source,
                            data_provider,
                            parameter_query,
                            selection_index,
                            total_indexes,
                            lookahead_enabled,
                        );
                    }
                }

                let release_timing_attributes = Self::release_timing_override_attributes(
                    transitions,
                    transitions_by_attribute,
                    &bound_instructions.cue_instruction,
                );
                for attribute in &release_timing_attributes {
                    for fixture_ref in &fixture_refs {
                        self.materialize_release_timing_for_fixture(
                            transitions,
                            transitions_by_attribute,
                            &bound_instructions.cue_instruction,
                            fixture_ref,
                            attribute,
                            data_provider,
                            parameter_query,
                            selection_index,
                            total_indexes,
                        );
                    }
                }
            }
        }
    }

    /// Materializes one color-vector path group for a fixture when the instruction has a color path.
    fn materialize_color_path_group_for_fixture(
        &mut self,
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
    ) {
        let Some(color_path_id) = cue_instruction
            .color_path_id
            .or_else(|| data_provider.color_path_default_for_element(fixture_ref))
        else {
            return;
        };
        let Some(path) = Self::resolve_color_path(color_path_id, color_path_data_provider) else {
            tracing::warn!(
                color_path_id = color_path_id.0,
                "Skipping cue color path because the path definition could not be resolved"
            );
            return;
        };

        for model in [
            MaterializedColorPathModel::Rgb,
            MaterializedColorPathModel::Cmy,
        ] {
            if let Some(group) = Self::materialized_color_path_group_for_model(
                cue_instruction,
                fixture_ref,
                path.clone(),
                model,
                data_provider,
                parameter_query,
            ) {
                self.color_path_groups.push(group);
                return;
            }
        }

        if let Some(group) = Self::materialized_scalar_color_path_group(
            cue_instruction,
            fixture_ref,
            path,
            data_provider,
            parameter_query,
        ) {
            self.color_path_scalar_groups.push(group);
        }
    }

    /// Builds a materialized color path group for one supported color-vector model.
    fn materialized_color_path_group_for_model(
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        path: ColorPath,
        model: MaterializedColorPathModel,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
    ) -> Option<MaterializedColorPathGroup> {
        let [first_attribute, second_attribute, third_attribute] = model.attributes();
        if !cue_instruction.values.contains_key(&first_attribute)
            || !cue_instruction.values.contains_key(&second_attribute)
            || !cue_instruction.values.contains_key(&third_attribute)
        {
            return None;
        }
        let first =
            data_provider.try_parameter_for_logical_attribute(fixture_ref, &first_attribute)?;
        let second =
            data_provider.try_parameter_for_logical_attribute(fixture_ref, &second_attribute)?;
        let third =
            data_provider.try_parameter_for_logical_attribute(fixture_ref, &third_attribute)?;
        if parameter_query.get(first.instance.entity()).is_err()
            || parameter_query.get(second.instance.entity()).is_err()
            || parameter_query.get(third.instance.entity()).is_err()
        {
            return None;
        }
        let auxiliary_emitters = model
            .auxiliary_attributes()
            .into_iter()
            .filter_map(|attribute| {
                if !cue_instruction.values.contains_key(&attribute) {
                    return None;
                }
                let parameter =
                    data_provider.try_parameter_for_logical_attribute(fixture_ref, &attribute)?;
                if parameter_query.get(parameter.instance.entity()).is_err() {
                    return None;
                }
                Some((attribute.clone(), parameter.instance))
            })
            .collect();
        let decomposed_emitters = model
            .decomposed_attributes()
            .iter()
            .filter_map(|attribute| {
                if cue_instruction.values.contains_key(attribute) {
                    return None;
                }
                let parameter =
                    data_provider.try_parameter_for_logical_attribute(fixture_ref, attribute)?;
                if parameter_query.get(parameter.instance.entity()).is_err() {
                    return None;
                }
                Some((attribute.clone(), parameter.instance))
            })
            .collect();

        Some(MaterializedColorPathGroup {
            path,
            model,
            red: first.instance,
            green: second.instance,
            blue: third.instance,
            auxiliary_emitters,
            decomposed_emitters,
        })
    }

    /// Builds a scalar color path group for color emitters that cannot form an RGB/CMY vector.
    fn materialized_scalar_color_path_group(
        cue_instruction: &CueInstruction,
        fixture_ref: &FixtureRef,
        path: ColorPath,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
    ) -> Option<MaterializedColorPathScalarGroup> {
        let emitters: Vec<_> = Self::scalar_color_path_attributes()
            .into_iter()
            .filter_map(|attribute| {
                if !cue_instruction.values.contains_key(&attribute) {
                    return None;
                }
                let parameter =
                    data_provider.try_parameter_for_logical_attribute(fixture_ref, &attribute)?;
                if parameter_query.get(parameter.instance.entity()).is_err() {
                    return None;
                }
                Some((attribute, parameter.instance))
            })
            .collect();

        if emitters.is_empty() {
            return None;
        }

        Some(MaterializedColorPathScalarGroup { path, emitters })
    }

    /// Returns scalar color emitters supported by color path timing without an RGB/CMY vector.
    fn scalar_color_path_attributes() -> [Attribute; 5] {
        [
            Attribute::White,
            Attribute::Amber,
            Attribute::WarmWhite,
            Attribute::CoolWhite,
            Attribute::UV,
        ]
    }

    /// Resolves a color path assignment against showfile paths, then built-ins.
    fn resolve_color_path(
        color_path_id: ColorPathId,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
    ) -> Option<ColorPath> {
        if let Some(color_path_data_provider) = color_path_data_provider
            && let Ok(path) = color_path_data_provider.from_id(color_path_id.0)
        {
            return Some((*path).clone());
        }
        builtin_color_paths()
            .into_iter()
            .find(|path| path.identifiers.id == color_path_id.0)
    }

    /// Merges parent cue transitions with a cue part's explicit timing overrides.
    pub(crate) fn inherited_part_transition(cue: &Cue, part: &CuePart) -> PartialTransition {
        part.transition_inheriting(cue)
    }

    /// Merges parent cue attribute transitions with cue-part attribute overrides.
    pub(crate) fn inherited_part_attribute_transitions(
        cue: &Cue,
        part: &CuePart,
    ) -> AttributeTransitions {
        let mut transitions = cue.transitions_by_attribute.clone();
        for (attribute, part_transition) in part.transitions_by_attribute.clone() {
            transitions
                .entry(attribute)
                .and_modify(|transition| {
                    transition.apply_some(part_transition.clone());
                })
                .or_insert(part_transition);
        }
        transitions
    }

    /// Generates a materialized cue from cue values.
    ///
    /// Looks up Parameters for fixtures, by attribute, for cue values and sets them
    /// with a transition if applicable. During this process, any references to
    /// groups, presets or palettes are dereferenced.
    pub fn materialize(
        cue: &Cue,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        Self::materialize_with_color_paths(
            cue,
            None,
            data_provider,
            parameter_query,
            selection_resolver,
        )
    }

    /// Builds one ordered materialized cue part layer from an instruction list.
    fn materialize_part_layer(
        cue: &Cue,
        instructions: &[BoundCueInstruction],
        transitions: &PartialTransition,
        transitions_by_attribute: &AttributeTransitions,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
        lookahead_enabled: bool,
    ) -> Self {
        let mut part_layer = MaterializedCue {
            cue: cue.clone(),
            ..Default::default()
        };
        part_layer.materialize_instructions(
            instructions,
            transitions,
            transitions_by_attribute,
            color_path_data_provider,
            blueprint_data_provider,
            data_provider,
            parameter_query,
            selection_resolver,
            lookahead_enabled,
        );
        part_layer
    }

    /// Merges an ordered materialized part layer into this cue's aggregate state.
    fn append_materialized_part_layer(&mut self, part_layer: MaterializedCue) {
        let has_renderable_values =
            !part_layer.values.absolute.is_empty() || !part_layer.values.relative.is_empty();
        if has_renderable_values
            || !part_layer.color_path_groups.is_empty()
            || !part_layer.color_path_scalar_groups.is_empty()
            || !part_layer.release_values.is_empty()
        {
            self.part_layers.push(MaterializedCuePartLayer {
                values: part_layer.values.clone(),
                lookahead_parameters: part_layer.lookahead_parameters.clone(),
                release_values: part_layer.release_values.clone(),
                release_value_transitions: part_layer.release_value_transitions.clone(),
                color_path_groups: part_layer.color_path_groups.clone(),
                color_path_scalar_groups: part_layer.color_path_scalar_groups.clone(),
            });
        }

        self.values.squash(part_layer.values);
        self.release_timing_overrides
            .extend_map(part_layer.release_timing_overrides);
        for parameter in self
            .values
            .absolute
            .keys()
            .chain(self.values.relative.keys())
            .collect::<Vec<_>>()
        {
            self.release_values.remove(&parameter);
            self.release_value_transitions.remove(parameter);
        }
        self.release_values.extend(part_layer.release_values);
        self.release_value_transitions
            .extend_map(part_layer.release_value_transitions);
        self.hold_position_values
            .extend(part_layer.hold_position_values);
        self.lookahead_parameters
            .extend(part_layer.lookahead_parameters);
        self.color_path_groups.extend(part_layer.color_path_groups);
        self.color_path_scalar_groups
            .extend(part_layer.color_path_scalar_groups);
        self.max_fade_in = self.max_fade_in.max(part_layer.max_fade_in);
        self.max_delay_in = self.max_delay_in.max(part_layer.max_delay_in);
        self.max_fade_out = self.max_fade_out.max(part_layer.max_fade_out);
        self.max_assertion_duration = self
            .max_assertion_duration
            .max(part_layer.max_assertion_duration);
        self.duration_profile.max_delay_in = self
            .duration_profile
            .max_delay_in
            .max(part_layer.duration_profile.max_delay_in);
        self.duration_profile.max_fade_in = self
            .duration_profile
            .max_fade_in
            .max(part_layer.duration_profile.max_fade_in);
        self.duration_profile.max_delay_out = self
            .duration_profile
            .max_delay_out
            .max(part_layer.duration_profile.max_delay_out);
        self.duration_profile.max_fade_out = self
            .duration_profile
            .max_fade_out
            .max(part_layer.duration_profile.max_fade_out);
        self.duration_profile.assertion_duration = self
            .duration_profile
            .assertion_duration
            .max(part_layer.duration_profile.assertion_duration);
        self.duration_profile.release_duration = self
            .duration_profile
            .release_duration
            .max(part_layer.duration_profile.release_duration);
        self.duration_profile.max_transition_duration = self
            .duration_profile
            .max_transition_duration
            .max(part_layer.duration_profile.max_transition_duration);
    }

    /// Generates a materialized cue from cue values using showfile color path definitions.
    pub fn materialize_with_color_paths(
        cue: &Cue,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        Self::materialize_with_sources(
            cue,
            color_path_data_provider,
            None,
            data_provider,
            parameter_query,
            selection_resolver,
        )
    }

    /// Generates a materialized cue while resolving color paths and live Blueprints.
    pub fn materialize_with_sources(
        cue: &Cue,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> Self {
        let mut mcue = MaterializedCue {
            cue: cue.clone(),
            ..Default::default()
        };

        let cue_body_layer = Self::materialize_part_layer(
            cue,
            &cue.instructions,
            &cue.transitions,
            &cue.transitions_by_attribute,
            color_path_data_provider,
            blueprint_data_provider,
            data_provider,
            parameter_query,
            selection_resolver,
            cue.lookahead.unwrap_or_default(),
        );
        mcue.append_materialized_part_layer(cue_body_layer);

        for part in &cue.parts {
            let part_transition = Self::inherited_part_transition(cue, part);
            let part_attribute_transitions = Self::inherited_part_attribute_transitions(cue, part);
            let part_layer = Self::materialize_part_layer(
                cue,
                &part.instructions,
                &part_transition,
                &part_attribute_transitions,
                color_path_data_provider,
                blueprint_data_provider,
                data_provider,
                parameter_query,
                selection_resolver,
                part.lookahead.unwrap_or_default(),
            );
            mcue.append_materialized_part_layer(part_layer);
        }

        mcue
    }
}
