// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo implementations for cue commands.

use bevy_ecs::prelude::*;
use nightfall::prelude::ColorPath;
use nightfall_desk::instances::InstanceIndex;
use nightfall_engine::prelude::*;
use nightfall_instances::InstanceId;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::SequencePlaybackAction;
use crate::data_provider_ext::CueDataProviderExt;
use crate::materialized_sequence::MaterializedSequence;
use crate::prelude::{Cue, CueAction, CueCommand, Sequence};

/// Capture the previous cue definition as an inverse store operation.
fn inverse_for_store_cue(
    cue: &Cue,
    cues: &DataProvider<Cue>,
    sequences: &DataProvider<Sequence>,
) -> Option<Box<dyn UndoableOperation>> {
    match cues.get(cue.identifiers.uid) {
        Ok(existing) => {
            let old_cue: Cue = (*existing).clone();
            Some(Box::new(CueAction::StoreCue(Box::new(old_cue))))
        }
        Err(_) => {
            let sequence_id = find_sequence_id_for_cue_uid(sequences, cue.identifiers.uid)
                .unwrap_or(cue.identifiers.id);
            Some(Box::new(CueCommand::DeleteCue {
                sequence_id,
                cue_id: cue.identifiers.id,
            }))
        }
    }
}

/// Capture the previous sequence definition as an inverse store operation.
fn inverse_for_store_sequence(
    sequence: &Sequence,
    sequences: &DataProvider<Sequence>,
) -> Option<Box<dyn UndoableOperation>> {
    match sequences.get(sequence.identifiers.uid) {
        Ok(existing) => {
            let old_sequence: Sequence = (*existing).clone();
            Some(Box::new(CueAction::StoreSequence(Box::new(old_sequence))))
        }
        Err(_) => Some(Box::new(CueCommand::DeleteSequence(
            sequence.identifiers.id,
        ))),
    }
}

impl UndoableOperation for CueCommand {
    /// Build the inverse cue operation from the definitions captured before mutation.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let cues = ctx.world.resource::<DataProvider<Cue>>();
        let sequences = ctx.world.resource::<DataProvider<Sequence>>();
        let color_paths = ctx.world.resource::<DataProvider<ColorPath>>();

        match self {
            CueCommand::StoreCue(cue) => inverse_for_store_cue(cue, cues, sequences),
            CueCommand::StoreSequence(sequence) => inverse_for_store_sequence(sequence, sequences),
            CueCommand::DeleteCue {
                sequence_id,
                cue_id,
            } => {
                // Capture full cue before deletion
                cues.cue_by_sequence_id(sequences, *sequence_id, *cue_id)
                    .ok()
                    .map(|cue_ref| {
                        let cue: Cue = (*cue_ref).clone();
                        Box::new(CueAction::StoreCue(Box::new(cue))) as Box<dyn UndoableOperation>
                    })
            }
            CueCommand::RenameCue {
                sequence_id,
                cue_id,
                new_sequence_id,
                new_cue_id,
            } => Some(Box::new(CueCommand::RenameCue {
                sequence_id: *new_sequence_id,
                cue_id: *new_cue_id,
                new_sequence_id: *sequence_id,
                new_cue_id: *cue_id,
            })),
            CueCommand::BlockCue {
                sequence_id,
                cue_id,
                ..
            }
            | CueCommand::UnblockCue {
                sequence_id,
                cue_id,
                ..
            }
            | CueCommand::SetCueColorPath {
                sequence_id,
                cue_id,
                ..
            } => {
                if *cue_id == 0 {
                    sequences.from_id(*sequence_id).ok().map(|seq_ref| {
                        let seq: Sequence = (*seq_ref).clone();
                        Box::new(CueAction::StoreSequence(Box::new(seq)))
                            as Box<dyn UndoableOperation>
                    })
                } else {
                    cues.cue_by_sequence_id(sequences, *sequence_id, *cue_id)
                        .ok()
                        .map(|cue_ref| {
                            let cue: Cue = (*cue_ref).clone();
                            Box::new(CueAction::StoreCue(Box::new(cue)))
                                as Box<dyn UndoableOperation>
                        })
                }
            }
            CueCommand::StoreColorPath(color_path) => {
                match color_paths.get(color_path.identifiers.uid) {
                    Ok(existing) => {
                        let old_color_path: ColorPath = (*existing).clone();
                        Some(Box::new(CueCommand::StoreColorPath(old_color_path)))
                    }
                    Err(_) => Some(Box::new(CueCommand::DeleteColorPath(
                        color_path.identifiers.id,
                    ))),
                }
            }
            CueCommand::LabelColorPath { id, .. } => {
                color_paths.from_id(*id).ok().map(|color_path_ref| {
                    let color_path: ColorPath = (*color_path_ref).clone();
                    Box::new(CueCommand::StoreColorPath(color_path)) as Box<dyn UndoableOperation>
                })
            }
            CueCommand::DuplicateColorPath { new_id, .. } => {
                Some(Box::new(CueCommand::DeleteColorPath(*new_id)))
            }
            CueCommand::RenameColorPath { id, new_id } => {
                Some(Box::new(CueCommand::RenameColorPath {
                    id: *new_id,
                    new_id: *id,
                }))
            }
            CueCommand::ListColorPaths => None,
            CueCommand::DeleteColorPath(id) => {
                color_paths.from_id(*id).ok().map(|color_path_ref| {
                    let color_path: ColorPath = (*color_path_ref).clone();
                    Box::new(CueCommand::StoreColorPath(color_path)) as Box<dyn UndoableOperation>
                })
            }
            CueCommand::DeleteSequence(id) => {
                // Capture full sequence before deletion
                sequences.from_id(*id).ok().map(|seq_ref| {
                    let seq: Sequence = (*seq_ref).clone();
                    Box::new(CueAction::StoreSequence(Box::new(seq))) as Box<dyn UndoableOperation>
                })
            }
            CueCommand::RenameSequence { id, new_id } => {
                Some(Box::new(CueCommand::RenameSequence {
                    id: *new_id,
                    new_id: *id,
                }))
            }
        }
    }

    fn description(&self) -> String {
        match self {
            CueCommand::StoreCue(cue) => format!("Store Cue {}", cue.identifiers.id),
            CueCommand::StoreSequence(sequence) => {
                format!("Store Sequence {}", sequence.identifiers.id)
            }
            CueCommand::DeleteCue {
                sequence_id,
                cue_id,
            } => format!("Delete Cue {}.{}", sequence_id, cue_id),
            CueCommand::RenameCue {
                sequence_id,
                cue_id,
                new_sequence_id,
                new_cue_id,
            } => format!(
                "Rename Cue {}.{} → {}.{}",
                sequence_id, cue_id, new_sequence_id, new_cue_id
            ),
            CueCommand::BlockCue {
                sequence_id,
                cue_id,
                part_id,
                overwrite,
            } => match part_id {
                Some(part_id) if *overwrite => {
                    format!(
                        "Block Cue {}.{} Part {} Overwrite",
                        sequence_id, cue_id, part_id
                    )
                }
                Some(part_id) => format!("Block Cue {}.{} Part {}", sequence_id, cue_id, part_id),
                None if *overwrite => format!("Block Cue {}.{} Overwrite", sequence_id, cue_id),
                None => format!("Block Cue {}.{}", sequence_id, cue_id),
            },
            CueCommand::UnblockCue {
                sequence_id,
                cue_id,
                part_id,
            } => match part_id {
                Some(part_id) => {
                    format!("Unblock Cue {}.{} Part {}", sequence_id, cue_id, part_id)
                }
                None => format!("Unblock Cue {}.{}", sequence_id, cue_id),
            },
            CueCommand::SetCueColorPath {
                sequence_id,
                cue_id,
                color_path_id,
            } => match color_path_id {
                Some(color_path_id) => {
                    format!(
                        "Set Cue {}.{} Color Path {}",
                        sequence_id, cue_id, color_path_id.0
                    )
                }
                None => format!("Clear Cue {}.{} Color Path", sequence_id, cue_id),
            },
            CueCommand::StoreColorPath(color_path) => {
                format!("Store Color Path {}", color_path.identifiers.id)
            }
            CueCommand::LabelColorPath { id, label } => {
                format!("Label Color Path {} {}", id, label)
            }
            CueCommand::DuplicateColorPath { id, new_id } => {
                format!("Duplicate Color Path {} → {}", id, new_id)
            }
            CueCommand::RenameColorPath { id, new_id } => {
                format!("Rename Color Path {} → {}", id, new_id)
            }
            CueCommand::ListColorPaths => "List Color Paths".to_string(),
            CueCommand::DeleteColorPath(id) => format!("Delete Color Path {}", id),
            CueCommand::DeleteSequence(id) => format!("Delete Sequence {}", id),
            CueCommand::RenameSequence { id, new_id } => {
                format!("Rename Sequence {} → {}", id, new_id)
            }
        }
    }
}

impl UndoableOperation for CueAction {
    /// Build the inverse cue operation from the definitions captured before mutation.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let cues = ctx.world.resource::<DataProvider<Cue>>();
        let sequences = ctx.world.resource::<DataProvider<Sequence>>();

        match self {
            CueAction::StoreCue(cue) => inverse_for_store_cue(cue, cues, sequences),
            CueAction::StoreSequence(sequence) => inverse_for_store_sequence(sequence, sequences),
            CueAction::StoreCueInSequence { .. } => None,
            CueAction::RestoreCueStoreState {
                sequence_id,
                cue_uid,
                undo_label,
                ..
            } => {
                let current_cue = cues.get(*cue_uid).ok().map(|cue_ref| (*cue_ref).clone());
                let current_sequence = sequences
                    .from_id(*sequence_id)
                    .ok()
                    .map(|sequence_ref| (*sequence_ref).clone());
                Some(Box::new(CueAction::RestoreCueStoreState {
                    sequence_id: *sequence_id,
                    cue_uid: *cue_uid,
                    previous_cue: current_cue.map(Box::new),
                    previous_sequence: current_sequence.map(Box::new),
                    undo_label: undo_label.clone(),
                }))
            }
        }
    }

    fn description(&self) -> String {
        match self {
            CueAction::StoreCue(cue) => format!("Store Cue {}", cue.identifiers.id),
            CueAction::StoreSequence(sequence) => {
                format!("Store Sequence {}", sequence.identifiers.id)
            }
            CueAction::StoreCueInSequence { undo_label, .. }
            | CueAction::RestoreCueStoreState { undo_label, .. } => undo_label.clone(),
        }
    }
}

fn find_sequence_id_for_cue_uid(sequences: &DataProvider<Sequence>, cue_uid: Uuid) -> Option<u32> {
    sequences.iter().find_map(|entry| {
        let sequence = entry.value();
        let contains_cue = sequence.steps.iter().any(|step| {
            let step_uid: Uuid = (*step).into();
            step_uid == cue_uid
        });
        contains_cue.then_some(sequence.identifiers.id)
    })
}

// ============================================================================
// Sequence Playback Undo
// ============================================================================

/// Snapshot of a sequence playback position for undo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencePositionSnapshot {
    /// The instance ID
    pub instance_id: InstanceId,
    /// The position (1-based cue number)
    pub position: u32,
}

/// Command to restore a sequence playback position.
///
/// Used for undoing Go and Goto commands on sequences.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct RestoreSequencePosition(pub SequencePositionSnapshot);

impl EngineAction for RestoreSequencePosition {}

impl UndoableOperation for RestoreSequencePosition {
    /// Build the inverse cue operation from the definitions captured before mutation.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        // Capture current position before restoring
        let position = get_sequence_position(ctx.world, self.0.instance_id)?;
        Some(Box::new(RestoreSequencePosition(
            SequencePositionSnapshot {
                instance_id: self.0.instance_id,
                position,
            },
        )))
    }

    fn description(&self) -> String {
        format!("Restore Sequence Position {}", self.0.position)
    }
}

/// Helper function to get the current sequence position for a playback.
fn get_sequence_position(world: &World, instance_id: InstanceId) -> Option<u32> {
    let instance_index = world.resource::<InstanceIndex>();
    let entity = instance_index.get(&instance_id)?;
    let mseq = world.get::<MaterializedSequence>(entity)?;
    Some(mseq.position())
}

impl UndoableOperation for SequencePlaybackAction {
    /// Build the inverse cue operation from the definitions captured before mutation.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        match self {
            SequencePlaybackAction::Go { instance_id }
            | SequencePlaybackAction::Back { instance_id }
            | SequencePlaybackAction::Goto { instance_id, .. }
            | SequencePlaybackAction::RenderAt { instance_id, .. } => {
                // Capture current position before sequence navigation changes it.
                let position = get_sequence_position(ctx.world, *instance_id)?;
                Some(Box::new(RestoreSequencePosition(
                    SequencePositionSnapshot {
                        instance_id: *instance_id,
                        position,
                    },
                )))
            }
            SequencePlaybackAction::Stop { .. } => {
                // Stopping a playback cannot be reliably undone - the playback state is lost
                // The playback would need to be re-started manually
                None
            }
        }
    }

    fn description(&self) -> String {
        match self {
            SequencePlaybackAction::Go { instance_id } => {
                format!("Sequence Go ({})", instance_id.0)
            }
            SequencePlaybackAction::Back { instance_id } => {
                format!("Sequence Back ({})", instance_id.0)
            }
            SequencePlaybackAction::Goto {
                instance_id,
                position,
                ..
            } => {
                format!("Sequence Goto {} ({})", position, instance_id.0)
            }
            SequencePlaybackAction::RenderAt {
                instance_id,
                position,
                ..
            } => {
                format!("Sequence RenderAt {} ({})", position, instance_id.0)
            }
            SequencePlaybackAction::Stop { instance_id } => {
                format!("Sequence Stop ({})", instance_id.0)
            }
        }
    }
}
