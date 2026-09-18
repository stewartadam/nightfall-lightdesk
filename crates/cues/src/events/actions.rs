// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue store operations and action dispatch.

use super::*;

/// Mutable domain state shared while committing one cue store operation.
pub(super) struct CueStoreOperationResources<'a, 'cue_w, 'sequence_w> {
    cue_data_provider: &'a mut DataProvider<Cue>,
    sequence_data_provider: &'a mut DataProvider<Sequence>,
    undo_manager: &'a mut UndoManager,
    cue_definition_changes: &'a mut MessageWriter<'cue_w, CueDefinitionChange>,
    sequence_definition_changes: &'a mut MessageWriter<'sequence_w, SequenceDefinitionChange>,
}

/// Stores a complete sequence after validation and records its inverse operation.
pub(super) fn execute_sequence_store_operation(
    operation: &EngineActionEnvelope<CueStoreOperation>,
    sequence: &Sequence,
    selection_resolver: &SpatialSelectionResolver,
    undo_label: &str,
    sequence_data_provider: &mut DataProvider<Sequence>,
    undo_manager: &mut UndoManager,
    sequence_definition_changes: &mut MessageWriter<SequenceDefinitionChange>,
) -> Result<CueStoreSuccess, CueStoreError> {
    let sequence = stabilized_sequence(sequence, selection_resolver);
    let previous_sequence = sequence_data_provider
        .get(sequence.identifiers.uid)
        .ok()
        .map(|stored| (*stored).clone());
    sequence_data_provider
        .validate_add(&sequence)
        .map_err(|error| {
            CueStoreError::new(
                "cue.sequence_store_conflict",
                format!("Failed to store sequence: {error}"),
            )
        })?;

    let inverse: Box<dyn UndoableOperation> = match previous_sequence {
        Some(previous) => Box::new(CueAction::StoreSequence(Box::new(previous))),
        None => Box::new(CueCommand::DeleteSequence(sequence.identifiers.id)),
    };
    sequence_data_provider
        .add(sequence.clone())
        .map_err(|error| {
            CueStoreError::new(
                "cue.sequence_store_failed",
                format!("Failed to store sequence: {error}"),
            )
        })?;
    write_sequence_definition_updated(sequence_definition_changes, &sequence);
    push_operation_undo_entry(undo_manager, inverse, undo_label, operation);

    Ok(CueStoreSuccess {
        sequence_id: sequence.identifiers.id,
        cue_id: 0,
        part_id: 0,
    })
}

/// Stores one cue part and its sequence membership as one validated operation.
pub(super) fn execute_cue_store_operation(
    operation: &EngineActionEnvelope<CueStoreOperation>,
    sequence_id: u32,
    cue_id: CueStoreTarget,
    part_id: CuePartStoreTarget,
    part: &CuePart,
    selection_resolver: &SpatialSelectionResolver,
    undo_label: &str,
    resources: &mut CueStoreOperationResources,
) -> Result<CueStoreSuccess, CueStoreError> {
    let CueStoreOperationResources {
        cue_data_provider,
        sequence_data_provider,
        undo_manager,
        cue_definition_changes,
        sequence_definition_changes,
    } = resources;
    let resolved_cue_id = match cue_id {
        CueStoreTarget::Exact(cue_id) => cue_id,
        CueStoreTarget::Next => {
            next_available_cue_id(cue_data_provider, sequence_data_provider, sequence_id)
        }
    };
    let existing_cue = match cue_id {
        CueStoreTarget::Exact(_) => cue_data_provider
            .cue_by_sequence_id(sequence_data_provider, sequence_id, resolved_cue_id)
            .ok()
            .map(|cue_ref| (*cue_ref).clone()),
        CueStoreTarget::Next => None,
    };
    let mut cue = existing_cue.unwrap_or_else(|| {
        let mut new_cue = Cue::default();
        new_cue.identifiers.id = resolved_cue_id;
        new_cue.tracking_mode = Some(TrackingMode::Inherit);
        new_cue
    });
    cue.identifiers.id = resolved_cue_id;
    let previous_cue = cue_snapshot_by_uid(cue_data_provider, cue.identifiers.uid);
    let previous_sequence = sequence_snapshot_by_id(sequence_data_provider, sequence_id);

    let resolved_part_id = match part_id {
        CuePartStoreTarget::Exact(part_id) => part_id,
        CuePartStoreTarget::Next => next_available_part_id(&cue),
    };
    let mut part = part.clone();
    part.identifiers.id = resolved_part_id;
    if resolved_part_id == 0 {
        if !part.identifiers.label.trim().is_empty() {
            cue.identifiers.label = part.identifiers.label;
        } else if cue.identifiers.label.trim().is_empty() {
            cue.identifiers.label = format!("Cue {resolved_cue_id}");
        }
        cue.transitions = part.transitions;
        cue.transitions_by_attribute = part.transitions_by_attribute;
        cue.instructions = part.instructions;
        cue.tracking_flags = part.tracking_flags;
    } else {
        if cue.identifiers.label.trim().is_empty() {
            cue.identifiers.label = format!("Cue {resolved_cue_id}");
        }
        if part.identifiers.label.trim().is_empty() {
            part.identifiers.label = format!("Part {resolved_part_id}");
        }
        cue.upsert_part(part);
    }

    let cue = stabilized_cue(&cue, selection_resolver);
    let (sequence, sequence_changed) =
        sequence_with_cue_step(sequence_data_provider, sequence_id, cue.identifiers.uid);
    let sequence = stabilized_sequence(&sequence, selection_resolver);
    cue_data_provider.validate_add(&cue).map_err(|error| {
        CueStoreError::new(
            "cue.store_conflict",
            format!("Failed to store cue: {error}"),
        )
    })?;
    if sequence_changed {
        sequence_data_provider
            .validate_add(&sequence)
            .map_err(|error| {
                CueStoreError::new(
                    "cue.sequence_store_conflict",
                    format!("Failed to store cue sequence: {error}"),
                )
            })?;
    }

    cue_data_provider.add(cue.clone()).map_err(|error| {
        CueStoreError::new("cue.store_failed", format!("Failed to store cue: {error}"))
    })?;
    if sequence_changed && let Err(error) = sequence_data_provider.add(sequence.clone()) {
        let rollback = match &previous_cue {
            Some(previous) => cue_data_provider.add(previous.clone()).map(|_| ()),
            None => cue_data_provider.remove(&cue.identifiers.uid).map(|_| ()),
        };
        if let Err(rollback_error) = rollback {
            tracing::error!(
                %rollback_error,
                cue_uid = %cue.identifiers.uid,
                "cue_store_rollback_failed"
            );
        }
        return Err(CueStoreError::new(
            "cue.sequence_store_failed",
            format!("Failed to store cue sequence: {error}"),
        ));
    }

    write_cue_definition_updated(cue_definition_changes, &cue);
    if sequence_changed {
        write_sequence_definition_updated(sequence_definition_changes, &sequence);
    }
    let restore_action = CueAction::RestoreCueStoreState {
        sequence_id,
        cue_uid: cue.identifiers.uid,
        previous_cue: previous_cue.map(Box::new),
        previous_sequence: previous_sequence.map(Box::new),
        undo_label: undo_label.to_string(),
    };
    push_operation_undo_entry(
        undo_manager,
        Box::new(restore_action),
        undo_label,
        operation,
    );

    Ok(CueStoreSuccess {
        sequence_id,
        cue_id: resolved_cue_id,
        part_id: resolved_part_id,
    })
}

/// Executes typed store operations and returns their domain outcome to the owning workflow.
pub fn cue_store_operations(
    mut cue_data_provider: ResMut<DataProvider<Cue>>,
    mut sequence_data_provider: ResMut<DataProvider<Sequence>>,
    mut undo_manager: ResMut<UndoManager>,
    mut operations: MessageReader<EngineActionEnvelope<CueStoreOperation>>,
    mut results: MessageWriter<OperationResult<CueStoreSuccess, CueStoreError>>,
    mut cue_definition_changes: MessageWriter<CueDefinitionChange>,
    mut sequence_definition_changes: MessageWriter<SequenceDefinitionChange>,
    selection_resolver: SpatialSelectionResolver,
) {
    for operation in operations.read() {
        let result = match &operation.action {
            CueStoreOperation::StoreSequence {
                sequence,
                undo_label,
            } => execute_sequence_store_operation(
                operation,
                sequence,
                &selection_resolver,
                undo_label,
                &mut sequence_data_provider,
                &mut undo_manager,
                &mut sequence_definition_changes,
            ),
            CueStoreOperation::StoreCueInSequence {
                sequence_id,
                cue_id,
                part_id,
                part,
                undo_label,
            } => execute_cue_store_operation(
                operation,
                *sequence_id,
                *cue_id,
                *part_id,
                part,
                &selection_resolver,
                undo_label,
                &mut CueStoreOperationResources {
                    cue_data_provider: &mut cue_data_provider,
                    sequence_data_provider: &mut sequence_data_provider,
                    undo_manager: &mut undo_manager,
                    cue_definition_changes: &mut cue_definition_changes,
                    sequence_definition_changes: &mut sequence_definition_changes,
                },
            ),
        };
        results.write(OperationResult {
            operation_id: operation.operation_id,
            result,
        });
    }
}

/// Executes cue runtime actions directly.
pub fn cue_action_events(
    mut cue_data_provider: ResMut<DataProvider<Cue>>,
    mut sequence_data_provider: ResMut<DataProvider<Sequence>>,
    mut undo_manager: ResMut<UndoManager>,
    mut actions: MessageReader<EngineActionEnvelope<CueAction>>,
    mut outbound: CommandResponder,
    mut cue_definition_changes: MessageWriter<CueDefinitionChange>,
    mut sequence_definition_changes: MessageWriter<SequenceDefinitionChange>,
    selection_resolver: SpatialSelectionResolver,
) {
    for event in actions.read() {
        let correlation_id = event
            .command_id
            .map(uuid::Uuid::from)
            .unwrap_or_else(|| event.operation_id.into());
        let undo_id = event
            .undo_id
            .map(uuid::Uuid::from)
            .unwrap_or(correlation_id);
        match &event.action {
            CueAction::StoreCue(cue) => {
                if store_cue_definition(
                    cue,
                    &selection_resolver,
                    correlation_id,
                    &mut cue_data_provider,
                    &mut outbound,
                    &mut cue_definition_changes,
                ) {
                    outbound.succeed_cue(correlation_id);
                }
            }
            CueAction::StoreSequence(sequence) => {
                if store_sequence_definition(
                    sequence,
                    &selection_resolver,
                    correlation_id,
                    &mut sequence_data_provider,
                    &mut outbound,
                    &mut sequence_definition_changes,
                ) {
                    outbound.succeed_cue(correlation_id);
                }
            }
            CueAction::StoreCueInSequence {
                sequence_id,
                cue_id,
                part_id,
                part,
                undo_label,
            } => {
                let resolved_cue_id = match cue_id {
                    CueStoreTarget::Exact(cue_id) => *cue_id,
                    CueStoreTarget::Next => next_available_cue_id(
                        &cue_data_provider,
                        &sequence_data_provider,
                        *sequence_id,
                    ),
                };
                let existing_cue = match cue_id {
                    CueStoreTarget::Exact(_) => cue_data_provider
                        .cue_by_sequence_id(&sequence_data_provider, *sequence_id, resolved_cue_id)
                        .ok()
                        .map(|cue_ref| (*cue_ref).clone()),
                    CueStoreTarget::Next => None,
                };
                let mut cue = existing_cue.unwrap_or_else(|| {
                    let mut new_cue = Cue::default();
                    new_cue.identifiers.id = resolved_cue_id;
                    new_cue.tracking_mode = Some(TrackingMode::Inherit);
                    new_cue
                });
                cue.identifiers.id = resolved_cue_id;
                let previous_cue = cue_snapshot_by_uid(&cue_data_provider, cue.identifiers.uid);
                let previous_sequence =
                    sequence_snapshot_by_id(&sequence_data_provider, *sequence_id);

                let resolved_part_id = match part_id {
                    CuePartStoreTarget::Exact(part_id) => *part_id,
                    CuePartStoreTarget::Next => next_available_part_id(&cue),
                };
                let mut part = part.clone();
                part.identifiers.id = resolved_part_id;

                if resolved_part_id == 0 {
                    if !part.identifiers.label.trim().is_empty() {
                        cue.identifiers.label = part.identifiers.label;
                    } else if cue.identifiers.label.trim().is_empty() {
                        cue.identifiers.label = format!("Cue {}", resolved_cue_id);
                    }
                    cue.transitions = part.transitions;
                    cue.transitions_by_attribute = part.transitions_by_attribute;
                    cue.instructions = part.instructions;
                    cue.tracking_flags = part.tracking_flags;
                } else {
                    if cue.identifiers.label.trim().is_empty() {
                        cue.identifiers.label = format!("Cue {}", resolved_cue_id);
                    }
                    if part.identifiers.label.trim().is_empty() {
                        part.identifiers.label = format!("Part {}", resolved_part_id);
                    }
                    cue.upsert_part(*part);
                }

                let (sequence, sequence_changed) = sequence_with_cue_step(
                    &sequence_data_provider,
                    *sequence_id,
                    cue.identifiers.uid,
                );
                let restore_action = CueAction::RestoreCueStoreState {
                    sequence_id: *sequence_id,
                    cue_uid: cue.identifiers.uid,
                    previous_cue: previous_cue.map(Box::new),
                    previous_sequence: previous_sequence.map(Box::new),
                    undo_label: undo_label.clone(),
                };

                if !store_cue_definition(
                    &cue,
                    &selection_resolver,
                    correlation_id,
                    &mut cue_data_provider,
                    &mut outbound,
                    &mut cue_definition_changes,
                ) {
                    continue;
                }
                if sequence_changed
                    && !store_sequence_definition(
                        &sequence,
                        &selection_resolver,
                        correlation_id,
                        &mut sequence_data_provider,
                        &mut outbound,
                        &mut sequence_definition_changes,
                    )
                {
                    continue;
                }

                push_labeled_undo_entry(
                    &mut undo_manager,
                    Some(Box::new(restore_action)),
                    undo_label,
                    correlation_id,
                    undo_id,
                );
            }
            CueAction::RestoreCueStoreState {
                sequence_id,
                cue_uid,
                previous_cue,
                previous_sequence,
                ..
            } => {
                if !restore_cue_snapshot(
                    *cue_uid,
                    previous_cue.as_deref(),
                    &selection_resolver,
                    correlation_id,
                    &mut cue_data_provider,
                    &mut outbound,
                    &mut cue_definition_changes,
                ) {
                    continue;
                }
                let _ = restore_sequence_snapshot(
                    *sequence_id,
                    previous_sequence.as_deref(),
                    &selection_resolver,
                    correlation_id,
                    &mut sequence_data_provider,
                    &mut outbound,
                    &mut sequence_definition_changes,
                );
            }
        }
    }
}
