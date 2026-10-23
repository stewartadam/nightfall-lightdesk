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
use uuid::Uuid;
use web_time::Instant;

use crate::timecode::{Timecode, TimecodeRate, TimecodeSource};

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

/// Feeds registered by the input plugins present in this engine.
///
/// Inputs shared by every timecode with a given source, such as MIDI timecode, register once for
/// that source. Inputs a timecode configures for itself, such as the audio channel LTC arrives on,
/// register for that timecode. A timecode without a feed, such as one following MIDI timecode in
/// the browser demo, never receives frames, so it waits for signal.
#[derive(Resource, Default)]
pub struct ExternalTimecodeFeeds {
    by_source: HashMap<TimecodeSource, ExternalTimecodeFeed>,
    by_timecode: HashMap<Uuid, (TimecodeSource, ExternalTimecodeFeed)>,
}

impl ExternalTimecodeFeeds {
    /// Makes `feed` the input for every timecode whose source is `source`.
    pub fn register(&mut self, source: TimecodeSource, feed: ExternalTimecodeFeed) {
        self.by_source.insert(source, feed);
    }

    /// Makes `feed` the input for the timecode `uid` while its source is `source`. It takes
    /// precedence over a feed registered for the whole source.
    pub fn register_timecode(
        &mut self,
        uid: Uuid,
        source: TimecodeSource,
        feed: ExternalTimecodeFeed,
    ) {
        self.by_timecode.insert(uid, (source, feed));
    }

    /// Removes the feed registered for the timecode `uid`, if any.
    pub fn unregister_timecode(&mut self, uid: Uuid) {
        self.by_timecode.remove(&uid);
    }

    /// Returns the latest frame received for `timecode`, from its own feed when one is registered
    /// for its current source, otherwise from its source's shared feed.
    pub fn latest(&self, timecode: &Timecode) -> Option<ExternalTimecodeFrame> {
        let own_feed = self
            .by_timecode
            .get(&timecode.identifiers.uid)
            .filter(|(source, _)| *source == timecode.source)
            .map(|(_, feed)| feed);
        own_feed
            .or_else(|| self.by_source.get(&timecode.source))
            .and_then(ExternalTimecodeFeed::latest)
    }
}

/// Largest forward step between consecutive frames still treated as playing rather than a jump.
pub const MAX_PLAYING_STEP: Duration = Duration::from_secs(1);

/// Infers whether a sender is playing, for sources whose frames carry no play state, such as
/// Art-Net timecode and LTC.
///
/// Such senders transmit a frame per frame while playing, and some keep repeating the parked
/// frame while stopped. A frame at most [`MAX_PLAYING_STEP`] ahead of the previous one counts as
/// playing; a repeated position, a backwards step, a long jump or the first frame is a locate.
#[derive(Debug, Default, Clone)]
pub struct PlayStateInference {
    previous: Option<Duration>,
}

impl PlayStateInference {
    /// Records the position of a newly received frame and returns whether the sender is playing.
    pub fn observe(&mut self, position: Duration) -> bool {
        let running = self
            .previous
            .is_some_and(|previous| position > previous && position - previous <= MAX_PLAYING_STEP);
        self.previous = Some(position);
        running
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

    /// Builds a frame at `seconds` for feed lookup tests.
    fn frame_at(seconds: u64) -> ExternalTimecodeFrame {
        ExternalTimecodeFrame {
            position: Duration::from_secs(seconds),
            rate: TimecodeRate::Fps25,
            running: true,
            received_at: Instant::now(),
        }
    }

    /// Builds a timecode following `source`.
    fn timecode_following(source: TimecodeSource) -> Timecode {
        Timecode {
            source,
            ..Timecode::default()
        }
    }

    /// Small forward steps count as playing; the first frame, repeats, backward steps and long
    /// jumps count as locates.
    #[test]
    fn play_state_inference_tells_playing_from_locating() {
        let mut inference = PlayStateInference::default();
        assert!(!inference.observe(Duration::from_secs(10)));
        assert!(inference.observe(Duration::from_millis(10_040)));
        assert!(!inference.observe(Duration::from_millis(10_040)));
        assert!(!inference.observe(Duration::from_secs(9)));
        assert!(!inference.observe(Duration::from_secs(60)));
        assert!(inference.observe(Duration::from_millis(60_040)));
    }

    /// A timecode's own feed wins over its source's shared feed, but only while the timecode
    /// still follows the source the feed was registered for.
    #[test]
    fn own_feed_takes_precedence_only_for_its_source() {
        let shared = ExternalTimecodeFeed::default();
        shared.publish(frame_at(1));
        let own = ExternalTimecodeFeed::default();
        own.publish(frame_at(2));
        let mut feeds = ExternalTimecodeFeeds::default();
        feeds.register(TimecodeSource::MidiMtc, shared);

        let mut timecode = timecode_following(TimecodeSource::SmpteLtc);
        assert_eq!(feeds.latest(&timecode), None);

        feeds.register_timecode(timecode.identifiers.uid, TimecodeSource::SmpteLtc, own);
        assert_eq!(
            feeds.latest(&timecode).map(|frame| frame.position),
            Some(Duration::from_secs(2))
        );

        timecode.source = TimecodeSource::MidiMtc;
        assert_eq!(
            feeds.latest(&timecode).map(|frame| frame.position),
            Some(Duration::from_secs(1))
        );

        timecode.source = TimecodeSource::SmpteLtc;
        feeds.unregister_timecode(timecode.identifiers.uid);
        assert_eq!(feeds.latest(&timecode), None);
    }

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
