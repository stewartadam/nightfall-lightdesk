// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared clip contracts and identifier lookup utilities.
#![warn(missing_docs)]

mod actions;
mod command;
mod instance_index;
mod lookup;
mod model;
mod source_reference;
mod undo;

pub use actions::{
    CLIP_BACK_ACTION_ID, CLIP_GO_ACTION_ID, CLIP_GOTO_ACTION_ID, CLIP_SET_RATE_ACTION_ID,
    CLIP_START_ACTION_ID, CLIP_STOP_ACTION_ID, ClipActionArguments, ClipGotoActionArguments,
    ClipRateActionArguments, back_clip_action, go_clip_action, goto_clip_action,
    set_clip_rate_action, start_clip_action, stop_clip_action,
};
pub use command::{ClipCommand, ClipOperation, clip_action_from_command};
pub use instance_index::{
    ClipReleaseAfterInstance, InstanceIndex, add_instances_to_index, remove_instances_from_index,
};
pub use lookup::{ClipLookup, ClipLookupError, ClipLookupSnapshot, log_clip_lookup_failure};
pub use model::{Clip, ClipOptions, ClipSourceRef, MaterializedClip, Source};
pub use source_reference::UnsupportedClipSource;
pub use undo::{ClipSourceSnapshot, RestoreClipSource};
