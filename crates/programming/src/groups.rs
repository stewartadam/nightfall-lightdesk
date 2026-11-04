// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Groups: stored fixture selections that other selections reference by number or name.
//!
//! Holds the group commands and operations, their undo support, and the CRUD handlers in
//! [`events`].

use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};

pub mod events;

/// Commands for group CRUD operations
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
pub enum GroupOperation {
    /// Store or update a group payload prepared by planner/runtime handlers.
    StoreGroup(Group),
}

impl EngineOperation for GroupOperation {}

impl ObjectCrud<GroupCommand> for Group {
    /// Returns the stable object kind used in group CRUD diagnostics.
    fn type_name() -> &'static str {
        "group"
    }

    /// Extracts the group to persist from a store command.
    fn extract_store(command: &GroupCommand) -> Option<Self> {
        match command {
            GroupCommand::StoreGroup(group) => Some(group.clone()),
            _ => None,
        }
    }

    /// Extracts the current and new numeric IDs from a rename command.
    fn extract_rename(command: &GroupCommand) -> Option<(u32, u32)> {
        match command {
            GroupCommand::RenameGroup { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    /// Extracts the numeric ID to remove from a delete command.
    fn extract_delete(command: &GroupCommand) -> Option<u32> {
        match command {
            GroupCommand::DeleteGroup(id) => Some(*id),
            _ => None,
        }
    }

    /// Gives the group its new numeric ID during a rename.
    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}

/// Builds the inverse of storing a Group: restore the prior definition, or delete a new one.
fn inverse_for_store_group(
    group: &Group,
    groups: &DataProvider<Group>,
) -> Option<Box<dyn Undoable>> {
    match groups.get(group.identifiers.uid) {
        Ok(existing) => {
            let old_group: Group = (*existing).clone();
            Some(Box::new(GroupCommand::StoreGroup(old_group)))
        }
        Err(_) => Some(Box::new(GroupCommand::DeleteGroup(group.identifiers.id))),
    }
}

impl Undoable for GroupCommand {
    /// Captures the Group state needed to reverse a store, rename, or delete.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
        let groups = ctx.world.resource::<DataProvider<Group>>();
        match self {
            GroupCommand::StoreGroup(group) => inverse_for_store_group(group, groups),
            GroupCommand::DeleteGroup(id) => {
                // Capture full group before deletion
                groups.from_id(*id).ok().map(|group_ref| {
                    let group: Group = (*group_ref).clone();
                    Box::new(GroupCommand::StoreGroup(group)) as Box<dyn Undoable>
                })
            }
            GroupCommand::RenameGroup { id, new_id } => Some(Box::new(GroupCommand::RenameGroup {
                id: *new_id,
                new_id: *id,
            })),
        }
    }

    /// Describes the Group mutation for the undo history.
    fn description(&self) -> String {
        match self {
            GroupCommand::StoreGroup(group) => format!("Store Group {}", group.identifiers.id),
            GroupCommand::DeleteGroup(id) => format!("Delete Group {}", id),
            GroupCommand::RenameGroup { id, new_id } => format!("Rename Group {} → {}", id, new_id),
        }
    }
}
