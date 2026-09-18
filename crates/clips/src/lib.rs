// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared clip contracts and identifier lookup utilities.
#![warn(missing_docs)]

mod command;
mod lookup;
mod model;
mod source_reference;
mod undo;

pub use command::{ClipAction, ClipCommand, clip_action_from_command};
pub use lookup::{ClipLookup, ClipLookupError, ClipLookupSnapshot, log_clip_lookup_failure};
pub use model::{Clip, ClipOptions, ClipSourceRef, MaterializedClip, Source};
pub use source_reference::UnsupportedClipSource;
pub use undo::{ClipSourceSnapshot, RestoreClipSource};
