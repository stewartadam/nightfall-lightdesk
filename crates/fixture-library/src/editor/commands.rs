// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Wire contract of the fixture editor: commands, edits and their published results.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::view::{DraftInfo, FixtureDraftView};
use crate::commands::{FixtureLibraryEntry, GetFixtureProfileResponse};

/// Identifies one open fixture draft.
#[typeshare::typeshare]
pub type DraftId = u32;

/// Commands that open, edit and save fixture drafts.
///
/// Drafts are shared by every client: a draft opened in one window can be
/// listed, previewed and edited from any other.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FixtureEditorCommand {
    /// Opens a new draft and returns its view.
    OpenDraft {
        /// What the draft starts from.
        source: DraftSource,
    },
    /// Returns every open draft.
    ListDrafts,
    /// Applies one edit to a draft and returns its updated view.
    ///
    /// Fails with `fixture_editor.stale_draft` when `base_version` is given
    /// and the draft has changed since, so an edit made against an outdated
    /// view never lands on the wrong channel.
    EditDraft {
        /// Draft to edit.
        draft_id: DraftId,
        /// Draft version the edit's positions refer to.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_version: Option<u32>,
        /// Edit to apply.
        edit: DraftEdit,
    },
    /// Reverts a draft's most recent edit.
    UndoDraft {
        /// Draft to revert.
        draft_id: DraftId,
    },
    /// Reapplies a draft's most recently reverted edit.
    RedoDraft {
        /// Draft to reapply on.
        draft_id: DraftId,
    },
    /// Converts one mode of a draft into a preview fixture and geometry.
    PreviewDraft {
        /// Draft to preview.
        draft_id: DraftId,
        /// Mode to convert; the first mode when omitted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
    },
    /// Writes a draft into the user fixture library as a GDTF file.
    ///
    /// Fails with `fixture_editor.file_exists` when the file is already in
    /// the library and `overwrite` is not set, so clients can confirm first.
    SaveDraft {
        /// Draft to save.
        draft_id: DraftId,
        /// File name to save as; the draft's current file, or one derived
        /// from its manufacturer and name, when omitted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_name: Option<String>,
        /// Replace an existing library file with the same name.
        #[serde(default)]
        overwrite: bool,
        /// Note recorded in the saved file's revision history.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// Closes a draft without saving it.
    DiscardDraft {
        /// Draft to close.
        draft_id: DraftId,
    },
}

impl IngressCommand for FixtureEditorCommand {}

/// What a new draft starts from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum DraftSource {
    /// An empty profile with one mode and no channels.
    Blank,
    /// A ready-made generic fixture.
    Template(DraftTemplate),
    /// A copy of a library fixture saved under a new name.
    Duplicate(FixtureLibraryEntry),
    /// A library fixture whose file is overwritten on save.
    Edit(FixtureLibraryEntry),
}

/// Ready-made generic fixtures a draft can start from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum DraftTemplate {
    /// One dimmer channel.
    Dimmer,
    /// Red, green and blue channels.
    Rgb,
    /// Red, green, blue and white channels.
    Rgbw,
    /// Red, green, blue, amber, white and UV channels.
    Rgbawuv,
    /// Dimmer, RGB and strobe channels.
    DimmerRgbStrobe,
    /// 16-bit pan and tilt, dimmer, shutter and a color wheel.
    MovingHead,
}

/// Body shape a draft's geometry is built from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum BodyShape {
    /// A round wash or par can.
    Par,
    /// A long, narrow bar with one beam.
    Bar,
    /// A base, a yoke that pans and a head that tilts.
    MovingHead,
}

/// One edit applied to a draft.
///
/// Mode, channel, function, set, wheel and slot positions are list indices
/// in the draft's current view; function positions count across a channel's
/// logical channels in order. Adding, removing, moving or resizing a channel
/// moves only the addresses behind its slots, so gaps elsewhere in the
/// footprint stay as they are.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum DraftEdit {
    /// Replaces the fixture's names and description.
    SetInfo(DraftInfo),
    /// Replaces the fixture's geometry with a body shape and points every
    /// channel at the part it moves.
    SetBody(BodyShape),
    /// Adds a mode, empty or copied from an existing one.
    AddMode {
        /// Name of the new mode.
        name: String,
        /// Mode to copy channels from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        copy_of: Option<u32>,
    },
    /// Renames a mode.
    RenameMode {
        /// Mode to rename.
        mode: u32,
        /// New name.
        name: String,
    },
    /// Removes a mode.
    RemoveMode {
        /// Mode to remove.
        mode: u32,
    },
    /// Adds a channel for one attribute, with a single function over its whole range.
    AddChannel {
        /// Mode to add to.
        mode: u32,
        /// Position in the channel list; the end when omitted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<u32>,
        /// GDTF attribute name, e.g. `Dimmer` or `ColorAdd_R`.
        attribute: String,
        /// Bytes per value: 1 for 8-bit, 2 for 16-bit, up to 4.
        resolution: u8,
    },
    /// Removes a channel.
    RemoveChannel {
        /// Mode holding the channel.
        mode: u32,
        /// Channel to remove.
        channel: u32,
    },
    /// Moves a channel to another position in its mode.
    MoveChannel {
        /// Mode holding the channel.
        mode: u32,
        /// Current position.
        from: u32,
        /// New position.
        to: u32,
    },
    /// Changes how many bytes a channel uses, rescaling its DMX values.
    SetChannelResolution {
        /// Mode holding the channel.
        mode: u32,
        /// Channel to change.
        channel: u32,
        /// Bytes per value, from 1 to 4.
        resolution: u8,
    },
    /// Sets the DMX value a channel outputs while highlighted.
    SetChannelHighlight {
        /// Mode holding the channel.
        mode: u32,
        /// Channel to change.
        channel: u32,
        /// Highlight value at the channel's resolution; none to clear it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<u32>,
    },
    /// Adds a function to a channel, starting at a DMX value.
    AddFunction {
        /// Mode holding the channel.
        mode: u32,
        /// Channel to add to.
        channel: u32,
        /// Function values; its sets are ignored.
        function: DraftFunctionFields,
    },
    /// Replaces a function's name, attribute, range start, defaults and physical values.
    UpdateFunction {
        /// Mode holding the channel.
        mode: u32,
        /// Channel holding the function.
        channel: u32,
        /// Function to change.
        function: u32,
        /// New values.
        fields: DraftFunctionFields,
    },
    /// Removes a function from a channel; a channel keeps at least one.
    RemoveFunction {
        /// Mode holding the channel.
        mode: u32,
        /// Channel holding the function.
        channel: u32,
        /// Function to remove.
        function: u32,
    },
    /// Adds or replaces the named ranges of a function.
    SetFunctionSets {
        /// Mode holding the channel.
        mode: u32,
        /// Channel holding the function.
        channel: u32,
        /// Function to change.
        function: u32,
        /// Ranges in ascending DMX order.
        sets: Vec<DraftSetFields>,
    },
    /// Adds an empty wheel.
    AddWheel {
        /// Wheel name.
        name: String,
    },
    /// Renames a wheel and updates the functions that use it.
    RenameWheel {
        /// Wheel to rename.
        wheel: u32,
        /// New name.
        name: String,
    },
    /// Removes a wheel that no function uses.
    RemoveWheel {
        /// Wheel to remove.
        wheel: u32,
    },
    /// Replaces a wheel's slots; slots that stay at their position keep their images.
    SetWheelSlots {
        /// Wheel to change.
        wheel: u32,
        /// Slots in wheel order.
        slots: Vec<DraftSlotFields>,
    },
}

/// Editable values of a channel function.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftFunctionFields {
    /// Function name shown to operators.
    pub name: String,
    /// GDTF attribute the function controls.
    pub attribute: String,
    /// First DMX value of the function, at the channel's resolution.
    pub dmx_from: u32,
    /// DMX value the function rests at, at the channel's resolution.
    pub default: u32,
    /// Physical value at the start of the range.
    pub physical_from: f64,
    /// Physical value at the end of the range.
    pub physical_to: f64,
    /// Wheel whose slots the function selects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel: Option<String>,
}

/// Editable values of a named DMX range within a function.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftSetFields {
    /// Range name shown to operators, e.g. `Open` or `Red`.
    pub name: String,
    /// First DMX value of the range, at the channel's resolution.
    pub dmx_from: u32,
    /// Wheel slot the range selects, counted from 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel_slot: Option<i32>,
}

/// Editable values of one wheel slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftSlotFields {
    /// Slot name, e.g. `Open` or `Red`.
    pub name: String,
    /// Slot color as CIE 1931 x, y and luminance Y. When omitted, a slot
    /// that already exists at this position keeps its color or filter and a
    /// new slot is white.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<[f64; 3]>,
}

/// Preview of one draft mode, shaped like a library profile response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DraftPreviewResponse {
    /// Draft that was previewed.
    pub draft_id: DraftId,
    /// Converted fixture and geometry for the mode.
    pub profile: GetFixtureProfileResponse,
}

/// Wrapper for serializing fixture-editor broadcasts with the WebSocket wire format.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub(super) enum FixtureEditorWsMessage<'a> {
    /// A draft was opened or changed.
    FixtureDraftUpdated(&'a FixtureDraftView),
    /// A draft was closed.
    FixtureDraftClosed(DraftId),
}

/// Successful outcome of one fixture-editor command.
#[derive(Clone, Debug)]
pub enum FixtureEditorSuccess {
    /// The command applied without producing typed output.
    Applied,
    /// The command produced one draft view.
    Draft(Box<FixtureDraftView>),
    /// The command produced every open draft.
    Drafts(Vec<FixtureDraftView>),
    /// The command produced a preview.
    Preview(Box<DraftPreviewResponse>),
}

/// Domain-local outcome emitted after one fixture-editor command has applied.
#[derive(Clone, Debug, Message)]
pub struct FixtureEditorCommandResult {
    command_id: CommandId,
    result: Result<FixtureEditorSuccess, CommandError>,
}

impl FixtureEditorCommandResult {
    /// Pairs a command identity with the outcome its handler produced.
    pub fn new(command_id: CommandId, result: Result<FixtureEditorSuccess, CommandError>) -> Self {
        Self { command_id, result }
    }
}

/// Deserializes one fixture-editor command into its semantic envelope.
pub(super) fn deserialize_fixture_editor_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: FixtureEditorCommand = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse FixtureEditorCommand: {error}"))?;
    let envelope = world
        .resource::<CommandTracker>()
        .admitted_envelope(command_id, undo_id, command);
    world.write_message(envelope);
    Ok(())
}

/// Publishes terminal results for fixture-editor commands.
pub(super) fn finish_fixture_editor_commands(
    mut events: MessageReader<FixtureEditorCommandResult>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let response = match &event.result {
            Ok(FixtureEditorSuccess::Applied) => responder.succeed(event.command_id),
            Ok(FixtureEditorSuccess::Draft(view)) => {
                responder.succeed_with_output(event.command_id, view)
            }
            Ok(FixtureEditorSuccess::Drafts(views)) => {
                responder.succeed_with_output(event.command_id, views)
            }
            Ok(FixtureEditorSuccess::Preview(preview)) => {
                responder.succeed_with_output(event.command_id, preview)
            }
            Err(error) => responder.fail(event.command_id, error.clone()),
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "fixture_editor_command_completion_failed"
            );
        }
    }
}

/// Broadcasts a draft's current view to every connected client.
pub(super) fn publish_draft(broadcaster: &ClientEventSink, view: &FixtureDraftView) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureEditorWsMessage::FixtureDraftUpdated(view),
    );
}

/// Broadcasts that a draft was closed to every connected client.
pub(super) fn publish_draft_closed(broadcaster: &ClientEventSink, draft_id: DraftId) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureEditorWsMessage::FixtureDraftClosed(draft_id),
    );
}
