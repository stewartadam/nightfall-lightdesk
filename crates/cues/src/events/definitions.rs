// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared cue and sequence definition persistence notifications.

use super::*;

/// Returns a cue whose authored group aliases are stabilized for persistence.
pub(super) fn stabilized_cue(cue: &Cue, selection_resolver: &SpatialSelectionResolver) -> Cue {
    let mut cue = cue.clone();
    for instruction in &mut cue.instructions {
        let stabilized = selection_resolver.stabilize_group_refs_selection(&instruction.selection);
        for warning in &stabilized.issues {
            tracing::warn!("{}", warning);
        }
        instruction.selection = stabilized.value;
    }
    for part in &mut cue.parts {
        for instruction in &mut part.instructions {
            let stabilized =
                selection_resolver.stabilize_group_refs_selection(&instruction.selection);
            for warning in &stabilized.issues {
                tracing::warn!("{}", warning);
            }
            instruction.selection = stabilized.value;
        }
    }
    cue
}

/// Returns a sequence whose built-in cue selections are stabilized for persistence.
pub(super) fn stabilized_sequence(
    sequence: &Sequence,
    selection_resolver: &SpatialSelectionResolver,
) -> Sequence {
    let mut sequence = sequence.clone();
    sequence.setup_cue = stabilized_cue(&sequence.setup_cue, selection_resolver);
    sequence.release_cue = stabilized_cue(&sequence.release_cue, selection_resolver);
    sequence
}

/// Marks sequence-editor lookahead projection state dirty when websocket state is installed.
pub(super) fn mark_sequence_lookahead_state_dirty(
    dirty: &mut Option<ResMut<SequenceLookaheadStateDirty>>,
) {
    if let Some(dirty) = dirty.as_mut() {
        dirty.mark();
    }
}

/// Queue a committed cue definition update for websocket publication.
pub(super) fn write_cue_definition_updated(
    changes: &mut MessageWriter<CueDefinitionChange>,
    cue: &Cue,
) {
    changes.write(CueDefinitionChange::Updated(Box::new(cue.clone())));
}

/// Queue a committed cue definition removal for websocket publication.
pub(super) fn write_cue_definition_removed(
    changes: &mut MessageWriter<CueDefinitionChange>,
    uid: uuid::Uuid,
) {
    changes.write(CueDefinitionChange::Removed { uid });
}

/// Queue a committed sequence definition update for websocket publication.
pub(super) fn write_sequence_definition_updated(
    changes: &mut MessageWriter<SequenceDefinitionChange>,
    sequence: &Sequence,
) {
    changes.write(SequenceDefinitionChange::Updated(Box::new(
        sequence.clone(),
    )));
}

/// Queue a committed sequence definition removal for websocket publication.
pub(super) fn write_sequence_definition_removed(
    changes: &mut MessageWriter<SequenceDefinitionChange>,
    uid: uuid::Uuid,
) {
    changes.write(SequenceDefinitionChange::Removed { uid });
}

/// Persists a cue definition, reports validation failures, and publishes the committed update.
pub(super) fn store_cue_definition(
    cue: &Cue,
    selection_resolver: &SpatialSelectionResolver,
    correlation_id: uuid::Uuid,
    cue_data_provider: &mut DataProvider<Cue>,
    outbound: &mut CommandResponder,
    cue_definition_changes: &mut MessageWriter<CueDefinitionChange>,
) -> bool {
    let cue = stabilized_cue(cue, selection_resolver);
    tracing::debug!("Storing cue with ID: {}", cue.identifiers.id);
    if let Err(e) = cue_data_provider.add(cue.clone()) {
        tracing::warn!("Failed to store cue: {}", e);
        outbound.fail_cue(correlation_id, format!("Failed to store cue: {}", e));
        return false;
    }

    write_cue_definition_updated(cue_definition_changes, &cue);
    true
}

/// Persists a sequence definition, reports validation failures, and publishes the committed update.
pub(super) fn store_sequence_definition(
    sequence: &Sequence,
    selection_resolver: &SpatialSelectionResolver,
    correlation_id: uuid::Uuid,
    sequence_data_provider: &mut DataProvider<Sequence>,
    outbound: &mut CommandResponder,
    sequence_definition_changes: &mut MessageWriter<SequenceDefinitionChange>,
) -> bool {
    let sequence = stabilized_sequence(sequence, selection_resolver);
    tracing::debug!("Storing sequence with ID: {}", sequence.identifiers.id);
    if let Err(e) = sequence_data_provider.add(sequence.clone()) {
        tracing::warn!("Failed to store sequence: {}", e);
        outbound.fail_cue(correlation_id, format!("Failed to store sequence: {}", e));
        return false;
    }

    write_sequence_definition_updated(sequence_definition_changes, &sequence);
    true
}
