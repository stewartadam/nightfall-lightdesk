// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI command types for CRUD operations and runtime events

use nightfall_actions::ActionReference;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

/// A mapping from MIDI input to an action
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct MidiMapping {
    /// Name of the MIDI device this mapping applies to
    pub device_name: String,
    /// MIDI status byte (channel + message type, e.g., 144 for Note On channel 0)
    pub channel: u8,
    /// MIDI note or control number
    pub note: u8,
    /// Optional velocity filter (None = match any velocity)
    pub velocity: Option<u8>,
    /// Action to trigger when this mapping matches
    pub action: ActionReference,
}

/// MIDI event information sent to the UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct MidiLastEvent {
    /// Device that generated the event
    pub device: String,
    /// MIDI channel/status byte
    pub channel: u8,
    /// Note or control number
    pub note: u8,
    /// Velocity or control value
    pub velocity: u8,
}

/// Commands for MIDI operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum MidiCommand {
    /// Store/replace all mappings
    StoreMappings(Vec<MidiMapping>),
    /// Delete a mapping by index
    DeleteMapping(u32),
}

impl IngressCommand for MidiCommand {}
