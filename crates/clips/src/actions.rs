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

/// Stable action ID for running a clip only while a control is held.
pub const CLIP_HOLD_ACTION_ID: &str = "clip.hold";

/// Stable action ID for moving a sequence clip back one cue.
pub const CLIP_BACK_ACTION_ID: &str = "clip.back";

/// Stable action ID for jumping a sequence clip to a cue.
pub const CLIP_GOTO_ACTION_ID: &str = "clip.goto";

/// Stable action ID for setting a clip's playback rate.
pub const CLIP_SET_RATE_ACTION_ID: &str = "clip.set-rate";

/// Persisted arguments shared by clip lifecycle actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipActionArguments {
    /// Persistent UID of the addressed clip.
    #[typeshare(serialized_as = "String")]
    pub clip: Uuid,
}

/// Persisted arguments for jumping a sequence clip to a cue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipGotoActionArguments {
    /// Persistent UID of the addressed clip.
    #[typeshare(serialized_as = "String")]
    pub clip: Uuid,
    /// One-based cue position to jump to.
    pub cue_index: u32,
}

/// Persisted arguments for setting a clip's playback rate.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipRateActionArguments {
    /// Persistent UID of the addressed clip.
    #[typeshare(serialized_as = "String")]
    pub clip: Uuid,
    /// Playback clock rate multiplier.
    pub rate: f32,
}

/// Creates a persisted start-clip action reference.
pub fn start_clip_action(clip: Uuid) -> ActionReference {
    clip_action_reference(CLIP_START_ACTION_ID, clip)
}

/// Creates a persisted stop-clip action reference.
pub fn stop_clip_action(clip: Uuid) -> ActionReference {
    clip_action_reference(CLIP_STOP_ACTION_ID, clip)
}

/// Creates a persisted go-clip action reference.
pub fn go_clip_action(clip: Uuid) -> ActionReference {
    clip_action_reference(CLIP_GO_ACTION_ID, clip)
}

/// Creates a persisted back-clip action reference.
pub fn back_clip_action(clip: Uuid) -> ActionReference {
    clip_action_reference(CLIP_BACK_ACTION_ID, clip)
}

/// Creates a persisted go-to-cue action reference.
pub fn goto_clip_action(clip: Uuid, cue_index: u32) -> ActionReference {
    ActionReference::with_arguments(
        CLIP_GOTO_ACTION_ID,
        &ClipGotoActionArguments { clip, cue_index },
    )
    .expect("clip goto arguments should serialize")
}

/// Creates a persisted clip-rate action reference.
pub fn set_clip_rate_action(clip: Uuid, rate: f32) -> ActionReference {
    ActionReference::with_arguments(
        CLIP_SET_RATE_ACTION_ID,
        &ClipRateActionArguments { clip, rate },
    )
    .expect("clip rate arguments should serialize")
}

/// Creates a clip lifecycle action reference with its typed clip argument.
fn clip_action_reference(action_id: &str, clip: Uuid) -> ActionReference {
    ActionReference::with_arguments(action_id, &ClipActionArguments { clip })
        .expect("clip action arguments should serialize")
}
