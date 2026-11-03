// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Removal of programmer instruction values for clear and release operations.

use super::*;

/// Returns whether an attribute-scoped release targets a live Blueprint row.
fn release_targets_blueprint_application(
    application: &BlueprintApplication,
    attributes: &[Attribute],
) -> bool {
    attributes
        .iter()
        .any(|attribute| match &application.selector {
            BlueprintSelector::All => true,
            BlueprintSelector::Attribute(selected) => selected == attribute,
            BlueprintSelector::Category(category) => attribute.category() == *category,
        })
}

/// Mutates programmer rows and returns lifecycle-managed cue cleanup, when delegated.
///
/// Instructions overlapping `selection` (or all instructions without one) lose the released
/// `attributes`, or every value when `attributes` is empty. Partially matched instructions are
/// split so unmatched fixtures keep their values. Fully emptied instructions are removed and
/// their cue instances released through a [`CueLifecycleOperation`], whose operation ID is
/// returned when it inherits the command context and must be awaited.
pub(super) fn release_programmer_values(
    state: &mut ProgrammerMutationState,
    correlation_id: uuid::Uuid,
    undo_id: uuid::Uuid,
    selection: Option<SelectionExpr>,
    attributes: &[Attribute],
    inherit_command_context: bool,
    cue_lifecycle_actions: &mut MessageWriter<EngineOperationEnvelope<CueLifecycleOperation>>,
) -> Option<OperationId> {
    let programmer: &mut Programmer = &mut state.programmer;
    let selection_resolver = &state.selection_resolver;
    let spatial_selection_resolver = &state.spatial_selection_resolver;
    let fixture_data = &state.fixture_data;

    let selection_filter: Option<Vec<FixtureRef>> = selection.map(|selection_expr| {
        selection_resolver
            .resolve_expr(&selection_expr)
            .into_value()
    });

    let mut updates: Vec<(uuid::Uuid, BoundCueInstruction)> = Vec::new();
    let mut removals: Vec<uuid::Uuid> = Vec::new();
    let mut additions: Vec<BoundCueInstruction> = Vec::new();

    for (uid, instruction) in programmer.active_instructions().iter() {
        let resolved_instruction_selection = spatial_selection_resolver
            .resolve(&instruction.selection)
            .into_value()
            .canonical;

        let (matched_fixtures, unmatched_fixtures) =
            if let Some(selection_filter) = &selection_filter {
                let mut matched = Vec::new();
                let mut unmatched = Vec::new();
                for fixture in &resolved_instruction_selection {
                    let (fixture_matched, fixture_unmatched) =
                        partition_fixture_ref_for_release(fixture, selection_filter, fixture_data);
                    matched.extend(fixture_matched);
                    unmatched.extend(fixture_unmatched);
                }
                (matched, unmatched)
            } else {
                (resolved_instruction_selection.clone(), Vec::new())
            };

        if matched_fixtures.is_empty() {
            continue;
        }

        if attributes.is_empty() {
            if unmatched_fixtures.is_empty() {
                removals.push(*uid);
            } else {
                updates.push((
                    *uid,
                    BoundCueInstruction {
                        selection: SelectionExpr::Resolved(unmatched_fixtures).into(),
                        cue_instruction: instruction.cue_instruction.clone(),
                    },
                ));
            }
            continue;
        }

        let mut filtered_instruction = instruction.cue_instruction.clone();
        for attribute in attributes {
            filtered_instruction.values.remove(attribute);
            filtered_instruction
                .transitions_by_attribute
                .remove(attribute);
        }
        if filtered_instruction
            .blueprint_application
            .as_ref()
            .is_some_and(|application| {
                release_targets_blueprint_application(application, attributes)
            })
        {
            filtered_instruction.blueprint_application = None;
        }

        let filtered_instruction_is_empty = filtered_instruction.values.is_empty()
            && filtered_instruction.blueprint_application.is_none();

        if unmatched_fixtures.is_empty() {
            if filtered_instruction_is_empty {
                removals.push(*uid);
            } else {
                updates.push((
                    *uid,
                    BoundCueInstruction {
                        selection: instruction.selection.clone(),
                        cue_instruction: filtered_instruction,
                    },
                ));
            }
        } else {
            updates.push((
                *uid,
                BoundCueInstruction {
                    selection: SelectionExpr::Resolved(unmatched_fixtures).into(),
                    cue_instruction: instruction.cue_instruction.clone(),
                },
            ));

            if !filtered_instruction_is_empty {
                additions.push(BoundCueInstruction {
                    selection: SelectionExpr::Resolved(matched_fixtures).into(),
                    cue_instruction: filtered_instruction,
                });
            }
        }
    }

    let mut released_uids = Vec::new();
    {
        let active_instructions = programmer.active_instructions_mut();
        for (uid, updated_instruction) in updates {
            if let Some(instruction) = active_instructions.get_mut(&uid) {
                *instruction = updated_instruction;
            }
        }

        for uid in removals {
            if active_instructions.remove(&uid).is_some() {
                released_uids.push(uid);
            }
        }
    }

    let release_operation_id = if released_uids.is_empty() {
        None
    } else {
        let action = CueLifecycleOperation::ReleaseCueInstances {
            uids: released_uids,
        };
        let envelope = if inherit_command_context {
            EngineOperationEnvelope::for_command_context(
                correlation_id.into(),
                undo_id.into(),
                action,
            )
        } else {
            EngineOperationEnvelope::detached(action)
        };
        let operation_id = envelope.operation_id;
        cue_lifecycle_actions.write(envelope);
        inherit_command_context.then_some(operation_id)
    };

    for instruction in additions {
        programmer.add_instruction(instruction);
    }

    if programmer.active_instructions().is_empty() {
        programmer.clear_recalled_cue_timing_defaults();
    }
    release_operation_id
}
