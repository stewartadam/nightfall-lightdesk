// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo inverses for park commands.

use nightfall_undo::prelude::*;

use crate::command::ParkCommand;
use crate::state::ParkedParameters;

impl Undoable for ParkCommand {
    /// Captures the whole parked set before the command changes it.
    ///
    /// A park captures each parameter's output at the moment it applies, which undo can't
    /// recompute, so every park command restores the full set it replaced. An unpark that
    /// can't change anything records no undo step, so undo never spends a step on a no-op.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
        let parked = ctx.world.get_resource::<ParkedParameters>()?;
        let changes_nothing = match self {
            ParkCommand::Park { .. } => false,
            ParkCommand::Unpark { .. } | ParkCommand::UnparkAll => parked.is_empty(),
            ParkCommand::UnparkParameters(keys) => {
                keys.iter().all(|key| parked.value(key).is_none())
            }
            ParkCommand::RestoreParked(entries) => {
                *parked == ParkedParameters::from_entries(entries.iter().cloned())
            }
        };
        if changes_nothing {
            return None;
        }
        Some(Box::new(ParkCommand::RestoreParked(parked.entries())))
    }

    /// Describes the change for the undo history.
    fn description(&self) -> String {
        match self {
            ParkCommand::Park { .. } => "Park".to_string(),
            ParkCommand::Unpark { .. } | ParkCommand::UnparkParameters(_) => "Unpark".to_string(),
            ParkCommand::UnparkAll => "Unpark All".to_string(),
            ParkCommand::RestoreParked(_) => "Restore Parked Parameters".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::*;
    use nightfall::prelude::FixtureRef;
    use nightfall_dmx::prelude::Attribute;
    use uuid::Uuid;

    use super::*;
    use crate::state::ParameterKey;

    /// Every park command inverts to restoring the parked set it was captured against.
    #[test]
    fn inverse_restores_previous_parked_set() {
        let mut parked = ParkedParameters::default();
        parked.park(
            ParameterKey {
                element: FixtureRef {
                    fixture_uid: Uuid::new_v4(),
                    index: Some(1),
                },
                attribute: Attribute::Intensity,
            },
            200.0,
        );
        let mut world = World::new();
        world.insert_resource(parked.clone());
        let ctx = UndoContext { world: &world };

        let inverse = ParkCommand::UnparkAll
            .inverse(&ctx)
            .expect("unpark all should be undoable")
            .into_any()
            .downcast::<ParkCommand>()
            .expect("inverse should be a park command");
        assert!(
            matches!(*inverse, ParkCommand::RestoreParked(entries) if entries == parked.entries())
        );
    }

    /// Unparking when nothing it names is parked records no undo step.
    #[test]
    fn unpark_without_parked_parameters_records_no_undo_step() {
        let mut world = World::new();
        world.insert_resource(ParkedParameters::default());
        let ctx = UndoContext { world: &world };

        assert!(ParkCommand::UnparkAll.inverse(&ctx).is_none());
        assert!(
            ParkCommand::Unpark {
                selection: None,
                attributes: Vec::new(),
            }
            .inverse(&ctx)
            .is_none()
        );
    }
}
