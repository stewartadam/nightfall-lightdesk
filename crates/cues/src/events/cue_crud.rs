// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue definition CRUD and target resolution.

use super::*;

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

/// Applies cue, cue-part, color-path, and block-tracking CRUD commands in message order.
pub fn cue_crud_events(
    mut cue_data_provider: ResMut<DataProvider<Cue>>,
    mut sequence_data_provider: ResMut<DataProvider<Sequence>>,
    mut color_path_data_provider: Option<ResMut<DataProvider<ColorPath>>>,
    mut events: MessageReader<CommandEnvelope<CueCommand>>,
    mut outbound: CommandResponder,
    mut cue_definition_changes: MessageWriter<CueDefinitionChange>,
    mut sequence_definition_changes: MessageWriter<SequenceDefinitionChange>,
    mut cue_crud_context: ParamSet<(CueCrudReadContext, ResMut<FixtureDataProviderExt>)>,
    mut sequence_lookahead_dirty: Option<ResMut<SequenceLookaheadStateDirty>>,
) {
    for envelope in events.read() {
        let command_id = envelope.command_id.into();
        match &envelope.command {
            CueCommand::StoreCue(cue) => {
                mark_sequence_lookahead_state_dirty(&mut sequence_lookahead_dirty);
                let read_context = cue_crud_context.p0();
                if store_cue_definition(
                    cue,
                    &read_context.selection_resolver,
                    command_id,
                    &mut cue_data_provider,
                    &mut outbound,
                    &mut cue_definition_changes,
                ) {
                    outbound.succeed_cue(command_id);
                }
            }

            CueCommand::RenameCue {
                sequence_id,
                cue_id,
                new_sequence_id,
                new_cue_id,
            } => {
                mark_sequence_lookahead_state_dirty(&mut sequence_lookahead_dirty);
                tracing::debug!(
                    "Renaming cue {}.{} to {}.{}",
                    sequence_id,
                    cue_id,
                    new_sequence_id,
                    new_cue_id
                );
                let is_noop = sequence_id == new_sequence_id && cue_id == new_cue_id;

                if cue_data_provider
                    .cue_by_sequence_id(&sequence_data_provider, *new_sequence_id, *new_cue_id)
                    .is_ok()
                    && !is_noop
                {
                    tracing::warn!(
                        "Failed to rename cue {}.{} -> {}.{}: target already exists",
                        sequence_id,
                        cue_id,
                        new_sequence_id,
                        new_cue_id
                    );
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to rename cue {}.{} to {}.{}: target already exists",
                            sequence_id, cue_id, new_sequence_id, new_cue_id
                        ),
                    );
                    continue;
                }
                let maybe_cue = cue_data_provider
                    .cue_by_sequence_id(&sequence_data_provider, *sequence_id, *cue_id)
                    .map(|cue_ref| (*cue_ref).clone());
                if let Ok(mut cue) = maybe_cue {
                    let maybe_source_sequence = sequence_data_provider
                        .from_id(*sequence_id)
                        .map(|sequence_ref| (*sequence_ref).clone());
                    let maybe_target_sequence = sequence_data_provider
                        .from_id(*new_sequence_id)
                        .map(|sequence_ref| (*sequence_ref).clone());

                    let (Ok(mut source_sequence), Ok(mut target_sequence)) =
                        (maybe_source_sequence, maybe_target_sequence)
                    else {
                        tracing::warn!(
                            "Failed to rename cue {}.{} -> {}.{}: source or target sequence not found",
                            sequence_id,
                            cue_id,
                            new_sequence_id,
                            new_cue_id
                        );
                        outbound.fail_cue(command_id, format!(
                                "Failed to rename cue {}.{} to {}.{}: source or target sequence not found",
                                sequence_id, cue_id, new_sequence_id, new_cue_id
                            ));
                        continue;
                    };

                    let cue_uid = cue.identifiers.uid;
                    cue.identifiers.id = *new_cue_id;
                    if let Err(err) = cue_data_provider.add(cue.clone()) {
                        tracing::warn!(
                            "Failed to rename cue {}.{} -> {}.{}: {}",
                            sequence_id,
                            cue_id,
                            new_sequence_id,
                            new_cue_id,
                            err
                        );
                        outbound.fail_cue(
                            command_id,
                            format!(
                                "Failed to rename cue {}.{} to {}.{}: {}",
                                sequence_id, cue_id, new_sequence_id, new_cue_id, err
                            ),
                        );
                        continue;
                    }
                    write_cue_definition_updated(&mut cue_definition_changes, &cue);

                    let cue_uid_simple = cue_uid.into();
                    if sequence_id == new_sequence_id {
                        if !source_sequence.steps.contains(&cue_uid_simple) {
                            source_sequence.steps.push(cue_uid_simple);
                        }
                        if let Err(err) = sequence_data_provider.add(source_sequence.clone()) {
                            tracing::warn!(
                                "Failed to persist sequence {} while renaming cue {}.{} -> {}.{}: {}",
                                sequence_id,
                                sequence_id,
                                cue_id,
                                new_sequence_id,
                                new_cue_id,
                                err
                            );
                            outbound.fail_cue(command_id, format!(
                                    "Failed to persist sequence {} while renaming cue {}.{} to {}.{}: {}",
                                    sequence_id, sequence_id, cue_id, new_sequence_id, new_cue_id, err
                                ));
                            continue;
                        }
                        write_sequence_definition_updated(
                            &mut sequence_definition_changes,
                            &source_sequence,
                        );
                    } else {
                        source_sequence
                            .steps
                            .retain(|step_uid| *step_uid != cue_uid_simple);
                        if !target_sequence.steps.contains(&cue_uid_simple) {
                            target_sequence.steps.push(cue_uid_simple);
                        }

                        if let Err(err) = sequence_data_provider.add(source_sequence.clone()) {
                            tracing::warn!(
                                "Failed to persist source sequence {} while moving cue {}.{} -> {}.{}: {}",
                                sequence_id,
                                sequence_id,
                                cue_id,
                                new_sequence_id,
                                new_cue_id,
                                err
                            );
                            outbound.fail_cue(command_id, format!(
                                    "Failed to persist source sequence {} while moving cue {}.{} to {}.{}: {}",
                                    sequence_id, sequence_id, cue_id, new_sequence_id, new_cue_id, err
                                ));
                            continue;
                        }
                        write_sequence_definition_updated(
                            &mut sequence_definition_changes,
                            &source_sequence,
                        );
                        if let Err(err) = sequence_data_provider.add(target_sequence.clone()) {
                            tracing::warn!(
                                "Failed to persist target sequence {} while moving cue {}.{} -> {}.{}: {}",
                                new_sequence_id,
                                sequence_id,
                                cue_id,
                                new_sequence_id,
                                new_cue_id,
                                err
                            );
                            outbound.fail_cue(command_id, format!(
                                    "Failed to persist target sequence {} while moving cue {}.{} to {}.{}: {}",
                                    new_sequence_id, sequence_id, cue_id, new_sequence_id, new_cue_id, err
                                ));
                            continue;
                        }
                        write_sequence_definition_updated(
                            &mut sequence_definition_changes,
                            &target_sequence,
                        );
                    }
                } else {
                    tracing::warn!(
                        "Failed to rename cue {}.{} -> {}.{}: not found",
                        sequence_id,
                        cue_id,
                        new_sequence_id,
                        new_cue_id
                    );
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to rename cue {}.{} to {}.{}: not found",
                            sequence_id, cue_id, new_sequence_id, new_cue_id
                        ),
                    );
                    continue;
                }
                outbound.succeed_cue(command_id);
            }

            CueCommand::SetCueColorPath {
                sequence_id,
                cue_id,
                color_path_id,
            } => {
                if let Some(color_path_id) = color_path_id
                    && !color_path_exists(*color_path_id, color_path_data_provider.as_deref())
                {
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to set color path for cue {}.{}: color path {} not found",
                            sequence_id, cue_id, color_path_id.0
                        ),
                    );
                    continue;
                }

                let maybe_cue = cue_data_provider
                    .cue_by_sequence_id(&sequence_data_provider, *sequence_id, *cue_id)
                    .map(|cue_ref| (*cue_ref).clone());
                let Ok(mut cue) = maybe_cue else {
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to set color path for cue {}.{}: cue not found",
                            sequence_id, cue_id
                        ),
                    );
                    continue;
                };

                let updated_count =
                    set_color_vector_instruction_color_path(&mut cue, *color_path_id);
                if updated_count == 0 {
                    outbound.fail_cue(command_id, format!(
                            "Failed to set color path for cue {}.{}: no supported color instructions found",
                            sequence_id, cue_id
                        ));
                    continue;
                }

                match cue_data_provider.add(cue.clone()) {
                    Ok(()) => {
                        write_cue_definition_updated(&mut cue_definition_changes, &cue);
                        outbound.succeed_cue(command_id);
                    }
                    Err(err) => {
                        outbound.fail_cue(
                            command_id,
                            format!(
                                "Failed to set color path for cue {}.{}: {}",
                                sequence_id, cue_id, err
                            ),
                        );
                    }
                };
            }

            CueCommand::StoreColorPath(color_path) => {
                let Some(color_path_data_provider) = color_path_data_provider.as_deref_mut() else {
                    outbound.fail_cue(
                        command_id,
                        "Failed to store color path: color path provider is unavailable"
                            .to_string(),
                    );
                    continue;
                };
                if is_builtin_color_path_id(color_path.identifiers.id) {
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to store color path {}: built-in color paths are read-only",
                            color_path.identifiers.id
                        ),
                    );
                    continue;
                }
                match color_path_data_provider.add(color_path.clone()) {
                    Ok(()) => outbound.succeed_cue(command_id),
                    Err(err) => outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to store color path {}: {}",
                            color_path.identifiers.id, err
                        ),
                    ),
                };
            }

            CueCommand::LabelColorPath { id, label } => {
                let Some(color_path_data_provider) = color_path_data_provider.as_deref_mut() else {
                    outbound.fail_cue(
                        command_id,
                        "Failed to label color path: color path provider is unavailable"
                            .to_string(),
                    );
                    continue;
                };
                if is_builtin_color_path_id(*id) {
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to label color path {}: built-in color paths are read-only",
                            id
                        ),
                    );
                    continue;
                }
                let maybe_color_path = color_path_data_provider
                    .from_id(*id)
                    .map(|color_path| (*color_path).clone());
                let Ok(mut color_path) = maybe_color_path else {
                    outbound.fail_cue(
                        command_id,
                        format!("Failed to label color path {}: not found", id),
                    );
                    continue;
                };
                color_path.identifiers.label = label.clone();
                match color_path_data_provider.add(color_path) {
                    Ok(()) => outbound.succeed_cue(command_id),
                    Err(err) => outbound.fail_cue(
                        command_id,
                        format!("Failed to label color path {}: {}", id, err),
                    ),
                };
            }

            CueCommand::DuplicateColorPath { id, new_id } => {
                let Some(color_path_data_provider) = color_path_data_provider.as_deref_mut() else {
                    outbound.fail_cue(
                        command_id,
                        "Failed to duplicate color path: color path provider is unavailable"
                            .to_string(),
                    );
                    continue;
                };
                if is_builtin_color_path_id(*new_id) {
                    outbound.fail_cue(command_id, format!(
                            "Failed to duplicate color path {} to {}: built-in color paths are read-only",
                            id, new_id
                        ));
                    continue;
                }
                let maybe_color_path = color_path_data_provider
                    .from_id(*id)
                    .map(|color_path| (*color_path).clone());
                let Ok(source) = maybe_color_path else {
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to duplicate color path {} to {}: source not found",
                            id, new_id
                        ),
                    );
                    continue;
                };
                let mut duplicate = source.clone();
                duplicate.identifiers = Identifiers {
                    id: *new_id,
                    label: format!("{} Copy", source.identifiers.label),
                    ..Default::default()
                };
                match color_path_data_provider.add(duplicate) {
                    Ok(()) => outbound.succeed_cue(command_id),
                    Err(err) => outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to duplicate color path {} to {}: {}",
                            id, new_id, err
                        ),
                    ),
                };
            }

            CueCommand::RenameColorPath { id, new_id } => {
                let Some(color_path_data_provider) = color_path_data_provider.as_deref_mut() else {
                    outbound.fail_cue(
                        command_id,
                        "Failed to rename color path: color path provider is unavailable"
                            .to_string(),
                    );
                    continue;
                };
                if is_builtin_color_path_id(*id) || is_builtin_color_path_id(*new_id) {
                    outbound.fail_cue(command_id, format!(
                            "Failed to rename color path {} to {}: built-in color paths are read-only",
                            id, new_id
                        ));
                    continue;
                }
                if color_path_data_provider.from_id(*new_id).is_ok() {
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to rename color path {} to {}: already exists",
                            id, new_id
                        ),
                    );
                    continue;
                }
                let maybe_color_path = color_path_data_provider
                    .from_id(*id)
                    .map(|color_path| (*color_path).clone());
                let Ok(mut color_path) = maybe_color_path else {
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to rename color path {} to {}: source not found",
                            id, new_id
                        ),
                    );
                    continue;
                };
                color_path.identifiers.id = *new_id;
                match color_path_data_provider.add(color_path) {
                    Ok(()) => {
                        let rewritten_cues =
                            match rewrite_stored_cue_color_path_references(
                                &mut cue_data_provider,
                                *id,
                                *new_id,
                            ) {
                                Ok(cues) => cues,
                                Err(err) => {
                                    outbound.fail_cue(command_id, format!(
                                        "Failed to rewrite color path references for {} to {}: {}",
                                        id, new_id, err
                                    ));
                                    continue;
                                }
                            };
                        for cue in &rewritten_cues {
                            write_cue_definition_updated(&mut cue_definition_changes, cue);
                        }
                        rewrite_fixture_color_path_defaults(
                            &mut cue_crud_context.p1(),
                            *id,
                            *new_id,
                        );
                        outbound.succeed_cue(command_id);
                    }
                    Err(err) => {
                        outbound.fail_cue(
                            command_id,
                            format!("Failed to rename color path {} to {}: {}", id, new_id, err),
                        );
                    }
                };
            }

            CueCommand::ListColorPaths => {
                let Some(color_path_data_provider) = color_path_data_provider.as_deref() else {
                    outbound.fail_cue(
                        command_id,
                        "Failed to list color paths: color path provider is unavailable"
                            .to_string(),
                    );
                    continue;
                };
                outbound.succeed_cue_with_output(
                    command_id,
                    format_color_path_list(color_path_data_provider),
                );
            }

            CueCommand::DeleteColorPath(id) => {
                let Some(color_path_data_provider) = color_path_data_provider.as_deref_mut() else {
                    outbound.fail_cue(
                        command_id,
                        "Failed to delete color path: color path provider is unavailable"
                            .to_string(),
                    );
                    continue;
                };
                if is_builtin_color_path_id(*id) {
                    outbound.fail_cue(
                        command_id,
                        format!(
                            "Failed to delete color path {}: built-in color paths are read-only",
                            id
                        ),
                    );
                    continue;
                }
                let maybe_uid = color_path_data_provider
                    .from_id(*id)
                    .map(|color_path| color_path.identifiers.uid);
                match maybe_uid {
                    Ok(uid) => match color_path_data_provider.remove(&uid) {
                        Ok(_) => {
                            let cleared_cues = match clear_stored_cue_color_path_references(
                                &mut cue_data_provider,
                                *id,
                            ) {
                                Ok(cues) => cues,
                                Err(err) => {
                                    outbound.fail_cue(
                                        command_id,
                                        format!(
                                            "Failed to clear color path {} cue references: {}",
                                            id, err
                                        ),
                                    );
                                    continue;
                                }
                            };
                            for cue in &cleared_cues {
                                write_cue_definition_updated(&mut cue_definition_changes, cue);
                            }
                            let cleared_defaults =
                                clear_fixture_color_path_defaults(&mut cue_crud_context.p1(), *id);
                            tracing::debug!(
                                color_path_id = *id,
                                cleared_cues = cleared_cues.len(),
                                cleared_defaults,
                                "Cleared color path references after delete"
                            );
                            outbound.succeed_cue(command_id);
                        }
                        Err(err) => {
                            outbound.fail_cue(
                                command_id,
                                format!("Failed to delete color path {}: {}", id, err),
                            );
                        }
                    },
                    Err(_) => {
                        outbound.fail_cue(
                            command_id,
                            format!("Failed to delete color path {}: not found", id),
                        );
                    }
                };
            }

            CueCommand::DeleteCue {
                sequence_id,
                cue_id,
            } => {
                mark_sequence_lookahead_state_dirty(&mut sequence_lookahead_dirty);
                tracing::debug!("Deleting cue {}.{}", sequence_id, cue_id);
                let maybe_cue = cue_data_provider
                    .cue_by_sequence_id(&sequence_data_provider, *sequence_id, *cue_id)
                    .map(|cue_ref| (*cue_ref).clone());
                if let Ok(cue) = maybe_cue {
                    let cue_uid = cue.identifiers.uid;
                    if let Err(err) = cue_data_provider.remove(&cue_uid) {
                        tracing::warn!("Failed to delete cue {}.{}: {}", sequence_id, cue_id, err);
                        outbound.fail_cue(
                            command_id,
                            format!("Failed to delete cue {}.{}: {}", sequence_id, cue_id, err),
                        );
                        continue;
                    }
                    write_cue_definition_removed(&mut cue_definition_changes, cue_uid);

                    let maybe_sequence = sequence_data_provider
                        .from_id(*sequence_id)
                        .map(|sequence_ref| (*sequence_ref).clone());
                    if let Ok(mut sequence) = maybe_sequence {
                        let cue_uid_simple = cue_uid.into();
                        sequence
                            .steps
                            .retain(|step_uid| *step_uid != cue_uid_simple);

                        if let Err(err) = sequence_data_provider.add(sequence.clone()) {
                            tracing::warn!(
                                "Failed to update sequence {} after deleting cue {}: {}",
                                sequence_id,
                                cue_id,
                                err
                            );
                            outbound.fail_cue(
                                command_id,
                                format!(
                                    "Failed to update sequence {} after deleting cue {}: {}",
                                    sequence_id, cue_id, err
                                ),
                            );
                            continue;
                        } else {
                            write_sequence_definition_updated(
                                &mut sequence_definition_changes,
                                &sequence,
                            );
                        }
                    } else {
                        tracing::warn!(
                            "Failed to update sequence {} after deleting cue {}: sequence not found",
                            sequence_id,
                            cue_id
                        );
                        outbound.fail_cue(command_id, format!(
                                "Failed to update sequence {} after deleting cue {}: sequence not found",
                                sequence_id, cue_id
                            ));
                        continue;
                    }
                } else {
                    tracing::warn!("Failed to delete cue {}.{}: not found", sequence_id, cue_id);
                    outbound.fail_cue(
                        command_id,
                        format!("Failed to delete cue {}.{}: not found", sequence_id, cue_id),
                    );
                    continue;
                }
                outbound.succeed_cue(command_id);
            }

            CueCommand::BlockCue {
                sequence_id,
                cue_id,
                part_id,
                overwrite,
            } => {
                mark_sequence_lookahead_state_dirty(&mut sequence_lookahead_dirty);
                let read_context = cue_crud_context.p0();
                if handle_block_cue_command(
                    command_id,
                    &mut outbound,
                    &mut cue_data_provider,
                    &mut sequence_data_provider,
                    &mut cue_definition_changes,
                    &mut sequence_definition_changes,
                    &read_context.selection_resolver,
                    &read_context.fixture_data_provider,
                    read_context.blueprint_data_provider.as_deref(),
                    *sequence_id,
                    *cue_id,
                    *part_id,
                    BlockCueOperation::Block,
                    *overwrite,
                ) {
                    outbound.succeed_cue(command_id);
                }
            }

            CueCommand::UnblockCue {
                sequence_id,
                cue_id,
                part_id,
            } => {
                mark_sequence_lookahead_state_dirty(&mut sequence_lookahead_dirty);
                let read_context = cue_crud_context.p0();
                if handle_block_cue_command(
                    command_id,
                    &mut outbound,
                    &mut cue_data_provider,
                    &mut sequence_data_provider,
                    &mut cue_definition_changes,
                    &mut sequence_definition_changes,
                    &read_context.selection_resolver,
                    &read_context.fixture_data_provider,
                    read_context.blueprint_data_provider.as_deref(),
                    *sequence_id,
                    *cue_id,
                    *part_id,
                    BlockCueOperation::Unblock,
                    false,
                ) {
                    outbound.succeed_cue(command_id);
                }
            }

            _ => {}
        }
    }
}
