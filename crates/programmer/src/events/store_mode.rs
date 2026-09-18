// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Pure programmer instruction normalization and cue store-mode transformations.

use super::*;

/// Captures active programmer instructions as store-mode rows with resolved selections.
pub(super) fn resolved_programmer_instructions(
    programmer: &Programmer,
    spatial_selection_resolver: &SpatialSelectionResolver,
) -> Vec<BoundCueInstruction> {
    programmer
        .active_instructions()
        .iter()
        .flat_map(|(_, instruction)| {
            resolve_store_instruction_rows(instruction.clone(), spatial_selection_resolver)
        })
        .collect::<Vec<_>>()
}

/// Resolves fanned assertion values and timings for one spatial store-mode row.
fn resolve_store_mode_instruction_fans(
    mut instruction: CueInstruction,
    selection_index: usize,
    selection_size: usize,
) -> CueInstruction {
    instruction.values = instruction
        .values
        .into_iter()
        .map(|(attribute, source)| {
            let source = match source {
                ValueSource::Fanned { values } => ValueSource::Inline(
                    resolve_store_mode_fanned_value(&values, selection_index, selection_size),
                ),
                source => source,
            };
            (attribute, source)
        })
        .collect();

    resolve_store_mode_transition_modes(
        &mut instruction.transitions,
        selection_index,
        selection_size,
    );
    for transition in instruction.transitions_by_attribute.values_mut() {
        resolve_store_mode_transition_modes(transition, selection_index, selection_size);
    }

    instruction
}

/// Resolves one instruction into rows matching its spatial iteration indexes.
fn resolve_store_instruction_rows(
    instruction: BoundCueInstruction,
    spatial_selection_resolver: &SpatialSelectionResolver,
) -> Vec<BoundCueInstruction> {
    if let SelectionExpr::Resolved(fixtures) = &instruction.selection.source {
        if instruction.selection.clauses.is_empty() {
            return vec![BoundCueInstruction {
                selection: SelectionExpr::Resolved(
                    spatial_selection_resolver
                        .collapse_complete_fixture_element_sets(fixtures.clone()),
                )
                .into(),
                cue_instruction: instruction.cue_instruction,
            }];
        }
    }

    let resolved_selection = spatial_selection_resolver
        .resolve(&instruction.selection)
        .into_value();
    let rows = resolved_selection
        .iter_non_empty_indexes()
        .map(|index| {
            index
                .members
                .iter()
                .map(|member| member.fixture.clone())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    if rows.is_empty() {
        return vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(Vec::new()).into(),
            cue_instruction: instruction.cue_instruction,
        }];
    }

    let row_count = rows.len();
    rows.into_iter()
        .enumerate()
        .map(|(selection_index, fixtures)| BoundCueInstruction {
            selection: SelectionExpr::Resolved(
                spatial_selection_resolver.collapse_complete_fixture_element_sets(fixtures),
            )
            .into(),
            cue_instruction: resolve_store_mode_instruction_fans(
                instruction.cue_instruction.clone(),
                selection_index,
                row_count,
            ),
        })
        .collect()
}

/// Resolves stored instruction selections before store-mode matching.
fn resolve_stored_instruction_selections(
    instructions: Vec<BoundCueInstruction>,
    spatial_selection_resolver: &SpatialSelectionResolver,
) -> Vec<BoundCueInstruction> {
    instructions
        .into_iter()
        .flat_map(|instruction| {
            resolve_store_instruction_rows(instruction, spatial_selection_resolver)
        })
        .collect::<Vec<_>>()
}

/// Merges incoming instructions into matching selections and appends new selections.
fn merge_instruction_list(
    existing: &mut Vec<BoundCueInstruction>,
    incoming: Vec<BoundCueInstruction>,
) {
    for incoming_instruction in incoming {
        if incoming_instruction
            .cue_instruction
            .blueprint_application
            .is_some()
        {
            existing.push(incoming_instruction);
            continue;
        }
        if let Some(existing_instruction) = existing.iter_mut().find(|candidate| {
            candidate.selection == incoming_instruction.selection
                && candidate.cue_instruction.blueprint_application.is_none()
        }) {
            existing_instruction
                .cue_instruction
                .merge(incoming_instruction.cue_instruction);
        } else {
            existing.push(incoming_instruction);
        }
    }
}

/// Resolves a fanned value for the fixture or element offset being split.
fn resolve_store_mode_fanned_value(
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
    let start = &values[segment_idx];
    let end = &values[segment_idx + 1];

    match (start, end) {
        (
            ParameterValue::AbsolutePercent { value: start_val },
            ParameterValue::AbsolutePercent { value: end_val },
        ) => {
            let start_f = start_val.as_f32();
            let end_f = end_val.as_f32();
            ParameterValue::AbsolutePercent {
                value: (start_f + segment_t * (end_f - start_f)).into(),
            }
        }
        (
            ParameterValue::RelativePercent {
                offset: start_offset,
            },
            ParameterValue::RelativePercent { offset: end_offset },
        ) => {
            let start_f = start_offset.as_f32();
            let end_f = end_offset.as_f32();
            ParameterValue::RelativePercent {
                offset: (start_f + segment_t * (end_f - start_f)).into(),
            }
        }
        (
            ParameterValue::Absolute { value: start_value },
            ParameterValue::Absolute { value: end_value },
        ) => ParameterValue::Absolute {
            value: (*start_value + segment_t * (*end_value - *start_value)).round(),
        },
        _ => *start,
    }
}

/// Resolves fanned transition modes for the fixture or element offset being split.
fn resolve_store_mode_transition_modes(
    transition: &mut PartialTransition,
    fixture_index: usize,
    total_fixtures: usize,
) {
    if let Some(mode) = &transition.delay_in {
        transition.delay_in = Some(TransitionMode::Fixed(
            mode.resolve(fixture_index, total_fixtures),
        ));
    }
    if let Some(mode) = &transition.fade_in {
        transition.fade_in = Some(TransitionMode::Fixed(
            mode.resolve(fixture_index, total_fixtures),
        ));
    }
    if let Some(mode) = &transition.delay_out {
        transition.delay_out = Some(TransitionMode::Fixed(
            mode.resolve(fixture_index, total_fixtures),
        ));
    }
    if let Some(mode) = &transition.fade_out {
        transition.fade_out = Some(TransitionMode::Fixed(
            mode.resolve(fixture_index, total_fixtures),
        ));
    }
}

/// Applies populated transition fields from one partial transition into another.
fn merge_store_mode_partial_transition(target: &mut PartialTransition, source: PartialTransition) {
    if source.delay_in.is_some() {
        target.delay_in = source.delay_in;
    }
    if source.fade_in.is_some() {
        target.fade_in = source.fade_in;
    }
    if source.curve_in.is_some() {
        target.curve_in = source.curve_in;
    }
    if source.delay_out.is_some() {
        target.delay_out = source.delay_out;
    }
    if source.fade_out.is_some() {
        target.fade_out = source.fade_out;
    }
    if source.curve_out.is_some() {
        target.curve_out = source.curve_out;
    }
}

/// Returns whether a partial transition carries any explicit timing or curve fields.
fn store_mode_transition_has_fields(transition: &PartialTransition) -> bool {
    transition.delay_in.is_some()
        || transition.fade_in.is_some()
        || transition.curve_in.is_some()
        || transition.delay_out.is_some()
        || transition.fade_out.is_some()
        || transition.curve_out.is_some()
}

/// Applies fixture-specific transition overrides to a split instruction row.
fn apply_split_fixture_transition_overrides(
    instruction: &mut CueInstruction,
    fixture: &FixtureRef,
) {
    let overrides = std::mem::take(&mut instruction.transitions_by_fixture_attribute);

    for fixture_transition in overrides.iter().filter(|transition| {
        transition.fixture.fixture_uid == fixture.fixture_uid && transition.fixture.index.is_none()
    }) {
        for (attribute, transition) in &fixture_transition.transitions_by_attribute {
            let target = instruction
                .transitions_by_attribute
                .entry(attribute.clone())
                .or_default();
            merge_store_mode_partial_transition(target, transition.clone());
        }
    }

    for fixture_transition in overrides
        .iter()
        .filter(|transition| transition.fixture == *fixture)
    {
        for (attribute, transition) in &fixture_transition.transitions_by_attribute {
            let target = instruction
                .transitions_by_attribute
                .entry(attribute.clone())
                .or_default();
            merge_store_mode_partial_transition(target, transition.clone());
        }
    }
}

/// Resolves fanned assertion values and timings for one split store-mode row.
fn resolve_split_store_mode_instruction(
    mut instruction: CueInstruction,
    fixture: &FixtureRef,
    fixture_index: usize,
    total_fixtures: usize,
) -> CueInstruction {
    instruction.values = instruction
        .values
        .into_iter()
        .map(|(attribute, source)| {
            let source = match source {
                ValueSource::Fanned { values } => ValueSource::Inline(
                    resolve_store_mode_fanned_value(&values, fixture_index, total_fixtures),
                ),
                source => source,
            };
            (attribute, source)
        })
        .collect();

    apply_split_fixture_transition_overrides(&mut instruction, fixture);
    resolve_store_mode_transition_modes(
        &mut instruction.transitions,
        fixture_index,
        total_fixtures,
    );
    for transition in instruction.transitions_by_attribute.values_mut() {
        resolve_store_mode_transition_modes(transition, fixture_index, total_fixtures);
    }

    instruction
}

/// Promotes row-level transitions to per-attribute transitions before row coalescing.
fn promote_store_mode_row_transitions_to_attributes(instruction: &mut CueInstruction) {
    if !store_mode_transition_has_fields(&instruction.transitions) {
        return;
    }

    let row_transition = std::mem::take(&mut instruction.transitions);
    let attributes = instruction.values.keys().cloned().collect::<Vec<_>>();
    if attributes.is_empty() {
        instruction.transitions = row_transition;
        return;
    }

    for attribute in attributes {
        let mut promoted_transition = row_transition.clone();
        if let Some(attribute_transition) = instruction.transitions_by_attribute.remove(&attribute)
        {
            merge_store_mode_partial_transition(&mut promoted_transition, attribute_transition);
        }
        if store_mode_transition_has_fields(&promoted_transition) {
            instruction
                .transitions_by_attribute
                .insert(attribute, promoted_transition);
        }
    }
}

/// Returns the single fixture ref addressed by a normalized store-mode row.
fn store_mode_fixture_ref(instruction: &BoundCueInstruction) -> Option<&FixtureRef> {
    let SelectionExpr::Resolved(fixtures) = &instruction.selection.source else {
        return None;
    };
    if !instruction.selection.clauses.is_empty() || fixtures.len() != 1 {
        return None;
    }
    fixtures.first()
}

/// Returns whether an incoming store-mode row should edit an existing row.
fn store_mode_rows_match(existing: &BoundCueInstruction, incoming: &BoundCueInstruction) -> bool {
    let Some(existing_fixture) = store_mode_fixture_ref(existing) else {
        return existing.selection == incoming.selection;
    };
    let Some(incoming_fixture) = store_mode_fixture_ref(incoming) else {
        return existing.selection == incoming.selection;
    };

    existing_fixture == incoming_fixture
        || (incoming_fixture.index.is_none()
            && existing_fixture.fixture_uid == incoming_fixture.fixture_uid)
}

/// Returns whether an element store row overlaps an existing whole-fixture row.
fn store_mode_element_store_targets_existing_whole_fixture_row(
    existing: &[BoundCueInstruction],
    incoming: &BoundCueInstruction,
) -> bool {
    let Some(incoming_fixture) = store_mode_fixture_ref(incoming) else {
        return false;
    };
    if incoming_fixture.index.is_none() {
        return false;
    }

    existing.iter().any(|candidate| {
        let Some(existing_fixture) = store_mode_fixture_ref(candidate) else {
            return false;
        };
        existing_fixture.index.is_none()
            && existing_fixture.fixture_uid == incoming_fixture.fixture_uid
    })
}

/// Flattens resolved instructions so each row targets one fixture or element.
fn flatten_instruction_list_by_fixture_ref(
    instructions: Vec<BoundCueInstruction>,
) -> Vec<BoundCueInstruction> {
    let mut split = Vec::new();
    for instruction in instructions {
        match &instruction.selection.source {
            SelectionExpr::Resolved(fixtures) if instruction.selection.clauses.is_empty() => {
                if fixtures.is_empty() {
                    split.push(instruction);
                } else {
                    for (index, fixture) in fixtures.iter().enumerate() {
                        split.push(BoundCueInstruction {
                            selection: SelectionExpr::Resolved(vec![fixture.clone()]).into(),
                            cue_instruction: resolve_split_store_mode_instruction(
                                instruction.cue_instruction.clone(),
                                fixture,
                                index,
                                fixtures.len(),
                            ),
                        });
                    }
                }
            }
            _ => split.push(instruction),
        }
    }
    split
}

/// Coalesces duplicate fixture/element rows before applying store-mode matching.
fn coalesce_instruction_list(instructions: Vec<BoundCueInstruction>) -> Vec<BoundCueInstruction> {
    let mut coalesced = Vec::new();
    merge_instruction_list(&mut coalesced, instructions);
    coalesced
}

/// Normalizes incoming programmer instructions for store-mode matching.
pub(super) fn normalize_incoming_store_mode_instructions(
    instructions: Vec<BoundCueInstruction>,
) -> Vec<BoundCueInstruction> {
    coalesce_instruction_list(flatten_instruction_list_by_fixture_ref(instructions))
}

/// Normalizes replace-mode instructions while preserving row timing per attribute.
pub(super) fn normalize_replace_store_mode_instructions(
    instructions: Vec<BoundCueInstruction>,
) -> Vec<BoundCueInstruction> {
    coalesce_instruction_list(
        flatten_instruction_list_by_fixture_ref(instructions)
            .into_iter()
            .map(|mut instruction| {
                promote_store_mode_row_transitions_to_attributes(&mut instruction.cue_instruction);
                instruction
            })
            .collect(),
    )
}

/// Normalizes existing stored instructions for store-mode matching.
pub(super) fn normalize_existing_store_mode_instructions(
    instructions: Vec<BoundCueInstruction>,
    spatial_selection_resolver: &SpatialSelectionResolver,
) -> Vec<BoundCueInstruction> {
    normalize_incoming_store_mode_instructions(resolve_stored_instruction_selections(
        instructions,
        spatial_selection_resolver,
    ))
}

/// Updates only fixture and attribute values that already exist in one instruction.
fn update_existing_instruction(existing: &mut CueInstruction, incoming: CueInstruction) {
    for (attribute, value) in incoming.values {
        if existing.values.contains_key(&attribute) {
            existing.values.insert(attribute, value);
        }
    }

    for (attribute, transition) in incoming.transitions_by_attribute {
        if existing.values.contains_key(&attribute)
            || existing.transitions_by_attribute.contains_key(&attribute)
        {
            existing
                .transitions_by_attribute
                .entry(attribute)
                .and_modify(|existing_transition| *existing_transition = transition.clone())
                .or_insert(transition);
        }
    }

    for incoming_fixture_transition in incoming.transitions_by_fixture_attribute {
        if let Some(existing_fixture_transition) = existing
            .transitions_by_fixture_attribute
            .iter_mut()
            .find(|transition| transition.fixture == incoming_fixture_transition.fixture)
        {
            for (attribute, transition) in incoming_fixture_transition.transitions_by_attribute {
                if existing_fixture_transition
                    .transitions_by_attribute
                    .contains_key(&attribute)
                {
                    existing_fixture_transition
                        .transitions_by_attribute
                        .entry(attribute)
                        .and_modify(|existing_transition| *existing_transition = transition.clone())
                        .or_insert(transition);
                }
            }
        }
    }
}

/// Removes attributes carried by the incoming instruction from one existing instruction.
fn remove_instruction_attributes(existing: &mut CueInstruction, incoming: CueInstruction) {
    let attributes_to_remove: HashSet<Attribute> = incoming
        .values
        .keys()
        .chain(incoming.transitions_by_attribute.keys())
        .cloned()
        .collect();

    for attribute in &attributes_to_remove {
        existing.values.remove(attribute);
        existing.transitions_by_attribute.remove(attribute);
    }

    for existing_fixture_transition in &mut existing.transitions_by_fixture_attribute {
        for attribute in &attributes_to_remove {
            existing_fixture_transition
                .transitions_by_attribute
                .remove(attribute);
        }
    }

    for incoming_fixture_transition in incoming.transitions_by_fixture_attribute {
        if let Some(existing_fixture_transition) = existing
            .transitions_by_fixture_attribute
            .iter_mut()
            .find(|transition| transition.fixture == incoming_fixture_transition.fixture)
        {
            for attribute in incoming_fixture_transition.transitions_by_attribute.keys() {
                existing_fixture_transition
                    .transitions_by_attribute
                    .remove(attribute);
            }
        }
    }

    existing
        .transitions_by_fixture_attribute
        .retain(|transition| !transition.transitions_by_attribute.is_empty());
}

/// Returns whether an instruction still stores any attribute data.
fn instruction_has_attributes(instruction: &CueInstruction) -> bool {
    instruction.blueprint_application.is_some()
        || !instruction.values.is_empty()
        || !instruction.transitions_by_attribute.is_empty()
        || instruction
            .transitions_by_fixture_attribute
            .iter()
            .any(|transition| !transition.transitions_by_attribute.is_empty())
}

/// Applies store mode semantics to an existing instruction list.
pub(super) fn apply_store_mode(
    existing: &mut Vec<BoundCueInstruction>,
    incoming: Vec<BoundCueInstruction>,
    mode: StoreMode,
) -> bool {
    let mut skipped_whole_fixture_row = false;
    match mode {
        StoreMode::Replace => {
            *existing = incoming;
        }
        StoreMode::Merge => {
            for incoming_instruction in incoming {
                let blocked_by_whole_fixture_row =
                    store_mode_element_store_targets_existing_whole_fixture_row(
                        existing,
                        &incoming_instruction,
                    );
                let mut matched_existing = false;
                let incoming_is_blueprint = incoming_instruction
                    .cue_instruction
                    .blueprint_application
                    .is_some();
                for existing_instruction in existing.iter_mut().filter(|candidate| {
                    !incoming_is_blueprint
                        && candidate.cue_instruction.blueprint_application.is_none()
                        && store_mode_rows_match(candidate, &incoming_instruction)
                }) {
                    matched_existing = true;
                    existing_instruction
                        .cue_instruction
                        .merge(incoming_instruction.cue_instruction.clone());
                }
                if blocked_by_whole_fixture_row {
                    skipped_whole_fixture_row = true;
                }
                if !matched_existing && !blocked_by_whole_fixture_row {
                    existing.push(incoming_instruction);
                }
            }
        }
        StoreMode::Update => {
            for incoming_instruction in incoming {
                if store_mode_element_store_targets_existing_whole_fixture_row(
                    existing,
                    &incoming_instruction,
                ) {
                    skipped_whole_fixture_row = true;
                }
                if incoming_instruction
                    .cue_instruction
                    .blueprint_application
                    .is_some()
                {
                    for existing_instruction in existing.iter_mut().filter(|candidate| {
                        store_mode_rows_match(candidate, &incoming_instruction)
                            && candidate.cue_instruction.blueprint_application
                                == incoming_instruction.cue_instruction.blueprint_application
                    }) {
                        existing_instruction.cue_instruction =
                            incoming_instruction.cue_instruction.clone();
                    }
                    continue;
                }
                for existing_instruction in existing.iter_mut().filter(|candidate| {
                    candidate.cue_instruction.blueprint_application.is_none()
                        && store_mode_rows_match(candidate, &incoming_instruction)
                }) {
                    update_existing_instruction(
                        &mut existing_instruction.cue_instruction,
                        incoming_instruction.cue_instruction.clone(),
                    );
                }
            }
        }
        StoreMode::Remove => {
            for incoming_instruction in incoming {
                if store_mode_element_store_targets_existing_whole_fixture_row(
                    existing,
                    &incoming_instruction,
                ) {
                    skipped_whole_fixture_row = true;
                }
                if incoming_instruction
                    .cue_instruction
                    .blueprint_application
                    .is_some()
                {
                    existing.retain(|candidate| {
                        !store_mode_rows_match(candidate, &incoming_instruction)
                            || candidate.cue_instruction.blueprint_application
                                != incoming_instruction.cue_instruction.blueprint_application
                    });
                    continue;
                }
                for existing_instruction in existing.iter_mut().filter(|candidate| {
                    candidate.cue_instruction.blueprint_application.is_none()
                        && store_mode_rows_match(candidate, &incoming_instruction)
                }) {
                    remove_instruction_attributes(
                        &mut existing_instruction.cue_instruction,
                        incoming_instruction.cue_instruction.clone(),
                    );
                }
            }
            existing.retain(|instruction| instruction_has_attributes(&instruction.cue_instruction));
        }
    }
    skipped_whole_fixture_row
}

/// Returns fixture refs expanded to concrete elements for overlap checks.
fn expand_fixture_ref_for_programmer_override(
    fixture_ref: &FixtureRef,
    fixture_data: &FixtureDataProviderExt,
) -> Vec<FixtureRef> {
    if fixture_ref.index.is_some() {
        return vec![fixture_ref.clone()];
    }

    fixture_data
        .inner
        .get(fixture_ref.fixture_uid)
        .map(|fixture| {
            (1..=fixture.elements.len() as u32)
                .map(|index| FixtureRef {
                    fixture_uid: fixture.identifiers.uid,
                    index: Some(index),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Returns concrete element refs addressed by an instruction selection.
fn concrete_programmer_selection_elements(
    instruction: &BoundCueInstruction,
    spatial_selection_resolver: &SpatialSelectionResolver,
    fixture_data: &FixtureDataProviderExt,
) -> Vec<FixtureRef> {
    concrete_programmer_selection_element_indexes(
        instruction,
        spatial_selection_resolver,
        fixture_data,
    )
    .into_iter()
    .map(|(fixture_ref, _, _)| fixture_ref)
    .collect()
}

/// Returns concrete element refs with their original spatial fan indexes.
fn concrete_programmer_selection_element_indexes(
    instruction: &BoundCueInstruction,
    spatial_selection_resolver: &SpatialSelectionResolver,
    fixture_data: &FixtureDataProviderExt,
) -> Vec<(FixtureRef, usize, usize)> {
    let resolved = spatial_selection_resolver
        .resolve(&instruction.selection)
        .into_value();
    let total_indexes = resolved.iter_non_empty_indexes().count();

    resolved
        .iter_non_empty_indexes()
        .enumerate()
        .flat_map(|(selection_index, resolved_index)| {
            resolved_index.members.iter().flat_map(move |member| {
                expand_fixture_ref_for_programmer_override(&member.fixture, fixture_data)
                    .into_iter()
                    .map(move |fixture_ref| (fixture_ref, selection_index, total_indexes))
            })
        })
        .filter(|(fixture_ref, _, _)| fixture_ref.index.is_some())
        .collect()
}

/// Returns the attributes whose values or attribute-specific timing are stored by an instruction.
fn instruction_attribute_set(instruction: &CueInstruction) -> HashSet<Attribute> {
    instruction
        .values
        .keys()
        .chain(instruction.transitions_by_attribute.keys())
        .cloned()
        .collect()
}

/// Keeps only the requested attributes in an instruction while preserving shared timing defaults.
fn instruction_for_attributes(
    mut instruction: CueInstruction,
    attributes: &HashSet<Attribute>,
) -> CueInstruction {
    instruction
        .values
        .retain(|attribute, _| attributes.contains(attribute));
    instruction
        .transitions_by_attribute
        .retain(|attribute, _| attributes.contains(attribute));
    for fixture_transition in &mut instruction.transitions_by_fixture_attribute {
        fixture_transition
            .transitions_by_attribute
            .retain(|attribute, _| attributes.contains(attribute));
    }
    instruction
        .transitions_by_fixture_attribute
        .retain(|fixture_transition| !fixture_transition.transitions_by_attribute.is_empty());
    instruction
}

/// Returns whether a transition mode varies across the selection.
fn transition_mode_is_fanned(mode: &TransitionMode) -> bool {
    !matches!(mode, TransitionMode::Fixed(_))
}

/// Returns whether a partial transition carries selection-relative timing.
fn transition_has_fanned_modes(transition: &PartialTransition) -> bool {
    transition
        .delay_in
        .as_ref()
        .is_some_and(transition_mode_is_fanned)
        || transition
            .fade_in
            .as_ref()
            .is_some_and(transition_mode_is_fanned)
        || transition
            .delay_out
            .as_ref()
            .is_some_and(transition_mode_is_fanned)
        || transition
            .fade_out
            .as_ref()
            .is_some_and(transition_mode_is_fanned)
}

/// Returns whether an instruction must be split before its selection is reduced.
fn instruction_has_selection_relative_sources(instruction: &CueInstruction) -> bool {
    instruction
        .values
        .values()
        .any(|source| matches!(source, ValueSource::Fanned { .. }))
        || transition_has_fanned_modes(&instruction.transitions)
        || instruction
            .transitions_by_attribute
            .values()
            .any(transition_has_fanned_modes)
        || instruction
            .transitions_by_fixture_attribute
            .iter()
            .flat_map(|transition| transition.transitions_by_attribute.values())
            .any(transition_has_fanned_modes)
}

/// Projects an instruction onto concrete selection members without changing resolved values.
fn split_programmer_rows(
    instruction: &CueInstruction,
    elements: Vec<(FixtureRef, usize, usize)>,
) -> Vec<BoundCueInstruction> {
    if !instruction_has_selection_relative_sources(instruction) {
        return vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(
                elements
                    .into_iter()
                    .map(|(fixture_ref, _, _)| fixture_ref)
                    .collect(),
            )
            .into(),
            cue_instruction: instruction.clone(),
        }];
    }

    elements
        .into_iter()
        .map(
            |(fixture_ref, selection_index, selection_size)| BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
                cue_instruction: resolve_split_store_mode_instruction(
                    instruction.clone(),
                    &fixture_ref,
                    selection_index,
                    selection_size,
                ),
            },
        )
        .collect()
}

/// Removes incoming element attributes from broader programmer rows so narrower edits can take effect.
fn carve_overlapping_programmer_attributes(
    programmer: &mut Programmer,
    incoming: &BoundCueInstruction,
    spatial_selection_resolver: &SpatialSelectionResolver,
    fixture_data: &FixtureDataProviderExt,
) {
    let incoming_elements =
        concrete_programmer_selection_elements(incoming, spatial_selection_resolver, fixture_data)
            .into_iter()
            .collect::<HashSet<_>>();
    if incoming_elements.is_empty() {
        return;
    }

    let incoming_attributes = instruction_attribute_set(&incoming.cue_instruction);
    if incoming_attributes.is_empty() {
        return;
    }

    let mut removals = Vec::new();
    let mut additions = Vec::new();
    for (uid, existing) in programmer.active_instructions_mut().iter_mut() {
        if existing.selection == incoming.selection {
            continue;
        }

        let existing_element_indexes = concrete_programmer_selection_element_indexes(
            existing,
            spatial_selection_resolver,
            fixture_data,
        );
        let existing_elements = existing_element_indexes
            .iter()
            .map(|(fixture_ref, _, _)| fixture_ref.clone())
            .collect::<Vec<_>>();
        if existing_elements.is_empty() {
            continue;
        }

        let existing_attributes = instruction_attribute_set(&existing.cue_instruction);
        let overlapping_attributes = existing_attributes
            .intersection(&incoming_attributes)
            .cloned()
            .collect::<HashSet<_>>();
        if overlapping_attributes.is_empty() {
            continue;
        }

        let (remaining_elements, overridden_elements): (Vec<_>, Vec<_>) = existing_element_indexes
            .into_iter()
            .partition(|(fixture_ref, _, _)| !incoming_elements.contains(fixture_ref));
        if remaining_elements.len() == existing_elements.len() {
            continue;
        }

        let original_instruction = existing.cue_instruction.clone();
        let overridden_instruction =
            instruction_for_attributes(original_instruction.clone(), &overlapping_attributes);
        let mut preserved_instruction = original_instruction.clone();
        remove_instruction_attributes(&mut preserved_instruction, overridden_instruction);

        let mut partitioned_rows = Vec::new();
        if !remaining_elements.is_empty() {
            partitioned_rows.extend(split_programmer_rows(
                &original_instruction,
                remaining_elements,
            ));
        }
        if instruction_has_attributes(&preserved_instruction) {
            partitioned_rows.extend(split_programmer_rows(
                &preserved_instruction,
                overridden_elements,
            ));
        }

        if partitioned_rows.is_empty() {
            removals.push(*uid);
            continue;
        }

        let first_row = partitioned_rows.remove(0);
        existing.selection = first_row.selection;
        existing.cue_instruction = first_row.cue_instruction;
        additions.extend(
            partitioned_rows
                .into_iter()
                .map(|instruction| (*uid, instruction)),
        );
    }

    let mut anchor_aliases = Vec::new();
    {
        let active_instructions = programmer.active_instructions_mut();
        for uid in removals {
            active_instructions.remove(&uid);
        }
        for (source_uid, addition) in additions {
            let addition_uid = uuid::Uuid::new_v4();
            active_instructions.insert(addition_uid, addition);
            anchor_aliases.push((addition_uid, source_uid));
        }
    }
    for (addition_uid, source_uid) in anchor_aliases {
        programmer.set_transition_anchor_alias(addition_uid, source_uid);
    }
}

/// Adds a live programmer instruction after carving overlapping broader element attributes.
pub(super) fn add_programmer_instruction_with_overrides(
    programmer: &mut Programmer,
    instruction: BoundCueInstruction,
    spatial_selection_resolver: &SpatialSelectionResolver,
    fixture_data: &FixtureDataProviderExt,
) {
    carve_overlapping_programmer_attributes(
        programmer,
        &instruction,
        spatial_selection_resolver,
        fixture_data,
    );
    programmer.add_instruction(instruction);
}

#[cfg(test)]
mod programmer_override_tests {
    use bevy_ecs::system::{Res, SystemState};
    use bevy_ecs::world::World;
    use nightfall_fixtures::prelude::{Fixture, FixtureElement};

    use super::*;
    /// Builds a fixture with predictable IDs and element count.
    fn test_fixture(fixture_id: u32, element_count: usize) -> Fixture {
        Fixture {
            identifiers: Identifiers {
                id: fixture_id,
                uid: uuid::Uuid::from_u128(fixture_id as u128),
                label: format!("Fixture {fixture_id}"),
            },
            elements: (0..element_count)
                .map(|_| FixtureElement::default())
                .collect(),
            ..Default::default()
        }
    }

    /// Builds a resolved element ref for a fixture ID and one-based element index.
    fn element_ref(fixture_id: u32, index: u32) -> FixtureRef {
        FixtureRef {
            fixture_uid: uuid::Uuid::from_u128(fixture_id as u128),
            index: Some(index),
        }
    }

    /// Builds an inline absolute-value programmer instruction.
    fn inline_instruction(
        selection: Vec<FixtureRef>,
        attribute: Attribute,
        value: f32,
    ) -> BoundCueInstruction {
        BoundCueInstruction {
            selection: SelectionExpr::Resolved(selection).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    attribute,
                    ValueSource::Inline(ParameterValue::Absolute { value }),
                )]),
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        }
    }

    /// Verifies pure incoming normalization coalesces attributes for one concrete target.
    #[test]
    fn incoming_normalization_coalesces_duplicate_fixture_rows() {
        let fixture = element_ref(1, 2);
        let normalized = normalize_incoming_store_mode_instructions(vec![
            inline_instruction(vec![fixture.clone()], Attribute::Red, 10.0),
            inline_instruction(vec![fixture.clone()], Attribute::Green, 20.0),
        ]);

        assert_eq!(normalized.len(), 1);
        assert_eq!(
            normalized[0].selection.source,
            SelectionExpr::Resolved(vec![fixture])
        );
        assert_eq!(
            normalized[0].cue_instruction.values.get(&Attribute::Red),
            Some(&ValueSource::Inline(ParameterValue::Absolute {
                value: 10.0,
            }))
        );
        assert_eq!(
            normalized[0].cue_instruction.values.get(&Attribute::Green),
            Some(&ValueSource::Inline(ParameterValue::Absolute {
                value: 20.0,
            }))
        );
    }

    /// Builds a fanned absolute-value programmer instruction.
    fn fanned_instruction(
        selection: Vec<FixtureRef>,
        attribute: Attribute,
        values: Vec<f32>,
    ) -> BoundCueInstruction {
        BoundCueInstruction {
            selection: SelectionExpr::Resolved(selection).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    attribute,
                    ValueSource::Fanned {
                        values: values
                            .into_iter()
                            .map(|value| ParameterValue::Absolute { value })
                            .collect(),
                    },
                )]),
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        }
    }

    /// Builds fixture-backed resolver resources for programmer override tests.
    fn test_world() -> World {
        let mut fixtures = FixtureDataProviderExt::default();
        fixtures
            .inner
            .add(test_fixture(1, 4))
            .expect("fixture should insert");

        let mut world = World::new();
        world.insert_resource(fixtures);
        world.insert_resource(DataProvider::<Group>::default());
        world
    }

    /// Adds an instruction through the live override insertion path.
    fn add_with_overrides(
        world: &mut World,
        programmer: &mut Programmer,
        instruction: BoundCueInstruction,
    ) {
        let mut system_state =
            SystemState::<(SpatialSelectionResolver, Res<FixtureDataProviderExt>)>::new(world);
        let (spatial_selection_resolver, fixture_data) = system_state
            .get(world)
            .expect("selection resolver resources should be available");
        add_programmer_instruction_with_overrides(
            programmer,
            instruction,
            &spatial_selection_resolver,
            &fixture_data,
        );
    }

    /// Returns the instruction targeting exactly one resolved element.
    fn instruction_for_element<'a>(
        programmer: &'a Programmer,
        fixture_ref: &FixtureRef,
    ) -> &'a BoundCueInstruction {
        programmer
            .active_instructions()
            .iter()
            .map(|(_, instruction)| instruction)
            .find(|instruction| {
                matches!(
                    &instruction.selection.source,
                    SelectionExpr::Resolved(fixtures)
                        if fixtures.as_slice() == std::slice::from_ref(fixture_ref)
                )
            })
            .expect("element instruction should exist")
    }

    /// Verifies same-selection updates merge into the existing row instead of replacing its UID.
    #[test]
    fn same_selection_programmer_override_preserves_instruction_uid() {
        let mut world = test_world();
        let mut programmer = Programmer::default();
        let selection = vec![element_ref(1, 2)];

        add_with_overrides(
            &mut world,
            &mut programmer,
            inline_instruction(selection.clone(), Attribute::Red, 10.0),
        );
        let initial_uid = programmer
            .active_instructions()
            .iter()
            .next()
            .map(|(uid, _)| *uid)
            .expect("initial instruction should exist");

        add_with_overrides(
            &mut world,
            &mut programmer,
            inline_instruction(selection, Attribute::Red, 20.0),
        );

        let active_uids = programmer
            .active_instructions()
            .iter()
            .map(|(uid, _)| *uid)
            .collect::<Vec<_>>();
        assert_eq!(active_uids, vec![initial_uid]);
    }

    /// Verifies subset overrides partition selections without splitting unrelated attributes.
    #[test]
    fn subset_override_keeps_complete_attribute_rows() {
        let mut world = test_world();
        let mut programmer = Programmer::default();
        let full_selection = (1..=4)
            .map(|index| element_ref(1, index))
            .collect::<Vec<_>>();

        add_with_overrides(
            &mut world,
            &mut programmer,
            inline_instruction(full_selection.clone(), Attribute::Red, 10.0),
        );
        add_with_overrides(
            &mut world,
            &mut programmer,
            inline_instruction(full_selection, Attribute::Blue, 40.0),
        );
        add_with_overrides(
            &mut world,
            &mut programmer,
            inline_instruction(
                vec![element_ref(1, 2), element_ref(1, 3)],
                Attribute::Red,
                30.0,
            ),
        );

        let instructions = programmer
            .active_instructions()
            .iter()
            .map(|(_, instruction)| instruction)
            .collect::<Vec<_>>();
        assert_eq!(instructions.len(), 2);

        let remainder = instructions
            .iter()
            .find(|instruction| {
                instruction.selection.source
                    == SelectionExpr::Resolved(vec![element_ref(1, 1), element_ref(1, 4)])
            })
            .expect("remainder row should retain its complete attribute set");
        assert_eq!(
            remainder.cue_instruction.values.get(&Attribute::Red),
            Some(&ValueSource::Inline(ParameterValue::Absolute {
                value: 10.0
            }))
        );
        assert_eq!(
            remainder.cue_instruction.values.get(&Attribute::Blue),
            Some(&ValueSource::Inline(ParameterValue::Absolute {
                value: 40.0
            }))
        );

        let overridden = instructions
            .iter()
            .find(|instruction| {
                instruction.selection.source
                    == SelectionExpr::Resolved(vec![element_ref(1, 2), element_ref(1, 3)])
            })
            .expect("overridden row should merge preserved and incoming attributes");
        assert_eq!(
            overridden.cue_instruction.values.get(&Attribute::Red),
            Some(&ValueSource::Inline(ParameterValue::Absolute {
                value: 30.0
            }))
        );
        assert_eq!(
            overridden.cue_instruction.values.get(&Attribute::Blue),
            Some(&ValueSource::Inline(ParameterValue::Absolute {
                value: 40.0
            }))
        );
    }

    /// Verifies carving one element out of a fanned range resolves remaining values first.
    #[test]
    fn element_override_preserves_fanned_values_when_splitting_remaining_rows() {
        let mut world = test_world();
        let mut programmer = Programmer::default();
        let selection = (1..=4)
            .map(|index| element_ref(1, index))
            .collect::<Vec<_>>();

        add_with_overrides(
            &mut world,
            &mut programmer,
            fanned_instruction(selection, Attribute::Red, vec![0.0, 30.0]),
        );
        add_with_overrides(
            &mut world,
            &mut programmer,
            inline_instruction(vec![element_ref(1, 2)], Attribute::Red, 100.0),
        );

        let element_three = instruction_for_element(&programmer, &element_ref(1, 3));
        assert_eq!(
            element_three.cue_instruction.values.get(&Attribute::Red),
            Some(&ValueSource::Inline(ParameterValue::Absolute {
                value: 20.0
            }))
        );
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
                resolve_store_mode_fanned_value(&values, index, values.len()),
                *expected
            );
        }
    }
}
