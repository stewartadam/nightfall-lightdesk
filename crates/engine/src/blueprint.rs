// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Blueprint command, action, and change contracts shared across domains.

use bevy_ecs::prelude::*;
use nightfall::prelude::Blueprint;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::prelude::*;

/// Describes a committed Blueprint definition mutation.
#[derive(Clone, Debug, Message)]
pub struct BlueprintDefinitionChange {
    /// Stable identity of the Blueprint that changed.
    pub uid: Uuid,
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
pub enum BlueprintOperation {
    /// Store or update a blueprint payload prepared by planner/runtime handlers.
    StoreBlueprint(Blueprint),
}

impl EngineOperation for BlueprintOperation {}
