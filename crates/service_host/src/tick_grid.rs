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

#[cfg(test)]
mod tests {
    use super::*;

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
