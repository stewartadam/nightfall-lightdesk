// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timecode data structures
use std::time::Duration;

use nightfall::prelude::*;
use serde::{Deserialize, Serialize};

/// Configuration for an internal timecode generator
// FIXME: consider replacing with vtc-rs but it lacks serde support
/// Timecode value with frame rate and frame count metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Timecode {
    /// Identifiers for the timecode
    pub identifiers: Identifiers,
    /// Timecode rate
    pub rate: TimecodeRate,
    /// Timecode source
    pub source: TimecodeSource,
}

impl Default for Timecode {
    fn default() -> Self {
        Self {
            identifiers: Identifiers::default(),
            rate: TimecodeRate::Fps30,
            source: TimecodeSource::Internal,
        }
    }
}

impl HasIdentifiers for Timecode {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

/// Timecode tick rate enum
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum TimecodeRate {
    /// NTSC standard (23.976 fps)
    Fps23_976,
    /// Cinema standard (24 FPS)
    Fps24,
    /// PAL standard (25 FPS)
    Fps25,
    /// NTSC standard (29.97 FPS)
    Fps29_97,
    /// 30 FPS
    Fps30,
    /// 60 FPS
    Fps60,
}

impl TimecodeRate {
    /// Returns one frame's length in seconds as a `(numerator, denominator)` pair, exact for the
    /// NTSC rates.
    pub fn frame_duration_ratio(self) -> (u64, u64) {
        match self {
            TimecodeRate::Fps23_976 => (1001, 24_000),
            TimecodeRate::Fps24 => (1, 24),
            TimecodeRate::Fps25 => (1, 25),
            TimecodeRate::Fps29_97 => (1001, 30_000),
            TimecodeRate::Fps30 => (1, 30),
            TimecodeRate::Fps60 => (1, 60),
        }
    }
}

/// Source for a timecode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum TimecodeSource {
    /// Timecode generated from an internal source
    // FIXME: return here to add correct references to the external sources
    Internal, // { generator_id: String },
    /// Extract timecode from MIDI MTC
    MidiMtc, // { midi_device_id: String },
    /// Extract timecode from a SMPTE LTC audio stream
    SmpteLtc, // { audio_device_id: String },
    /// Extract timecode from ArtNet network stream
    ArtNet, // { universe: u8, channel: u8 },
}

/// State of a timecode generator
// FIXME: move this into ECS as MaterializedTimecode?
/// Playback position, rate, and source status for a timecode clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimecodeState {
    /// The timecode slot ID the state is associated with
    pub timecode_id: u32,
    /// Whether the timecode is currently running. Inactive timecodes will not
    /// trigger events in the console.
    pub is_active: bool,
    /// The current position of the timecode, stored as a duration past the start time
    pub current_time: Duration,
    /// The start position that will mark this timecode as active
    // FIXME: this is presently unhandled
    pub start_time: Option<Duration>,
    /// Timecode position after which the timecode will automatically disable
    // FIXME: this is presently unhandled
    pub end_time: Option<Duration>,
    /// Whether an external source is armed and how its signal is doing.
    pub signal: TimecodeSignal,
    /// Frame rate the external source declared in its last frame, if one arrived since arming.
    pub source_rate: Option<TimecodeRate>,
}

impl TimecodeState {
    /// Returns the stopped, zeroed state of the timecode with slot `timecode_id`.
    pub fn new(timecode_id: u32) -> Self {
        Self {
            timecode_id,
            is_active: false,
            current_time: Duration::ZERO,
            start_time: None,
            end_time: None,
            signal: TimecodeSignal::Internal,
            source_rate: None,
        }
    }
}

/// How a timecode is following its source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum TimecodeSignal {
    /// The engine clock drives the timecode.
    Internal,
    /// The timecode has an external source but is not started, so it ignores the source.
    Off,
    /// The timecode is started and waits for its source to play. A locate from the source still
    /// moves the position.
    Waiting,
    /// The source is playing and frames are arriving.
    Receiving,
    /// Frames stopped arriving recently; the timecode keeps running on the engine clock until
    /// they return or the freewheel time runs out.
    Freewheeling,
}
