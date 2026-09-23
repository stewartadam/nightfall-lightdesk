// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue block and tracked-value reconstruction operations.

use super::*;

/// Stable key for a tracked fixture attribute value.
pub(super) type TrackedFixtureAttribute = (FixtureRef, Attribute);

/// A value tracked into a later cue for block-marker storage.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct TrackedCueValue {
    value: ParameterValue,
}

/// Values tracked into a cue target before its own instructions run.
pub(super) type TrackedCueValues = HashMap<TrackedFixtureAttribute, TrackedCueValue>;

/// Writes a cue command error to the command result stream.
pub(super) fn write_cue_command_error(
    outbound: &mut CommandResponder,
    correlation_id: uuid::Uuid,
    message: String,
) {
    outbound.fail_cue(correlation_id, message);
}

/// Returns resolved fixture refs touched by one stored instruction.
pub(super) fn resolved_instruction_fixtures(
    instruction: &BoundCueInstruction,
    selection_resolver: &SpatialSelectionResolver,
) -> Vec<FixtureRef> {
    let resolved = selection_resolver
        .resolve(&instruction.selection)
        .into_value();
    let mut fixtures = Vec::new();
    for member in resolved
        .iter_non_empty_indexes()
        .flat_map(|index| index.members.iter())
    {
        if !fixtures.contains(&member.fixture) {
            fixtures.push(member.fixture.clone());
        }
    }
    fixtures
}

/// Resolves the concrete parameter value tracked for one fixture position.
pub(super) fn tracked_parameter_value_for_source(
    source: &ValueSource,
    selection_index: usize,
    selection_size: usize,
) -> Option<ParameterValue> {
    match source {
        ValueSource::Inline(value) => Some(*value),
        ValueSource::Fanned { values } => {
            if values.is_empty() {
                return None;
            }
            if values.len() == 1 || selection_size <= 1 {
                return values.first().copied();
            }
            if values.len() == selection_size {
                return values.get(selection_index).copied();
            }
            let position = selection_index as f64 / (selection_size - 1) as f64;
            let segment_count = values.len() - 1;
            let scaled_position = position * segment_count as f64;
            let lower = scaled_position.floor() as usize;
            let upper = (lower + 1).min(values.len() - 1);
            let t = (scaled_position - lower as f64) as f64;
            Some(interpolate_tracked_parameter_values(
                values[lower],
                values[upper],
                t,
            ))
        }
        ValueSource::Release | ValueSource::HoldPosition => None,
    }
}

/// Interpolates fanned tracked values into the concrete asserted value.
pub(super) fn interpolate_tracked_parameter_values(
    from: ParameterValue,
    to: ParameterValue,
    factor: f64,
) -> ParameterValue {
    match (from, to) {
        (
            ParameterValue::AbsolutePercent { value: from_value },
            ParameterValue::AbsolutePercent { value: to_value },
        ) => {
            let start = from_value.as_f64();
            let end = to_value.as_f64();
            ParameterValue::AbsolutePercent {
                value: (start + (end - start) * factor).clamp(0.0, 1.0).into(),
            }
        }
        (
            ParameterValue::Absolute { value: from_value },
            ParameterValue::Absolute { value: to_value },
        ) => ParameterValue::Absolute {
            value: (from_value + (to_value - from_value) * factor).round(),
        },
        (
            ParameterValue::RelativePercent {
                offset: from_offset,
            },
            ParameterValue::RelativePercent { offset: to_offset },
        ) => {
            let start = from_offset.as_f64();
            let end = to_offset.as_f64();
            ParameterValue::RelativePercent {
                offset: (start + (end - start) * factor).into(),
            }
        }
        (
            ParameterValue::Relative {
                offset: from_offset,
            },
            ParameterValue::Relative { offset: to_offset },
        ) => ParameterValue::Relative {
            offset: from_offset + (to_offset - from_offset) * factor,
        },
        (_, to) => to,
    }
}

/// Applies one instruction to the tracked-value map used by cue block planning.
pub(super) fn track_instruction_values(
    tracked: &mut TrackedCueValues,
    instruction: &BoundCueInstruction,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    selection_resolver: &SpatialSelectionResolver,
) {
    let fixtures = resolved_instruction_fixtures(instruction, selection_resolver);
    let selection_size = fixtures.len();
    for (selection_index, fixture) in fixtures.into_iter().enumerate() {
        let logical_values = instruction
            .cue_instruction
            .blueprint_application
            .as_ref()
            .and_then(|application| {
                blueprint_data_provider
                    .and_then(|provider| provider.get(application.blueprint_uid).ok())
                    .map(|blueprint| blueprint.selected_values(&application.selector))
            })
            .unwrap_or_else(|| instruction.cue_instruction.values.clone());
        for (attribute, source) in &logical_values {
            let key = (fixture.clone(), attribute.clone());
            match source {
                ValueSource::Inline(_) | ValueSource::Fanned { .. } => {
                    if let Some(value) =
                        tracked_parameter_value_for_source(source, selection_index, selection_size)
                    {
                        tracked.insert(key, TrackedCueValue { value });
                    }
                }
                ValueSource::Release => {
                    tracked.remove(&key);
                }
                ValueSource::HoldPosition => {}
            }
        }
    }
}

/// Applies all instructions from a cue-like instruction list to tracked values.
pub(super) fn track_instruction_list_values(
    tracked: &mut TrackedCueValues,
    instructions: &[BoundCueInstruction],
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    selection_resolver: &SpatialSelectionResolver,
) {
    for instruction in instructions {
        track_instruction_values(
            tracked,
            instruction,
            blueprint_data_provider,
            selection_resolver,
        );
    }
}

/// Computes tracked values immediately before the target cue in a sequence.
pub(super) fn tracked_values_before_cue(
    sequence: &Sequence,
    cue_data_provider: &DataProvider<Cue>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    target_cue_id: u32,
    selection_resolver: &SpatialSelectionResolver,
) -> TrackedCueValues {
    let mut tracked = TrackedCueValues::default();
    if target_cue_id == 0 {
        return tracked;
    }

    track_instruction_list_values(
        &mut tracked,
        &sequence.setup_cue.instructions,
        blueprint_data_provider,
        selection_resolver,
    );

    for step_uid in &sequence.steps {
        let Ok(cue) = cue_data_provider.get((*step_uid).into()) else {
            continue;
        };
        if cue.identifiers.id == target_cue_id {
            break;
        }
        track_instruction_list_values(
            &mut tracked,
            &cue.instructions,
            blueprint_data_provider,
            selection_resolver,
        );
        for part in &cue.parts {
            track_instruction_list_values(
                &mut tracked,
                &part.instructions,
                blueprint_data_provider,
                selection_resolver,
            );
        }
    }

    tracked
}

/// Builds flattened block-marker instructions for tracked fixture attributes.
pub(super) fn block_instructions_from_tracked_values(
    tracked: &TrackedCueValues,
    existing_assertions: Option<&HashSet<TrackedFixtureAttribute>>,
    fixture_data_provider: &FixtureDataProviderExt,
) -> Vec<BoundCueInstruction> {
    let mut grouped = HashMap::<FixtureRef, HashMap<Attribute, ValueSource>>::new();
    for (key, tracked_value) in tracked {
        if existing_assertions.is_some_and(|assertions| assertions.contains(key)) {
            continue;
        }
        let (fixture, attribute) = key;
        grouped
            .entry(fixture.clone())
            .or_default()
            .insert(attribute.clone(), ValueSource::Inline(tracked_value.value));
    }
    collapse_identical_complete_fixture_blocks(&mut grouped, fixture_data_provider);

    let mut instructions = grouped
        .into_iter()
        .map(|(fixture, values)| BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values,
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
                transitions: Default::default(),
            },
        })
        .collect::<Vec<_>>();
    instructions.sort_by_key(|instruction| {
        cue_instruction_fixture(instruction)
            .map(|fixture| (fixture.fixture_uid, fixture.index))
            .unwrap_or_default()
    });
    instructions
}

/// Collapses identical per-element block rows into one whole-fixture block row.
pub(super) fn collapse_identical_complete_fixture_blocks(
    grouped: &mut HashMap<FixtureRef, HashMap<Attribute, ValueSource>>,
    fixture_data_provider: &FixtureDataProviderExt,
) {
    let fixture_uids = grouped
        .keys()
        .map(|fixture| fixture.fixture_uid)
        .collect::<HashSet<_>>();

    for fixture_uid in fixture_uids {
        let Ok(fixture) = fixture_data_provider.inner.get(fixture_uid) else {
            continue;
        };
        let element_count = fixture.elements.len() as u32;
        if element_count == 0 {
            continue;
        }

        let whole_fixture = FixtureRef {
            fixture_uid,
            index: None,
        };
        if grouped.contains_key(&whole_fixture) {
            continue;
        }

        let mut element_refs = Vec::with_capacity(element_count as usize);
        let mut first_payload: Option<HashMap<Attribute, ValueSource>> = None;
        let mut can_collapse = true;
        for index in 1..=element_count {
            let element_ref = FixtureRef {
                fixture_uid,
                index: Some(index),
            };
            let Some(payload) = grouped.get(&element_ref) else {
                can_collapse = false;
                break;
            };
            if first_payload.as_ref().is_some_and(|first| first != payload) {
                can_collapse = false;
                break;
            }
            first_payload.get_or_insert_with(|| payload.clone());
            element_refs.push(element_ref);
        }

        if can_collapse && let Some(payload) = first_payload {
            for element_ref in element_refs {
                grouped.remove(&element_ref);
            }
            grouped.insert(whole_fixture, payload);
        }
    }
}

/// Returns the single fixture ref addressed by a normalized cue instruction row.
pub(super) fn cue_instruction_fixture(instruction: &BoundCueInstruction) -> Option<&FixtureRef> {
    let SelectionExpr::Resolved(fixtures) = &instruction.selection.source else {
        return None;
    };
    if !instruction.selection.clauses.is_empty() || fixtures.len() != 1 {
        return None;
    }
    fixtures.first()
}

/// Returns whether an incoming block row should edit an existing row.
pub(super) fn block_rows_match(
    existing: &BoundCueInstruction,
    incoming: &BoundCueInstruction,
) -> bool {
    if existing.cue_instruction.blueprint_application.is_some()
        || incoming.cue_instruction.blueprint_application.is_some()
    {
        return false;
    }
    let Some(existing_fixture) = cue_instruction_fixture(existing) else {
        return existing.selection == incoming.selection;
    };
    let Some(incoming_fixture) = cue_instruction_fixture(incoming) else {
        return existing.selection == incoming.selection;
    };

    existing_fixture == incoming_fixture
        || (incoming_fixture.index.is_none()
            && existing_fixture.fixture_uid == incoming_fixture.fixture_uid)
}

/// Returns whether an element block row overlaps an existing whole-fixture row.
pub(super) fn element_block_targets_existing_whole_fixture_row(
    existing: &[BoundCueInstruction],
    incoming: &BoundCueInstruction,
) -> bool {
    let Some(incoming_fixture) = cue_instruction_fixture(incoming) else {
        return false;
    };
    if incoming_fixture.index.is_none() {
        return false;
    }

    existing.iter().any(|candidate| {
        if candidate.cue_instruction.blueprint_application.is_some() {
            return false;
        }
        let Some(existing_fixture) = cue_instruction_fixture(candidate) else {
            return false;
        };
        existing_fixture.index.is_none()
            && existing_fixture.fixture_uid == incoming_fixture.fixture_uid
    })
}

/// Merges generated block instructions into an existing instruction list.
pub(super) fn merge_block_instructions(
    existing: &mut Vec<BoundCueInstruction>,
    incoming: Vec<BoundCueInstruction>,
) {
    for incoming_instruction in incoming {
        let blocked_by_whole_fixture_row =
            element_block_targets_existing_whole_fixture_row(existing, &incoming_instruction);
        let mut matched_existing = false;
        for existing_instruction in existing
            .iter_mut()
            .filter(|candidate| block_rows_match(candidate, &incoming_instruction))
        {
            matched_existing = true;
            existing_instruction
                .cue_instruction
                .merge(incoming_instruction.cue_instruction.clone());
        }
        if !matched_existing && !blocked_by_whole_fixture_row {
            existing.push(incoming_instruction);
        }
    }
}

/// Adds assertions for every value tracked into the target instruction list.
pub(super) fn block_tracked_values(
    instructions: &mut Vec<BoundCueInstruction>,
    tracked: &TrackedCueValues,
    overwrite: bool,
    selection_resolver: &SpatialSelectionResolver,
    fixture_data_provider: &FixtureDataProviderExt,
) {
    let existing_assertions =
        (!overwrite).then(|| asserted_fixture_attributes(instructions, selection_resolver));
    let incoming = block_instructions_from_tracked_values(
        tracked,
        existing_assertions.as_ref(),
        fixture_data_provider,
    );
    merge_block_instructions(instructions, incoming);
}

/// Returns the fixture attributes already asserted by an instruction list.
pub(super) fn asserted_fixture_attributes(
    instructions: &[BoundCueInstruction],
    selection_resolver: &SpatialSelectionResolver,
) -> HashSet<TrackedFixtureAttribute> {
    let mut asserted = HashSet::new();
    for instruction in instructions {
        let fixtures = resolved_instruction_fixtures(instruction, selection_resolver);
        for fixture in fixtures {
            for attribute in instruction.cue_instruction.values.keys() {
                asserted.insert((fixture.clone(), attribute.clone()));
            }
        }
    }
    asserted
}

/// Returns whether one asserted value matches the tracked-in fixture attribute value.
pub(super) fn asserted_value_matches_tracked(
    fixture: &FixtureRef,
    attribute: &Attribute,
    value: ParameterValue,
    tracked: &TrackedCueValues,
    fixture_data_provider: &FixtureDataProviderExt,
) -> bool {
    let key = (fixture.clone(), attribute.clone());
    if tracked
        .get(&key)
        .is_some_and(|tracked_value| tracked_value.value == value)
    {
        return true;
    }
    if fixture.index.is_some() {
        return false;
    }

    let Ok(fixture_data) = fixture_data_provider.inner.get(fixture.fixture_uid) else {
        return false;
    };
    let element_count = fixture_data.elements.len() as u32;
    element_count > 0
        && (1..=element_count).all(|index| {
            let key = (
                FixtureRef {
                    fixture_uid: fixture.fixture_uid,
                    index: Some(index),
                },
                attribute.clone(),
            );
            tracked
                .get(&key)
                .is_some_and(|tracked_value| tracked_value.value == value)
        })
}

/// Removes assertions that still correspond to tracked-in values.
pub(super) fn unblock_tracked_values(
    instructions: &mut Vec<BoundCueInstruction>,
    tracked: &TrackedCueValues,
    selection_resolver: &SpatialSelectionResolver,
    fixture_data_provider: &FixtureDataProviderExt,
) {
    for instruction in instructions.iter_mut() {
        let fixtures = resolved_instruction_fixtures(instruction, selection_resolver);
        let attributes_to_unblock = instruction
            .cue_instruction
            .values
            .iter()
            .filter_map(|(attribute, source)| {
                let block_matches_tracked = !fixtures.is_empty()
                    && fixtures
                        .iter()
                        .enumerate()
                        .all(|(selection_index, fixture)| {
                            let Some(value) = tracked_parameter_value_for_source(
                                source,
                                selection_index,
                                fixtures.len(),
                            ) else {
                                return false;
                            };
                            asserted_value_matches_tracked(
                                fixture,
                                attribute,
                                value,
                                tracked,
                                fixture_data_provider,
                            )
                        });
                block_matches_tracked.then(|| attribute.clone())
            })
            .collect::<Vec<_>>();
        for attribute in attributes_to_unblock {
            instruction.cue_instruction.values.remove(&attribute);
            instruction
                .cue_instruction
                .transitions_by_attribute
                .remove(&attribute);
            for fixture_transition in
                &mut instruction.cue_instruction.transitions_by_fixture_attribute
            {
                fixture_transition
                    .transitions_by_attribute
                    .remove(&attribute);
            }
            instruction
                .cue_instruction
                .transitions_by_fixture_attribute
                .retain(|transition| !transition.transitions_by_attribute.is_empty());
        }
    }
    instructions.retain(|instruction| instruction_has_attributes(&instruction.cue_instruction));
}

/// Applies a block or unblock operation to the cue or cue part target.
pub(super) fn apply_block_operation_to_cue(
    cue: &mut Cue,
    part_id: Option<u32>,
    tracked: &TrackedCueValues,
    operation: BlockCueOperation,
    overwrite: bool,
    selection_resolver: &SpatialSelectionResolver,
    fixture_data_provider: &FixtureDataProviderExt,
) -> Result<(), String> {
    let instructions = match part_id {
        Some(part_id) => {
            &mut cue
                .parts
                .iter_mut()
                .find(|part| part.identifiers.id == part_id)
                .ok_or_else(|| format!("Cue {} part {} not found", cue.identifiers.id, part_id))?
                .instructions
        }
        None => &mut cue.instructions,
    };

    match operation {
        BlockCueOperation::Block => block_tracked_values(
            instructions,
            tracked,
            overwrite,
            selection_resolver,
            fixture_data_provider,
        ),
        BlockCueOperation::Unblock => unblock_tracked_values(
            instructions,
            tracked,
            selection_resolver,
            fixture_data_provider,
        ),
    }
    Ok(())
}

/// Cue tracking operation requested by a block command.
#[derive(Clone, Copy)]
pub(super) enum BlockCueOperation {
    Block,
    Unblock,
}

/// Resolves a cue that can be edited by sequence and cue id.
pub(super) fn cue_by_sequence_id(
    cue_data_provider: &DataProvider<Cue>,
    sequence_data_provider: &DataProvider<Sequence>,
    sequence_id: u32,
    cue_id: u32,
) -> Option<Cue> {
    if cue_id == 0 {
        return sequence_data_provider
            .from_id(sequence_id)
            .ok()
            .map(|sequence| sequence.setup_cue.clone());
    }

    cue_data_provider
        .cue_by_sequence_id(sequence_data_provider, sequence_id, cue_id)
        .ok()
        .map(|cue| (*cue).clone())
}

/// Handles cue block and unblock commands by storing an updated cue definition.
pub(super) fn handle_block_cue_command(
    command_id: uuid::Uuid,
    outbound: &mut CommandResponder,
    cue_data_provider: &mut DataProvider<Cue>,
    sequence_data_provider: &mut DataProvider<Sequence>,
    cue_definition_changes: &mut MessageWriter<CueDefinitionChange>,
    sequence_definition_changes: &mut MessageWriter<SequenceDefinitionChange>,
    selection_resolver: &SpatialSelectionResolver,
    fixture_data_provider: &FixtureDataProviderExt,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    sequence_id: u32,
    cue_id: u32,
    part_id: Option<u32>,
    operation: BlockCueOperation,
    overwrite: bool,
) -> bool {
    let sequence = match sequence_data_provider.from_id(sequence_id) {
        Ok(sequence) => (*sequence).clone(),
        Err(_) => {
            write_cue_command_error(
                outbound,
                command_id,
                format!("Sequence {} not found", sequence_id),
            );
            return false;
        }
    };
    let Some(mut cue) = cue_by_sequence_id(
        cue_data_provider,
        sequence_data_provider,
        sequence_id,
        cue_id,
    ) else {
        write_cue_command_error(
            outbound,
            command_id,
            format!("Cue {}.{} not found", sequence_id, cue_id),
        );
        return false;
    };

    let tracked = tracked_values_before_cue(
        &sequence,
        cue_data_provider,
        blueprint_data_provider,
        cue_id,
        selection_resolver,
    );
    if let Err(message) = apply_block_operation_to_cue(
        &mut cue,
        part_id,
        &tracked,
        operation,
        overwrite,
        selection_resolver,
        fixture_data_provider,
    ) {
        write_cue_command_error(outbound, command_id, message);
        return false;
    }

    if cue_id == 0 {
        let mut sequence = sequence;
        sequence.setup_cue = cue;
        store_sequence_definition(
            &sequence,
            selection_resolver,
            command_id,
            sequence_data_provider,
            outbound,
            sequence_definition_changes,
        )
    } else {
        store_cue_definition(
            &cue,
            selection_resolver,
            command_id,
            cue_data_provider,
            outbound,
            cue_definition_changes,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tracks authored mixed-unit waypoints without borrowing the neighboring target value.
    #[test]
    fn exact_fan_waypoints_preserve_mixed_value_types() {
        let values = vec![
            ParameterValue::AbsolutePercent { value: 0.5.into() },
            ParameterValue::Absolute { value: 25.0 },
            ParameterValue::AbsolutePercent { value: 0.8.into() },
        ];
        let source = ValueSource::Fanned {
            values: values.clone(),
        };
        for (index, expected) in values.iter().enumerate() {
            assert_eq!(
                tracked_parameter_value_for_source(&source, index, values.len()),
                Some(*expected)
            );
        }
    }
}
