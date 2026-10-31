// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo inverses for macro commands.

use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::command::MacroCommand;

impl Undoable for MacroCommand {
    /// Captures the command that restores the macro this command is about to change.
    ///
    /// Starting, releasing and stopping runs change no stored state, so they have no inverse;
    /// the statements a run executes record their own.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
        let macros = ctx.world.resource::<DataProvider<Macro>>();
        let inverse = match self {
            MacroCommand::StoreMacro(definition) => match macros.get(definition.identifiers.uid) {
                Ok(existing) => MacroCommand::StoreMacro(existing.clone()),
                Err(_) => MacroCommand::DeleteMacro(definition.identifiers.id),
            },
            MacroCommand::DeleteMacro(id) => {
                MacroCommand::StoreMacro(macros.from_id(*id).ok()?.clone())
            }
            MacroCommand::RenameMacro { id, new_id } => MacroCommand::RenameMacro {
                id: *new_id,
                new_id: *id,
            },
            MacroCommand::StartMacro(_)
            | MacroCommand::ReleaseMacro(_)
            | MacroCommand::StopMacro(_) => return None,
        };
        Some(Box::new(inverse))
    }

    /// Describes the edit for the undo history.
    fn description(&self) -> String {
        match self {
            MacroCommand::StoreMacro(definition) => {
                format!("Store Macro {}", definition.identifiers.id)
            }
            MacroCommand::RenameMacro { id, new_id } => format!("Rename Macro {id} to {new_id}"),
            MacroCommand::DeleteMacro(id) => format!("Delete Macro {id}"),
            MacroCommand::StartMacro(id) => format!("Start Macro {id}"),
            MacroCommand::ReleaseMacro(id) => format!("Release Macro {id}"),
            MacroCommand::StopMacro(id) => format!("Stop Macro {id}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::*;

    use super::*;

    /// Builds a world holding one macro.
    fn world_with_macro() -> (World, Macro) {
        let definition = Macro {
            identifiers: Identifiers {
                id: 3,
                label: "Blackout".to_string(),
                ..Default::default()
            },
            commands: "group 1 int 0".to_string(),
            ..Default::default()
        };
        let mut world = World::new();
        let mut macros = DataProvider::<Macro>::default();
        macros.add(definition.clone()).expect("macro should store");
        world.insert_resource(macros);
        (world, definition)
    }

    /// Downcasts an inverse back to a macro command for assertions.
    fn as_macro_command(inverse: Box<dyn Undoable>) -> MacroCommand {
        *inverse
            .into_any()
            .downcast::<MacroCommand>()
            .expect("inverse should be a macro command")
    }

    /// Editing restores the previous body, and deleting restores the whole macro.
    #[test]
    fn edits_and_deletes_restore_previous_macro() {
        let (world, definition) = world_with_macro();
        let ctx = UndoContext { world: &world };
        let edited = Macro {
            commands: "group 1 int 100".to_string(),
            ..definition.clone()
        };
        let inverse = as_macro_command(
            MacroCommand::StoreMacro(edited)
                .inverse(&ctx)
                .expect("inverse"),
        );
        assert!(matches!(inverse, MacroCommand::StoreMacro(restored) if restored == definition));

        let inverse =
            as_macro_command(MacroCommand::DeleteMacro(3).inverse(&ctx).expect("inverse"));
        assert!(matches!(inverse, MacroCommand::StoreMacro(restored) if restored == definition));
    }

    /// Creating a macro inverts to deleting it, and running one records nothing.
    #[test]
    fn creation_inverts_to_delete_and_runs_have_no_inverse() {
        let (world, _) = world_with_macro();
        let ctx = UndoContext { world: &world };
        let created = Macro {
            identifiers: Identifiers {
                id: 4,
                ..Default::default()
            },
            ..Default::default()
        };
        let inverse = as_macro_command(
            MacroCommand::StoreMacro(created)
                .inverse(&ctx)
                .expect("inverse"),
        );
        assert!(matches!(inverse, MacroCommand::DeleteMacro(4)));
        assert!(MacroCommand::StartMacro(3).inverse(&ctx).is_none());
        assert!(MacroCommand::ReleaseMacro(3).inverse(&ctx).is_none());
        assert!(MacroCommand::StopMacro(3).inverse(&ctx).is_none());
    }
}
