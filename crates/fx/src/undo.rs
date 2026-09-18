// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo implementations for fx commands.

use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::prelude::{Fx, FxCommand, StepFx, StepFxCommand};

impl UndoableOperation for FxCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let fx_provider = ctx.world.resource::<DataProvider<Fx>>();

        match self {
            FxCommand::StoreFx(fx) => {
                // Check if this is update vs create
                match fx_provider.get(fx.identifiers.uid) {
                    Ok(existing) => {
                        // Update: restore old version
                        let old_fx: Fx = (*existing).clone();
                        Some(Box::new(FxCommand::StoreFx(old_fx)))
                    }
                    Err(_) => {
                        // Create: inverse is delete
                        Some(Box::new(FxCommand::DeleteFx(fx.identifiers.id)))
                    }
                }
            }
            FxCommand::DeleteFx(id) => {
                // Capture full fx before deletion
                fx_provider.from_id(*id).ok().map(|fx_ref| {
                    let fx: Fx = (*fx_ref).clone();
                    Box::new(FxCommand::StoreFx(fx)) as Box<dyn UndoableOperation>
                })
            }
            FxCommand::RenameFx { id, new_id } => fx_provider.from_id(*id).ok().map(|_| {
                Box::new(FxCommand::RenameFx {
                    id: *new_id,
                    new_id: *id,
                }) as Box<dyn UndoableOperation>
            }),
        }
    }

    fn description(&self) -> String {
        match self {
            FxCommand::StoreFx(f) => format!("Store Fx {}", f.identifiers.id),
            FxCommand::DeleteFx(id) => format!("Delete Fx {}", id),
            FxCommand::RenameFx { id, new_id } => format!("Rename Fx {} → {}", id, new_id),
        }
    }
}

impl UndoableOperation for StepFxCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let stored = |predicate: &dyn Fn(&StepFx) -> bool| {
            ctx.world.iter_entities().find_map(|entity| {
                entity
                    .get::<StepFx>()
                    .filter(|step_fx| predicate(step_fx))
                    .cloned()
            })
        };

        match self {
            StepFxCommand::Create(step_fx) => {
                stored(&|existing| existing.identifiers.uid == step_fx.identifiers.uid)
                    .map(|existing| {
                        Box::new(StepFxCommand::Store(existing)) as Box<dyn UndoableOperation>
                    })
                    .or_else(|| {
                        stored(&|existing| existing.identifiers.id == step_fx.identifiers.id)
                            .is_none()
                            .then(|| {
                                Box::new(StepFxCommand::Delete(step_fx.identifiers.id))
                                    as Box<dyn UndoableOperation>
                            })
                    })
            }
            StepFxCommand::Store(step_fx) => {
                stored(&|existing| existing.identifiers.uid == step_fx.identifiers.uid)
                    .map(|existing| {
                        Box::new(StepFxCommand::Store(existing)) as Box<dyn UndoableOperation>
                    })
                    .or_else(|| {
                        stored(&|existing| existing.identifiers.id == step_fx.identifiers.id)
                            .is_none()
                            .then(|| {
                                Box::new(StepFxCommand::Delete(step_fx.identifiers.id))
                                    as Box<dyn UndoableOperation>
                            })
                    })
            }
            StepFxCommand::Delete(id) => {
                stored(&|existing| existing.identifiers.id == *id).map(|existing| {
                    Box::new(StepFxCommand::Store(existing)) as Box<dyn UndoableOperation>
                })
            }
            StepFxCommand::Start(_) | StepFxCommand::Stop(_) | StepFxCommand::SetRate { .. } => {
                None
            }
        }
    }

    fn description(&self) -> String {
        match self {
            StepFxCommand::Create(step_fx) => {
                format!("Create Step FX {}", step_fx.identifiers.id)
            }
            StepFxCommand::Store(step_fx) => {
                format!("Store Step FX {}", step_fx.identifiers.id)
            }
            StepFxCommand::Delete(id) => format!("Delete Step FX {id}"),
            StepFxCommand::Start(id) => format!("Start Step FX {id}"),
            StepFxCommand::Stop(id) => format!("Stop Step FX {id}"),
            StepFxCommand::SetRate { fx_id, rate } => {
                format!("Set Step FX {fx_id} rate to {rate}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::world::World;
    use uuid::Uuid;

    use super::*;

    /// Builds a definition with deterministic identity for undo snapshots.
    fn step_fx(id: u32, uid: u128, label: &str) -> StepFx {
        let mut step_fx = StepFx::default();
        step_fx.identifiers.id = id;
        step_fx.identifiers.uid = Uuid::from_u128(uid);
        step_fx.identifiers.label = label.to_owned();
        step_fx
    }

    /// Extracts a Step FX command from a boxed undo operation.
    fn inverse_step_fx_command(command: Box<dyn UndoableOperation>) -> StepFxCommand {
        *command
            .into_any()
            .downcast::<StepFxCommand>()
            .expect("inverse should remain in the Step FX domain")
    }

    /// Verifies a newly stored definition is undone through deletion.
    #[test]
    fn new_store_inverse_deletes_the_numeric_id() {
        let world = World::new();
        let inverse = StepFxCommand::Store(step_fx(4, 0x401, "New"))
            .inverse(&UndoContext { world: &world })
            .expect("new stores should be undoable");

        assert!(matches!(
            inverse_step_fx_command(inverse),
            StepFxCommand::Delete(4)
        ));
    }

    /// Verifies replacement snapshots the existing UID-owned definition.
    #[test]
    fn replacement_inverse_restores_the_previous_definition() {
        let mut world = World::new();
        world.spawn(step_fx(4, 0x402, "Before"));
        let inverse = StepFxCommand::Store(step_fx(9, 0x402, "After"))
            .inverse(&UndoContext { world: &world })
            .expect("replacement should capture an undo snapshot");

        let StepFxCommand::Store(restored) = inverse_step_fx_command(inverse) else {
            panic!("replacement undo should store the old definition");
        };
        assert_eq!(restored.identifiers.id, 4);
        assert_eq!(restored.identifiers.label, "Before");
    }

    /// Verifies numeric-ID collisions rejected by storage do not enter undo history.
    #[test]
    fn colliding_new_uid_store_has_no_inverse() {
        let mut world = World::new();
        world.spawn(step_fx(4, 0x403, "Existing"));

        assert!(
            StepFxCommand::Store(step_fx(4, 0x404, "Collision"))
                .inverse(&UndoContext { world: &world })
                .is_none()
        );
    }

    /// Verifies deletion captures the complete definition for restoration.
    #[test]
    fn delete_inverse_restores_the_deleted_definition() {
        let mut world = World::new();
        world.spawn(step_fx(4, 0x405, "Deleted"));
        let inverse = StepFxCommand::Delete(4)
            .inverse(&UndoContext { world: &world })
            .expect("stored definitions should be restorable after deletion");

        let StepFxCommand::Store(restored) = inverse_step_fx_command(inverse) else {
            panic!("delete undo should store the deleted definition");
        };
        assert_eq!(restored.identifiers.uid, Uuid::from_u128(0x405));
        assert_eq!(restored.identifiers.label, "Deleted");
    }
}
