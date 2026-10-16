// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue definition store, rename, delete, and block-tracking commands.

use super::*;

/// Applies one cue definition command and reports its outcome.
///
/// Every command here can change sequence playback order or tracked values, so each marks the
/// sequence lookahead state dirty before mutating definitions.
pub(super) fn handle_command(context: &mut CueCrudContext, envelope: &CommandEnvelope<CueCommand>) {
    let command_id = envelope.command_id.into();
    match &envelope.command {
        CueCommand::StoreCue(cue) => {
            mark_sequence_lookahead_state_dirty(&mut context.sequence_lookahead_dirty);
            let read_context = context.selection_or_fixtures.p0();
            if store_cue_definition(
                cue,
                &read_context.selection_resolver,
                command_id,
                &mut context.cue_data_provider,
                &mut context.outbound,
                &mut context.cue_definition_changes,
            ) {
                context.outbound.succeed_cue(command_id);
            }
        }

        CueCommand::RenameCue {
            sequence_id,
            cue_id,
            new_sequence_id,
            new_cue_id,
        } => {
            mark_sequence_lookahead_state_dirty(&mut context.sequence_lookahead_dirty);
            let rename = CueRename {
                sequence_id: *sequence_id,
                cue_id: *cue_id,
                new_sequence_id: *new_sequence_id,
                new_cue_id: *new_cue_id,
            };
            if rename_cue(context, command_id, &rename) {
                context.outbound.succeed_cue(command_id);
            }
        }

        CueCommand::DeleteCue {
            sequence_id,
            cue_id,
        } => {
            mark_sequence_lookahead_state_dirty(&mut context.sequence_lookahead_dirty);
            if delete_cue(context, command_id, *sequence_id, *cue_id) {
                context.outbound.succeed_cue(command_id);
            }
        }

        CueCommand::BlockCue {
            sequence_id,
            cue_id,
            part_id,
            overwrite,
        } => {
            mark_sequence_lookahead_state_dirty(&mut context.sequence_lookahead_dirty);
            if block_cue(
                context,
                command_id,
                *sequence_id,
                *cue_id,
                *part_id,
                BlockCueOperation::Block,
                *overwrite,
            ) {
                context.outbound.succeed_cue(command_id);
            }
        }

        CueCommand::UnblockCue {
            sequence_id,
            cue_id,
            part_id,
        } => {
            mark_sequence_lookahead_state_dirty(&mut context.sequence_lookahead_dirty);
            if block_cue(
                context,
                command_id,
                *sequence_id,
                *cue_id,
                *part_id,
                BlockCueOperation::Unblock,
                false,
            ) {
                context.outbound.succeed_cue(command_id);
            }
        }

        _ => {}
    }
}

/// Source and target addresses of a cue rename or move.
struct CueRename {
    /// Sequence currently holding the cue.
    sequence_id: u32,
    /// Current cue ID.
    cue_id: u32,
    /// Sequence the cue moves to; equal to `sequence_id` for an in-place rename.
    new_sequence_id: u32,
    /// Cue ID after the rename.
    new_cue_id: u32,
}

impl CueRename {
    /// Returns whether the rename leaves the cue at its current address.
    fn is_noop(&self) -> bool {
        self.sequence_id == self.new_sequence_id && self.cue_id == self.new_cue_id
    }

    /// Logs and reports a failed rename step.
    ///
    /// `action` names the failed step, such as `Failed to rename`; the cue addresses and
    /// `reason` follow it. Logs write the move as `from -> to`, operator messages as
    /// `from to to`.
    fn fail(
        &self,
        outbound: &mut CommandResponder,
        command_id: uuid::Uuid,
        action: &str,
        reason: impl std::fmt::Display,
    ) {
        let Self {
            sequence_id,
            cue_id,
            new_sequence_id,
            new_cue_id,
        } = self;
        tracing::warn!(
            "{} cue {}.{} -> {}.{}: {}",
            action,
            sequence_id,
            cue_id,
            new_sequence_id,
            new_cue_id,
            reason
        );
        outbound.fail_cue(
            command_id,
            format!(
                "{} cue {}.{} to {}.{}: {}",
                action, sequence_id, cue_id, new_sequence_id, new_cue_id, reason
            ),
        );
    }
}

/// Renames a cue within its sequence or moves it to another sequence.
///
/// Fails without changes when another cue already holds the target address, or when the cue or
/// either sequence is missing. Otherwise the cue is stored under its new ID and the sequence
/// steps are updated. Returns whether every step succeeded; failures are already reported.
fn rename_cue(context: &mut CueCrudContext, command_id: uuid::Uuid, rename: &CueRename) -> bool {
    tracing::debug!(
        "Renaming cue {}.{} to {}.{}",
        rename.sequence_id,
        rename.cue_id,
        rename.new_sequence_id,
        rename.new_cue_id
    );

    if context
        .cue_data_provider
        .cue_by_sequence_id(
            &context.sequence_data_provider,
            rename.new_sequence_id,
            rename.new_cue_id,
        )
        .is_ok()
        && !rename.is_noop()
    {
        rename.fail(
            &mut context.outbound,
            command_id,
            "Failed to rename",
            "target already exists",
        );
        return false;
    }
    let maybe_cue = context
        .cue_data_provider
        .cue_by_sequence_id(
            &context.sequence_data_provider,
            rename.sequence_id,
            rename.cue_id,
        )
        .map(|cue_ref| (*cue_ref).clone());
    let Ok(mut cue) = maybe_cue else {
        rename.fail(
            &mut context.outbound,
            command_id,
            "Failed to rename",
            "not found",
        );
        return false;
    };

    let maybe_source_sequence = context
        .sequence_data_provider
        .from_id(rename.sequence_id)
        .map(|sequence_ref| (*sequence_ref).clone());
    let maybe_target_sequence = context
        .sequence_data_provider
        .from_id(rename.new_sequence_id)
        .map(|sequence_ref| (*sequence_ref).clone());
    let (Ok(source_sequence), Ok(target_sequence)) = (maybe_source_sequence, maybe_target_sequence)
    else {
        rename.fail(
            &mut context.outbound,
            command_id,
            "Failed to rename",
            "source or target sequence not found",
        );
        return false;
    };

    let cue_uid = cue.identifiers.uid;
    cue.identifiers.id = rename.new_cue_id;
    if let Err(err) = context.cue_data_provider.add(cue.clone()) {
        rename.fail(&mut context.outbound, command_id, "Failed to rename", err);
        return false;
    }
    write_cue_definition_updated(&mut context.cue_definition_changes, &cue);

    let cue_step = cue_uid.into();
    if rename.sequence_id == rename.new_sequence_id {
        keep_renamed_cue_step(context, command_id, rename, source_sequence, cue_step)
    } else {
        move_cue_step_between_sequences(
            context,
            command_id,
            rename,
            source_sequence,
            target_sequence,
            cue_step,
        )
    }
}

/// Ensures a cue renamed in place is still a step of its sequence and persists the sequence.
///
/// Returns whether the sequence was persisted; failures are already reported.
fn keep_renamed_cue_step(
    context: &mut CueCrudContext,
    command_id: uuid::Uuid,
    rename: &CueRename,
    mut sequence: Sequence,
    cue_step: SimpleUuid,
) -> bool {
    if !sequence.steps.contains(&cue_step) {
        sequence.steps.push(cue_step);
    }
    if let Err(err) = context.sequence_data_provider.add(sequence.clone()) {
        rename.fail(
            &mut context.outbound,
            command_id,
            &format!(
                "Failed to persist sequence {} while renaming",
                rename.sequence_id
            ),
            err,
        );
        return false;
    }
    write_sequence_definition_updated(&mut context.sequence_definition_changes, &sequence);
    true
}

/// Moves a renamed cue's step from its source sequence to the target sequence.
///
/// The source sequence is persisted first; a failure there leaves the target untouched.
/// Returns whether both sequences were persisted; failures are already reported.
fn move_cue_step_between_sequences(
    context: &mut CueCrudContext,
    command_id: uuid::Uuid,
    rename: &CueRename,
    mut source_sequence: Sequence,
    mut target_sequence: Sequence,
    cue_step: SimpleUuid,
) -> bool {
    source_sequence
        .steps
        .retain(|step_uid| *step_uid != cue_step);
    if !target_sequence.steps.contains(&cue_step) {
        target_sequence.steps.push(cue_step);
    }

    if let Err(err) = context.sequence_data_provider.add(source_sequence.clone()) {
        rename.fail(
            &mut context.outbound,
            command_id,
            &format!(
                "Failed to persist source sequence {} while moving",
                rename.sequence_id
            ),
            err,
        );
        return false;
    }
    write_sequence_definition_updated(&mut context.sequence_definition_changes, &source_sequence);
    if let Err(err) = context.sequence_data_provider.add(target_sequence.clone()) {
        rename.fail(
            &mut context.outbound,
            command_id,
            &format!(
                "Failed to persist target sequence {} while moving",
                rename.new_sequence_id
            ),
            err,
        );
        return false;
    }
    write_sequence_definition_updated(&mut context.sequence_definition_changes, &target_sequence);
    true
}

/// Deletes a cue definition and removes its step from the owning sequence.
///
/// The cue is removed before its sequence is updated, so a missing or unpersistable sequence
/// fails the command after the cue is already gone. Returns whether every step succeeded;
/// failures are already reported.
fn delete_cue(
    context: &mut CueCrudContext,
    command_id: uuid::Uuid,
    sequence_id: u32,
    cue_id: u32,
) -> bool {
    tracing::debug!("Deleting cue {}.{}", sequence_id, cue_id);
    let maybe_cue = context
        .cue_data_provider
        .cue_by_sequence_id(&context.sequence_data_provider, sequence_id, cue_id)
        .map(|cue_ref| (*cue_ref).clone());
    let Ok(cue) = maybe_cue else {
        tracing::warn!("Failed to delete cue {}.{}: not found", sequence_id, cue_id);
        context.outbound.fail_cue(
            command_id,
            format!("Failed to delete cue {}.{}: not found", sequence_id, cue_id),
        );
        return false;
    };

    let cue_uid = cue.identifiers.uid;
    if let Err(err) = context.cue_data_provider.remove(&cue_uid) {
        tracing::warn!("Failed to delete cue {}.{}: {}", sequence_id, cue_id, err);
        context.outbound.fail_cue(
            command_id,
            format!("Failed to delete cue {}.{}: {}", sequence_id, cue_id, err),
        );
        return false;
    }
    write_cue_definition_removed(&mut context.cue_definition_changes, cue_uid);

    let maybe_sequence = context
        .sequence_data_provider
        .from_id(sequence_id)
        .map(|sequence_ref| (*sequence_ref).clone());
    let Ok(mut sequence) = maybe_sequence else {
        tracing::warn!(
            "Failed to update sequence {} after deleting cue {}: sequence not found",
            sequence_id,
            cue_id
        );
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to update sequence {} after deleting cue {}: sequence not found",
                sequence_id, cue_id
            ),
        );
        return false;
    };

    let cue_uid_simple = cue_uid.into();
    sequence
        .steps
        .retain(|step_uid| *step_uid != cue_uid_simple);
    if let Err(err) = context.sequence_data_provider.add(sequence.clone()) {
        tracing::warn!(
            "Failed to update sequence {} after deleting cue {}: {}",
            sequence_id,
            cue_id,
            err
        );
        context.outbound.fail_cue(
            command_id,
            format!(
                "Failed to update sequence {} after deleting cue {}: {}",
                sequence_id, cue_id, err
            ),
        );
        return false;
    }
    write_sequence_definition_updated(&mut context.sequence_definition_changes, &sequence);
    true
}

/// Blocks or unblocks tracked values in a cue or cue part.
///
/// Returns whether the operation succeeded; failures are already reported.
fn block_cue(
    context: &mut CueCrudContext,
    command_id: uuid::Uuid,
    sequence_id: u32,
    cue_id: u32,
    part_id: Option<u32>,
    operation: BlockCueOperation,
    overwrite: bool,
) -> bool {
    let read_context = context.selection_or_fixtures.p0();
    handle_block_cue_command(
        command_id,
        &mut context.outbound,
        &mut context.cue_data_provider,
        &mut context.sequence_data_provider,
        &mut context.cue_definition_changes,
        &mut context.sequence_definition_changes,
        &read_context.selection_resolver,
        &read_context.fixture_data_provider,
        read_context.blueprint_data_provider.as_deref(),
        sequence_id,
        cue_id,
        part_id,
        operation,
        overwrite,
    )
}
