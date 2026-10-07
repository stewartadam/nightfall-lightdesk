// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Persisted action references for clip lifecycle actions.
//!
//! The desk registers the handlers for these action IDs; other domains only need to build
//! references to them, so the IDs and argument shapes live with the clip contracts.

use nightfall_actions::ActionReference;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Stable action ID for starting a clip.
pub const CLIP_START_ACTION_ID: &str = "clip.start";

/// Stable action ID for stopping a clip.
pub const CLIP_STOP_ACTION_ID: &str = "clip.stop";

/// Stable action ID for advancing a clip.
pub const CLIP_GO_ACTION_ID: &str = "clip.go";

/// Persisted clip target interpreted by desk-owned action registrations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ClipTarget {
    /// User-facing numeric clip identifier.
    Id(u32),
    /// Persistent clip UID.
    Uid(Uuid),
}

/// Persisted arguments shared by clip lifecycle actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipActionArguments {
    /// Clip addressed by the action.
    pub target: ClipTarget,
}

/// Creates a persisted start-clip action reference.
pub fn start_clip_action(target: ClipTarget) -> ActionReference {
    clip_action_reference(CLIP_START_ACTION_ID, target)
}

/// Creates a persisted stop-clip action reference.
pub fn stop_clip_action(target: ClipTarget) -> ActionReference {
    clip_action_reference(CLIP_STOP_ACTION_ID, target)
}

/// Creates a persisted go-clip action reference.
pub fn go_clip_action(target: ClipTarget) -> ActionReference {
    clip_action_reference(CLIP_GO_ACTION_ID, target)
}

/// Creates a clip lifecycle action reference with its typed target argument.
fn clip_action_reference(action_id: &str, target: ClipTarget) -> ActionReference {
    ActionReference::with_arguments(action_id, &ClipActionArguments { target })
        .expect("clip action arguments should serialize")
}
