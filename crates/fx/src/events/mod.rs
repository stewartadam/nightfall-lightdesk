// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! FX command, playback, and editor preview event handling.

mod authoring;
mod commands;
mod continuity;
mod playback;
mod preview;
#[cfg(test)]
mod test_support;

pub use authoring::{crud_events, finish_step_fx_commands, handle_step_fx_commands};
pub use commands::{
    FxStepDraft, FxStepSequenceDraft, StepFxCommand, StepFxCommandResult, StepFxCommandValueSource,
    StepFxDraft,
};
pub use playback::{FxPlaybackAction, handle_events, handle_step_fx_playback_commands};
pub use preview::{
    FxPreviewUpdate, PreviewMaterializedFx, PreviewStepFxDefinition, PreviewStepFxPlayback,
    StepFxPreviewSessionId, StepFxPreviewUpdate, handle_preview_commands,
    handle_step_fx_preview_commands,
};
