// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo support for stored FX module management commands.

use nightfall_engine::prelude::*;
use nightfall_fx::prelude::{Fx, StepFx};
use nightfall_undo::prelude::*;

use crate::{FxModuleCommand, StoredFxModule, StoredFxModuleRequest};

/// Builds a complete store request that restores a stored module definition exactly.
pub(crate) fn restore_request(definition: &StoredFxModule) -> StoredFxModuleRequest {
    StoredFxModuleRequest {
        identifiers: definition.identifiers.clone(),
        module_name: definition.module_name.clone(),
        selection: Some(definition.selection.clone()),
        config: definition.config.clone(),
        merge: false,
    }
}

impl UndoableOperation for FxModuleCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let modules = ctx.world.resource::<DataProvider<StoredFxModule>>();

        match self {
            FxModuleCommand::StoreFxModule(request) => modules
                .from_id(request.identifiers.id)
                .ok()
                .or_else(|| modules.get(request.identifiers.uid).ok())
                .map(|definition| {
                    Box::new(FxModuleCommand::StoreFxModule(restore_request(&definition)))
                        as Box<dyn UndoableOperation>
                })
                .or_else(|| {
                    request.selection.as_ref().map(|_| {
                        Box::new(FxModuleCommand::DeleteFxModule(request.identifiers.id))
                            as Box<dyn UndoableOperation>
                    })
                }),
            FxModuleCommand::MoveFxModule { id, new_id }
                if modules.from_id(*id).is_ok()
                    && modules.from_id(*new_id).is_err()
                    && ctx
                        .world
                        .resource::<DataProvider<Fx>>()
                        .from_id(*new_id)
                        .is_err()
                    && !ctx.world.iter_entities().any(|entity| {
                        entity
                            .get::<StepFx>()
                            .is_some_and(|step_fx| step_fx.identifiers.id == *new_id)
                    }) =>
            {
                Some(Box::new(FxModuleCommand::MoveFxModule {
                    id: *new_id,
                    new_id: *id,
                }))
            }
            FxModuleCommand::DeleteFxModule(id) => modules.from_id(*id).ok().map(|definition| {
                Box::new(FxModuleCommand::RestoreDeletedFxModule(definition.clone()))
                    as Box<dyn UndoableOperation>
            }),
            FxModuleCommand::RestoreDeletedFxModule(definition)
                if modules.from_id(definition.identifiers.id).is_err()
                    && modules.get(definition.identifiers.uid).is_err() =>
            {
                Some(Box::new(FxModuleCommand::DeleteFxModule(
                    definition.identifiers.id,
                )))
            }
            FxModuleCommand::MoveFxModule { .. }
            | FxModuleCommand::RestoreDeletedFxModule(_)
            | FxModuleCommand::ControlFxModule(_)
            | FxModuleCommand::ListAvailableFxModules => None,
        }
    }

    fn description(&self) -> String {
        match self {
            FxModuleCommand::StoreFxModule(request) => {
                format!("Store Fx Module {}", request.identifiers.id)
            }
            FxModuleCommand::MoveFxModule { id, new_id } => {
                format!("Move Fx Module {} → {}", id, new_id)
            }
            FxModuleCommand::DeleteFxModule(id) => format!("Delete Fx Module {}", id),
            FxModuleCommand::RestoreDeletedFxModule(definition) => {
                format!("Restore Deleted Fx Module {}", definition.identifiers.id)
            }
            FxModuleCommand::ControlFxModule(_) => "Control Fx Module".to_string(),
            FxModuleCommand::ListAvailableFxModules => "List Available Fx Modules".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::World;
    use nightfall::prelude::{Identifiers, SpatialSelection};
    use uuid::Uuid;

    use super::*;

    /// Builds a complete module definition for inverse-capture tests.
    fn definition(id: u32, uid: Uuid) -> StoredFxModule {
        StoredFxModule {
            identifiers: Identifiers {
                id,
                uid,
                label: "Stored module".to_string(),
            },
            module_name: "stored-module".to_string(),
            selection: SpatialSelection::default(),
            config: Default::default(),
        }
    }

    /// Builds an isolated world containing the requested stored definitions.
    fn world_with_modules(definitions: impl IntoIterator<Item = StoredFxModule>) -> World {
        let mut provider = DataProvider::<StoredFxModule>::default();
        provider.extend(definitions);
        let mut world = World::new();
        world.insert_resource(provider);
        world.init_resource::<DataProvider<Fx>>();
        world
    }

    /// Verifies terminal updates with fresh UUIDs still restore the existing numeric-ID object.
    #[test]
    fn store_update_with_fresh_uid_captures_existing_definition() {
        let existing_uid = Uuid::from_u128(0x501);
        let world = world_with_modules([definition(6, existing_uid)]);
        let mut request = restore_request(&definition(6, Uuid::from_u128(0x502)));
        request.config.insert("speed".to_string(), "2".to_string());

        let inverse = FxModuleCommand::StoreFxModule(request)
            .inverse(&UndoContext { world: &world })
            .expect("valid update should capture an inverse");
        let restored = inverse
            .as_any()
            .downcast_ref::<FxModuleCommand>()
            .expect("inverse should remain in the module domain");
        let FxModuleCommand::StoreFxModule(restored_request) = restored else {
            panic!("module update should restore through a store command");
        };
        assert_eq!(restored_request.identifiers.uid, existing_uid);
    }

    /// Verifies an invalid selection-less create does not enter undo history.
    #[test]
    fn invalid_new_store_has_no_inverse() {
        let world = world_with_modules([]);
        let mut request = restore_request(&definition(6, Uuid::from_u128(0x503)));
        request.selection = None;

        assert!(
            FxModuleCommand::StoreFxModule(request)
                .inverse(&UndoContext { world: &world })
                .is_none()
        );
    }

    /// Verifies deletion restoration preflight fails after another UUID reuses the numeric ID.
    #[test]
    fn restore_deleted_module_conflict_has_no_inverse() {
        let deleted = definition(6, Uuid::from_u128(0x504));
        let world = world_with_modules([definition(6, Uuid::from_u128(0x505))]);

        assert!(
            FxModuleCommand::RestoreDeletedFxModule(deleted)
                .inverse(&UndoContext { world: &world })
                .is_none()
        );
    }

    /// Verifies move commands rejected by another FX domain never enter undo history.
    #[test]
    fn cross_domain_move_conflicts_have_no_inverse() {
        let mut world = world_with_modules([definition(6, Uuid::from_u128(0x506))]);
        world
            .resource_mut::<DataProvider<Fx>>()
            .add(Fx {
                identifiers: Identifiers {
                    id: 9,
                    uid: Uuid::from_u128(0x507),
                    label: "Regular destination".to_string(),
                },
                ..Default::default()
            })
            .expect("regular FX destination should insert cleanly");
        world.spawn(StepFx {
            identifiers: Identifiers {
                id: 10,
                uid: Uuid::from_u128(0x508),
                label: "Step destination".to_string(),
            },
            ..Default::default()
        });

        for new_id in [9, 10] {
            assert!(
                FxModuleCommand::MoveFxModule { id: 6, new_id }
                    .inverse(&UndoContext { world: &world })
                    .is_none()
            );
        }
    }
}
