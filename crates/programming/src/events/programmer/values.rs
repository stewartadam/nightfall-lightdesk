// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programmer value commands: adding instructions and requesting clears or releases.

use super::*;

/// Translates clear and release commands into programmer operations.
///
/// The operations are applied later in the same system run by
/// [`super::operations::apply_operations`], so planned user commands and direct commands share
/// one release path. A release asking to flatten selections must carry a still-valid approval,
/// otherwise the command fails without writing an operation.
pub(super) fn handle_release_command(
    state: &mut ProgrammerMutationState,
    operations: &mut MessageWriter<EngineOperationEnvelope<ProgrammerOperation>>,
    event: &CommandEnvelope<ProgrammerCommand>,
) {
    let correlation_id = event.command_id.into();
    match &event.command {
        ProgrammerCommand::ClearProgrammer => {
            let action = if state.programmer.active_selection().is_empty() {
                ProgrammerOperation::ClearValues {
                    scope: Scope::All,
                    attributes: AttributeFilter::All,
                    allow_selection_flatten: false,
                }
            } else {
                ProgrammerOperation::ClearSelection
            };

            operations.write(EngineOperationEnvelope::for_command(event, action));
        }

        ProgrammerCommand::ClearProgrammerSelection => {
            operations.write(EngineOperationEnvelope::for_command(
                event,
                ProgrammerOperation::ClearSelection,
            ));
        }

        ProgrammerCommand::ClearProgrammerValues => {
            operations.write(EngineOperationEnvelope::for_command(
                event,
                ProgrammerOperation::ClearValues {
                    scope: Scope::All,
                    attributes: AttributeFilter::All,
                    allow_selection_flatten: false,
                },
            ));
        }

        ProgrammerCommand::ReleaseProgrammerValues {
            selection,
            attributes,
            allow_selection_flatten,
            selection_flatten_approval,
        } => {
            let approved = *allow_selection_flatten
                && selection_flatten_approval.is_some_and(|approval_id| {
                    state
                        .approvals
                        .consume(approval_id, "ProgrammerCommand", &event.command)
                });
            if *allow_selection_flatten && !approved {
                write_command_error(
                    &mut state.responder,
                    correlation_id,
                    "programmer.selection_flatten_approval_invalid",
                    "Selection-flatten approval is invalid or has already been used".to_string(),
                );
                return;
            }
            operations.write(EngineOperationEnvelope::for_command(
                event,
                ProgrammerOperation::ReleaseValues {
                    scope: selection.clone().map_or(Scope::All, Scope::Selection),
                    attributes: AttributeFilter::from_attributes(attributes),
                    allow_selection_flatten: approved,
                },
            ));
        }

        _ => {}
    }
}

/// Adds a cue instruction to the programmer, applying per-fixture overrides.
///
/// An explicit selection is validated first and the command fails when it resolves to nothing
/// because of resolution issues. With auto-select enabled, the active selection follows the
/// instruction's selection. Instructions targeting the active selection skip validation.
pub(super) fn handle_instruction_command(
    state: &mut ProgrammerMutationState,
    event: &CommandEnvelope<ProgrammerCommand>,
) {
    let correlation_id = event.command_id.into();
    match &event.command {
        ProgrammerCommand::AddProgrammerInstruction {
            selection,
            instruction,
        } => {
            let result = state.spatial_selection_resolver.resolve(selection);
            if !accept_resolved_selection(
                &mut state.responder,
                correlation_id,
                &result,
                result.value.is_empty(),
            ) {
                return;
            }

            add_programmer_instruction_with_overrides(
                &mut state.programmer,
                BoundCueInstruction {
                    selection: selection.clone(),
                    cue_instruction: instruction.to_owned(),
                },
                &state.spatial_selection_resolver,
                &state.fixture_data,
            );

            if state.settings.programmer_auto_select {
                state
                    .programmer
                    .set_active_spatial_selection(selection.clone());
            }
            write_command_success(&mut state.responder, correlation_id);
        }

        ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(instruction) => {
            let selection = state.programmer.active_spatial_selection();
            add_programmer_instruction_with_overrides(
                &mut state.programmer,
                BoundCueInstruction {
                    selection,
                    cue_instruction: instruction.to_owned(),
                },
                &state.spatial_selection_resolver,
                &state.fixture_data,
            );
            write_command_success(&mut state.responder, correlation_id);
        }

        _ => {}
    }
}
