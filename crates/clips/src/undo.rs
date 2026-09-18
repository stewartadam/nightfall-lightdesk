// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::World;
use nightfall::engine::{EngineAction, EngineIngressMeta, EnginePayload};
use nightfall_undo::prelude::{UndoContext, UndoableOperation};
use serde::{Deserialize, Serialize};

use crate::{Clip, ClipCommand, Source};

/// Snapshot of a clip's source assignment for undo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipSourceSnapshot {
    /// Clip ID whose assignment should be restored.
    pub clip_id: u32,
    /// Previous source assignment, or `None` when the clip was unassigned.
    pub source: Option<Source>,
}

/// Runtime action that restores a clip's previous source assignment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreClipSource(pub ClipSourceSnapshot);

impl EnginePayload for RestoreClipSource {}

impl EngineIngressMeta for RestoreClipSource {
    const COMMAND_MODULE: &'static str = "RestoreClipSource";
}

impl EngineAction for RestoreClipSource {}

impl UndoableOperation for RestoreClipSource {
    /// Captures the current source so restoring a source can itself be undone.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let clip = find_clip_by_id(ctx.world, self.0.clip_id)?;
        Some(Box::new(RestoreClipSource(ClipSourceSnapshot {
            clip_id: self.0.clip_id,
            source: clip.source.clone(),
        })))
    }

    /// Describes the clip source restoration for undo history.
    fn description(&self) -> String {
        format!("Restore Clip {} Source", self.0.clip_id)
    }
}

impl UndoableOperation for ClipCommand {
    /// Captures the inverse clip operation from the current ECS state.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        match self {
            ClipCommand::StoreClip(clip) => {
                if let Some(existing) = find_clip_by_uid(ctx.world, clip.identifiers.uid) {
                    Some(Box::new(ClipCommand::StoreClip(existing)))
                } else if find_clip_by_id(ctx.world, clip.identifiers.id).is_some() {
                    None
                } else {
                    Some(Box::new(ClipCommand::DeleteClip(clip.identifiers.id)))
                }
            }
            ClipCommand::DeleteClip(id) => find_clip_by_id(ctx.world, *id)
                .map(|clip| Box::new(ClipCommand::StoreClip(clip)) as Box<dyn UndoableOperation>),
            ClipCommand::RenameClip { id, new_id } => Some(Box::new(ClipCommand::RenameClip {
                id: *new_id,
                new_id: *id,
            })),
            ClipCommand::StartClip(id_expr) => {
                Some(Box::new(ClipCommand::StopClip(id_expr.clone())))
            }
            ClipCommand::StartClipAtTiming { clip_id, .. } => {
                Some(Box::new(ClipCommand::StopClip(clip_id.clone())))
            }
            ClipCommand::StopClip(id_expr)
            | ClipCommand::StopClipAtTiming {
                clip_id: id_expr, ..
            } => Some(Box::new(ClipCommand::StartClip(id_expr.clone()))),
            ClipCommand::GoClip(_)
            | ClipCommand::BackClip(_)
            | ClipCommand::SetRate { .. }
            | ClipCommand::GotoClip { .. }
            | ClipCommand::RenderClipAt { .. } => None,
            ClipCommand::AssignSource { clip_id, .. }
            | ClipCommand::AssignSourceById { clip_id, .. } => {
                restore_source_inverse(ctx.world, *clip_id)
            }
            ClipCommand::ClearSource(id) => restore_source_inverse(ctx.world, *id),
            ClipCommand::UpdateClipOptions { clip_id, .. } => find_clip_by_id(ctx.world, *clip_id)
                .map(|clip| {
                    Box::new(ClipCommand::UpdateClipOptions {
                        clip_id: *clip_id,
                        options: clip.options.clone(),
                    }) as Box<dyn UndoableOperation>
                }),
        }
    }

    /// Describes the clip operation for undo history.
    fn description(&self) -> String {
        match self {
            ClipCommand::StoreClip(clip) => {
                format!("Store Clip {}", clip.identifiers.id)
            }
            ClipCommand::DeleteClip(id) => format!("Delete Clip {id}"),
            ClipCommand::RenameClip { id, new_id } => {
                format!("Rename Clip {id} to {new_id}")
            }
            ClipCommand::StartClip(id_expr)
            | ClipCommand::StartClipAtTiming {
                clip_id: id_expr, ..
            } => format!("Start Clip {id_expr}"),
            ClipCommand::StopClip(id_expr)
            | ClipCommand::StopClipAtTiming {
                clip_id: id_expr, ..
            } => format!("Stop Clip {id_expr}"),
            ClipCommand::GoClip(id_expr) => format!("Go Clip {id_expr}"),
            ClipCommand::BackClip(id_expr) => format!("Back Clip {id_expr}"),
            ClipCommand::SetRate { clip_id, rate } => {
                format!("Set Clip {clip_id} Rate {rate}")
            }
            ClipCommand::GotoClip {
                clip_id, position, ..
            } => format!("Goto Clip {clip_id} Position {position}"),
            ClipCommand::RenderClipAt {
                clip_id, position, ..
            } => format!("Render Clip {clip_id} At Position {position}"),
            ClipCommand::AssignSource { clip_id, source } => {
                format!("Assign {source:?} to Clip {clip_id}")
            }
            ClipCommand::AssignSourceById { clip_id, source } => {
                format!("Assign {source:?} to Clip {clip_id}")
            }
            ClipCommand::ClearSource(id) => format!("Clear Source from Clip {id}"),
            ClipCommand::UpdateClipOptions { clip_id, options } => format!(
                "Update Clip {} Options (auto_release={}, deactivate_on_sequence_end={})",
                clip_id, options.auto_release, options.deactivate_on_sequence_end
            ),
        }
    }
}

/// Builds an inverse source-restoration action for the requested clip.
fn restore_source_inverse(world: &World, clip_id: u32) -> Option<Box<dyn UndoableOperation>> {
    find_clip_by_id(world, clip_id).map(|clip| {
        Box::new(RestoreClipSource(ClipSourceSnapshot {
            clip_id,
            source: clip.source.clone(),
        })) as Box<dyn UndoableOperation>
    })
}

/// Finds a cloned clip by console-facing numeric ID.
fn find_clip_by_id(world: &World, id: u32) -> Option<Clip> {
    world
        .iter_entities()
        .filter_map(|entity| entity.get::<Clip>())
        .find(|clip| clip.identifiers.id == id)
        .cloned()
}

/// Finds a cloned clip by persistent UUID.
fn find_clip_by_uid(world: &World, uid: uuid::Uuid) -> Option<Clip> {
    world
        .iter_entities()
        .filter_map(|entity| entity.get::<Clip>())
        .find(|clip| clip.identifiers.uid == uid)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies source restoration retains the engine routing name used before extraction.
    #[test]
    fn preserves_restore_source_engine_module_name() {
        assert_eq!(RestoreClipSource::COMMAND_MODULE, "RestoreClipSource");
    }
}
