// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Exact channel snapshots and immutable rules shared across instances of a compiled mode.

use std::fmt;
use std::sync::Arc;

/// Raw behavior of a physical or virtual channel, independent of function selection and rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawChannelSpec {
    /// Significant byte width, including the declared precision of virtual channels.
    pub bytes: u8,
    /// Initial value in the channel's own precision.
    pub default: u32,
    /// Temporary highlight override; absence preserves the current value.
    pub highlight: Option<u32>,
    /// Whether the channel can receive physical DMX input.
    pub physical: bool,
}

/// Invalid raw metadata or snapshot update, with a channel index when one is responsible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelStateError {
    /// Stable error category for callers.
    pub code: &'static str,
    /// Definition-local channel index, absent for whole-snapshot errors.
    pub channel: Option<usize>,
    /// Explanation suitable for attaching fixture identity at the application boundary.
    pub message: String,
}

impl fmt::Display for ChannelStateError {
    /// Include the definition-local channel index when a specific channel caused rejection.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.channel {
            Some(channel) => write!(f, "{} at channel/{channel}: {}", self.code, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for ChannelStateError {}

/// Validated immutable channel rules, shared by fixture instances without exposing mutation.
#[derive(Debug)]
pub struct RawChannelLayout {
    channels: Vec<RawChannelSpec>,
}

impl RawChannelLayout {
    /// Reject unsupported precision and out-of-range defaults/highlights before publishing a layout.
    pub fn new(channels: Vec<RawChannelSpec>) -> Result<Self, ChannelStateError> {
        for (index, channel) in channels.iter().enumerate() {
            if !(1..=4).contains(&channel.bytes) {
                return Err(error(
                    "invalid_channel_width",
                    Some(index),
                    "Channel precision must be one to four bytes",
                ));
            }
            validate_value(channel, index, channel.default)?;
            if let Some(highlight) = channel.highlight {
                validate_value(channel, index, highlight)?;
            }
        }
        Ok(Self { channels })
    }

    /// Inspect validated rules in the same order as the compiled wire and function arrays.
    pub fn channels(&self) -> &[RawChannelSpec] {
        &self.channels
    }

    /// Create independent mutable values while sharing this layout with other instances.
    pub fn new_state(self: &Arc<Self>) -> RawChannelState {
        RawChannelState {
            layout: Arc::clone(self),
            values: self
                .channels
                .iter()
                .map(|channel| channel.default)
                .collect(),
        }
    }
}

/// One fixture's raw values before temporary highlight or semantic relation evaluation.
/// This does not replace compositor ownership, priority, release, or physical-function conversion.
#[derive(Debug, Clone)]
pub struct RawChannelState {
    layout: Arc<RawChannelLayout>,
    values: Vec<u32>,
}

impl RawChannelState {
    /// Inspect values without permitting unchecked mutations or loss of integer precision.
    pub fn values(&self) -> &[u32] {
        &self.values
    }

    /// Inspect the shared immutable channel rules for this state.
    pub fn layout(&self) -> &Arc<RawChannelLayout> {
        &self.layout
    }

    /// Apply an ordered batch atomically; repeated channel indices use the last value in the batch.
    pub fn set_many(&mut self, updates: &[(usize, u32)]) -> Result<(), ChannelStateError> {
        for &(index, value) in updates {
            let channel = self.layout.channels.get(index).ok_or_else(|| {
                error(
                    "invalid_channel_index",
                    Some(index),
                    "Channel does not exist in this mode",
                )
            })?;
            validate_value(channel, index, value)?;
        }
        for &(index, value) in updates {
            self.values[index] = value;
        }
        Ok(())
    }

    /// Apply decoded physical inputs atomically, preserving virtual channels and absent input values.
    /// Input must retain the full compiled channel ordering; virtual channels cannot receive wire data.
    pub fn apply_input(&mut self, input: &[Option<u32>]) -> Result<(), ChannelStateError> {
        if input.len() != self.values.len() {
            return Err(error(
                "channel_count_mismatch",
                None,
                "Input must retain every compiled channel position",
            ));
        }
        for (index, (channel, value)) in self.layout.channels.iter().zip(input).enumerate() {
            if let Some(value) = value {
                if !channel.physical {
                    return Err(error(
                        "virtual_channel_input",
                        Some(index),
                        "Virtual channels have no physical DMX input",
                    ));
                }
                validate_value(channel, index, *value)?;
            }
        }
        for (target, value) in self.values.iter_mut().zip(input) {
            if let Some(value) = value {
                *target = *value;
            }
        }
        Ok(())
    }

    /// Produce a temporary raw output snapshot without overwriting the fixture's underlying values.
    /// Channels without a declared highlight remain unchanged, including virtual channels.
    pub fn snapshot(&self, highlight: bool) -> Vec<u32> {
        self.values
            .iter()
            .zip(&self.layout.channels)
            .map(|(&value, channel)| {
                if highlight {
                    channel.highlight.unwrap_or(value)
                } else {
                    value
                }
            })
            .collect()
    }

    /// Restore authored defaults; this is an explicit reset, not compositor release semantics.
    pub fn reset(&mut self) {
        for (value, channel) in self.values.iter_mut().zip(&self.layout.channels) {
            *value = channel.default;
        }
    }
}

/// Validate values only after the layout constructor has checked byte precision.
fn validate_value(
    channel: &RawChannelSpec,
    index: usize,
    value: u32,
) -> Result<(), ChannelStateError> {
    let maximum = u32::MAX >> (32 - u32::from(channel.bytes) * 8);
    if value > maximum {
        return Err(error(
            "raw_value_out_of_range",
            Some(index),
            &format!("Value {value} exceeds the channel maximum {maximum}"),
        ));
    }
    Ok(())
}

/// Preserve structured context without coupling the DMX state to parser-specific errors.
fn error(code: &'static str, channel: Option<usize>, message: &str) -> ChannelStateError {
    ChannelStateError {
        code,
        channel,
        message: message.into(),
    }
}
