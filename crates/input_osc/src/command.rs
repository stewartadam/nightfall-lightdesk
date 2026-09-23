// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OSC command and state types.

use nightfall_actions::ActionReference;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// OSC timestamp value represented as NTP seconds plus fractional units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OscTime {
    /// Whole seconds since NTP epoch (1900-01-01).
    pub seconds: u32,
    /// Fractional part in 2^-32 units.
    pub fractional: u32,
}

/// OSC color value (RGBA).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OscColor {
    /// Red channel.
    pub red: u8,
    /// Green channel.
    pub green: u8,
    /// Blue channel.
    pub blue: u8,
    /// Alpha channel.
    pub alpha: u8,
}

/// OSC MIDI message payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OscMidiMessage {
    /// Port identifier.
    pub port: u8,
    /// Status byte.
    pub status: u8,
    /// First data byte.
    pub data1: u8,
    /// Second data byte.
    pub data2: u8,
}

/// OSC argument value captured from a decoded OSC message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum OscType {
    /// Integer OSC value.
    Int(i32),
    /// Floating-point OSC value.
    Float(f32),
    /// Double-precision floating-point OSC value.
    Double(f64),
    /// 64-bit integer OSC value (serialized as a string for TypeScript compatibility).
    Long(String),
    /// String OSC value.
    String(String),
    /// Binary OSC value.
    Blob(Vec<u8>),
    /// Timestamp OSC value.
    Time(OscTime),
    /// Character OSC value.
    Char(String),
    /// RGBA color OSC value.
    Color(OscColor),
    /// MIDI OSC value.
    Midi(OscMidiMessage),
    /// Boolean OSC value.
    Bool(bool),
    /// OSC array value.
    Array(Vec<OscType>),
    /// Nil OSC value.
    Nil,
    /// Infinitum OSC value.
    Inf,
}

impl OscType {
    /// Convert this OSC argument into a matching string.
    pub fn as_match_value(&self) -> String {
        match self {
            Self::Int(value) => value.to_string(),
            Self::Float(value) => value.to_string(),
            Self::Double(value) => value.to_string(),
            Self::Long(value) => value.clone(),
            Self::String(value) => value.clone(),
            Self::Blob(bytes) => {
                let mut value = String::from("0x");
                for byte in bytes {
                    value.push_str(&format!("{byte:02x}"));
                }
                value
            }
            Self::Time(time) => format!("{}:{}", time.seconds, time.fractional),
            Self::Char(value) => value.clone(),
            Self::Color(color) => format!(
                "{},{},{},{}",
                color.red, color.green, color.blue, color.alpha
            ),
            Self::Midi(message) => format!(
                "{},{},{},{}",
                message.port, message.status, message.data1, message.data2
            ),
            Self::Bool(value) => value.to_string(),
            Self::Array(values) => {
                let values = values
                    .iter()
                    .map(Self::as_match_value)
                    .collect::<Vec<_>>()
                    .join(",");
                format!("[{values}]")
            }
            Self::Nil => "nil".to_string(),
            Self::Inf => "inf".to_string(),
        }
    }

    /// Convert this OSC argument into a hardware fader percentage.
    pub fn as_hardware_fader_percent(&self) -> Option<f32> {
        let (value, normalize_unit_interval) = match self {
            Self::Int(value) => (*value as f64, false),
            Self::Float(value) => (f64::from(*value), true),
            Self::Double(value) => (*value, true),
            Self::Long(value) => (value.parse::<f64>().ok()?, false),
            Self::Bool(value) => {
                return Some(if *value { 100.0 } else { 0.0 });
            }
            _ => return None,
        };

        let normalized = if normalize_unit_interval && (0.0..=1.0).contains(&value) {
            value * 100.0
        } else {
            value
        };

        Some(normalized.clamp(0.0, 100.0) as f32)
    }
}

/// A mapping from OSC source/address/argument criteria to an action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OscMapping {
    /// Persistent binding identity, independent of its position in the editor.
    pub id: uuid::Uuid,
    /// Runtime interpretation of OSC arguments.
    pub input: OscBindingInput,
    /// Optional source address filter (`ip:port`).
    pub source: Option<String>,
    /// OSC address pattern to match (exact string match).
    pub address: String,
    /// Optional argument index to match against (defaults to 0 when `arg_value` is set).
    pub arg_index: Option<u8>,
    /// Optional argument value to match against.
    pub arg_value: Option<String>,
    /// Action to trigger when mapping criteria match.
    pub action: ActionReference,
}

/// Input conversion selected when binding an OSC control to a domain action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum OscBindingInput {
    /// Trigger on a false/zero to true/nonzero transition.
    Press,
    /// Trigger on a true/nonzero to false/zero transition.
    Release,
    /// Trigger once per message, for addresses that carry discrete pulses.
    Pulse,
    /// Convert an explicitly configured range into normalized domain input.
    Continuous {
        /// Source value corresponding to the destination minimum.
        minimum: f32,
        /// Source value corresponding to the destination maximum.
        maximum: f32,
    },
}

impl OscType {
    /// Reads a finite control value without guessing units or clamping source data.
    pub fn control_value(&self) -> Option<f32> {
        let value = match self {
            Self::Int(value) => *value as f32,
            Self::Float(value) => *value,
            Self::Double(value) => *value as f32,
            Self::Long(value) => value.parse().ok()?,
            Self::Bool(value) => {
                if *value {
                    1.0
                } else {
                    0.0
                }
            }
            _ => return None,
        };
        value.is_finite().then_some(value)
    }
}

/// Latest OSC event observed by the backend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OscLastEvent {
    /// Source socket address (`ip:port`).
    pub source: String,
    /// OSC address pattern.
    pub address: String,
    /// OSC argument payload.
    pub args: Vec<OscType>,
}

/// OSC listener status presented to the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OscListenerStatus {
    /// Whether the UDP listener is currently bound and receiving.
    pub is_listening: bool,
    /// Bound local IP address.
    pub bind_address: String,
    /// Bound UDP port.
    pub port: u16,
}

/// Metadata used by the UI to create or update command-line scrollback entries
/// for externally-triggered eval commands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, bevy_ecs::prelude::Message)]
#[typeshare::typeshare]
pub struct OscExternalEval {
    /// Correlation ID shared with the `DeskCommand::Eval` dispatch and final result.
    pub correlation_id: Uuid,
    /// Command string dispatched through `DeskCommand::Eval`.
    pub command: String,
    /// Human-readable source label shown in CommandLine.
    pub source: String,
}

/// Commands accepted by the OSC plugin.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum OscCommand {
    /// Creates or edits one binding without overwriting concurrent changes to other bindings.
    StoreMapping {
        /// Exact version being replaced, or none when creating a new binding.
        expected: Option<OscMapping>,
        /// Validated desired binding; edits must preserve its persistent identity.
        mapping: OscMapping,
    },
    /// Saves the backend-captured source with domain arguments and optional replacement.
    BindLearned {
        /// Owner of the capture session.
        session_id: uuid::Uuid,
        /// Destination selected in the UI.
        action: ActionReference,
        /// Previously read record, required for replacing an existing binding.
        replace: Option<OscMapping>,
        /// Argument used as the input value; defaults to the first argument.
        arg_index: Option<u8>,
        /// Optional explicit conversion; defaults to gesture-based trigger or unit scalar.
        input: Option<OscBindingInput>,
    },
    /// Deletes the exact record the user saw, rejecting stale edits.
    RemoveMapping {
        /// Expected existing binding.
        expected: OscMapping,
    },
    /// Replace all mappings.
    StoreMappings(Vec<OscMapping>),
    /// Delete mapping by index.
    DeleteMapping(u32),
}

impl IngressCommand for OscCommand {}

#[cfg(test)]
mod tests {
    use super::OscType;

    #[test]
    fn fader_percent_scales_normalized_float_values() {
        assert_eq!(OscType::Float(0.5).as_hardware_fader_percent(), Some(50.0));
        assert_eq!(
            OscType::Double(1.0).as_hardware_fader_percent(),
            Some(100.0)
        );
    }

    #[test]
    fn fader_percent_uses_percent_like_numeric_values_directly() {
        assert_eq!(OscType::Int(1).as_hardware_fader_percent(), Some(1.0));
        assert_eq!(OscType::Int(42).as_hardware_fader_percent(), Some(42.0));
        assert_eq!(
            OscType::Long("1".to_string()).as_hardware_fader_percent(),
            Some(1.0)
        );
        assert_eq!(
            OscType::Long("75".to_string()).as_hardware_fader_percent(),
            Some(75.0)
        );
    }

    #[test]
    fn fader_percent_clamps_and_rejects_non_numeric_values() {
        assert_eq!(
            OscType::Double(250.0).as_hardware_fader_percent(),
            Some(100.0)
        );
        assert_eq!(OscType::Int(-20).as_hardware_fader_percent(), Some(0.0));
        assert_eq!(
            OscType::String("nope".to_string()).as_hardware_fader_percent(),
            None
        );
    }
}
