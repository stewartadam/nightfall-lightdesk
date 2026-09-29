// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo support for Blueprint CRUD commands.

use nightfall::prelude::Blueprint;
use nightfall_engine::prelude::*;

use crate::context::UndoContext;
use crate::traits::UndoableOperation;

/// Builds the inverse of storing a Blueprint: restore the prior definition, or delete a new one.
fn inverse_for_store_blueprint(
    blueprint: &Blueprint,
    blueprints: &DataProvider<Blueprint>,
) -> Option<Box<dyn UndoableOperation>> {
    match blueprints.get(blueprint.identifiers.uid) {
        Ok(existing) => {
            let old_blueprint: Blueprint = (*existing).clone();
            Some(Box::new(BlueprintCommand::StoreBlueprint(old_blueprint)))
        }
        Err(_) => Some(Box::new(BlueprintCommand::DeleteBlueprint(
            blueprint.identifiers.id,
        ))),
    }
}

impl UndoableOperation for BlueprintCommand {
    /// Captures the Blueprint state needed to reverse a store, rename, or delete.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let blueprints = ctx.world.resource::<DataProvider<Blueprint>>();
        match self {
            BlueprintCommand::StoreBlueprint(blueprint) => {
                inverse_for_store_blueprint(blueprint, blueprints)
            }
            BlueprintCommand::DeleteBlueprint(id) => {
                // Capture full blueprint before deletion
                blueprints.from_id(*id).ok().map(|blueprint_ref| {
                    let blueprint: Blueprint = (*blueprint_ref).clone();
                    Box::new(BlueprintCommand::StoreBlueprint(blueprint))
                        as Box<dyn UndoableOperation>
                })
            }
            BlueprintCommand::RenameBlueprint { id, new_id } => {
                Some(Box::new(BlueprintCommand::RenameBlueprint {
                    id: *new_id,
                    new_id: *id,
                }))
            }
        }
    }

    /// Describes the Blueprint mutation for the undo history.
    fn description(&self) -> String {
        match self {
            BlueprintCommand::StoreBlueprint(blueprint) => {
                format!("Store Blueprint {}", blueprint.identifiers.id)
            }
            BlueprintCommand::DeleteBlueprint(id) => format!("Delete Blueprint {}", id),
            BlueprintCommand::RenameBlueprint { id, new_id } => {
                format!("Rename Blueprint {} → {}", id, new_id)
            }
        }
    }
}
