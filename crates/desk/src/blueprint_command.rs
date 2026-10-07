// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk-side Blueprint persistence and Step FX dependency indexing

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fx::prelude::StepFx;

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

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use nightfall_fx::prelude::{CurveType, FxLane, FxStep, FxTrack, Linear};
    use uuid::Uuid;

    use super::*;

    /// Verifies Step FX references enter and leave the shared Blueprint dependency index.
    #[test]
    fn step_fx_blueprint_references_are_indexed() {
        let mut app = App::new();
        app.init_resource::<BlueprintReferenceIndex>();
        app.add_systems(Update, rebuild_step_fx_blueprint_reference_index);
        let blueprint_uid = Uuid::from_u128(0xb10e);
        let step_fx = StepFx {
            identifiers: Identifiers {
                id: 4,
                uid: Uuid::from_u128(0xf004),
                label: "Pulse".to_owned(),
            },
            lanes: vec![FxLane {
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
            }],
            ..Default::default()
        };
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
