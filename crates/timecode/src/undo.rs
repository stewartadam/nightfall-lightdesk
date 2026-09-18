// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo implementations for timecode commands.

use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::prelude::*;
use crate::timecode::Timecode;

impl UndoableOperation for TimecodeCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let timecodes = ctx.world.resource::<DataProvider<Timecode>>();
        match self {
            // CRUD operations
            TimecodeCommand::StoreTimecode(timecode) => {
                // Check if this is update vs create
                match timecodes.get(timecode.identifiers.uid) {
                    Ok(existing) => {
                        // Update: restore old version
                        let old_timecode: Timecode = (*existing).clone();
                        Some(Box::new(TimecodeCommand::StoreTimecode(old_timecode)))
                    }
                    Err(_) => {
                        // Create: inverse is delete
                        Some(Box::new(TimecodeCommand::DeleteTimecode(
                            timecode.identifiers.id,
                        )))
                    }
                }
            }
            TimecodeCommand::DeleteTimecode(id) => {
                // Capture full timecode before deletion
                timecodes.from_id(*id).ok().map(|timecode_ref| {
                    let timecode: Timecode = (*timecode_ref).clone();
                    Box::new(TimecodeCommand::StoreTimecode(timecode)) as Box<dyn UndoableOperation>
                })
            }
            TimecodeCommand::RenameTimecode { id, new_id } => {
                Some(Box::new(TimecodeCommand::RenameTimecode {
                    id: *new_id,
                    new_id: *id,
                }))
            }

            // Runtime operations - not undoable
            // These control live playback state which is transient
            TimecodeCommand::StartTimecode(_)
            | TimecodeCommand::PauseTimecode(_)
            | TimecodeCommand::StopTimecode(_)
            | TimecodeCommand::SeekTimecode { .. } => None,
        }
    }

    fn description(&self) -> String {
        match self {
            TimecodeCommand::StoreTimecode(t) => format!("Store Timecode {}", t.identifiers.id),
            TimecodeCommand::DeleteTimecode(id) => format!("Delete Timecode {}", id),
            TimecodeCommand::RenameTimecode { id, new_id } => {
                format!("Rename Timecode {} → {}", id, new_id)
            }
            TimecodeCommand::StartTimecode(id) => format!("Start Timecode {}", id),
            TimecodeCommand::PauseTimecode(id) => format!("Pause Timecode {}", id),
            TimecodeCommand::StopTimecode(id) => format!("Stop Timecode {}", id),
            TimecodeCommand::SeekTimecode { id, position } => {
                format!("Seek Timecode {} to {:?}", id, position)
            }
        }
    }
}
