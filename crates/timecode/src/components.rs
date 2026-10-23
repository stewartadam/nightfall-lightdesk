// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timecode components
use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use web_time::Instant;

use crate::external::{
    ExternalTimecodeFrame, JITTER_TOLERANCE, POSITION_JUMP_THRESHOLD, SIGNAL_TIMEOUT,
};
use crate::prelude::*;
use crate::timecode::TimecodeSignal;

/// Component for an active timecode generator in the ECS
#[derive(Component, Debug, Clone)]
pub struct TimecodeGenerator {
    /// The timecode data
    pub timecode: Timecode,
    /// The timecode state
    pub state: TimecodeState,
    /// The accumulated time
    pub accumulated_time: Duration,
    /// When an external-source timecode was started, so frames received before it are ignored.
    /// `None` while it is paused or stopped, and always for internal timecodes.
    pub armed_at: Option<Instant>,
    /// Counts the times an external source moved the position while it kept running, such as a
    /// sender jumping to another cue mid-playback. Followers that play along on their own clock,
    /// like timeline audio, resync when it changes.
    pub position_jumps: u64,
}

impl Default for TimecodeGenerator {
    fn default() -> Self {
        Self::new(Timecode {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Default".to_string(),
            },
            rate: TimecodeRate::Fps30,
            source: TimecodeSource::Internal,
            freewheel: None,
            audio_input: None,
        })
    }
}

impl TimecodeGenerator {
    /// Create a new timecode generator
    pub fn new(timecode: Timecode) -> Self {
        let mut state = TimecodeState::new(timecode.identifiers.id);
        if timecode.source != TimecodeSource::Internal {
            state.signal = TimecodeSignal::Off;
        }

        Self {
            timecode,
            state,
            accumulated_time: Duration::ZERO,
            armed_at: None,
            position_jumps: 0,
        }
    }

    /// Returns whether the engine clock drives this timecode rather than an external source.
    pub fn is_internal(&self) -> bool {
        self.timecode.source == TimecodeSource::Internal
    }

    /// Returns whether the timecode was started and not since paused or stopped: an internal
    /// timecode that is running, or an external one armed to follow its source even while that
    /// source is silent.
    pub fn is_started(&self) -> bool {
        if self.is_internal() {
            self.state.is_active
        } else {
            self.armed_at.is_some()
        }
    }

    /// Starts an internal timecode, or arms an external one to follow its source.
    ///
    /// An armed timecode only runs while its source plays, so starting one whose source is
    /// silent leaves it waiting rather than running.
    pub fn start(&mut self) {
        if self.is_internal() {
            self.state.is_active = true;
        } else if self.armed_at.is_none() {
            self.armed_at = Some(Instant::now());
            self.state.signal = TimecodeSignal::Waiting;
        }
    }

    /// Pauses the timecode at its current position; an external timecode stops following its
    /// source.
    pub fn pause(&mut self) {
        self.state.is_active = false;
        self.disarm();
    }

    /// Stop the timecode generator
    pub fn stop(&mut self) {
        self.state.is_active = false;
        self.disarm();
        self.accumulated_time = Duration::ZERO;
        self.state.current_time = Duration::ZERO;
    }

    /// Stops an external timecode from following its source.
    fn disarm(&mut self) {
        self.armed_at = None;
        if !self.is_internal() {
            self.state.signal = TimecodeSignal::Off;
        }
    }

    /// Advances the timecode by `delta` of engine time, or chases `frame` when an external
    /// source drives it.
    pub fn advance(&mut self, delta: Duration, frame: Option<ExternalTimecodeFrame>, now: Instant) {
        if self.is_internal() {
            self.armed_at = None;
            self.state.signal = TimecodeSignal::Internal;
            self.state.source_rate = None;
            self.update(delta);
        } else {
            let was_running = self.state.is_active;
            let previous = self.state.current_time;
            self.follow(frame, now);
            let expected = previous + delta;
            let deviation = self.state.current_time.abs_diff(expected);
            if was_running && self.state.is_active && deviation > POSITION_JUMP_THRESHOLD {
                self.position_jumps += 1;
            }
        }
    }

    /// Moves the position to where the external source is now.
    ///
    /// While frames arrive, the position is the last frame plus the time since it arrived. When
    /// they stop, the timecode freewheels on the engine clock for the timecode's freewheel time,
    /// then returns to the last position received and holds it until the source plays again, so
    /// a stopped sender leaves the timecode where the sender stopped. A locate moves the position
    /// without running. Frames received before the timecode was started are ignored.
    pub fn follow(&mut self, frame: Option<ExternalTimecodeFrame>, now: Instant) {
        let Some(armed_at) = self.armed_at else {
            self.state.is_active = false;
            self.state.signal = TimecodeSignal::Off;
            return;
        };
        let Some(frame) = frame.filter(|frame| frame.received_at >= armed_at) else {
            self.state.is_active = false;
            self.state.signal = TimecodeSignal::Waiting;
            return;
        };
        self.state.source_rate = Some(frame.rate);

        let age = now.saturating_duration_since(frame.received_at);
        let (signal, position) = if !frame.running {
            (TimecodeSignal::Waiting, frame.position)
        } else if age <= SIGNAL_TIMEOUT {
            (TimecodeSignal::Receiving, frame.position + age)
        } else if age <= SIGNAL_TIMEOUT.saturating_add(self.timecode.freewheel()) {
            (TimecodeSignal::Freewheeling, frame.position + age)
        } else {
            (TimecodeSignal::Waiting, frame.position)
        };
        let running = matches!(
            signal,
            TimecodeSignal::Receiving | TimecodeSignal::Freewheeling
        );
        let jitter = self.state.current_time.saturating_sub(position);
        let position = if running
            && self.state.is_active
            && jitter > Duration::ZERO
            && jitter < JITTER_TOLERANCE
        {
            self.state.current_time
        } else {
            position
        };

        self.accumulated_time = position;
        self.state.current_time = position;
        self.state.is_active = running;
        self.state.signal = signal;
    }

    /// Seek the timecode generator to a specific time
    pub fn seek(&mut self, time: Duration) {
        self.accumulated_time = time;
        self.state.current_time = time;
    }

    /// Update the timecode generator based on elapsed time
    pub fn update(&mut self, delta: Duration) {
        if self.state.is_active {
            self.accumulated_time += delta;
            self.state.current_time = self.accumulated_time;

            // Check if we've reached the end time
            if let Some(end_time) = self.state.end_time
                && self.accumulated_time >= end_time
            {
                self.stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_timecode_generator() {
        let timecode = Timecode {
            identifiers: Identifiers {
                id: 2,
                uid: uuid::Uuid::new_v4(),
                label: "Test".to_string(),
            },
            rate: TimecodeRate::Fps24,
            source: TimecodeSource::Internal,
            freewheel: None,
            audio_input: None,
        };

        let generator = TimecodeGenerator::new(timecode.clone());

        assert_eq!(generator.timecode.identifiers.id, 2);
        assert_eq!(generator.timecode.identifiers.label, "Test");
        assert_eq!(generator.state.timecode_id, 2);
        assert!(!generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::ZERO);
        assert_eq!(generator.accumulated_time, Duration::ZERO);
    }

    #[test]
    fn test_start_stop() {
        let mut generator = TimecodeGenerator::default();

        // Test start
        generator.start();
        assert!(generator.state.is_active);

        // Test stop
        generator.stop();
        assert!(!generator.state.is_active);
        assert_eq!(generator.accumulated_time, Duration::ZERO);
        assert_eq!(generator.state.current_time, Duration::ZERO);
    }

    #[test]
    fn test_pause_resume() {
        let mut generator = TimecodeGenerator::default();

        generator.start();
        generator.update(Duration::from_millis(50));
        generator.pause();

        assert!(!generator.state.is_active);
        let paused_time = generator.accumulated_time;
        assert!(paused_time > Duration::ZERO);

        // Time should not advance while paused
        generator.update(Duration::from_millis(50));
        assert_eq!(generator.accumulated_time, paused_time);

        // Resume and check time advances
        generator.start();
        generator.update(Duration::from_millis(50));
        assert!(generator.accumulated_time > paused_time);
    }

    #[test]
    fn test_seek() {
        let mut generator = TimecodeGenerator::default();
        let target_time = Duration::from_secs(5);

        generator.seek(target_time);
        assert_eq!(generator.accumulated_time, target_time);
        assert_eq!(generator.state.current_time, target_time);
    }

    #[test]
    fn test_update_with_end_time() {
        let mut generator = TimecodeGenerator::default();
        let end_time = Duration::from_millis(100);
        generator.state.end_time = Some(end_time);

        generator.start();
        generator.update(Duration::from_millis(110));

        // Generator should have stopped automatically
        assert!(!generator.state.is_active);
        assert_eq!(generator.accumulated_time, Duration::ZERO);
        assert_eq!(generator.state.current_time, Duration::ZERO);
    }

    /// Builds a generator whose source is MIDI timecode.
    fn external_generator() -> TimecodeGenerator {
        TimecodeGenerator::new(Timecode {
            source: TimecodeSource::MidiMtc,
            ..Default::default()
        })
    }

    /// Builds a running frame at `position_ms` received at `received_at`.
    fn running_frame(position_ms: u64, received_at: Instant) -> ExternalTimecodeFrame {
        ExternalTimecodeFrame {
            position: Duration::from_millis(position_ms),
            rate: TimecodeRate::Fps25,
            running: true,
            received_at,
        }
    }

    /// An external timecode ignores the engine clock and its source until it is started.
    #[test]
    fn external_timecode_is_off_until_started() {
        let mut generator = external_generator();
        let now = Instant::now();
        generator.advance(
            Duration::from_millis(50),
            Some(running_frame(1000, now)),
            now,
        );
        assert_eq!(generator.state.signal, TimecodeSignal::Off);
        assert!(!generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::ZERO);
    }

    /// Starting arms the timecode, which waits until a frame arrives instead of running on the
    /// engine clock.
    #[test]
    fn started_external_timecode_waits_for_signal() {
        let mut generator = external_generator();
        generator.start();
        generator.advance(Duration::from_millis(50), None, Instant::now());
        assert_eq!(generator.state.signal, TimecodeSignal::Waiting);
        assert!(!generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::ZERO);
    }

    /// A running source moving the position by more than the engine clock explains counts as a
    /// jump; following it continuously does not.
    #[test]
    fn running_jump_counts_but_continuous_play_does_not() {
        let mut generator = external_generator();
        generator.start();
        let start = Instant::now();
        let step = Duration::from_millis(40);
        generator.advance(step, Some(running_frame(1000, start)), start);
        generator.advance(step, Some(running_frame(1040, start + step)), start + step);
        assert_eq!(generator.position_jumps, 0);

        generator.advance(
            step,
            Some(running_frame(5000, start + step * 2)),
            start + step * 2,
        );
        assert_eq!(generator.position_jumps, 1);
        assert!(generator.state.is_active);
    }

    /// While frames arrive the position is the frame plus the time since it arrived.
    #[test]
    fn receiving_extrapolates_from_last_frame() {
        let mut generator = external_generator();
        generator.start();
        let received_at = Instant::now();
        generator.follow(
            Some(running_frame(1000, received_at)),
            received_at + Duration::from_millis(40),
        );
        assert_eq!(generator.state.signal, TimecodeSignal::Receiving);
        assert!(generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::from_millis(1040));
        assert_eq!(generator.state.source_rate, Some(TimecodeRate::Fps25));
    }

    /// A timecode with no freewheel time stops as soon as the signal times out.
    #[test]
    fn zero_freewheel_stops_at_signal_timeout() {
        let mut generator = TimecodeGenerator::new(Timecode {
            source: TimecodeSource::SmpteLtc,
            freewheel: Some(Duration::ZERO),
            ..Default::default()
        });
        generator.start();
        let received_at = Instant::now();
        let frame = Some(running_frame(1000, received_at));
        generator.follow(
            frame,
            received_at + SIGNAL_TIMEOUT + Duration::from_millis(1),
        );
        assert_eq!(generator.state.signal, TimecodeSignal::Waiting);
        assert!(!generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::from_millis(1000));
    }

    /// After a dropout the timecode freewheels for its freewheel time, then returns to the last
    /// position received and stops running.
    #[test]
    fn dropout_freewheels_then_holds() {
        let mut generator = external_generator();
        generator.start();
        let received_at = Instant::now();
        let frame = Some(running_frame(1000, received_at));

        generator.follow(frame, received_at + Duration::from_millis(400));
        assert_eq!(generator.state.signal, TimecodeSignal::Freewheeling);
        assert!(generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::from_millis(1400));

        generator.follow(frame, received_at + Duration::from_secs(10));
        assert_eq!(generator.state.signal, TimecodeSignal::Waiting);
        assert!(!generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::from_millis(1000));
    }

    /// A new frame slightly behind the extrapolated position holds the position instead of
    /// stepping back, while a larger difference is applied as a jump.
    #[test]
    fn small_backward_corrections_hold_position() {
        let mut generator = external_generator();
        generator.start();
        let first = Instant::now();
        generator.follow(
            Some(running_frame(1000, first)),
            first + Duration::from_millis(60),
        );
        assert_eq!(generator.state.current_time, Duration::from_millis(1060));

        let second = first + Duration::from_millis(60);
        generator.follow(Some(running_frame(1040, second)), second);
        assert_eq!(generator.state.current_time, Duration::from_millis(1060));

        generator.follow(Some(running_frame(500, second)), second);
        assert_eq!(generator.state.current_time, Duration::from_millis(500));
    }

    /// A locate moves the position without running, and frames from before the timecode was
    /// started are ignored.
    #[test]
    fn locate_moves_without_running_and_stale_frames_are_ignored() {
        let mut generator = external_generator();
        let stale = Instant::now();
        generator.start();
        generator.follow(
            Some(running_frame(9000, stale - Duration::from_millis(1))),
            stale,
        );
        assert_eq!(generator.state.current_time, Duration::ZERO);

        let received_at = generator.armed_at.expect("started generator is armed");
        let locate = ExternalTimecodeFrame {
            running: false,
            ..running_frame(4000, received_at)
        };
        generator.follow(Some(locate), received_at + Duration::from_secs(5));
        assert_eq!(generator.state.signal, TimecodeSignal::Waiting);
        assert!(!generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::from_millis(4000));
    }

    /// Pausing stops following the source and keeps the position; stopping also resets it.
    #[test]
    fn pause_and_stop_disarm_external_timecode() {
        let mut generator = external_generator();
        generator.start();
        let received_at = generator.armed_at.expect("started generator is armed");
        let frame = Some(running_frame(2000, received_at));
        generator.follow(frame, received_at);
        generator.pause();
        generator.follow(frame, received_at + Duration::from_millis(100));
        assert_eq!(generator.state.signal, TimecodeSignal::Off);
        assert_eq!(generator.state.current_time, Duration::from_millis(2000));

        generator.stop();
        assert_eq!(generator.state.current_time, Duration::ZERO);
        assert!(generator.armed_at.is_none());
    }

    #[test]
    fn test_time_accumulation() {
        let mut generator = TimecodeGenerator::default();

        generator.start();
        generator.update(Duration::from_millis(50));

        let first_duration = generator.accumulated_time;
        assert!(first_duration > Duration::ZERO);

        generator.update(Duration::from_millis(50));

        assert!(generator.accumulated_time > first_duration);
    }
}
