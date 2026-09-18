// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo implementations for desk commands.

use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::blueprint_command::BlueprintCommand;
use crate::group_command::GroupCommand;
use crate::masters::{Master, MasterCommand};

// ============================================================================
// Master Commands
// ============================================================================

impl UndoableOperation for MasterCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let masters = ctx.world.resource::<DataProvider<Master>>();
        match self {
            MasterCommand::StoreMaster(master) => match masters.get(master.identifiers.uid) {
                Ok(existing) => Some(Box::new(MasterCommand::StoreMaster(existing.clone()))),
                Err(_) => Some(Box::new(MasterCommand::DeleteMaster(master.identifiers.id))),
            },
            MasterCommand::DeleteMaster(id) => masters.from_id(*id).ok().map(|master| {
                Box::new(MasterCommand::StoreMaster(master.clone())) as Box<dyn UndoableOperation>
            }),
            MasterCommand::RenameMaster { id, new_id } => {
                Some(Box::new(MasterCommand::RenameMaster {
                    id: *new_id,
                    new_id: *id,
                }))
            }
            MasterCommand::SetMasterLevel { id, .. } => masters.from_id(*id).ok().map(|master| {
                Box::new(MasterCommand::SetMasterLevel {
                    id: *id,
                    level_percent: master.level_percent,
                }) as Box<dyn UndoableOperation>
            }),
            MasterCommand::SetMasterMode { id, .. } | MasterCommand::ToggleMaster { id } => {
                masters.from_id(*id).ok().map(|master| {
                    Box::new(MasterCommand::SetMasterMode {
                        id: *id,
                        mode: master.mode.clone(),
                    }) as Box<dyn UndoableOperation>
                })
            }
        }
    }

    fn description(&self) -> String {
        match self {
            MasterCommand::StoreMaster(master) => format!("Store Master {}", master.identifiers.id),
            MasterCommand::RenameMaster { id, new_id } => {
                format!("Rename Master {} to {}", id, new_id)
            }
            MasterCommand::DeleteMaster(id) => format!("Delete Master {}", id),
            MasterCommand::SetMasterLevel { id, level_percent } => {
                format!("Set Master {} Level {}", id, level_percent)
            }
            MasterCommand::SetMasterMode { id, .. } => format!("Set Master {} Mode", id),
            MasterCommand::ToggleMaster { id } => format!("Toggle Master {}", id),
        }
    }
}

// ============================================================================
// Blueprint Commands
// ============================================================================

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

// ============================================================================
// Group Commands
// ============================================================================

fn inverse_for_store_group(
    group: &Group,
    groups: &DataProvider<Group>,
) -> Option<Box<dyn UndoableOperation>> {
    match groups.get(group.identifiers.uid) {
        Ok(existing) => {
            let old_group: Group = (*existing).clone();
            Some(Box::new(GroupCommand::StoreGroup(old_group)))
        }
        Err(_) => Some(Box::new(GroupCommand::DeleteGroup(group.identifiers.id))),
    }
}

impl UndoableOperation for GroupCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let groups = ctx.world.resource::<DataProvider<Group>>();
        match self {
            GroupCommand::StoreGroup(group) => inverse_for_store_group(group, groups),
            GroupCommand::DeleteGroup(id) => {
                // Capture full group before deletion
                groups.from_id(*id).ok().map(|group_ref| {
                    let group: Group = (*group_ref).clone();
                    Box::new(GroupCommand::StoreGroup(group)) as Box<dyn UndoableOperation>
                })
            }
            GroupCommand::RenameGroup { id, new_id } => Some(Box::new(GroupCommand::RenameGroup {
                id: *new_id,
                new_id: *id,
            })),
        }
    }

    fn description(&self) -> String {
        match self {
            GroupCommand::StoreGroup(group) => format!("Store Group {}", group.identifiers.id),
            GroupCommand::DeleteGroup(id) => format!("Delete Group {}", id),
            GroupCommand::RenameGroup { id, new_id } => format!("Rename Group {} → {}", id, new_id),
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::*;
    use nightfall_clips::{Clip, ClipCommand, ClipSourceRef, RestoreClipSource, Source};
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use uuid::Uuid;

    use super::*;

    /// Builds a minimal clip snapshot for undo tests.
    fn clip(id: u32, uid: Uuid, label: &str) -> Clip {
        Clip {
            identifiers: Identifiers {
                id,
                uid,
                label: label.to_string(),
            },
            ..Default::default()
        }
    }

    /// Extracts an clip command from a boxed undo command.
    fn inverse_clip_command(command: Box<dyn UndoableOperation>) -> ClipCommand {
        *command
            .into_any()
            .downcast::<ClipCommand>()
            .expect("inverse should be an clip command")
    }

    /// Extracts a Blueprint command from a boxed undo command.
    fn inverse_blueprint_command(command: Box<dyn UndoableOperation>) -> BlueprintCommand {
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

    /// Verifies store undo snapshots by UID after an earlier numeric rename.
    #[test]
    fn store_clip_inverse_uses_uid_after_numeric_id_changes() {
        let uid = Uuid::from_u128(10);
        let mut world = World::new();
        world.spawn(clip(10, uid, "Before"));
        let ctx = UndoContext { world: &world };

        let inverse = ClipCommand::StoreClip(clip(11, uid, "After"))
            .inverse(&ctx)
            .expect("store update should be undoable");

        match inverse_clip_command(inverse) {
            ClipCommand::StoreClip(snapshot) => {
                assert_eq!(snapshot.identifiers.id, 10);
                assert_eq!(snapshot.identifiers.uid, uid);
                assert_eq!(snapshot.identifiers.label, "Before");
            }
            other => panic!("expected StoreClip inverse, got {other:?}"),
        }
    }

    /// Verifies ID-based source assignment snapshots the source before resolution.
    #[test]
    fn assign_source_by_id_inverse_restores_previous_source() {
        let clip_uid = Uuid::from_u128(10);
        let previous_source_uid = Uuid::from_u128(20);
        let mut existing = clip(10, clip_uid, "Existing");
        existing.source = Some(Source::Fx(previous_source_uid));
        let mut world = World::new();
        world.spawn(existing);
        let ctx = UndoContext { world: &world };

        let inverse = ClipCommand::AssignSourceById {
            clip_id: 10,
            source: ClipSourceRef::Sequence(1),
        }
        .inverse(&ctx)
        .expect("ID-based source assignment should be undoable");

        let restore = inverse
            .into_any()
            .downcast::<RestoreClipSource>()
            .expect("inverse should restore the clip source");
        assert_eq!(restore.0.clip_id, 10);
        assert!(matches!(
            restore.0.source,
            Some(Source::Fx(uid)) if uid == previous_source_uid
        ));
    }

    /// Verifies rejected store collisions do not record destructive undo entries.
    #[test]
    fn store_clip_inverse_skips_numeric_id_collision_for_new_uid() {
        let mut world = World::new();
        world.spawn(clip(10, Uuid::from_u128(10), "Existing"));
        let ctx = UndoContext { world: &world };

        let inverse =
            ClipCommand::StoreClip(clip(10, Uuid::from_u128(11), "Colliding")).inverse(&ctx);

        assert!(inverse.is_none());
    }
}
