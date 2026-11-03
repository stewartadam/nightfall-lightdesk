// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Blueprint command and action contracts shared across domains.

use nightfall::prelude::Blueprint;
use serde::{Deserialize, Serialize};

use crate::prelude::*;

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
