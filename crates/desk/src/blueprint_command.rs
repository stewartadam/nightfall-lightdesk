// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Commands for blueprint CRUD operations

use std::collections::{HashMap, HashSet};

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fx::prelude::StepFx;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Describes a committed Blueprint definition mutation.
#[derive(Clone, Debug, Message)]
pub struct BlueprintDefinitionChange {
    /// Stable identity of the Blueprint that changed.
    pub uid: Uuid,
}

/// Tracks authored objects that currently contain live Blueprint references.
#[derive(Debug, Default, Resource)]
pub struct BlueprintReferenceIndex {
    references: HashMap<Uuid, HashSet<String>>,
}

impl BlueprintReferenceIndex {
    /// Replaces every dependency reported by one indexing subsystem.
    pub fn replace_source(
        &mut self,
        source: &str,
        references: impl IntoIterator<Item = (Uuid, String)>,
    ) {
        let prefix = format!("{source}:");
        self.references.retain(|_, dependents| {
            dependents.retain(|dependent| !dependent.starts_with(&prefix));
            !dependents.is_empty()
        });
        for (uid, dependent) in references {
            self.references
                .entry(uid)
                .or_default()
                .insert(format!("{prefix}{dependent}"));
        }
    }

    /// Returns sorted descriptions of objects that reference one Blueprint.
    pub fn dependents(&self, uid: Uuid) -> Vec<String> {
        let mut dependents = self
            .references
            .get(&uid)
            .into_iter()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        dependents.sort();
        dependents
    }

    /// Returns every indexed Blueprint dependency in stable UUID and description order.
    pub fn snapshot(&self) -> Vec<(Uuid, Vec<String>)> {
        let mut entries = self
            .references
            .keys()
            .copied()
            .map(|uid| (uid, self.dependents(uid)))
            .collect::<Vec<_>>();
        entries.sort_by_key(|(uid, _)| *uid);
        entries
    }
}

/// Rebuilds Step FX dependencies whenever a stored FX is added, changed, or removed.
pub fn rebuild_step_fx_blueprint_reference_index(
    step_fx: Query<&StepFx>,
    changed_step_fx: Query<(), Changed<StepFx>>,
    mut removed_step_fx: RemovedComponents<StepFx>,
    mut reference_index: ResMut<BlueprintReferenceIndex>,
) {
    let removed = removed_step_fx.read().next().is_some();
    if changed_step_fx.is_empty() && !removed {
        return;
    }

    let references = step_fx
        .iter()
        .flat_map(|fx| {
            fx.blueprint_references().map(move |(uid, attribute)| {
                (
                    uid,
                    format!(
                        "step FX {} ({}) {}",
                        fx.identifiers.id, fx.identifiers.label, attribute
                    ),
                )
            })
        })
        .collect::<Vec<_>>();
    reference_index.replace_source("step_fx", references);
}

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
pub enum BlueprintAction {
    /// Store or update a blueprint payload prepared by planner/runtime handlers.
    StoreBlueprint(Blueprint),
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use nightfall_fx::prelude::{CurveType, FxLane, FxStep, FxTrack, Linear};

    use super::*;

    /// Verifies Step FX references enter and leave the shared Blueprint dependency index.
    #[test]
    fn step_fx_blueprint_references_are_indexed() {
        let mut app = App::new();
        app.init_resource::<BlueprintReferenceIndex>();
        app.add_systems(Update, rebuild_step_fx_blueprint_reference_index);
        let blueprint_uid = Uuid::from_u128(0xb10e);
        let mut step_fx = StepFx::default();
        step_fx.identifiers = Identifiers {
            id: 4,
            uid: Uuid::from_u128(0xf004),
            label: "Pulse".to_owned(),
        };
        step_fx.lanes = vec![FxLane {
            attribute: Attribute::Red,
            timing_override: None,
            phase_override: None,
            absolute: Some(FxTrack {
                steps: vec![FxStep {
                    uid: Uuid::from_u128(0xf005),
                    target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                    blueprint_uid: Some(blueprint_uid),
                    width_beats: 1.0,
                    transition: 0.0.into(),
                    curve: CurveType::Linear(Linear {}),
                }],
            }),
            relative: None,
        }];
        let entity = app.world_mut().spawn(step_fx).id();

        app.update();
        assert_eq!(
            app.world()
                .resource::<BlueprintReferenceIndex>()
                .dependents(blueprint_uid),
            vec!["step_fx:step FX 4 (Pulse) Red".to_owned()]
        );

        app.world_mut().despawn(entity);
        app.update();
        assert!(
            app.world()
                .resource::<BlueprintReferenceIndex>()
                .dependents(blueprint_uid)
                .is_empty()
        );
    }
}

impl EngineAction for BlueprintAction {}

impl crate::object_crud::ObjectCrud for Blueprint {
    type Command = BlueprintCommand;

    fn type_name() -> &'static str {
        "blueprint"
    }

    fn extract_store(command: &Self::Command) -> Option<Self> {
        match command {
            BlueprintCommand::StoreBlueprint(blueprint) => Some(blueprint.clone()),
            _ => None,
        }
    }

    fn extract_rename(command: &Self::Command) -> Option<(u32, u32)> {
        match command {
            BlueprintCommand::RenameBlueprint { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    fn extract_delete(command: &Self::Command) -> Option<u32> {
        match command {
            BlueprintCommand::DeleteBlueprint(id) => Some(*id),
            _ => None,
        }
    }

    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}
