// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Process-wide tick grid shared by every fixed-rate scheduler.
//!
//! Schedulers that compute their deadlines with [`next_grid_tick`] tick on `epoch + n * period`
//! from one process-wide epoch, so schedulers with the same period stay in phase with each other
//! on different threads and across world replacement. The engine frame limiter and the DMX
//! output workers rely on this: regular frames and DMX transmissions start on the same ticks, so
//! each transmission carries the frame that started one tick earlier.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Returns the process-wide origin of the tick grid.
pub fn grid_epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

/// Returns the first tick of the grid `grid_epoch() + n * period` strictly after `after`.
///
/// A zero `period` has no grid, so `after` is returned unchanged.
pub fn next_grid_tick(period: Duration, after: Instant) -> Instant {
    let period_ns = period.as_nanos();
    if period_ns == 0 {
        return after;
    }
    let epoch = grid_epoch();
    let elapsed_ns = after.saturating_duration_since(epoch).as_nanos();
    let offset_ns = (elapsed_ns / period_ns + 1) * period_ns;
    epoch
        + Duration::new(
            (offset_ns / 1_000_000_000) as u64,
            (offset_ns % 1_000_000_000) as u32,
        )
}

/// How a series of events, such as transmitted packets, lines up with the tick grid of one
/// period.
///
/// Built by [`GridTiming::measure`] for timing tests that check a scheduler stays on the grid:
/// one event per tick, no skipped ticks, and each event shortly after its tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridTiming {
    /// Grid slots from the first event's slot to the last event's, both included.
    pub slots_spanned: u64,
    /// Slots in that span that saw at least one event.
    pub slots_hit: u64,
    /// Events that landed in a slot an earlier event had already hit.
    pub doubled: u64,
    /// How long after its grid tick each event landed, sorted shortest first.
    pub lateness: Vec<Duration>,
}

impl GridTiming {
    /// Places each event in the grid slot of `period` it falls in and measures how far past
    /// the slot's tick it landed.
    ///
    /// Events may come in any order. An event before [`grid_epoch`] counts as landing on the
    /// epoch. A zero `period` has no grid and yields an empty measurement.
    ///
    /// An event more than one period after its tick lands in a later slot and leaves its own
    /// slot empty, so it shows up as a missed slot rather than as lateness.
    pub fn measure(events: &[Instant], period: Duration) -> Self {
        let period_ns = period.as_nanos();
        let mut timing = Self {
            slots_spanned: 0,
            slots_hit: 0,
            doubled: 0,
            lateness: Vec::with_capacity(events.len()),
        };
        if period_ns == 0 {
            return timing;
        }
        let epoch = grid_epoch();
        let mut slots: Vec<u64> = events
            .iter()
            .map(|event| {
                let elapsed_ns = event.saturating_duration_since(epoch).as_nanos();
                timing
                    .lateness
                    .push(Duration::from_nanos((elapsed_ns % period_ns) as u64));
                (elapsed_ns / period_ns) as u64
            })
            .collect();
        slots.sort_unstable();
        if let (Some(first), Some(last)) = (slots.first(), slots.last()) {
            timing.slots_spanned = last - first + 1;
        }
        let event_count = slots.len() as u64;
        slots.dedup();
        timing.slots_hit = slots.len() as u64;
        timing.doubled = event_count - timing.slots_hit;
        timing.lateness.sort_unstable();
        timing
    }

    /// Returns how many slots in the span saw no event.
    pub fn missed_slots(&self) -> u64 {
        self.slots_spanned.saturating_sub(self.slots_hit)
    }

    /// Returns the lateness that `percent` percent of events stayed at or under, or zero when
    /// there were no events.
    pub fn lateness_percentile(&self, percent: f64) -> Duration {
        let Some(last) = self.lateness.len().checked_sub(1) else {
            return Duration::ZERO;
        };
        let index = ((percent.clamp(0.0, 100.0) / 100.0) * last as f64).round() as usize;
        self.lateness[index]
    }

    /// Checks the events stayed on the grid within `tolerance` over a run expected to cover
    /// `expected_ticks` ticks, returning a summary of the timing either way.
    ///
    /// Fails when fewer events arrived than the run should have produced, when a tick saw two
    /// events, when too many ticks saw none, or when events landed too long after their tick.
    pub fn check(&self, expected_ticks: u64, tolerance: &GridTolerance) -> Result<String, String> {
        let events = self.lateness.len() as u64;
        let summary = format!(
            "{events} events over {} grid ticks ({} missed, {} doubled), lateness p50 {:?} p95 \
             {:?} max {:?}",
            self.slots_spanned,
            self.missed_slots(),
            self.doubled,
            self.lateness_percentile(50.0),
            self.lateness_percentile(95.0),
            self.lateness_percentile(100.0),
        );
        let allowed_missed = |ticks: u64| (ticks as f64 * tolerance.max_missed_share) as u64;
        let failure = if events + allowed_missed(expected_ticks) + 1 < expected_ticks {
            Some(format!("expected about {expected_ticks} events"))
        } else if self.doubled > 0 {
            Some("a grid tick saw two events".to_string())
        } else if self.missed_slots() > allowed_missed(self.slots_spanned) {
            Some("too many grid ticks saw no event".to_string())
        } else if self.lateness_percentile(95.0) > tolerance.max_p95_lateness {
            Some(format!(
                "95th percentile lateness is over {:?}",
                tolerance.max_p95_lateness
            ))
        } else if self.lateness_percentile(100.0) > tolerance.max_lateness {
            Some(format!(
                "an event was over {:?} late",
                tolerance.max_lateness
            ))
        } else {
            None
        };
        match failure {
            Some(failure) => Err(format!("{failure}: {summary}")),
            None => Ok(summary),
        }
    }
}

/// Limits [`GridTiming::check`] holds a series of events to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridTolerance {
    /// Share of grid ticks that may pass without an event, from 0 to 1.
    pub max_missed_share: f64,
    /// Lateness after the grid tick that 95% of events must stay within.
    pub max_p95_lateness: Duration,
    /// Lateness after the grid tick that every event must stay within.
    pub max_lateness: Duration,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Events are counted per grid slot, doubled and missed slots are found, and lateness is
    /// measured from each slot's tick.
    #[test]
    fn grid_timing_counts_slots_and_lateness() {
        let period = Duration::from_millis(10);
        let epoch = grid_epoch();
        let at = |ms: u64| epoch + Duration::from_millis(ms);
        // Slots 1 and 2 hit once each, slot 3 twice, slot 4 missed, slot 5 hit. The order of the
        // events does not matter.
        let events = [at(50), at(11), at(31), at(22), at(33)];

        let timing = GridTiming::measure(&events, period);

        assert_eq!(timing.slots_spanned, 5);
        assert_eq!(timing.slots_hit, 4);
        assert_eq!(timing.doubled, 1);
        assert_eq!(timing.missed_slots(), 1);
        assert_eq!(timing.lateness_percentile(0.0), Duration::ZERO);
        assert_eq!(timing.lateness_percentile(100.0), Duration::from_millis(3));
        assert_eq!(timing.lateness_percentile(50.0), Duration::from_millis(1));
    }

    /// A check passes events that meet every limit and names the first limit that fails.
    #[test]
    fn grid_timing_check_reports_the_failed_limit() {
        let period = Duration::from_millis(10);
        let epoch = grid_epoch();
        let at = |ms: u64| epoch + Duration::from_millis(ms);
        let tolerance = GridTolerance {
            max_missed_share: 0.0,
            max_p95_lateness: Duration::from_millis(2),
            max_lateness: Duration::from_millis(5),
        };
        let check = |events: &[Instant], expected| {
            GridTiming::measure(events, period).check(expected, &tolerance)
        };

        assert!(check(&[at(10), at(21), at(30)], 3).is_ok());
        assert!(
            check(&[at(10), at(21), at(30)], 10)
                .unwrap_err()
                .starts_with("expected about")
        );
        assert!(
            check(&[at(10), at(12), at(20)], 2)
                .unwrap_err()
                .contains("two events")
        );
        assert!(
            check(&[at(10), at(30)], 2)
                .unwrap_err()
                .contains("saw no event")
        );
        assert!(
            check(&[at(13), at(23), at(33)], 3)
                .unwrap_err()
                .contains("95th percentile")
        );
    }

    /// Grid ticks are aligned to the shared epoch and strictly after the reference instant.
    #[test]
    fn next_grid_tick_is_aligned_and_strictly_later() {
        let period = Duration::from_millis(10);
        let epoch = grid_epoch();

        assert_eq!(next_grid_tick(period, epoch), epoch + period);
        assert_eq!(
            next_grid_tick(period, epoch + Duration::from_millis(15)),
            epoch + Duration::from_millis(20)
        );
        assert_eq!(
            next_grid_tick(period, epoch + Duration::from_millis(20)),
            epoch + Duration::from_millis(30)
        );
    }

    /// A zero period disables the grid instead of dividing by zero.
    #[test]
    fn next_grid_tick_with_zero_period_returns_reference() {
        let now = Instant::now();
        assert_eq!(next_grid_tick(Duration::ZERO, now), now);
    }
}
