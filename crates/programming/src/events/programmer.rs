// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime programmer selection and instruction mutation handlers.

use bevy_ecs::system::SystemParam;

use super::cues::{write_command_error, write_command_success, write_command_warning};
use super::planning::{
    programmer_action_requires_selection_flatten_confirmation, release_would_flatten_non_resolved,
    selection_flatten_approval_issue_error, selection_flatten_confirmation_error,
};
use super::release::partition_fixture_ref_for_release;
use super::store_mode::add_programmer_instruction_with_overrides;
use super::*;

mod instruction_release;
mod operations;
mod selection;
mod values;

/// Cohesive runtime state used while mutating programmer selection and instructions.
#[derive(SystemParam)]
pub struct ProgrammerMutationState<'w> {
    /// Publishes terminal command outcomes and non-terminal notices.
    responder: CommandResponder<'w>,
    /// Active programmer selection, instructions, and recalled-cue context.
    programmer: ResMut<'w, Programmer>,
    /// Resolves non-spatial fixture selections.
    selection_resolver: SelectionResolver<'w>,
    /// Resolves spatial selection pipelines against fixture and group data.
    spatial_selection_resolver: SpatialSelectionResolver<'w>,
    /// Supplies fixture element metadata needed by partial releases and overrides.
    fixture_data: Res<'w, FixtureDataProviderExt>,
    /// Controls operator confirmation policy for destructive selection flattening.
    settings: Res<'w, DeskSettings>,
    /// Stores single-use capabilities for approved selection flattening.
    approvals: ResMut<'w, SelectionFlattenApprovals>,
    /// Retains high-level commands until their planned actions reach dispatch.
    pending_plans: ResMut<'w, PendingUserCommandPlans>,
    /// Joins delegated cue and playback operations for each programmer action.
    pending_action_workflows: ResMut<'w, PendingProgrammerActionWorkflows>,
}

/// Programmer operation reader and the delegated operation writers it feeds.
///
/// Reading and writing [`ProgrammerOperation`]s in one system requires a [`ParamSet`]; its
/// accessors rebind the `'static` member lifetimes to the borrow of the set.
type ProgrammerOperationChannels<'w, 's> = ParamSet<
    'w,
    's,
    (
        MessageReader<'static, 'static, EngineOperationEnvelope<ProgrammerOperation>>,
        MessageWriter<'static, EngineOperationEnvelope<CueLifecycleOperation>>,
        MessageWriter<'static, EngineOperationEnvelope<PlaybackOperation>>,
        MessageWriter<'static, EngineOperationEnvelope<ProgrammerOperation>>,
    ),
>;

/// Forwards selection resolution warnings and rejects selections that resolved to nothing.
///
/// Every issue is reported as a command warning. When `resolved_empty` is set and resolution
/// reported issues, the command fails with every issue joined and `false` is returned so the
/// caller leaves programmer state untouched.
fn accept_resolved_selection<T>(
    responder: &mut CommandResponder,
    correlation_id: uuid::Uuid,
    result: &PartialResult<T>,
    resolved_empty: bool,
) -> bool {
    for warning in &result.issues {
        write_command_warning(responder, correlation_id, warning.clone());
    }
    if resolved_empty && result.is_partial() {
        write_command_error(
            responder,
            correlation_id,
            "programmer.selection_invalid",
            result.issues.join("; "),
        );
        return false;
    }
    true
}

/// Handles programmer commands, then applies every programmer operation written this frame.
///
/// Commands route by family: clear and release commands become [`ProgrammerOperation`]s,
/// instruction commands mutate programmer rows, and selection commands change the active
/// selection. Operations written here, by planned user commands, and by automation are then
/// applied in one pass so they share confirmation and delegation handling.
pub fn handle_programmer_events(
    mut events_reader: MessageReader<CommandEnvelope<ProgrammerCommand>>,
    mut channels: ProgrammerOperationChannels,
    mut state: ProgrammerMutationState,
) {
    for event in events_reader.read() {
        match &event.command {
            ProgrammerCommand::ClearProgrammer
            | ProgrammerCommand::ClearProgrammerSelection
            | ProgrammerCommand::ClearProgrammerValues
            | ProgrammerCommand::ReleaseProgrammerValues { .. } => {
                values::handle_release_command(&mut state, &mut channels.p3(), event);
            }
            ProgrammerCommand::AddProgrammerInstruction { .. }
            | ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(_) => {
                values::handle_instruction_command(&mut state, event);
            }
            ProgrammerCommand::SetProgrammerSelection(_)
            | ProgrammerCommand::SetProgrammerSpatialSelection(_)
            | ProgrammerCommand::AddProgrammerSelection(_)
            | ProgrammerCommand::RemoveProgrammerSelection(_) => {
                selection::handle_command(&mut state, event);
            }
            _ => {}
        }
    }

    operations::apply_operations(&mut state, &mut channels);
}

/// Reports programmer actions whose delegated cue and playback operations have all finished.
///
/// Scheduled after every `EventHandling` handler, so operation results written by delegated
/// handlers this frame complete their programmer command in the same frame.
pub fn finish_programmer_action_workflows(
    mut results: MessageReader<OperationResult<(), CommandError>>,
    mut workflows: ResMut<PendingProgrammerActionWorkflows>,
    mut responder: CommandResponder,
) {
    let finished: Vec<_> = results
        .read()
        .filter_map(|result| workflows.resolve(result.operation_id, result.result.clone()))
        .collect();

    for (command_id, result) in finished {
        match result {
            Ok(()) => write_command_success(&mut responder, command_id.into()),
            Err(error) => {
                if let Err(completion_error) = responder.fail(command_id, error) {
                    tracing::error!(
                        %command_id,
                        %completion_error,
                        "programmer_parameter_release_failure_failed"
                    );
                }
            }
        }
    }
}
