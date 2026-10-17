// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk-side Blueprint persistence

use nightfall::prelude::*;
use nightfall_engine::prelude::*;

impl crate::object_crud::ObjectCrud<BlueprintCommand> for Blueprint {
    fn type_name() -> &'static str {
        "blueprint"
    }

    fn extract_store(command: &BlueprintCommand) -> Option<Self> {
        match command {
            BlueprintCommand::StoreBlueprint(blueprint) => Some(blueprint.clone()),
            _ => None,
        }
    }

    fn extract_rename(command: &BlueprintCommand) -> Option<(u32, u32)> {
        match command {
            BlueprintCommand::RenameBlueprint { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    fn extract_delete(command: &BlueprintCommand) -> Option<u32> {
        match command {
            BlueprintCommand::DeleteBlueprint(id) => Some(*id),
            _ => None,
        }
    }

    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}
