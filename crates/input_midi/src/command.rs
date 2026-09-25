// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI command types for CRUD operations and runtime events

use nightfall_actions::{ActionReference, ControlBehavior, SourceSignal};
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One MIDI control on a device, independent of the value it currently sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum MidiSource {
    /// A key or pad sending note on/off, which acts as a button.
    Note {
        /// Zero-based MIDI channel (0-15).
        channel: u8,
        /// Note number.
        note: u8,
    },
    /// A continuous controller such as a fader, knob, or level-reporting button.
    ControlChange {
        /// Zero-based MIDI channel (0-15).
        channel: u8,
        /// Controller number.
        controller: u8,
    },
    /// A pitch bend wheel or 14-bit fader.
    PitchBend {
        /// Zero-based MIDI channel (0-15).
        channel: u8,
    },
}

impl MidiSource {
    /// Classifies a channel message into its control and the signal it carries.
    ///
    /// Returns `None` for message types that cannot drive actions, such as clock or sysex.
    pub fn classify(status: u8, data1: u8, data2: u8) -> Option<(Self, SourceSignal)> {
        let channel = status & 0x0F;
        match status & 0xF0 {
            0x80 => Some((
                Self::Note {
                    channel,
                    note: data1,
                },
                SourceSignal::Button(false),
            )),
            0x90 => Some((
                Self::Note {
                    channel,
                    note: data1,
                },
                SourceSignal::Button(data2 > 0),
            )),
            0xB0 => Some((
                Self::ControlChange {
                    channel,
                    controller: data1,
                },
                SourceSignal::Level(f32::from(data2) / 127.0),
            )),
            0xE0 => {
                let value = (u16::from(data2) << 7) | u16::from(data1);
                Some((
                    Self::PitchBend { channel },
                    SourceSignal::Level(f32::from(value) / 16_383.0),
                ))
            }
            _ => None,
        }
    }
}

/// A mapping from one MIDI control to a bindable action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct MidiMapping {
    /// Stable identity used to edit, replace, and delete the mapping.
    #[typeshare(serialized_as = "String")]
    pub id: Uuid,
    /// Name of the MIDI device this mapping applies to.
    pub device_name: String,
    /// Control on the device that drives the action.
    pub source: MidiSource,
    /// How the control's presses and releases invoke the action.
    #[serde(default)]
    pub behavior: ControlBehavior,
    /// Action invoked by the control.
    pub action: ActionReference,
}

/// MIDI event information sent to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct MidiLastEvent {
    /// Device that generated the event.
    pub device: String,
    /// MIDI status byte (message type and channel).
    pub channel: u8,
    /// Note or control number.
    pub note: u8,
    /// Velocity or control value.
    pub velocity: u8,
    /// Mappable control that sent the event, when the message type can drive actions.
    pub source: Option<MidiSource>,
}

/// Commands for MIDI mapping edits.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum MidiCommand {
    /// Create or replace a mapping; other mappings on the same control are removed.
    UpsertMapping(MidiMapping),
    /// Delete a mapping by its stable ID.
    DeleteMapping(#[typeshare(serialized_as = "String")] Uuid),
}

impl IngressCommand for MidiCommand {}
