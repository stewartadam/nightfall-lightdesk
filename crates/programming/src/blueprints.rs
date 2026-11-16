// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Blueprints: stored attribute values that programmer and cue content apply by reference or
//! by value.
//!
//! Holds the blueprint commands and operations, their undo support, and the CRUD handlers in
//! [`events`]. Applying programmer values to Blueprints and storing them from the programmer
//! are handled with the other programmer events in [`crate::events`].

use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};

pub mod events;

/// Commands for blueprint CRUD operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum BlueprintCommand {
    /// Store or update a blueprint
    StoreBlueprint(Blueprint),

    /// Rename a blueprint (change numeric ID)
    RenameBlueprint {
        /// ID of the blueprint
        id: u32,
        /// New ID for the blueprint
        new_id: u32,
    },
    /// Delete a blueprint by ID
    DeleteBlueprint(u32),
}

impl IngressCommand for BlueprintCommand {}

/// Runtime actions for blueprint operations derived from user command plans.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub enum BlueprintOperation {
    /// Store or update a blueprint payload prepared by planner/runtime handlers.
    StoreBlueprint(Blueprint),
}

impl EngineOperation for BlueprintOperation {}

impl ObjectCrud<BlueprintCommand> for Blueprint {
    /// Returns the stable object kind used in blueprint CRUD diagnostics.
    fn type_name() -> &'static str {
        "blueprint"
    }

    /// Extracts a persistent blueprint from a store command.
    fn extract_store(command: &BlueprintCommand) -> Option<Self> {
        match command {
            BlueprintCommand::StoreBlueprint(blueprint) => Some(blueprint.clone()),
            _ => None,
        }
    }

    /// Extracts existing and replacement IDs from a rename command.
    fn extract_rename(command: &BlueprintCommand) -> Option<(u32, u32)> {
        match command {
            BlueprintCommand::RenameBlueprint { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    /// Extracts the target ID from a delete command.
    fn extract_delete(command: &BlueprintCommand) -> Option<u32> {
        match command {
            BlueprintCommand::DeleteBlueprint(id) => Some(*id),
            _ => None,
        }
    }

    /// Replaces the blueprint's console-facing numeric ID.
    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}

/// Builds the inverse of storing a Blueprint: restore the prior definition, or delete a new one.
fn inverse_for_store_blueprint(
    blueprint: &Blueprint,
    blueprints: &DataProvider<Blueprint>,
) -> Option<Box<dyn Undoable>> {
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

impl Undoable for BlueprintCommand {
    /// Captures the Blueprint state needed to reverse a store, rename, or delete.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
        let blueprints = ctx.world.resource::<DataProvider<Blueprint>>();
        match self {
            BlueprintCommand::StoreBlueprint(blueprint) => {
                inverse_for_store_blueprint(blueprint, blueprints)
            }
            BlueprintCommand::DeleteBlueprint(id) => {
                // Capture full blueprint before deletion
                blueprints.from_id(*id).ok().map(|blueprint_ref| {
                    let blueprint: Blueprint = (*blueprint_ref).clone();
                    Box::new(BlueprintCommand::StoreBlueprint(blueprint)) as Box<dyn Undoable>
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

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::*;
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use uuid::Uuid;

    use super::*;

    /// Extracts a Blueprint command from a boxed undo command.
    fn inverse_blueprint_command(command: Box<dyn Undoable>) -> BlueprintCommand {
        *command
            .into_any()
            .downcast::<BlueprintCommand>()
            .expect("inverse should be a Blueprint command")
    }

    /// Verifies Blueprint edits undo to the previous UUID-backed logical definition.
    #[test]
    fn store_blueprint_inverse_restores_previous_definition() {
        let uid = Uuid::from_u128(30);
        let original = Blueprint {
            identifiers: Identifiers {
                id: 5,
                uid,
                label: "Before".to_owned(),
            },
            values: std::collections::HashMap::from([(
                Attribute::Red,
                ValueSource::Inline(ParameterValue::Absolute { value: 20.0 }),
            )]),
            ..Default::default()
        };
        let mut blueprints = DataProvider::<Blueprint>::default();
        blueprints
            .add(original.clone())
            .expect("original Blueprint should be insertable");
        let mut world = World::new();
        world.insert_resource(blueprints);
        let updated = Blueprint {
            identifiers: Identifiers {
                id: 50,
                uid,
                label: "After".to_owned(),
            },
            values: std::collections::HashMap::from([(
                Attribute::Red,
                ValueSource::Inline(ParameterValue::Absolute { value: 80.0 }),
            )]),
            ..Default::default()
        };

        let inverse = BlueprintCommand::StoreBlueprint(updated)
            .inverse(&UndoContext { world: &world })
            .expect("Blueprint update should be undoable");

        match inverse_blueprint_command(inverse) {
            BlueprintCommand::StoreBlueprint(snapshot) => {
                assert_eq!(snapshot.identifiers.uid, uid);
                assert_eq!(snapshot.identifiers.id, 5);
                assert_eq!(snapshot.identifiers.label, "Before");
                assert!(matches!(
                    snapshot.values.get(&Attribute::Red),
                    Some(ValueSource::Inline(ParameterValue::Absolute { value }))
                        if *value == 20.0
                ));
            }
            other => panic!("expected StoreBlueprint inverse, got {other:?}"),
        }
    }
}
