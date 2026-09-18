// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Sequence definition CRUD operations.

use super::*;

/// Applies sequence definition CRUD commands and publishes committed changes in message order.
pub fn sequence_crud_events(
    mut sequence_data_provider: ResMut<DataProvider<Sequence>>,
    mut events: MessageReader<CommandEnvelope<CueCommand>>,
    mut outbound: CommandResponder,
    mut sequence_definition_changes: MessageWriter<SequenceDefinitionChange>,
    mut sequence_lookahead_dirty: Option<ResMut<SequenceLookaheadStateDirty>>,
    selection_resolver: SpatialSelectionResolver,
) {
    for envelope in events.read() {
        let command_id = envelope.command_id.into();
        match &envelope.command {
            CueCommand::StoreSequence(sequence) => {
                mark_sequence_lookahead_state_dirty(&mut sequence_lookahead_dirty);
                if store_sequence_definition(
                    sequence,
                    &selection_resolver,
                    command_id,
                    &mut sequence_data_provider,
                    &mut outbound,
                    &mut sequence_definition_changes,
                ) {
                    outbound.succeed_cue(command_id);
                }
            }

            CueCommand::RenameSequence { id, new_id } => {
                mark_sequence_lookahead_state_dirty(&mut sequence_lookahead_dirty);
                tracing::debug!("Renaming sequence with ID: {} to {}", id, new_id);
                if sequence_data_provider.from_id(*new_id).is_ok() {
                    tracing::warn!(
                        "Failed to rename sequence {} -> {}: already exists",
                        id,
                        new_id
                    );
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to rename sequence {} to {}: already exists",
                            id, new_id
                        ),
                    );
                    continue;
                }
                let maybe_sequence = sequence_data_provider.from_id(*id).map(|seq| seq.clone());
                if let Ok(mut sequence) = maybe_sequence {
                    sequence.identifiers.id = *new_id;
                    // This is an update (same UID, new ID) so it should always succeed
                    let _ = sequence_data_provider.add(sequence.clone());
                    write_sequence_definition_updated(&mut sequence_definition_changes, &sequence);
                } else {
                    tracing::warn!("Failed to rename sequence {} -> {}: not found", id, new_id);
                    outbound.fail_cue(
                        command_id,
                        format!("Failed to rename sequence {} to {}: not found", id, new_id),
                    );
                    continue;
                }
                outbound.succeed_cue(command_id);
            }

            CueCommand::DeleteSequence(id) => {
                mark_sequence_lookahead_state_dirty(&mut sequence_lookahead_dirty);
                tracing::debug!("Deleting sequence with ID: {}", id);
                let maybe_uid = sequence_data_provider
                    .from_id(*id)
                    .map(|seq| seq.identifiers.uid);
                if let Ok(uid) = maybe_uid {
                    if let Err(err) = sequence_data_provider.remove(&uid) {
                        tracing::warn!("Failed to delete sequence {}: {}", id, err);
                        outbound.fail_cue(
                            command_id,
                            format!("Failed to delete sequence {}: {}", id, err),
                        );
                        continue;
                    } else {
                        write_sequence_definition_removed(&mut sequence_definition_changes, uid);
                    }
                } else {
                    tracing::warn!("Failed to delete sequence {}: not found", id);
                    outbound.fail_cue(
                        command_id,
                        format!("Failed to delete sequence {}: not found", id),
                    );
                    continue;
                }
                outbound.succeed_cue(command_id);
            }

            _ => {}
        }
    }
}
