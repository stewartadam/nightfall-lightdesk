// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timecode received from outside the engine.
//!
//! Input services decode MIDI timecode, Art-Net timecode, or linear timecode on their own threads
//! and publish each decoded frame to an [`ExternalTimecodeFeed`]. Timecode generators whose source
//! names that input read the latest frame from [`ExternalTimecodeFeeds`] on every render and chase
//! it.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bevy_ecs::prelude::*;
use web_time::Instant;

use crate::timecode::{TimecodeRate, TimecodeSource};

/// One timecode position decoded from an external source.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExternalTimecodeFrame {
    /// Position the sender reported, as time since 00:00:00:00.
    pub position: Duration,
    /// Frame rate the sender declared.
    pub rate: TimecodeRate,
    /// Whether the sender is playing. A locate, such as an MTC full-frame message, moves the
    /// position without playing.
    pub running: bool,
    /// When the input thread received the frame. Generators extrapolate from it, so the position
    /// moves smoothly between frames and stays accurate however late the engine reads it.
    pub received_at: Instant,
}

/// Shared slot an input thread writes decoded frames into.
///
/// Only the latest frame matters, so a frame overwrites the one before it instead of queueing,
/// and input threads never wake the engine for timecode.
#[derive(Clone, Default)]
pub struct ExternalTimecodeFeed(Arc<Mutex<Option<ExternalTimecodeFrame>>>);

impl ExternalTimecodeFeed {
    /// Replaces the latest frame with `frame`.
    pub fn publish(&self, frame: ExternalTimecodeFrame) {
        if let Ok(mut latest) = self.0.lock() {
            *latest = Some(frame);
        }
    }

    /// Returns the most recently published frame, if any arrived yet.
    pub fn latest(&self) -> Option<ExternalTimecodeFrame> {
        self.0.lock().ok().and_then(|latest| *latest)
    }
}

/// Feeds registered by the input plugins present in this engine, keyed by the source they read.
///
/// A source without a feed, such as MIDI timecode in the browser demo, never receives frames, so
/// timecodes following it wait for signal.
#[derive(Resource, Default)]
pub struct ExternalTimecodeFeeds(HashMap<TimecodeSource, ExternalTimecodeFeed>);

impl ExternalTimecodeFeeds {
    /// Makes `feed` the input for every timecode whose source is `source`.
    pub fn register(&mut self, source: TimecodeSource, feed: ExternalTimecodeFeed) {
        self.0.insert(source, feed);
    }

    /// Returns the latest frame received for `source`.
    pub fn latest(&self, source: TimecodeSource) -> Option<ExternalTimecodeFrame> {
        self.0.get(&source).and_then(ExternalTimecodeFeed::latest)
    }
}

/// An SMPTE time address (hours, minutes, seconds, frames) as external sources transmit it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmpteTime {
    /// Hours, 0-23.
    pub hours: u8,
    /// Minutes, 0-59.
    pub minutes: u8,
    /// Seconds, 0-59.
    pub seconds: u8,
    /// Frames within the second.
    pub frames: u8,
}

impl SmpteTime {
    /// Converts the address to elapsed real time at `rate`.
    ///
    /// 29.97 fps is treated as drop-frame, the only 29.97 variant MIDI timecode and Art-Net carry:
    /// its labels skip frames 0 and 1 at the start of every minute except each tenth, so the
    /// label stays close to wall-clock time. Other rates count every frame.
    pub fn to_duration(self, rate: TimecodeRate) -> Duration {
        let total_seconds =
            u64::from(self.hours) * 3600 + u64::from(self.minutes) * 60 + u64::from(self.seconds);
        match rate {
            TimecodeRate::Fps29_97 => {
                let total_minutes = u64::from(self.hours) * 60 + u64::from(self.minutes);
                let dropped = 2 * (total_minutes - total_minutes / 10);
                let frame_number =
                    (total_seconds * 30 + u64::from(self.frames)).saturating_sub(dropped);
                frames_to_duration(frame_number, rate)
            }
            _ => {
                Duration::from_secs(total_seconds)
                    + frames_to_duration(u64::from(self.frames), rate)
            }
        }
    }
}

/// Returns how long `frames` frames last at `rate`.
pub fn frames_to_duration(frames: u64, rate: TimecodeRate) -> Duration {
    let (numerator, denominator) = rate.frame_duration_ratio();
    Duration::from_nanos(frames * 1_000_000_000 * numerator / denominator)
}

/// How long after its last frame a running source still counts as receiving.
///
/// Covers MIDI timecode's two-frame updates at the slowest rate plus scheduling jitter.
pub const SIGNAL_TIMEOUT: Duration = Duration::from_millis(150);

/// How long after its last frame a running source keeps advancing on the engine clock before the
/// timecode holds its position.
pub const FREEWHEEL_DURATION: Duration = Duration::from_secs(1);

/// Backward correction below which a new frame is treated as jitter rather than a jump.
///
/// Extrapolating between frames can run slightly ahead of the next frame. Holding the position
/// until the source catches up keeps timelines from stepping backwards on every frame.
pub const JITTER_TOLERANCE: Duration = Duration::from_millis(100);

/// Difference between where a running external timecode moved and where the engine clock alone
/// would have put it, above which the move counts as a jump rather than clock drift or jitter.
pub const POSITION_JUMP_THRESHOLD: Duration = Duration::from_millis(250);

#[cfg(test)]
mod tests {
    use super::*;

    /// Non-drop rates add whole seconds and a fraction of a second per frame.
    #[test]
    fn non_drop_addresses_convert_exactly() {
        let time = SmpteTime {
            hours: 1,
            minutes: 2,
            seconds: 3,
            frames: 12,
        };
        assert_eq!(
            time.to_duration(TimecodeRate::Fps25),
            Duration::from_millis(3_723_480)
        );
        assert_eq!(
            time.to_duration(TimecodeRate::Fps24),
            Duration::from_millis(3_723_500)
        );
    }

    /// Drop-frame labels skip two frames per minute except each tenth minute, so one hour of
    /// labels is 107,892 frames, which lasts 3600 seconds give or take a few milliseconds.
    #[test]
    fn drop_frame_hour_stays_close_to_wall_clock() {
        let hour = SmpteTime {
            hours: 1,
            minutes: 0,
            seconds: 0,
            frames: 0,
        };
        assert_eq!(
            hour.to_duration(TimecodeRate::Fps29_97),
            frames_to_duration(107_892, TimecodeRate::Fps29_97)
        );
        let drift = hour
            .to_duration(TimecodeRate::Fps29_97)
            .abs_diff(Duration::from_secs(3600));
        assert!(drift < Duration::from_millis(5), "drift was {drift:?}");
    }

    /// The first label after a dropped pair counts from the frame number it replaces.
    #[test]
    fn drop_frame_minute_boundary_skips_two_labels() {
        let last_of_minute = SmpteTime {
            hours: 0,
            minutes: 0,
            seconds: 59,
            frames: 29,
        };
        let first_of_next = SmpteTime {
            hours: 0,
            minutes: 1,
            seconds: 0,
            frames: 2,
        };
        let gap = first_of_next.to_duration(TimecodeRate::Fps29_97)
            - last_of_minute.to_duration(TimecodeRate::Fps29_97);
        let one_frame = frames_to_duration(1, TimecodeRate::Fps29_97);
        assert!(
            gap.abs_diff(one_frame) < Duration::from_micros(1),
            "gap was {gap:?}"
        );
    }

    /// A feed returns only its newest frame.
    #[test]
    fn feed_keeps_latest_frame() {
        let feed = ExternalTimecodeFeed::default();
        assert!(feed.latest().is_none());
        let now = Instant::now();
        for millis in [10, 20] {
            feed.publish(ExternalTimecodeFrame {
                position: Duration::from_millis(millis),
                rate: TimecodeRate::Fps25,
                running: true,
                received_at: now,
            });
        }
        assert_eq!(
            feed.latest().map(|frame| frame.position),
            Some(Duration::from_millis(20))
        );
    }
}
