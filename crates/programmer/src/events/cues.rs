// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue storage, recall, command responses, and store workflow completion.

use bevy_ecs::system::SystemParam;

use super::store_mode::{
    apply_store_mode, normalize_existing_store_mode_instructions,
    normalize_incoming_store_mode_instructions, normalize_replace_store_mode_instructions,
    resolved_programmer_instructions,
};
use super::*;

/// Cohesive state for storing and recalling cues from active programmer data.
#[derive(SystemParam)]
pub struct ProgrammerCueState<'w> {
    /// Publishes immediate cue recall failures and successes.
    responder: CommandResponder<'w>,
    /// Supplies active instructions and receives recalled cue contents.
    programmer: ResMut<'w, Programmer>,
    /// Buffers programmer actions needed to apply recalled selections.
    pending_actions: ResMut<'w, PendingEngineActionBuffer>,
    /// Tracks cue-store operations until the cues domain reports completion.
    store_workflows: ResMut<'w, StoreCueWorkflows>,
    /// Provides cue definitions used for recall and existing-target store modes.
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    /// Resolves sequence IDs and setup cue targets.
    sequence_data_provider: Res<'w, DataProvider<Sequence>>,
    /// Materializes programmer and recalled cue selections deterministically.
    spatial_selection_resolver: SpatialSelectionResolver<'w>,
}

/// Reports a successful command through semantic lifecycle ownership.
pub(super) fn write_command_success(responder: &mut CommandResponder, correlation_id: uuid::Uuid) {
    let command_id = CommandId::from(correlation_id);
    if let Err(error) = responder.succeed(command_id) {
        tracing::error!(%command_id, %error, "programmer_command_success_failed");
    }
}

/// Reports a failed command through semantic lifecycle ownership.
pub(super) fn write_command_error(
    responder: &mut CommandResponder,
    correlation_id: uuid::Uuid,
    code: &'static str,
    message: String,
) {
    tracing::warn!("{}", message);
    let command_id = CommandId::from(correlation_id);
    if let Err(error) = responder.fail(command_id, CommandError::new(code, message)) {
        tracing::error!(%command_id, %error, "programmer_command_failure_failed");
    }
}

/// Reports a cue store command error and skips further processing.
fn write_store_error(
    responder: &mut CommandResponder,
    correlation_id: uuid::Uuid,
    message: String,
) {
    write_command_error(
        responder,
        correlation_id,
        "programmer.store_cue_failed",
        message,
    );
}

/// Reports non-terminal operator feedback without resolving a tracked command.
pub(super) fn write_command_warning(
    responder: &mut CommandResponder,
    correlation_id: uuid::Uuid,
    message: String,
) {
    tracing::warn!("{}", message);
    let command_id = CommandId::from(correlation_id);
    if let Err(error) = responder.notice(command_id, NoticeLevel::Warning, message) {
        tracing::error!(%command_id, %error, "programmer_command_notice_failed");
    }
}

/// Resolves a cue that can be recalled by sequence and cue id.
fn recallable_cue_by_sequence_id(
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

/// Builds the active selection represented by recalled programmer instructions.
fn active_selection_from_recalled_instructions(
    instructions: &[BoundCueInstruction],
    spatial_selection_resolver: &SpatialSelectionResolver,
) -> SpatialSelection {
    let mut seen = HashSet::new();
    let mut fixtures = Vec::new();
    for instruction in instructions {
        let resolved = spatial_selection_resolver
            .resolve(&instruction.selection)
            .into_value();
        for fixture in resolved.canonical {
            if seen.insert(fixture.clone()) {
                fixtures.push(fixture);
            }
        }
    }
    SelectionExpr::Resolved(fixtures).into()
}

/// Rewrites dynamic group references in cue instructions to stable UID references before storage.
fn stabilize_stored_cue_instructions(
    instructions: &mut [BoundCueInstruction],
    spatial_selection_resolver: &SpatialSelectionResolver,
) {
    for instruction in instructions {
        let stabilized =
            spatial_selection_resolver.stabilize_group_refs_selection(&instruction.selection);
        for warning in &stabilized.issues {
            tracing::warn!("{}", warning);
        }
        instruction.selection = stabilized.value;
    }
}

/// Handles events related to cues in the programmer
pub fn handle_cue_events(
    mut events_reader: MessageReader<CommandEnvelope<ProgrammerCommand>>,
    mut store_operations: MessageWriter<EngineActionEnvelope<CueStoreOperation>>,
    state: ProgrammerCueState,
) {
    let ProgrammerCueState {
        mut responder,
        mut programmer,
        mut pending_actions,
        mut store_workflows,
        cue_data_provider,
        sequence_data_provider,
        spatial_selection_resolver,
    } = state;

    for event in events_reader.read() {
        let correlation_id = event.command_id.into();
        let undo_id = event.undo_id;
        match &event.command {
            // StoreCue materializes active programmer values before cue storage.
            ProgrammerCommand::StoreCue {
                sequence_id,
                cue_id,
                part_id,
                mode,
                label,
            } => {
                let cue_target = match cue_id {
                    StoreCueId::Exact(cue_id) => CueStoreTarget::Exact(*cue_id),
                    StoreCueId::Next => {
                        if *mode != StoreMode::Replace {
                            write_store_error(
                                &mut responder,
                                correlation_id,
                                format!("Store mode {:?} requires an existing cue target", mode),
                            );
                            continue;
                        }
                        CueStoreTarget::Next
                    }
                };
                let part_target = match part_id {
                    StoreCuePartId::Exact(part_id) => CuePartStoreTarget::Exact(*part_id),
                    StoreCuePartId::Next => {
                        if *mode != StoreMode::Replace {
                            write_store_error(
                                &mut responder,
                                correlation_id,
                                format!(
                                    "Store mode {:?} requires an existing cue part target",
                                    mode
                                ),
                            );
                            continue;
                        }
                        CuePartStoreTarget::Next
                    }
                };
                let resolved_cue_id = match cue_target {
                    CueStoreTarget::Exact(cue_id) => cue_id,
                    CueStoreTarget::Next => 0,
                };
                tracing::debug!(
                    sequence_id,
                    cue_target = ?cue_target,
                    part_target = ?part_target,
                    "StoreCue event received"
                );

                let command_id = event.command_id;
                let use_workflow = responder.is_active(command_id);
                let recalled_timing_defaults = (*mode == StoreMode::Replace)
                    .then(|| programmer.recalled_cue_timing_defaults.clone())
                    .flatten();

                if matches!(cue_target, CueStoreTarget::Exact(0)) {
                    if !matches!(part_target, CuePartStoreTarget::Exact(0)) {
                        write_store_error(
                            &mut responder,
                            correlation_id,
                            "Setup cue stores cannot target cue parts".to_string(),
                        );
                        continue;
                    }

                    let mut sequence = match sequence_data_provider.from_id(*sequence_id) {
                        Ok(sequence_ref) => (*sequence_ref).clone(),
                        Err(_) if *mode == StoreMode::Replace => {
                            let mut new_sequence = Sequence::default();
                            new_sequence.identifiers.id = *sequence_id;
                            new_sequence
                        }
                        Err(_) => {
                            write_store_error(
                                &mut responder,
                                correlation_id,
                                format!(
                                    "Sequence {} must exist for {:?} setup cue store mode",
                                    sequence_id, mode
                                ),
                            );
                            continue;
                        }
                    };
                    let mut cue = sequence.setup_cue.clone();
                    cue.identifiers.id = 0;

                    if let Some(label) = label {
                        cue.identifiers.label = label.clone();
                    } else if cue.identifiers.label.trim().is_empty() {
                        cue.identifiers.label = "Setup".to_string();
                    }

                    if *mode != StoreMode::Replace {
                        cue.instructions = normalize_existing_store_mode_instructions(
                            std::mem::take(&mut cue.instructions),
                            &spatial_selection_resolver,
                        );
                    }
                    if let Some(defaults) = &recalled_timing_defaults {
                        cue.transitions = defaults.transitions.clone();
                        cue.transitions_by_attribute = defaults.transitions_by_attribute.clone();
                    }

                    let incoming =
                        resolved_programmer_instructions(&programmer, &spatial_selection_resolver);
                    let incoming = match mode {
                        StoreMode::Replace => normalize_replace_store_mode_instructions(incoming),
                        _ => normalize_incoming_store_mode_instructions(incoming),
                    };
                    let skipped_whole_fixture_row =
                        apply_store_mode(&mut cue.instructions, incoming, *mode);
                    stabilize_stored_cue_instructions(
                        &mut cue.instructions,
                        &spatial_selection_resolver,
                    );
                    if skipped_whole_fixture_row {
                        write_command_warning(
                            &mut responder,
                            correlation_id,
                            "Element store skipped existing whole-fixture instruction rows"
                                .to_string(),
                        );
                    }

                    sequence.setup_cue = cue;
                    tracing::info!(
                        "Stored programmer instructions as sequence {} setup cue",
                        sequence_id
                    );
                    if use_workflow {
                        let operation_id = OperationId::new();
                        store_workflows.commands.insert(operation_id, command_id);
                        store_operations.write(EngineActionEnvelope {
                            operation_id,
                            command_id: Some(command_id),
                            undo_id: Some(undo_id),
                            action: CueStoreOperation::StoreSequence {
                                sequence: Box::new(sequence),
                                undo_label: event
                                    .command
                                    .to_cli_command()
                                    .unwrap_or_else(|| "store cue".to_string()),
                            },
                        });
                    } else {
                        pending_actions.push(DynEngineActionEnvelope::with_context(
                            OperationId::new(),
                            None,
                            Some(undo_id),
                            Box::new(CueAction::StoreSequence(Box::new(sequence))),
                        ));
                    }
                    continue;
                }

                let existing_cue = match cue_target {
                    CueStoreTarget::Exact(cue_id) => cue_data_provider
                        .cue_by_sequence_id(&sequence_data_provider, *sequence_id, cue_id)
                        .ok()
                        .map(|cue_ref| (*cue_ref).clone()),
                    CueStoreTarget::Next => None,
                };
                if *mode != StoreMode::Replace && existing_cue.is_none() {
                    write_store_error(
                        &mut responder,
                        correlation_id,
                        format!(
                            "Cue {}.{} must exist for {:?} store mode",
                            sequence_id, resolved_cue_id, mode
                        ),
                    );
                    continue;
                }

                let existing_part = match (&existing_cue, part_target) {
                    (Some(cue), CuePartStoreTarget::Exact(0)) => {
                        let mut part = CuePart::default();
                        part.identifiers.id = 0;
                        part.identifiers.label = cue.identifiers.label.clone();
                        part.transitions = cue.transitions.clone();
                        part.transitions_by_attribute = cue.transitions_by_attribute.clone();
                        part.instructions = cue.instructions.clone();
                        part.tracking_flags = cue.tracking_flags;
                        Some(part)
                    }
                    (Some(cue), CuePartStoreTarget::Exact(part_id)) => {
                        cue.part_by_id(part_id).cloned()
                    }
                    (None, CuePartStoreTarget::Exact(_)) => None,
                    (_, CuePartStoreTarget::Next) => None,
                };
                let resolved_part_id = match part_target {
                    CuePartStoreTarget::Exact(part_id) => part_id,
                    CuePartStoreTarget::Next => 0,
                };
                if *mode != StoreMode::Replace && existing_part.is_none() {
                    write_store_error(
                        &mut responder,
                        correlation_id,
                        format!(
                            "Cue {}.{} part {} must exist for {:?} store mode",
                            sequence_id, resolved_cue_id, resolved_part_id, mode
                        ),
                    );
                    continue;
                }

                let mut part = existing_part.unwrap_or_else(|| {
                    let mut new_part = CuePart::default();
                    new_part.identifiers.id = resolved_part_id;
                    new_part
                });
                if let Some(label) = label {
                    part.identifiers.label = label.clone();
                } else if part.identifiers.label.trim().is_empty()
                    && matches!(part_target, CuePartStoreTarget::Exact(part_id) if part_id > 0)
                {
                    part.identifiers.label = format!("Part {}", resolved_part_id);
                }
                if let Some(defaults) = &recalled_timing_defaults {
                    part.transitions = defaults.transitions.clone();
                    part.transitions_by_attribute = defaults.transitions_by_attribute.clone();
                }

                if *mode != StoreMode::Replace {
                    part.instructions = normalize_existing_store_mode_instructions(
                        std::mem::take(&mut part.instructions),
                        &spatial_selection_resolver,
                    );
                }

                let incoming =
                    resolved_programmer_instructions(&programmer, &spatial_selection_resolver);
                let incoming = match mode {
                    StoreMode::Replace => normalize_replace_store_mode_instructions(incoming),
                    _ => normalize_incoming_store_mode_instructions(incoming),
                };
                let skipped_whole_fixture_row =
                    apply_store_mode(&mut part.instructions, incoming, *mode);
                stabilize_stored_cue_instructions(
                    &mut part.instructions,
                    &spatial_selection_resolver,
                );
                if skipped_whole_fixture_row {
                    write_command_warning(
                        &mut responder,
                        correlation_id,
                        "Element store skipped existing whole-fixture instruction rows".to_string(),
                    );
                }

                let undo_label = event
                    .command
                    .to_cli_command()
                    .unwrap_or_else(|| "store cue".to_string());
                if use_workflow {
                    let operation_id = OperationId::new();
                    store_workflows.commands.insert(operation_id, command_id);
                    store_operations.write(EngineActionEnvelope {
                        operation_id,
                        command_id: Some(command_id),
                        undo_id: Some(undo_id),
                        action: CueStoreOperation::StoreCueInSequence {
                            sequence_id: *sequence_id,
                            cue_id: cue_target,
                            part_id: part_target,
                            part: Box::new(part),
                            undo_label,
                        },
                    });
                } else {
                    pending_actions.push(DynEngineActionEnvelope::with_context(
                        OperationId::new(),
                        None,
                        Some(undo_id),
                        Box::new(CueAction::StoreCueInSequence {
                            sequence_id: *sequence_id,
                            cue_id: cue_target,
                            part_id: part_target,
                            part: Box::new(part),
                            undo_label,
                        }),
                    ));
                }
            }

            ProgrammerCommand::RecallCue {
                sequence_id,
                cue_id,
                part_id,
                select,
            } => {
                tracing::debug!("Recalling cue {}.{} part {}", sequence_id, cue_id, part_id);
                let recallable_cue = recallable_cue_by_sequence_id(
                    &cue_data_provider,
                    &sequence_data_provider,
                    *sequence_id,
                    *cue_id,
                );
                if *part_id == 0 {
                    if let Some(cue) = recallable_cue {
                        programmer.clear();
                        programmer.set_recalled_cue_timing_defaults(
                            cue.transitions.clone(),
                            cue.transitions_by_attribute.clone(),
                        );
                        for instruction in &cue.instructions {
                            programmer.add_instruction(BoundCueInstruction {
                                selection: instruction.selection.clone(),
                                cue_instruction: instruction.cue_instruction.clone(),
                            });
                        }
                        if *select {
                            programmer.set_active_spatial_selection(
                                active_selection_from_recalled_instructions(
                                    &cue.instructions,
                                    &spatial_selection_resolver,
                                ),
                            );
                        }

                        tracing::trace!(
                            "Recalled {} instructions from cue {}.{}",
                            cue.instructions.len(),
                            sequence_id,
                            cue_id
                        );
                        write_command_success(&mut responder, correlation_id);
                    } else {
                        let error_msg = format!("Cue {}.{} not found", sequence_id, cue_id);
                        tracing::warn!("{}", error_msg);
                        write_command_error(
                            &mut responder,
                            correlation_id,
                            "programmer.cue_not_found",
                            error_msg,
                        );
                    }
                    continue;
                }

                match recallable_cue.and_then(|cue| cue.part_by_id(*part_id).cloned()) {
                    Some(part) => {
                        programmer.clear();
                        programmer.set_recalled_cue_timing_defaults(
                            part.transitions.clone(),
                            part.transitions_by_attribute.clone(),
                        );
                        for instruction in &part.instructions {
                            programmer.add_instruction(BoundCueInstruction {
                                selection: instruction.selection.clone(),
                                cue_instruction: instruction.cue_instruction.clone(),
                            });
                        }
                        if *select {
                            programmer.set_active_spatial_selection(
                                active_selection_from_recalled_instructions(
                                    &part.instructions,
                                    &spatial_selection_resolver,
                                ),
                            );
                        }

                        tracing::trace!(
                            "Recalled {} instructions from cue {}.{} part {}",
                            part.instructions.len(),
                            sequence_id,
                            cue_id,
                            part_id
                        );
                        write_command_success(&mut responder, correlation_id);
                    }
                    None => {
                        let error_msg =
                            format!("Cue {}.{} part {} not found", sequence_id, cue_id, part_id);
                        tracing::warn!("{}", error_msg);
                        write_command_error(
                            &mut responder,
                            correlation_id,
                            "programmer.cue_part_not_found",
                            error_msg,
                        );
                    }
                }
            }

            _ => {}
        }
    }
}

/// Resumes programmer-owned store workflows from cues-domain operation results.
pub fn resume_store_cue_workflows(
    mut results: MessageReader<OperationResult<CueStoreSuccess, CueStoreError>>,
    mut workflows: ResMut<StoreCueWorkflows>,
    mut responder: CommandResponder,
) {
    for result in results.read() {
        let Some(command_id) = workflows.commands.remove(&result.operation_id) else {
            tracing::warn!(
                operation_id = %result.operation_id,
                "unknown_cue_store_operation_result"
            );
            continue;
        };

        let response = match &result.result {
            Ok(success) => responder.succeed_with_output(command_id, success),
            Err(error) => responder.fail(
                command_id,
                CommandError::new(error.code, error.message.clone()),
            ),
        };
        if let Err(error) = response {
            tracing::error!(%command_id, %error, "cue_store_workflow_finish_failed");
        }
    }
}
