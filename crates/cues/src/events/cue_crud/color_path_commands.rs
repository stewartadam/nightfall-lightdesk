// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Color path library commands and cue color path assignment.

use super::*;

/// Applies one color path command and reports its outcome.
///
/// Built-in color paths are read-only. Renaming or deleting a color path also rewrites or
/// clears the references stored in cues and fixture defaults.
pub(super) fn handle_command(context: &mut CueCrudContext, envelope: &CommandEnvelope<CueCommand>) {
    let command_id = envelope.command_id.into();
    match &envelope.command {
        CueCommand::SetCueColorPath {
            sequence_id,
            cue_id,
            color_path_id,
        } => set_cue_color_path(context, command_id, *sequence_id, *cue_id, *color_path_id),
        CueCommand::StoreColorPath(color_path) => store_color_path(context, command_id, color_path),
        CueCommand::LabelColorPath { id, label } => {
            label_color_path(context, command_id, *id, label);
        }
        CueCommand::DuplicateColorPath { id, new_id } => {
            duplicate_color_path(context, command_id, *id, *new_id);
        }
        CueCommand::RenameColorPath { id, new_id } => {
            rename_color_path(context, command_id, *id, *new_id);
        }
        CueCommand::ListColorPaths => list_color_paths(context, command_id),
        CueCommand::DeleteColorPath(id) => delete_color_path(context, command_id, *id),
        _ => {}
    }
}

/// Returns the writable color path library, failing the command when it is unavailable.
///
/// `action` completes the failure message `Failed to {action}: ...`.
fn writable_color_paths<'a>(
    color_path_data_provider: &'a mut Option<ResMut<DataProvider<ColorPath>>>,
    outbound: &mut CommandResponder,
    command_id: uuid::Uuid,
    action: &str,
) -> Option<&'a mut DataProvider<ColorPath>> {
    let provider = color_path_data_provider.as_deref_mut();
    if provider.is_none() {
        outbound.fail_cue(
            command_id,
            format!("Failed to {action}: color path provider is unavailable"),
        );
    }
    provider
}

/// Points every color instruction of a cue at a color path, or clears the reference.
///
/// Fails when the color path does not exist, the cue is missing, or the cue has no color
/// instruction that supports color paths.
fn set_cue_color_path(
    context: &mut CueCrudContext,
    command_id: uuid::Uuid,
    sequence_id: u32,
    cue_id: u32,
    color_path_id: Option<ColorPathId>,
) {
    if let Some(color_path_id) = color_path_id
        && !color_path_exists(color_path_id, context.color_path_data_provider.as_deref())
    {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to set color path for cue {}.{}: color path {} not found",
                sequence_id, cue_id, color_path_id.0
            ),
        );
        return;
    }

    let maybe_cue = context
        .cue_data_provider
        .cue_by_sequence_id(&context.sequence_data_provider, sequence_id, cue_id)
        .map(|cue_ref| (*cue_ref).clone());
    let Ok(mut cue) = maybe_cue else {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to set color path for cue {}.{}: cue not found",
                sequence_id, cue_id
            ),
        );
        return;
    };

    let updated_count = set_color_vector_instruction_color_path(&mut cue, color_path_id);
    if updated_count == 0 {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to set color path for cue {}.{}: no supported color instructions found",
                sequence_id, cue_id
            ),
        );
        return;
    }

    match context.cue_data_provider.add(cue.clone()) {
        Ok(()) => {
            write_cue_definition_updated(&mut context.cue_definition_changes, &cue);
            context.outbound.succeed_cue(command_id);
        }
        Err(err) => {
            context.outbound.fail_cue(
                command_id,
                format!(
                    "Failed to set color path for cue {}.{}: {}",
                    sequence_id, cue_id, err
                ),
            );
        }
    };
}

/// Stores a user color path definition.
fn store_color_path(context: &mut CueCrudContext, command_id: uuid::Uuid, color_path: &ColorPath) {
    let Some(color_path_data_provider) = writable_color_paths(
        &mut context.color_path_data_provider,
        &mut context.outbound,
        command_id,
        "store color path",
    ) else {
        return;
    };
    if is_builtin_color_path_id(color_path.identifiers.id) {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to store color path {}: built-in color paths are read-only",
                color_path.identifiers.id
            ),
        );
        return;
    }
    match color_path_data_provider.add(color_path.clone()) {
        Ok(()) => context.outbound.succeed_cue(command_id),
        Err(err) => context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to store color path {}: {}",
                color_path.identifiers.id, err
            ),
        ),
    };
}

/// Relabels an existing user color path.
fn label_color_path(context: &mut CueCrudContext, command_id: uuid::Uuid, id: u32, label: &str) {
    let Some(color_path_data_provider) = writable_color_paths(
        &mut context.color_path_data_provider,
        &mut context.outbound,
        command_id,
        "label color path",
    ) else {
        return;
    };
    if is_builtin_color_path_id(id) {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to label color path {}: built-in color paths are read-only",
                id
            ),
        );
        return;
    }
    let maybe_color_path = color_path_data_provider
        .from_id(id)
        .map(|color_path| (*color_path).clone());
    let Ok(mut color_path) = maybe_color_path else {
        context.outbound.fail_cue(
            command_id,
            format!("Failed to label color path {}: not found", id),
        );
        return;
    };
    color_path.identifiers.label = label.to_owned();
    match color_path_data_provider.add(color_path) {
        Ok(()) => context.outbound.succeed_cue(command_id),
        Err(err) => context.outbound.fail_cue(
            command_id,
            format!("Failed to label color path {}: {}", id, err),
        ),
    };
}

/// Copies a color path to a new user color path ID with a `Copy` label suffix.
///
/// Built-in color paths may be duplicated, but not overwritten by the copy.
fn duplicate_color_path(
    context: &mut CueCrudContext,
    command_id: uuid::Uuid,
    id: u32,
    new_id: u32,
) {
    let Some(color_path_data_provider) = writable_color_paths(
        &mut context.color_path_data_provider,
        &mut context.outbound,
        command_id,
        "duplicate color path",
    ) else {
        return;
    };
    if is_builtin_color_path_id(new_id) {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to duplicate color path {} to {}: built-in color paths are read-only",
                id, new_id
            ),
        );
        return;
    }
    let maybe_color_path = color_path_data_provider
        .from_id(id)
        .map(|color_path| (*color_path).clone());
    let Ok(source) = maybe_color_path else {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to duplicate color path {} to {}: source not found",
                id, new_id
            ),
        );
        return;
    };
    let mut duplicate = source.clone();
    duplicate.identifiers = Identifiers {
        id: new_id,
        label: format!("{} Copy", source.identifiers.label),
        ..Default::default()
    };
    match color_path_data_provider.add(duplicate) {
        Ok(()) => context.outbound.succeed_cue(command_id),
        Err(err) => context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to duplicate color path {} to {}: {}",
                id, new_id, err
            ),
        ),
    };
}

/// Moves a user color path to a free ID and rewrites stored references to it.
///
/// Cue instructions and fixture color path defaults referencing the old ID follow the rename.
fn rename_color_path(context: &mut CueCrudContext, command_id: uuid::Uuid, id: u32, new_id: u32) {
    let Some(color_path_data_provider) = writable_color_paths(
        &mut context.color_path_data_provider,
        &mut context.outbound,
        command_id,
        "rename color path",
    ) else {
        return;
    };
    if is_builtin_color_path_id(id) || is_builtin_color_path_id(new_id) {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to rename color path {} to {}: built-in color paths are read-only",
                id, new_id
            ),
        );
        return;
    }
    if color_path_data_provider.from_id(new_id).is_ok() {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to rename color path {} to {}: already exists",
                id, new_id
            ),
        );
        return;
    }
    let maybe_color_path = color_path_data_provider
        .from_id(id)
        .map(|color_path| (*color_path).clone());
    let Ok(mut color_path) = maybe_color_path else {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to rename color path {} to {}: source not found",
                id, new_id
            ),
        );
        return;
    };
    color_path.identifiers.id = new_id;
    if let Err(err) = color_path_data_provider.add(color_path) {
        context.outbound.fail_cue(
            command_id,
            format!("Failed to rename color path {} to {}: {}", id, new_id, err),
        );
        return;
    }

    let rewritten_cues = match rewrite_stored_cue_color_path_references(
        &mut context.cue_data_provider,
        id,
        new_id,
    ) {
        Ok(cues) => cues,
        Err(err) => {
            context.outbound.fail_cue(
                command_id,
                format!(
                    "Failed to rewrite color path references for {} to {}: {}",
                    id, new_id, err
                ),
            );
            return;
        }
    };
    for cue in &rewritten_cues {
        write_cue_definition_updated(&mut context.cue_definition_changes, cue);
    }
    rewrite_fixture_color_path_defaults(&mut context.selection_or_fixtures.p1(), id, new_id);
    context.outbound.succeed_cue(command_id);
}

/// Returns a formatted listing of every color path as command output.
fn list_color_paths(context: &mut CueCrudContext, command_id: uuid::Uuid) {
    let Some(color_path_data_provider) = context.color_path_data_provider.as_deref() else {
        context.outbound.fail_cue(
            command_id,
            "Failed to list color paths: color path provider is unavailable".to_string(),
        );
        return;
    };
    context
        .outbound
        .succeed_cue_with_output(command_id, format_color_path_list(color_path_data_provider));
}

/// Deletes a user color path and clears stored references to it.
///
/// Cue instructions and fixture color path defaults referencing the deleted ID lose the
/// reference.
fn delete_color_path(context: &mut CueCrudContext, command_id: uuid::Uuid, id: u32) {
    let Some(color_path_data_provider) = writable_color_paths(
        &mut context.color_path_data_provider,
        &mut context.outbound,
        command_id,
        "delete color path",
    ) else {
        return;
    };
    if is_builtin_color_path_id(id) {
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to delete color path {}: built-in color paths are read-only",
                id
            ),
        );
        return;
    }
    let Ok(uid) = color_path_data_provider
        .from_id(id)
        .map(|color_path| color_path.identifiers.uid)
    else {
        context.outbound.fail_cue(
            command_id,
            format!("Failed to delete color path {}: not found", id),
        );
        return;
    };
    if let Err(err) = color_path_data_provider.remove(&uid) {
        context.outbound.fail_cue(
            command_id,
            format!("Failed to delete color path {}: {}", id, err),
        );
        return;
    }

    let cleared_cues =
        match clear_stored_cue_color_path_references(&mut context.cue_data_provider, id) {
            Ok(cues) => cues,
            Err(err) => {
                context.outbound.fail_cue(
                    command_id,
                    format!("Failed to clear color path {} cue references: {}", id, err),
                );
                return;
            }
        };
    for cue in &cleared_cues {
        write_cue_definition_updated(&mut context.cue_definition_changes, cue);
    }
    let cleared_defaults =
        clear_fixture_color_path_defaults(&mut context.selection_or_fixtures.p1(), id);
    tracing::debug!(
        color_path_id = id,
        cleared_cues = cleared_cues.len(),
        cleared_defaults,
        "Cleared color path references after delete"
    );
    context.outbound.succeed_cue(command_id);
}
