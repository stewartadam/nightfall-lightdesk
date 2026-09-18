// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk-owned persistence integration for clip contracts.

pub(crate) use nightfall_clips::{Clip, ClipAction, ClipCommand, ClipSourceRef, MaterializedClip};

use crate::object_crud::ObjectCrud;

impl ObjectCrud for Clip {
    type Command = ClipCommand;

    /// Returns the stable object kind used in clip CRUD diagnostics.
    fn type_name() -> &'static str {
        "clip"
    }

    /// Extracts a persistent clip from a store command.
    fn extract_store(command: &Self::Command) -> Option<Self> {
        match command {
            ClipCommand::StoreClip(clip) => Some(clip.clone()),
            _ => None,
        }
    }

    /// Extracts existing and replacement IDs from a rename command.
    fn extract_rename(command: &Self::Command) -> Option<(u32, u32)> {
        match command {
            ClipCommand::RenameClip { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    /// Extracts the target ID from a delete command.
    fn extract_delete(command: &Self::Command) -> Option<u32> {
        match command {
            ClipCommand::DeleteClip(id) => Some(*id),
            _ => None,
        }
    }

    /// Replaces the clip's console-facing numeric ID.
    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}
