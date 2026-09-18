// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Group management command types
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

/// Events related to group management
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum GroupCommand {
    /// Store or update a group
    StoreGroup(Group),

    /// Rename a group
    RenameGroup {
        /// ID of the group
        id: u32,
        /// New ID for the group
        new_id: u32,
    },

    /// Delete a group
    DeleteGroup(u32),
}

impl IngressCommand for GroupCommand {}

/// Runtime actions for group operations derived from user command plans.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub enum GroupAction {
    /// Store or update a group payload prepared by planner/runtime handlers.
    StoreGroup(Group),
}

impl EngineAction for GroupAction {}

impl crate::object_crud::ObjectCrud for Group {
    type Command = GroupCommand;

    fn type_name() -> &'static str {
        "group"
    }

    fn extract_store(command: &Self::Command) -> Option<Self> {
        match command {
            GroupCommand::StoreGroup(group) => Some(group.clone()),
            _ => None,
        }
    }

    fn extract_rename(command: &Self::Command) -> Option<(u32, u32)> {
        match command {
            GroupCommand::RenameGroup { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    fn extract_delete(command: &Self::Command) -> Option<u32> {
        match command {
            GroupCommand::DeleteGroup(id) => Some(*id),
            _ => None,
        }
    }

    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}
