// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue and sequence snapshot restoration and undo registration helpers.

use super::*;

/// Captures a cue by UID before a store mutates it.
pub(super) fn cue_snapshot_by_uid(
    cue_data_provider: &DataProvider<Cue>,
    cue_uid: uuid::Uuid,
) -> Option<Cue> {
    cue_data_provider
        .get(cue_uid)
        .ok()
        .map(|cue_ref| (*cue_ref).clone())
}

/// Captures a sequence by numeric ID before a store mutates it.
pub(super) fn sequence_snapshot_by_id(
    sequence_data_provider: &DataProvider<Sequence>,
    sequence_id: u32,
) -> Option<Sequence> {
    sequence_data_provider
        .from_id(sequence_id)
        .ok()
        .map(|sequence_ref| (*sequence_ref).clone())
}

/// Restores or removes a cue definition according to a captured store snapshot.
pub(super) fn restore_cue_snapshot(
    cue_uid: uuid::Uuid,
    previous_cue: Option<&Cue>,
    selection_resolver: &SpatialSelectionResolver,
    correlation_id: uuid::Uuid,
    cue_data_provider: &mut DataProvider<Cue>,
    outbound: &mut CommandResponder,
    cue_definition_changes: &mut MessageWriter<CueDefinitionChange>,
) -> bool {
    if let Some(cue) = previous_cue {
        store_cue_definition(
            cue,
            selection_resolver,
            correlation_id,
            cue_data_provider,
            outbound,
            cue_definition_changes,
        )
    } else {
        match cue_data_provider.remove(&cue_uid) {
            Ok(_) | Err(DataStoreError::NoSuchId { .. }) => {
                write_cue_definition_removed(cue_definition_changes, cue_uid);
                true
            }
            Err(err) => {
                tracing::warn!(
                    "Failed to restore cue state by removing {}: {}",
                    cue_uid,
                    err
                );
                outbound.fail_cue(
                    correlation_id,
                    format!(
                        "Failed to restore cue state by removing {}: {}",
                        cue_uid, err
                    ),
                );
                false
            }
        }
    }
}

/// Restores or removes a sequence definition according to a captured store snapshot.
pub(super) fn restore_sequence_snapshot(
    sequence_id: u32,
    previous_sequence: Option<&Sequence>,
    selection_resolver: &SpatialSelectionResolver,
    correlation_id: uuid::Uuid,
    sequence_data_provider: &mut DataProvider<Sequence>,
    outbound: &mut CommandResponder,
    sequence_definition_changes: &mut MessageWriter<SequenceDefinitionChange>,
) -> bool {
    if let Some(sequence) = previous_sequence {
        store_sequence_definition(
            sequence,
            selection_resolver,
            correlation_id,
            sequence_data_provider,
            outbound,
            sequence_definition_changes,
        )
    } else {
        let maybe_uid = sequence_data_provider
            .from_id(sequence_id)
            .map(|sequence_ref| sequence_ref.identifiers.uid);
        match maybe_uid {
            Ok(uid) => match sequence_data_provider.remove(&uid) {
                Ok(_) | Err(DataStoreError::NoSuchId { .. }) => {
                    write_sequence_definition_removed(sequence_definition_changes, uid);
                    true
                }
                Err(err) => {
                    tracing::warn!(
                        "Failed to restore sequence state by removing {}: {}",
                        sequence_id,
                        err
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!(
                            "Failed to restore sequence state by removing {}: {}",
                            sequence_id, err
                        ),
                    );
                    false
                }
            },
            Err(_) => true,
        }
    }
}

/// Pushes a resolved undo command using the user-facing label and undo identity.
pub(super) fn push_labeled_undo_entry(
    undo_manager: &mut UndoManager,
    command: Option<Box<dyn UndoableOperation>>,
    label: &str,
    correlation_id: uuid::Uuid,
    undo_id: uuid::Uuid,
) {
    if let Some(command) = command {
        undo_manager.push(
            UndoEntry {
                command,
                description: label.to_string(),
                command_id: Some(CommandId::from(correlation_id)),
            },
            UndoId::from(undo_id),
            false,
        );
    }
}

/// Pushes an undo entry for one workflow operation when it belongs to an undo group.
pub(super) fn push_operation_undo_entry(
    undo_manager: &mut UndoManager,
    command: Box<dyn UndoableOperation>,
    label: &str,
    operation: &EngineActionEnvelope<CueStoreOperation>,
) {
    let Some(undo_id) = operation.undo_id else {
        return;
    };
    undo_manager.push(
        UndoEntry {
            command,
            description: label.to_string(),
            command_id: operation.command_id,
        },
        undo_id,
        operation.command_id.is_some(),
    );
}

/// Handles RestoreSequencePosition commands for undo.
pub fn handle_restore_sequence_position(
    mut events: MessageReader<EngineActionEnvelope<RestoreSequencePosition>>,
    instance_index: Res<InstanceIndex>,
    mut msequence_query: Query<&mut MaterializedSequence>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let snapshot = &event.action.0;

        let Some(entity) = instance_index.get(&snapshot.instance_id) else {
            tracing::warn!(
                instance_id = ?snapshot.instance_id,
                "RestoreSequencePosition: playback not found"
            );
            if let Some(command_id) = event.command_id
                && let Err(error) = responder.fail(
                    command_id,
                    CommandError::new(
                        "cues.restore_sequence_position_failed",
                        "Playback was not found",
                    ),
                )
            {
                tracing::error!(%command_id, %error, "sequence_restore_failure_failed");
            }
            continue;
        };

        let Ok(mut msequence) = msequence_query.get_mut(entity) else {
            tracing::warn!(
                instance_id = ?snapshot.instance_id,
                "RestoreSequencePosition: entity is not a MaterializedSequence"
            );
            if let Some(command_id) = event.command_id
                && let Err(error) = responder.fail(
                    command_id,
                    CommandError::new(
                        "cues.restore_sequence_position_failed",
                        "Playback is not a materialized sequence",
                    ),
                )
            {
                tracing::error!(%command_id, %error, "sequence_restore_failure_failed");
            }
            continue;
        };

        msequence.set_position(snapshot.position);
        tracing::debug!(
            "RestoreSequencePosition: restored sequence '{}' to position {}",
            msequence.sequence.identifiers.label,
            snapshot.position
        );
        if let Some(command_id) = event.command_id
            && let Err(error) = responder.succeed(command_id)
        {
            tracing::error!(%command_id, %error, "sequence_restore_completion_failed");
        }
    }
}
