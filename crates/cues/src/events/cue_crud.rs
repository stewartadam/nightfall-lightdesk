// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue definition CRUD and target resolution.

use super::*;

mod color_path_commands;
mod cue_commands;

/// Read-only cue CRUD context used when resolving cue fixture selections.
#[derive(SystemParam)]
pub struct CueCrudReadContext<'w> {
    /// Resolves stored cue selections to fixtures.
    selection_resolver: SpatialSelectionResolver<'w>,
    /// Fixture definitions used by cue block/unblock operations.
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    /// Optional Blueprint definitions used to resolve live tracking sources.
    blueprint_data_provider: Option<Res<'w, DataProvider<Blueprint>>>,
}

/// Finds the first positive integer not present in the provided ID set.
pub(super) fn next_available_numeric_id(used_ids: impl IntoIterator<Item = u32>) -> u32 {
    let mut used_ids: Vec<u32> = used_ids.into_iter().filter(|id| *id > 0).collect();
    used_ids.sort_unstable();
    let mut candidate = 1;
    for id in used_ids {
        if id == candidate {
            candidate += 1;
        } else if id > candidate {
            break;
        }
    }
    candidate
}

/// Resolves the next available cue ID from the current sequence contents.
pub(super) fn next_available_cue_id(
    cue_data_provider: &DataProvider<Cue>,
    sequence_data_provider: &DataProvider<Sequence>,
    sequence_id: u32,
) -> u32 {
    let cue_ids = sequence_data_provider
        .from_id(sequence_id)
        .ok()
        .map(|sequence| {
            sequence
                .steps
                .iter()
                .filter_map(|cue_uid| cue_data_provider.get((*cue_uid).into()).ok())
                .map(|cue| cue.identifiers.id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    next_available_numeric_id(cue_ids)
}

/// Resolves the next available part ID from the current cue contents.
pub(super) fn next_available_part_id(cue: &Cue) -> u32 {
    next_available_numeric_id(cue.parts.iter().map(|part| part.identifiers.id))
}

/// Returns a sequence containing the cue step and whether the sequence changed.
pub(super) fn sequence_with_cue_step(
    sequence_data_provider: &DataProvider<Sequence>,
    sequence_id: u32,
    cue_uid: uuid::Uuid,
) -> (Sequence, bool) {
    let mut sequence = sequence_data_provider
        .from_id(sequence_id)
        .ok()
        .map(|seq_ref| (*seq_ref).clone())
        .unwrap_or_else(|| {
            let mut new_seq = Sequence::default();
            new_seq.identifiers.id = sequence_id;
            new_seq
        });

    let cue_step = cue_uid.into();
    if sequence.steps.contains(&cue_step) {
        (sequence, false)
    } else {
        sequence.steps.push(cue_step);
        (sequence, true)
    }
}

/// Cohesive dependencies shared by cue definition and color path command handlers.
#[derive(SystemParam)]
pub struct CueCrudContext<'w, 's> {
    /// Persisted cue definitions.
    cue_data_provider: ResMut<'w, DataProvider<Cue>>,
    /// Persisted sequence definitions whose steps reference cues.
    sequence_data_provider: ResMut<'w, DataProvider<Sequence>>,
    /// Optional persisted color path library.
    color_path_data_provider: Option<ResMut<'w, DataProvider<ColorPath>>>,
    /// Exact-once command lifecycle responder.
    outbound: CommandResponder<'w>,
    /// Committed cue definition changes for websocket publication.
    cue_definition_changes: MessageWriter<'w, CueDefinitionChange>,
    /// Committed sequence definition changes for websocket publication.
    sequence_definition_changes: MessageWriter<'w, SequenceDefinitionChange>,
    /// Selection resolution for cue definitions, or writable fixture data for color path
    /// default rewrites.
    selection_or_fixtures:
        ParamSet<'w, 's, (CueCrudReadContext<'w>, ResMut<'w, FixtureDataProviderExt>)>,
    /// Optional lookahead invalidation flag for sequence-affecting cue mutations.
    sequence_lookahead_dirty: Option<ResMut<'w, SequenceLookaheadStateDirty>>,
}

/// Applies cue, cue-part, color-path, and block-tracking CRUD commands in message order.
///
/// Cue definition commands route to `cue_commands` and color path commands, including
/// assigning a color path to a cue, route to `color_path_commands`.
pub fn cue_crud_events(
    mut context: CueCrudContext,
    mut events: MessageReader<CommandEnvelope<CueCommand>>,
) {
    for envelope in events.read() {
        match &envelope.command {
            CueCommand::StoreCue(_)
            | CueCommand::RenameCue { .. }
            | CueCommand::DeleteCue { .. }
            | CueCommand::BlockCue { .. }
            | CueCommand::UnblockCue { .. } => cue_commands::handle_command(&mut context, envelope),
            CueCommand::SetCueColorPath { .. }
            | CueCommand::StoreColorPath(_)
            | CueCommand::LabelColorPath { .. }
            | CueCommand::DuplicateColorPath { .. }
            | CueCommand::RenameColorPath { .. }
            | CueCommand::ListColorPaths
            | CueCommand::DeleteColorPath(_) => {
                color_path_commands::handle_command(&mut context, envelope);
            }
            _ => {}
        }
    }
}
