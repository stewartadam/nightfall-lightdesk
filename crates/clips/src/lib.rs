// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clips and their playback.
//!
//! A clip is a playable reference to a sequence, FX, Step FX, flow, or FX module, with options
//! for how it plays. This crate defines the clip model, [`ClipCommand`], the bindable
//! clip actions, lookups by identifier, and the index from clips to their running instances.
//!
//! [`ClipsPlugin`] runs clip and instance commands, launch quantize, and the clocks of running
//! playbacks. It routes clip starts and stops to the playback plugin registered for each clip
//! source kind through [`ClipSourceAppExt`].
#![warn(missing_docs)]

mod actions;
pub mod ast_conv;
mod command;
mod instance_index;
pub mod launch_quantize;
mod lookup;
mod model;
pub mod playback;
mod source_reference;
mod source_routing;
mod undo;
pub mod websocket;

pub use actions::{
    CLIP_BACK_ACTION_ID, CLIP_GO_ACTION_ID, CLIP_GOTO_ACTION_ID, CLIP_LAUNCH_ARMED_ACTION_ID,
    CLIP_SET_SPEED_ACTION_ID, CLIP_START_ACTION_ID, CLIP_STOP_ACTION_ID, ClipActionArguments,
    ClipGotoActionArguments, ClipSpeedActionArguments, back_clip_action, clip_live_state,
    go_clip_action, goto_clip_action, register_clip_actions, set_clip_speed_action,
    start_clip_action, stop_clip_action,
};
pub use command::{ClipCommand, ClipOperation, clip_action_from_command};
pub use instance_index::{
    ClipReleaseAfterInstance, InstanceIndex, add_instances_to_index, remove_instances_from_index,
};
pub use lookup::{ClipLookup, ClipLookupError, ClipLookupSnapshot, log_clip_lookup_failure};
pub use model::{Clip, ClipOptions, ClipSourceRef, MaterializedClip, Source};
pub use playback::ClipsPlugin;
pub use source_reference::UnsupportedClipSource;
pub use source_routing::{
    ClipSourceAppExt, ClipSourceDomain, ClipSourceKind, ClipSourceOperation, ClipSourceRegistry,
    register_clip_source_routing,
};
pub use undo::{ClipSourceSnapshot, RestoreClipSource};
