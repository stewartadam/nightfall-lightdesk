// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Worker threads that run a callback on every tick of the shared grid.

use std::ops::ControlFlow;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::tick_grid::next_grid_tick;

/// Thread that calls a tick callback on every [`next_grid_tick`] of a fixed period.
///
/// Ticks land on the process-wide grid, so a worker stays in phase with every other scheduler
/// using the same period. Ticks missed while a callback overran are skipped rather than run
/// back to back. Dropping the worker shuts it down.
pub struct FixedRateWorker {
    stop: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl FixedRateWorker {
    /// Spawns a thread named `name` that calls `tick` on every tick of `period`.
    ///
    /// The thread exits when `tick` returns [`ControlFlow::Break`] or after
    /// [`shutdown`](Self::shutdown); a shutdown takes effect within one period.
    pub fn spawn(
        name: impl Into<String>,
        period: Duration,
        mut tick: impl FnMut() -> ControlFlow<()> + Send + 'static,
    ) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let join_handle = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let mut next_tick = next_grid_tick(period, Instant::now());
                loop {
                    let now = Instant::now();
                    if next_tick > now {
                        std::thread::sleep(next_tick - now);
                    }
                    if thread_stop.load(Ordering::Acquire) || tick().is_break() {
                        break;
                    }
                    next_tick = next_grid_tick(period, next_tick.max(Instant::now()));
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
        let mut worker = FixedRateWorker::spawn("test-fixed-rate", period, move || {
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
        let worker =
            FixedRateWorker::spawn("test-fixed-rate-break", Duration::from_millis(1), || {
                ControlFlow::Break(())
            })
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(1);
        while worker.is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(!worker.is_alive());
    }
}
