// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Worker threads that run a callback on every tick of the shared grid.

use std::ops::ControlFlow;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::tick_grid::next_grid_tick;

/// Shortest period a [`FixedRatePeriod`] accepts, so a zero period can never busy-loop a worker.
const MIN_PERIOD: Duration = Duration::from_millis(1);

/// Final stretch before a tick that is slept with `spin_sleep`; longer than the coarsest native
/// sleep granularity (about 16 ms on Windows) so the tick itself is never overslept.
const PRECISE_TAIL: Duration = Duration::from_millis(20);

/// Longest native sleep between stop-flag and period checks while far from the next tick.
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Shared, adjustable tick period for a [`FixedRateWorker`].
///
/// Cloning shares the period, so the owner of the worker can change the rate without respawning
/// it; a waiting worker reschedules its pending tick when it notices the change.
#[derive(Clone, Debug)]
pub struct FixedRatePeriod(Arc<AtomicU64>);

impl FixedRatePeriod {
    /// Creates a period handle, raising anything shorter than 1 ms to 1 ms.
    pub fn new(period: Duration) -> Self {
        Self(Arc::new(AtomicU64::new(Self::to_nanos(period))))
    }

    /// Returns the current period.
    pub fn get(&self) -> Duration {
        Duration::from_nanos(self.0.load(Ordering::Acquire))
    }

    /// Replaces the period, raising anything shorter than 1 ms to 1 ms.
    pub fn set(&self, period: Duration) {
        self.0.store(Self::to_nanos(period), Ordering::Release);
    }

    /// Converts a period to stored nanoseconds after applying the 1 ms floor.
    fn to_nanos(period: Duration) -> u64 {
        u64::try_from(period.max(MIN_PERIOD).as_nanos()).unwrap_or(u64::MAX)
    }
}

/// Thread that calls a tick callback on every [`next_grid_tick`] of an adjustable period.
///
/// Ticks land on the process-wide grid, so a worker stays in phase with every other scheduler
/// using the same period. Waits sleep natively until the last [`PRECISE_TAIL`] before a tick and
/// finish with `spin_sleep`, which spins the final stretch, so ticks fire within microseconds of
/// the grid even where native sleep is coarse (Windows). Ticks missed while a callback overran
/// are skipped rather than run back to back. Dropping the worker shuts it down.
pub struct FixedRateWorker {
    stop: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl FixedRateWorker {
    /// Spawns a thread named `name` that calls `tick` on every tick of `period`.
    ///
    /// The thread exits when `tick` returns [`ControlFlow::Break`] or after
    /// [`shutdown`](Self::shutdown). Shutdowns and period changes take effect within
    /// [`PRECISE_TAIL`] plus [`STOP_POLL_INTERVAL`], however long the period; a new period
    /// reschedules the pending tick onto its own grid.
    pub fn spawn(
        name: impl Into<String>,
        period: FixedRatePeriod,
        mut tick: impl FnMut() -> ControlFlow<()> + Send + 'static,
    ) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let join_handle = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let mut scheduled_period = period.get();
                let mut next_tick = next_grid_tick(scheduled_period, Instant::now());
                loop {
                    match sleep_until(next_tick, &thread_stop, &period, scheduled_period) {
                        Wake::Stop => break,
                        Wake::Retime => {
                            scheduled_period = period.get();
                            next_tick = next_grid_tick(scheduled_period, Instant::now());
                        }
                        Wake::Tick => {
                            if tick().is_break() {
                                break;
                            }
                            scheduled_period = period.get();
                            next_tick =
                                next_grid_tick(scheduled_period, next_tick.max(Instant::now()));
                        }
                    }
                }
            })?;
        Ok(Self {
            stop,
            join_handle: Some(join_handle),
        })
    }

    /// Stops the thread after its current tick and waits for it to exit.
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }

    /// Returns whether the thread is still running.
    pub fn is_alive(&self) -> bool {
        self.join_handle
            .as_ref()
            .is_some_and(|join_handle| !join_handle.is_finished())
    }
}

/// Why a worker's wait for its next tick ended.
enum Wake {
    /// The scheduled tick arrived.
    Tick,
    /// The worker was asked to stop.
    Stop,
    /// The period changed, so the pending tick must be rescheduled.
    Retime,
}

/// Sleeps until `deadline`, ending early when `stop` is set or `period` no longer equals the
/// `scheduled_period` the deadline was computed from.
///
/// Native sleeps of at most [`STOP_POLL_INTERVAL`] cover the wait up to the last
/// [`PRECISE_TAIL`], checking both between them, and `spin_sleep` covers the tail precisely.
fn sleep_until(
    deadline: Instant,
    stop: &AtomicBool,
    period: &FixedRatePeriod,
    scheduled_period: Duration,
) -> Wake {
    loop {
        if stop.load(Ordering::Acquire) {
            return Wake::Stop;
        }
        if period.get() != scheduled_period {
            return Wake::Retime;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining <= PRECISE_TAIL {
            spin_sleep::sleep(remaining);
            return if stop.load(Ordering::Acquire) {
                Wake::Stop
            } else {
                Wake::Tick
            };
        }
        std::thread::sleep((remaining - PRECISE_TAIL).min(STOP_POLL_INTERVAL));
    }
}

impl Drop for FixedRateWorker {
    /// Shuts the thread down so it never outlives its owner.
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::tick_grid::grid_epoch;

    /// Ticks arrive at the configured rate, each just after a grid tick.
    #[test]
    fn ticks_on_grid_at_fixed_rate() {
        let period = Duration::from_millis(10);
        let ticks = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&ticks);
        let mut worker =
            FixedRateWorker::spawn("test-fixed-rate", FixedRatePeriod::new(period), move || {
                recorded.lock().unwrap().push(Instant::now());
                ControlFlow::Continue(())
            })
            .unwrap();

        std::thread::sleep(Duration::from_millis(105));
        worker.shutdown();

        let ticks = ticks.lock().unwrap();
        assert!(
            (8..=12).contains(&ticks.len()),
            "expected about 10 ticks in 105 ms, got {}",
            ticks.len()
        );
        for tick in ticks.iter() {
            let since_epoch = tick.saturating_duration_since(grid_epoch());
            let phase = Duration::from_nanos((since_epoch.as_nanos() % period.as_nanos()) as u64);
            assert!(
                phase < Duration::from_millis(3),
                "tick should land just after a grid tick, got phase {phase:?}"
            );
        }
    }

    /// Returning `Break` from the callback ends the thread.
    #[test]
    fn break_stops_worker() {
        let worker = FixedRateWorker::spawn(
            "test-fixed-rate-break",
            FixedRatePeriod::new(Duration::from_millis(1)),
            || ControlFlow::Break(()),
        )
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(1);
        while worker.is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(!worker.is_alive());
    }

    /// Changing the shared period retimes a running worker without respawning it.
    #[test]
    fn period_change_applies_to_running_worker() {
        let period = FixedRatePeriod::new(Duration::from_secs(10));
        let ticks = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&ticks);
        let mut worker =
            FixedRateWorker::spawn("test-fixed-rate-retime", period.clone(), move || {
                recorded.lock().unwrap().push(Instant::now());
                ControlFlow::Continue(())
            })
            .unwrap();

        std::thread::sleep(Duration::from_millis(20));
        period.set(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(300));
        worker.shutdown();

        let tick_count = ticks.lock().unwrap().len();
        assert!(
            tick_count >= 5,
            "a 10 s tick pending at the change should be replaced by 10 ms ticks, got \
             {tick_count} ticks in 300 ms"
        );
    }

    /// Shutdown returns promptly even when the next tick is far away.
    #[test]
    fn shutdown_does_not_wait_for_long_period() {
        let mut worker = FixedRateWorker::spawn(
            "test-fixed-rate-shutdown",
            FixedRatePeriod::new(Duration::from_secs(5)),
            || ControlFlow::Continue(()),
        )
        .unwrap();

        std::thread::sleep(Duration::from_millis(10));
        let started = Instant::now();
        worker.shutdown();
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "shutdown took {:?}",
            started.elapsed()
        );
    }

    /// Periods shorter than 1 ms are raised to 1 ms so a worker can never busy-loop.
    #[test]
    fn period_has_one_millisecond_floor() {
        let period = FixedRatePeriod::new(Duration::ZERO);
        assert_eq!(period.get(), Duration::from_millis(1));
        period.set(Duration::from_millis(7));
        assert_eq!(period.get(), Duration::from_millis(7));
    }
}
