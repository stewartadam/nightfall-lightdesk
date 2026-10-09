// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Pure show-tempo model: a monotonic beat counter that eases toward tempo and phase targets.
//!
//! Every input (taps, resync, nudge, BPM changes) sets a target instead of moving the beat
//! counter directly. Tempo glides to its target over about one beat, and phase errors are
//! absorbed by briefly running faster or slower, so anything following the counter speeds up
//! or slows down slightly but never skips or restarts.

use serde::{Deserialize, Serialize};

/// Slowest tempo the engine accepts, in beats per minute.
pub const MIN_BPM: f64 = 20.0;
/// Fastest tempo the engine accepts, in beats per minute.
pub const MAX_BPM: f64 = 300.0;
/// Tempo used by a freshly created engine.
pub const DEFAULT_BPM: f64 = 120.0;
/// Beats per bar used by a freshly created engine.
pub const DEFAULT_BEATS_PER_BAR: u8 = 4;
/// Largest supported bar length.
pub const MAX_BEATS_PER_BAR: u8 = 16;

/// Largest share of nominal speed a phase correction may add or remove.
const MAX_CORRECTION_RATE: f64 = 0.25;
/// Smallest correction rate, so tiny phase errors still finish promptly.
const MIN_CORRECTION_RATE: f64 = 0.02;
/// Remaining phase error, in beats, below which a correction is complete.
const PHASE_EPSILON: f64 = 1e-6;
/// Tempo difference below which easing snaps to its target.
const BPM_EPSILON: f64 = 1e-3;
/// Idle time after which the next tap starts a new tap sequence on the downbeat.
const TAP_RESET_SECS: f64 = 2.0;
/// Relative deviation from the fitted interval that marks a tap as an outlier.
const TAP_OUTLIER_RATIO: f64 = 0.4;
/// Number of recent taps used to fit tempo and phase.
const TAP_HISTORY: usize = 8;

/// Read-only view of the tempo state at the last engine advance.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TempoSnapshot {
    /// Current, possibly still easing, tempo in beats per minute.
    pub bpm: f64,
    /// Tempo the engine is easing toward.
    pub target_bpm: f64,
    /// Number of beats in one bar.
    pub beats_per_bar: u8,
    /// Monotonic beat counter; whole numbers are beats and multiples of
    /// `beats_per_bar` are downbeats.
    pub beat_position: f64,
}

impl TempoSnapshot {
    /// Returns the zero-based beat index within the current bar.
    pub fn beat_in_bar(&self) -> u32 {
        (self.beat_position.floor() as u64 % u64::from(self.beats_per_bar.max(1))) as u32
    }

    /// Returns the zero-based index of the current bar.
    pub fn bar(&self) -> u64 {
        (self.beat_position / f64::from(self.beats_per_bar.max(1))).floor() as u64
    }

    /// Returns progress through the current beat in `0.0..1.0`.
    pub fn beat_phase(&self) -> f64 {
        self.beat_position.fract()
    }
}

/// Outcome of registering one tap with the [`TapTracker`].
#[derive(Clone, Copy, Debug, PartialEq)]
enum TapOutcome {
    /// The tap began a new sequence after an idle gap and marks the downbeat.
    Downbeat,
    /// The tap broke the rhythm of the sequence and restarted it without realigning.
    Restarted,
    /// The tap extended the sequence; carries the fitted beat interval in seconds and the
    /// tap's offset from the fitted line in seconds.
    Fitted {
        /// Fitted seconds per beat.
        interval: f64,
        /// Seconds the tap landed after the fitted beat time.
        residual: f64,
    },
}

/// Collects recent taps and fits a steady beat interval and phase to them.
#[derive(Clone, Debug, Default, PartialEq)]
struct TapTracker {
    /// Times of the taps in the current sequence, oldest first, in engine seconds.
    taps: Vec<f64>,
}

impl TapTracker {
    /// Records a tap and reports whether it starts, restarts or extends the sequence.
    fn tap(&mut self, now: f64) -> TapOutcome {
        let Some(&last) = self.taps.last() else {
            self.taps.push(now);
            return TapOutcome::Downbeat;
        };
        let gap = now - last;
        if !(0.0..=TAP_RESET_SECS).contains(&gap) {
            self.taps.clear();
            self.taps.push(now);
            return TapOutcome::Downbeat;
        }
        if let Some((interval, _)) = self.fit()
            && (gap - interval).abs() > interval * TAP_OUTLIER_RATIO
        {
            self.taps.clear();
            self.taps.push(now);
            return TapOutcome::Restarted;
        }

        self.taps.push(now);
        if self.taps.len() > TAP_HISTORY {
            self.taps.remove(0);
        }
        let (interval, intercept) = self
            .fit()
            .expect("a sequence with at least two taps always fits");
        let fitted_last = intercept + interval * (self.taps.len() - 1) as f64;
        TapOutcome::Fitted {
            interval,
            residual: now - fitted_last,
        }
    }

    /// Least-squares fit of tap time against tap index, returning `(interval, intercept)`.
    fn fit(&self) -> Option<(f64, f64)> {
        let count = self.taps.len();
        if count < 2 {
            return None;
        }
        let mean_index = (count - 1) as f64 / 2.0;
        let mean_time = self.taps.iter().sum::<f64>() / count as f64;
        let (covariance, variance) = self.taps.iter().enumerate().fold(
            (0.0, 0.0),
            |(covariance, variance), (index, time)| {
                let index_offset = index as f64 - mean_index;
                (
                    covariance + index_offset * (time - mean_time),
                    variance + index_offset * index_offset,
                )
            },
        );
        let interval = covariance / variance;
        (interval > 0.0).then_some((interval, mean_time - interval * mean_index))
    }
}

/// Show-wide tempo: a monotonic beat counter driven by an eased tempo and phase target.
///
/// Time is supplied by the caller as monotonic seconds, so the model is deterministic and
/// testable; the Bevy layer feeds it wall-clock time.
#[derive(Clone, Debug, PartialEq)]
pub struct TempoEngine {
    /// Current tempo in beats per minute.
    bpm: f64,
    /// Tempo that `bpm` is easing toward.
    target_bpm: f64,
    /// BPM change per beat while easing, chosen so a new target is reached in about one beat.
    bpm_slew: f64,
    /// Number of beats in one bar.
    beats_per_bar: u8,
    /// Monotonic beat counter at `last_time`.
    beat_position: f64,
    /// Phase error in beats still to be absorbed; positive runs ahead, negative holds back.
    pending_phase: f64,
    /// Share of nominal speed used to absorb `pending_phase`.
    correction_rate: f64,
    /// Engine time of the last advance, if the engine has advanced yet.
    last_time: Option<f64>,
    /// Recent taps used to fit tempo and phase.
    taps: TapTracker,
}

impl Default for TempoEngine {
    fn default() -> Self {
        Self {
            bpm: DEFAULT_BPM,
            target_bpm: DEFAULT_BPM,
            bpm_slew: 0.0,
            beats_per_bar: DEFAULT_BEATS_PER_BAR,
            beat_position: 0.0,
            pending_phase: 0.0,
            correction_rate: 0.0,
            last_time: None,
            taps: TapTracker::default(),
        }
    }
}

impl TempoEngine {
    /// Returns the tempo state as of the last advance.
    pub fn snapshot(&self) -> TempoSnapshot {
        TempoSnapshot {
            bpm: self.bpm,
            target_bpm: self.target_bpm,
            beats_per_bar: self.beats_per_bar,
            beat_position: self.beat_position,
        }
    }

    /// Returns whether tempo or phase is still easing toward a target.
    pub fn is_settling(&self) -> bool {
        self.pending_phase.abs() > PHASE_EPSILON || (self.target_bpm - self.bpm).abs() > BPM_EPSILON
    }

    /// Advances the beat counter to `now`, easing tempo and absorbing pending phase error.
    ///
    /// The counter never moves backwards: phase corrections are bounded to a fraction of the
    /// nominal advance, so every frame still moves forward at no less than three quarters of
    /// the current tempo. Times earlier than the previous advance are ignored.
    pub fn advance_to(&mut self, now: f64) {
        let Some(last_time) = self.last_time.replace(now) else {
            return;
        };
        let dt = now - last_time;
        if dt <= 0.0 {
            self.last_time = Some(last_time.max(now));
            return;
        }

        let tempo_error = self.target_bpm - self.bpm;
        let tempo_step = self.bpm_slew * dt * self.bpm / 60.0;
        if tempo_error.abs() <= tempo_step.max(BPM_EPSILON) {
            self.bpm = self.target_bpm;
        } else {
            self.bpm += tempo_step * tempo_error.signum();
        }

        let nominal = dt * self.bpm / 60.0;
        let correction = (nominal * self.correction_rate).min(self.pending_phase.abs())
            * self.pending_phase.signum();
        self.pending_phase -= correction;
        if self.pending_phase.abs() <= PHASE_EPSILON {
            self.pending_phase = 0.0;
        }
        self.beat_position += nominal + correction;
    }

    /// Sets the tempo target, clamped to the supported range; non-finite values are ignored.
    pub fn set_bpm(&mut self, bpm: f64) {
        if bpm.is_finite() {
            self.target_bpm = bpm.clamp(MIN_BPM, MAX_BPM);
            self.bpm_slew = (self.target_bpm - self.bpm).abs();
        }
    }

    /// Multiplies the tempo target, e.g. `2.0` for double time and `0.5` for half time.
    pub fn multiply(&mut self, factor: f64) {
        if factor.is_finite() && factor > 0.0 {
            self.set_bpm(self.target_bpm * factor);
        }
    }

    /// Sets the number of beats per bar, clamped to `1..=MAX_BEATS_PER_BAR`.
    pub fn set_beats_per_bar(&mut self, beats_per_bar: u8) {
        self.beats_per_bar = beats_per_bar.clamp(1, MAX_BEATS_PER_BAR);
    }

    /// Shifts the phase by a signed number of beats, eased like any other correction.
    pub fn nudge(&mut self, beats: f64) {
        if beats.is_finite() {
            self.add_phase_correction(beats);
        }
    }

    /// Eases the phase so that `now` becomes the nearest downbeat.
    pub fn resync(&mut self, now: f64) {
        self.align(now, 0.0, f64::from(self.beats_per_bar));
    }

    /// Jumps forward to the next downbeat at `now`, discarding any pending correction.
    ///
    /// This is the one operation that moves the counter discontinuously; it only ever moves
    /// forward, by at most one bar.
    pub fn snap(&mut self, now: f64) {
        let bar = f64::from(self.beats_per_bar);
        let elapsed = self.beats_since_advance(now);
        let next_downbeat = ((self.beat_position + elapsed) / bar).ceil() * bar;
        self.beat_position = (next_downbeat - elapsed).max(self.beat_position);
        self.pending_phase = 0.0;
    }

    /// Registers a tap at `now`, updating the tempo target and easing the phase onto the taps.
    ///
    /// The first tap after an idle gap marks the downbeat. Later taps fit a steady interval to
    /// the recent taps and align the nearest beat to the fitted line. A tap that breaks the
    /// rhythm restarts the sequence without moving anything.
    pub fn tap(&mut self, now: f64) {
        match self.taps.tap(now) {
            TapOutcome::Downbeat => self.resync(now),
            TapOutcome::Restarted => {}
            TapOutcome::Fitted { interval, residual } => {
                self.set_bpm(60.0 / interval);
                self.align(now, residual / interval, 1.0);
            }
        }
    }

    /// Beats elapsed between the last advance and `now` at the current tempo.
    fn beats_since_advance(&self, now: f64) -> f64 {
        self.last_time
            .map_or(0.0, |last| (now - last).max(0.0) * self.bpm / 60.0)
    }

    /// Eases the phase so that, at `now`, the counter sits at `offset` modulo `modulus`,
    /// correcting the shorter way round.
    fn align(&mut self, now: f64, offset: f64, modulus: f64) {
        let effective = self.beat_position + self.beats_since_advance(now) + self.pending_phase;
        let mut error = (offset - effective).rem_euclid(modulus);
        if error > modulus / 2.0 {
            error -= modulus;
        }
        self.add_phase_correction(error);
    }

    /// Adds phase error to absorb and picks a rate that spreads it over about one bar.
    fn add_phase_correction(&mut self, beats: f64) {
        self.pending_phase += beats;
        self.correction_rate = (self.pending_phase.abs() / f64::from(self.beats_per_bar))
            .clamp(MIN_CORRECTION_RATE, MAX_CORRECTION_RATE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frame interval used to drive the engine in tests (60 FPS).
    const FRAME: f64 = 1.0 / 60.0;

    /// Advances the engine frame by frame from `from` to `to`, asserting the counter never
    /// moves backwards or below three quarters of nominal speed, and returns the end time.
    fn run(engine: &mut TempoEngine, from: f64, to: f64) -> f64 {
        let mut now = from;
        while now + FRAME <= to + 1e-9 {
            let before = engine.snapshot();
            now += FRAME;
            engine.advance_to(now);
            let after = engine.snapshot();
            let step = after.beat_position - before.beat_position;
            let slowest = FRAME * before.bpm.min(after.bpm) / 60.0 * (1.0 - MAX_CORRECTION_RATE);
            assert!(
                step >= slowest - 1e-9,
                "beat counter advanced {step} < {slowest} at t={now}"
            );
        }
        now
    }

    /// Returns the signed distance in beats from `position` to the nearest multiple of `modulus`.
    fn distance_to_grid(position: f64, modulus: f64) -> f64 {
        let offset = position.rem_euclid(modulus);
        offset.min(modulus - offset)
    }

    /// Verifies a steady engine counts beats at its tempo.
    #[test]
    fn advance_counts_beats_at_tempo() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        run(&mut engine, 0.0, 2.0);
        assert!((engine.snapshot().beat_position - 4.0).abs() < 1e-6);
    }

    /// Verifies a new tempo is reached gradually over about a beat, not instantly.
    #[test]
    fn set_bpm_eases_toward_target() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        engine.set_bpm(60.0);
        engine.advance_to(FRAME);
        let first = engine.snapshot().bpm;
        assert!(first < 120.0 && first > 100.0, "first frame bpm {first}");
        run(&mut engine, FRAME, 5.0);
        assert_eq!(engine.snapshot().bpm, 60.0);
        assert!(!engine.is_settling());
    }

    /// Verifies tempo targets are clamped and non-finite or non-positive inputs are ignored.
    #[test]
    fn tempo_inputs_are_sanitized() {
        let mut engine = TempoEngine::default();
        engine.set_bpm(1000.0);
        assert_eq!(engine.snapshot().target_bpm, MAX_BPM);
        engine.set_bpm(f64::NAN);
        assert_eq!(engine.snapshot().target_bpm, MAX_BPM);
        engine.multiply(-2.0);
        assert_eq!(engine.snapshot().target_bpm, MAX_BPM);
        engine.multiply(0.01);
        assert_eq!(engine.snapshot().target_bpm, MIN_BPM);
        engine.set_beats_per_bar(0);
        assert_eq!(engine.snapshot().beats_per_bar, 1);
    }

    /// Verifies half and double time change the target relative to the current target.
    #[test]
    fn multiply_halves_and_doubles_target() {
        let mut engine = TempoEngine::default();
        engine.multiply(2.0);
        assert_eq!(engine.snapshot().target_bpm, 240.0);
        engine.multiply(0.5);
        engine.multiply(0.5);
        assert_eq!(engine.snapshot().target_bpm, 60.0);
    }

    /// Verifies steady taps set the tempo and pull the beat grid onto the taps without any
    /// backwards or skipped motion.
    #[test]
    fn steady_taps_converge_tempo_and_phase() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        let mut now = run(&mut engine, 0.0, 0.31);
        let interval = 60.0 / 100.0;
        let mut last_tap = now;
        for _ in 0..6 {
            engine.tap(now);
            last_tap = now;
            now = run(&mut engine, now, now + interval);
        }
        assert!((engine.snapshot().target_bpm - 100.0).abs() < 0.5);
        let settled_from = last_tap;
        now = run(&mut engine, now, now + 8.0);
        let snapshot = engine.snapshot();
        assert!((snapshot.bpm - 100.0).abs() < 0.5, "bpm {}", snapshot.bpm);
        let at_tap = snapshot.beat_position - (now - settled_from) * snapshot.bpm / 60.0;
        assert!(
            distance_to_grid(at_tap, 1.0) < 0.05,
            "taps should land on beats, off by {}",
            distance_to_grid(at_tap, 1.0)
        );
    }

    /// Verifies the first tap after an idle gap is treated as the downbeat.
    #[test]
    fn first_tap_marks_downbeat() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        let now = run(&mut engine, 0.0, 0.8);
        engine.tap(now);
        let now = run(&mut engine, now, now + 8.0);
        let elapsed = (now - 0.8) * engine.snapshot().bpm / 60.0;
        let at_tap = engine.snapshot().beat_position - elapsed;
        assert!(distance_to_grid(at_tap, 4.0) < 1e-3, "off by {at_tap}");
    }

    /// Verifies a tap far off the established rhythm restarts the sequence and leaves tempo alone.
    #[test]
    fn outlier_tap_restarts_without_changing_tempo() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        for index in 0..4 {
            engine.tap(f64::from(index) * 0.4);
        }
        let target = engine.snapshot().target_bpm;
        assert!((target - 150.0).abs() < 1e-6);
        engine.tap(1.2 + 1.0);
        assert_eq!(engine.snapshot().target_bpm, target);
        engine.tap(1.2 + 1.0 + 0.5);
        assert!((engine.snapshot().target_bpm - 120.0).abs() < 1e-6);
    }

    /// Verifies resync eases the nearest downbeat onto the resync moment.
    #[test]
    fn resync_aligns_downbeat_gradually() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        let now = run(&mut engine, 0.0, 0.75);
        engine.resync(now);
        let resync_time = now;
        let now = run(&mut engine, now, now + 0.1);
        assert!(engine.is_settling(), "a phase error should ease, not jump");
        let now = run(&mut engine, now, now + 10.0);
        let at_resync = engine.snapshot().beat_position - (now - resync_time) * 2.0;
        assert!(
            distance_to_grid(at_resync, 4.0) < 1e-3,
            "off by {at_resync}"
        );
    }

    /// Verifies nudges shift the phase by the requested amount once absorbed.
    #[test]
    fn nudge_shifts_phase() {
        let mut steady = TempoEngine::default();
        let mut nudged = TempoEngine::default();
        steady.advance_to(0.0);
        nudged.advance_to(0.0);
        nudged.nudge(0.25);
        run(&mut steady, 0.0, 6.0);
        run(&mut nudged, 0.0, 6.0);
        let shift = nudged.snapshot().beat_position - steady.snapshot().beat_position;
        assert!((shift - 0.25).abs() < 1e-6, "shift {shift}");
    }

    /// Verifies snap jumps forward to the next downbeat and never backwards.
    #[test]
    fn snap_jumps_forward_to_next_downbeat() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        run(&mut engine, 0.0, 0.5);
        let before = engine.snapshot().beat_position;
        engine.snap(0.5);
        let after = engine.snapshot().beat_position;
        assert!(after >= before);
        assert!((after - 4.0).abs() < 1e-9);
        assert!(!engine.is_settling());
    }

    /// Verifies snapshot helpers report the beat within the bar, the bar and the beat phase.
    #[test]
    fn snapshot_reports_bar_position() {
        let snapshot = TempoSnapshot {
            bpm: 120.0,
            target_bpm: 120.0,
            beats_per_bar: 4,
            beat_position: 9.25,
        };
        assert_eq!(snapshot.beat_in_bar(), 1);
        assert_eq!(snapshot.bar(), 2);
        assert!((snapshot.beat_phase() - 0.25).abs() < 1e-12);
    }
}
