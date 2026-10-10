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
/// Idle time after which the next tap starts a new tap sequence on the downbeat; just longer
/// than one beat at the slowest tempo, so slow tempos can still be tapped.
const TAP_RESET_SECS: f64 = 60.0 / MIN_BPM + 0.5;
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
    /// Rate the beat counter is actually advancing at, in beats per minute, including any
    /// phase correction in progress. Clients extrapolate the counter at this rate.
    pub effective_bpm: f64,
    /// Tempo the engine is easing toward.
    pub target_bpm: f64,
    /// Number of beats in one bar.
    pub beats_per_bar: u8,
    /// Monotonic beat counter; whole numbers are beats.
    pub beat_position: f64,
    /// Beat position of a reference downbeat; downbeats fall every `beats_per_bar` beats
    /// from here. It moves when the bar length changes so the current bar is not re-based.
    pub bar_origin: f64,
    /// Number of bars completed before `bar_origin`, so bar numbers keep counting up across
    /// bar length changes.
    pub bars_before_origin: u32,
}

impl TempoSnapshot {
    /// Returns the bar length as a float, never less than one beat.
    fn bar_length(&self) -> f64 {
        f64::from(self.beats_per_bar.max(1))
    }

    /// Returns the zero-based beat index within the bar containing `beat_position`.
    pub fn beat_in_bar_at(&self, beat_position: f64) -> u32 {
        let since_origin = (beat_position - self.bar_origin).max(0.0).floor();
        (since_origin % self.bar_length()) as u32
    }

    /// Returns the zero-based index of the bar containing `beat_position`.
    pub fn bar_at(&self, beat_position: f64) -> u64 {
        let since_origin = (beat_position - self.bar_origin).max(0.0);
        u64::from(self.bars_before_origin) + (since_origin / self.bar_length()).floor() as u64
    }

    /// Returns the zero-based beat index within the current bar.
    pub fn beat_in_bar(&self) -> u32 {
        self.beat_in_bar_at(self.beat_position)
    }

    /// Returns the zero-based index of the current bar.
    pub fn bar(&self) -> u64 {
        self.bar_at(self.beat_position)
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

/// When and where a tap happened.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TapTime {
    /// The tap was timed on the engine clock, in engine seconds.
    Engine(f64),
    /// The tap was timed on a remote client's clock.
    Client {
        /// Identity of the client session, so taps from different devices never mix.
        client: u64,
        /// Tap time on the client's own monotonic clock, in seconds.
        seconds: f64,
        /// Engine time at which the tap was received, in engine seconds.
        received: f64,
    },
}

/// Collects recent taps and fits a steady beat interval and phase to them.
///
/// Taps are fitted on the clock that timed them, so a client's taps keep their exact
/// spacing however long each one took to reach the engine.
#[derive(Clone, Debug, Default, PartialEq)]
struct TapTracker {
    /// Times of the taps in the current sequence, oldest first, on the sequence's clock.
    taps: Vec<f64>,
    /// Client whose clock times the current sequence, or `None` for the engine clock.
    client: Option<u64>,
    /// Smallest engine-minus-client clock difference seen in the sequence. The fastest
    /// delivery best approximates the true offset, so client times map to engine time by
    /// adding it.
    clock_offset: f64,
}

impl TapTracker {
    /// Records a tap and reports whether it starts, restarts or extends the sequence,
    /// along with the tap's time on the engine clock.
    fn tap(&mut self, time: TapTime) -> (TapOutcome, f64) {
        let (client, now, offset) = match time {
            TapTime::Engine(now) => (None, now, 0.0),
            TapTime::Client {
                client,
                seconds,
                received,
            } => (Some(client), seconds, received - seconds),
        };
        let continues = self.client == client && !self.taps.is_empty();
        self.client = client;
        self.clock_offset = if continues {
            self.clock_offset.min(offset)
        } else {
            offset
        };
        let engine_time = now + self.clock_offset;
        (self.record(now, continues), engine_time)
    }

    /// Adds a tap at `now` on the sequence's clock and fits the sequence, restarting it when
    /// `continues` is false, after an idle gap, or when the tap breaks the rhythm.
    fn record(&mut self, now: f64, continues: bool) -> TapOutcome {
        let gap = self.taps.last().map(|last| now - last);
        let Some(gap) = gap.filter(|gap| continues && (0.0..=TAP_RESET_SECS).contains(gap)) else {
            self.taps.clear();
            self.taps.push(now);
            return TapOutcome::Downbeat;
        };
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
    /// Rate the counter advanced at over the last frame, in beats per minute.
    effective_bpm: f64,
    /// Whole-beat position of a reference downbeat.
    bar_origin: f64,
    /// Bars completed before `bar_origin`.
    bars_before_origin: u32,
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
    /// Starts a 4/4 grid at the default tempo with the beat counter and clock at zero.
    fn default() -> Self {
        Self {
            bpm: DEFAULT_BPM,
            target_bpm: DEFAULT_BPM,
            bpm_slew: 0.0,
            beats_per_bar: DEFAULT_BEATS_PER_BAR,
            beat_position: 0.0,
            effective_bpm: DEFAULT_BPM,
            bar_origin: 0.0,
            bars_before_origin: 0,
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
            effective_bpm: self.effective_bpm,
            target_bpm: self.target_bpm,
            beats_per_bar: self.beats_per_bar,
            beat_position: self.beat_position,
            bar_origin: self.bar_origin,
            bars_before_origin: self.bars_before_origin,
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
        self.effective_bpm = (nominal + correction) / dt * 60.0;
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
    ///
    /// The bar in progress keeps its downbeat and the bar count keeps going, so changing the
    /// bar length does not re-base the current beat onto a different grid.
    pub fn set_beats_per_bar(&mut self, beats_per_bar: u8) {
        let beats_per_bar = beats_per_bar.clamp(1, MAX_BEATS_PER_BAR);
        if beats_per_bar == self.beats_per_bar {
            return;
        }
        let snapshot = self.snapshot();
        let bar = snapshot.bar();
        self.bar_origin +=
            (bar - u64::from(self.bars_before_origin)) as f64 * snapshot.bar_length();
        self.bars_before_origin = u32::try_from(bar).unwrap_or(u32::MAX);
        self.beats_per_bar = beats_per_bar;
    }

    /// Shifts the phase by a signed number of beats, eased like any other correction.
    pub fn nudge(&mut self, beats: f64) {
        if beats.is_finite() {
            self.add_phase_correction(beats);
        }
    }

    /// Eases the phase so that `now` becomes the nearest downbeat.
    pub fn resync(&mut self, now: f64) {
        self.align(now, self.bar_origin, f64::from(self.beats_per_bar));
    }

    /// Jumps forward to the next downbeat at `now`, discarding any pending correction.
    ///
    /// This is the one operation that moves the counter discontinuously; it only ever moves
    /// forward, by at most one bar.
    pub fn snap(&mut self, now: f64) {
        let bar = f64::from(self.beats_per_bar);
        let elapsed = self.beats_since_advance(now);
        let since_origin = self.beat_position + elapsed - self.bar_origin;
        let next_downbeat = self.bar_origin + (since_origin / bar).ceil() * bar;
        self.beat_position = (next_downbeat - elapsed).max(self.beat_position);
        self.pending_phase = 0.0;
    }

    /// Registers a tap, updating the tempo target and easing the phase onto the taps.
    ///
    /// The first tap after an idle gap, or the first from a different client, marks the
    /// downbeat. Later taps fit a steady interval to the recent taps, measured on the clock
    /// that timed them, and align the nearest beat to the fitted line at the moment the tap
    /// happened, which may be slightly before the engine processed it. A tap that breaks the
    /// rhythm restarts the sequence without moving anything.
    pub fn tap(&mut self, time: TapTime) {
        let (outcome, at) = self.taps.tap(time);
        match outcome {
            TapOutcome::Downbeat => self.resync(at),
            TapOutcome::Restarted => {}
            TapOutcome::Fitted { interval, residual } => {
                self.set_bpm(60.0 / interval);
                self.align(at, residual / interval, 1.0);
            }
        }
    }

    /// Beats elapsed between the last advance and `now` at the current tempo, never negative.
    fn beats_since_advance(&self, now: f64) -> f64 {
        self.beats_relative_to_advance(now).max(0.0)
    }

    /// Signed beats between the last advance and `time` at the current tempo; negative for
    /// times before the last advance, such as a tap that waited for the next frame.
    fn beats_relative_to_advance(&self, time: f64) -> f64 {
        self.last_time
            .map_or(0.0, |last| (time - last) * self.bpm / 60.0)
    }

    /// Eases the phase so that, at `now`, the counter sits at `offset` modulo `modulus`,
    /// correcting the shorter way round. `now` may lie slightly before the last advance.
    fn align(&mut self, now: f64, offset: f64, modulus: f64) {
        let effective =
            self.beat_position + self.beats_relative_to_advance(now) + self.pending_phase;
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
            engine.tap(TapTime::Engine(now));
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
        engine.tap(TapTime::Engine(now));
        let now = run(&mut engine, now, now + 8.0);
        let elapsed = (now - 0.8) * engine.snapshot().bpm / 60.0;
        let at_tap = engine.snapshot().beat_position - elapsed;
        assert!(distance_to_grid(at_tap, 4.0) < 1e-3, "off by {at_tap}");
    }

    /// Taps one client's beats exactly `interval` apart on its own clock, delivering each to
    /// the engine after the matching delay in `delays`, and returns the engine time of the
    /// last tap's true moment and the time of the last delivery.
    fn tap_client_with_delays(
        engine: &mut TempoEngine,
        client: u64,
        first_tap: f64,
        interval: f64,
        delays: &[f64],
    ) -> (f64, f64) {
        let client_clock_offset = 1_000.0;
        let mut now = engine.last_time.unwrap_or(0.0);
        let mut tap_time = first_tap;
        for (index, delay) in delays.iter().enumerate() {
            tap_time = first_tap + index as f64 * interval;
            let received = tap_time + delay;
            now = run(engine, now, received);
            engine.advance_to(received);
            now = now.max(received);
            engine.tap(TapTime::Client {
                client,
                seconds: tap_time + client_clock_offset,
                received,
            });
        }
        (tap_time, now)
    }

    /// Verifies taps timed on the client's clock give the exact tempo and land beats on the
    /// taps, however unevenly the network and frame timing delay their delivery.
    #[test]
    fn client_timed_taps_ignore_delivery_jitter() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        let delays = [
            0.023, 0.004, 0.017, 0.0, 0.011, 0.020, 0.008, 0.015, 0.002, 0.019,
        ];
        let (last_tap, now) = tap_client_with_delays(&mut engine, 7, 1.0, 0.5, &delays);
        assert!(
            (engine.snapshot().target_bpm - 120.0).abs() < 1e-9,
            "target {}",
            engine.snapshot().target_bpm
        );

        let now = run(&mut engine, now, now + 8.0);
        let snapshot = engine.snapshot();
        let at_tap = snapshot.beat_position - (now - last_tap) * snapshot.bpm / 60.0;
        assert!(
            distance_to_grid(at_tap, 1.0) < 0.01,
            "taps should land on beats, off by {}",
            distance_to_grid(at_tap, 1.0)
        );
    }

    /// Verifies the same delivery jitter visibly skews the tempo when taps are timed on
    /// arrival, which is what client timing avoids.
    #[test]
    fn arrival_timed_taps_pick_up_delivery_jitter() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        let delays = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.023, 0.023];
        let mut now = 0.0;
        for (index, delay) in delays.iter().enumerate() {
            let received = 1.0 + index as f64 * 0.5 + delay;
            now = run(&mut engine, now, received);
            engine.tap(TapTime::Engine(received));
        }
        assert!((engine.snapshot().target_bpm - 120.0).abs() > 0.5);
    }

    /// Verifies a tap from a different client starts a new sequence on that client's clock
    /// instead of mixing two clocks into one fit.
    #[test]
    fn taps_from_another_client_start_a_new_sequence() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        tap_client_with_delays(&mut engine, 1, 1.0, 0.4, &[0.0; 4]);
        assert!((engine.snapshot().target_bpm - 150.0).abs() < 1e-9);
        tap_client_with_delays(&mut engine, 2, 2.6, 0.5, &[0.0]);
        assert!((engine.snapshot().target_bpm - 150.0).abs() < 1e-9);
        tap_client_with_delays(&mut engine, 2, 3.1, 0.5, &[0.0]);
        assert!((engine.snapshot().target_bpm - 120.0).abs() < 1e-9);
    }

    /// Verifies a tap far off the established rhythm restarts the sequence and leaves tempo alone.
    #[test]
    fn outlier_tap_restarts_without_changing_tempo() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        for index in 0..4 {
            engine.tap(TapTime::Engine(f64::from(index) * 0.4));
        }
        let target = engine.snapshot().target_bpm;
        assert!((target - 150.0).abs() < 1e-6);
        engine.tap(TapTime::Engine(1.2 + 1.0));
        assert_eq!(engine.snapshot().target_bpm, target);
        engine.tap(TapTime::Engine(1.2 + 1.0 + 0.5));
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
            effective_bpm: 120.0,
            target_bpm: 120.0,
            beats_per_bar: 4,
            beat_position: 9.25,
            bar_origin: 0.0,
            bars_before_origin: 0,
        };
        assert_eq!(snapshot.beat_in_bar(), 1);
        assert_eq!(snapshot.bar(), 2);
        assert!((snapshot.beat_phase() - 0.25).abs() < 1e-12);
    }

    /// Verifies changing the bar length keeps the current bar's downbeat and keeps counting
    /// bars instead of re-basing the beat onto a new grid.
    #[test]
    fn bar_length_change_keeps_current_bar() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        run(&mut engine, 0.0, 4.6);
        let before = engine.snapshot();
        assert_eq!((before.bar(), before.beat_in_bar()), (2, 1));

        engine.set_beats_per_bar(3);
        let after = engine.snapshot();
        assert_eq!((after.bar(), after.beat_in_bar()), (2, 1));

        run(&mut engine, 4.6, 5.6);
        let later = engine.snapshot();
        assert_eq!((later.bar(), later.beat_in_bar()), (3, 0));

        engine.advance_to(6.0);
        engine.snap(6.0);
        let snapped = engine.snapshot();
        assert_eq!((snapped.bar(), snapped.beat_in_bar()), (4, 0));
        assert_eq!(snapped.beat_position.fract(), 0.0);
    }

    /// Verifies the reported effective rate includes a phase correction in progress.
    #[test]
    fn effective_rate_reflects_phase_correction() {
        let mut engine = TempoEngine::default();
        engine.advance_to(0.0);
        engine.nudge(-1.0);
        engine.advance_to(FRAME);
        let snapshot = engine.snapshot();
        assert!((snapshot.effective_bpm - 120.0 * (1.0 - MAX_CORRECTION_RATE)).abs() < 1e-6);
    }
}
