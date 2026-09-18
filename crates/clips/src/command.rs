// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::engine::{EngineAction, EngineIngressMeta, EnginePayload, IngressCommand};
use nightfall::prelude::IdExpr;
use nightfall_instances::InstanceOptions;
use nightfall_playback_planner::PlaybackReconstructionTiming;
use serde::{Deserialize, Serialize};

use crate::{Clip, ClipOptions, ClipSourceRef, Source};

/// Commands for clip assignment, persistence, and runtime control.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ClipCommand {
    /// Assigns a resolved source to a clip.
    AssignSource {
        /// ID of the clip.
        clip_id: u32,
        /// Resolved source to assign.
        source: Source,
    },
    /// Resolves a source by numeric object ID and assigns it to a clip.
    AssignSourceById {
        /// ID of the clip.
        clip_id: u32,
        /// Source object to resolve and assign.
        source: ClipSourceRef,
    },
    /// Clears the source assignment from a clip.
    ClearSource(u32),
    /// Updates clip-local options.
    UpdateClipOptions {
        /// ID of the clip.
        clip_id: u32,
        /// Options to persist on the clip.
        options: ClipOptions,
    },
    /// Starts a clip and materializes its playback.
    StartClip(IdExpr),
    /// Starts a clip from a reconstruction timing seed.
    StartClipAtTiming {
        /// ID of the clip.
        clip_id: IdExpr,
        /// Source-local timing used to seed the materialized instance.
        timing: PlaybackReconstructionTiming,
        /// Optional playback behavior overrides supplied by the caller.
        #[serde(default)]
        instance_options: Option<InstanceOptions>,
    },
    /// Stops a clip and releases its attached playback.
    StopClip(IdExpr),
    /// Stops a clip from a release reconstruction timing seed.
    StopClipAtTiming {
        /// ID of the clip.
        clip_id: IdExpr,
        /// Playback-local timing used to anchor release.
        timing: PlaybackReconstructionTiming,
    },
    /// Advances attached playback, starting it first when necessary.
    GoClip(IdExpr),
    /// Moves attached playback backward.
    BackClip(IdExpr),
    /// Sets the rate multiplier for attached playback.
    SetRate {
        /// ID of the clip.
        clip_id: IdExpr,
        /// Playback clock rate multiplier.
        rate: f32,
    },
    /// Jumps sequence playback to a one-based cue position.
    GotoClip {
        /// ID of the clip.
        clip_id: IdExpr,
        /// One-based cue position.
        position: u32,
        /// Optional source-local timing used to seed the entered transition.
        timing: Option<PlaybackReconstructionTiming>,
    },
    /// Renders sequence playback at a planner-derived source-local position.
    RenderClipAt {
        /// ID of the clip.
        clip_id: IdExpr,
        /// One-based cue position.
        position: u32,
        /// Source-local timing used to seed the active cue and playback clock.
        timing: PlaybackReconstructionTiming,
        /// Optional playback behavior overrides supplied by the caller.
        #[serde(default)]
        instance_options: Option<InstanceOptions>,
    },
    /// Stores a clip record.
    StoreClip(Clip),
    /// Renames a clip's console-facing ID.
    RenameClip {
        /// Existing clip ID.
        id: u32,
        /// Replacement clip ID.
        new_id: u32,
    },
    /// Deletes a clip by console-facing ID.
    DeleteClip(u32),
}

impl EnginePayload for ClipCommand {}

impl EngineIngressMeta for ClipCommand {
    const COMMAND_MODULE: &'static str = "ClipCommand";
}

impl IngressCommand for ClipCommand {}

/// Concrete runtime actions applied to clip playback state.
#[derive(Debug, Clone)]
pub enum ClipAction {
    /// Starts a clip and creates or refreshes attached playback.
    Start(IdExpr),
    /// Starts a clip from a reconstruction timing seed.
    StartAtTiming {
        /// Clip selection to start.
        clip_id: IdExpr,
        /// Source-local timing used to seed playback.
        timing: PlaybackReconstructionTiming,
        /// Optional playback behavior supplied by the caller.
        instance_options: Option<InstanceOptions>,
    },
    /// Stops a clip and releases its attached playback.
    Stop(IdExpr),
    /// Stops a clip from a release reconstruction timing seed.
    StopAtTiming {
        /// Clip selection to stop.
        clip_id: IdExpr,
        /// Source-local timing used to anchor release.
        timing: PlaybackReconstructionTiming,
    },
    /// Advances a clip's attached playback.
    Go(IdExpr),
    /// Moves a clip's attached playback backward.
    Back(IdExpr),
    /// Sets the rate multiplier for attached playback.
    SetRate {
        /// Clip selection whose playback rate should change.
        clip_id: IdExpr,
        /// Playback clock rate multiplier.
        rate: f32,
    },
    /// Jumps sequence playback to a one-based cue position.
    Goto {
        /// Clip selection whose sequence should move.
        clip_id: IdExpr,
        /// One-based cue position.
        position: u32,
        /// Optional source-local transition timing.
        timing: Option<PlaybackReconstructionTiming>,
    },
    /// Renders sequence playback at a planner-derived position.
    RenderAt {
        /// Clip selection whose sequence should render.
        clip_id: IdExpr,
        /// One-based cue position.
        position: u32,
        /// Source-local reconstruction timing.
        timing: PlaybackReconstructionTiming,
        /// Optional playback behavior supplied by the caller.
        instance_options: Option<InstanceOptions>,
    },
}

impl EnginePayload for ClipAction {}

impl EngineIngressMeta for ClipAction {
    const COMMAND_MODULE: &'static str = "ClipAction";
}

impl EngineAction for ClipAction {}

/// Converts a user-facing clip command into concrete runtime work when applicable.
pub fn clip_action_from_command(command: &ClipCommand) -> Option<ClipAction> {
    match command {
        ClipCommand::StartClip(clip_id) => Some(ClipAction::Start(clip_id.clone())),
        ClipCommand::StartClipAtTiming {
            clip_id,
            timing,
            instance_options,
        } => Some(ClipAction::StartAtTiming {
            clip_id: clip_id.clone(),
            timing: *timing,
            instance_options: *instance_options,
        }),
        ClipCommand::StopClip(clip_id) => Some(ClipAction::Stop(clip_id.clone())),
        ClipCommand::StopClipAtTiming { clip_id, timing } => Some(ClipAction::StopAtTiming {
            clip_id: clip_id.clone(),
            timing: *timing,
        }),
        ClipCommand::GoClip(clip_id) => Some(ClipAction::Go(clip_id.clone())),
        ClipCommand::BackClip(clip_id) => Some(ClipAction::Back(clip_id.clone())),
        ClipCommand::SetRate { clip_id, rate } => Some(ClipAction::SetRate {
            clip_id: clip_id.clone(),
            rate: *rate,
        }),
        ClipCommand::GotoClip {
            clip_id,
            position,
            timing,
        } => Some(ClipAction::Goto {
            clip_id: clip_id.clone(),
            position: *position,
            timing: *timing,
        }),
        ClipCommand::RenderClipAt {
            clip_id,
            position,
            timing,
            instance_options,
        } => Some(ClipAction::RenderAt {
            clip_id: clip_id.clone(),
            position: *position,
            timing: *timing,
            instance_options: *instance_options,
        }),
        ClipCommand::AssignSource { .. }
        | ClipCommand::AssignSourceById { .. }
        | ClipCommand::ClearSource(_)
        | ClipCommand::UpdateClipOptions { .. }
        | ClipCommand::StoreClip(_)
        | ClipCommand::RenameClip { .. }
        | ClipCommand::DeleteClip(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies moving clip payloads does not change their engine routing names.
    #[test]
    fn preserves_clip_engine_module_names() {
        assert_eq!(ClipCommand::COMMAND_MODULE, "ClipCommand");
        assert_eq!(ClipAction::COMMAND_MODULE, "ClipAction");
    }
}
