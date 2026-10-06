// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Early-wake signal from command ingress to the frame limiter.
//!
//! Regular engine frames start on the shared tick grid (see
//! `nightfall_service_host::tick_grid`). [`FrameWaker`] lets command ingress start a frame before
//! the next tick. DMX leaves on the output workers' own fixed-rate clock, so an early frame
//! changes neither the output rate nor its phase.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;

use bevy_ecs::prelude::Resource;

/// Wakes a sleeping frame limiter so the next engine frame starts before its tick.
///
/// Cloning shares the signal. Each [`wake`](Self::wake) advances a generation counter; a sleeper
/// compares it with the generation it last observed, so a wake that lands while a frame is
/// running is not lost and starts the following frame early.
#[derive(Resource, Clone, Default)]
pub struct FrameWaker {
    inner: Arc<FrameWakerInner>,
}

/// Generation counter plus the condition variable sleepers block on.
#[derive(Default)]
struct FrameWakerInner {
    generation: AtomicU64,
    lock: Mutex<()>,
    condvar: Condvar,
}

impl FrameWaker {
    /// Requests an early frame and interrupts any sleeper blocked in [`wait_timeout`](Self::wait_timeout).
    pub fn wake(&self) {
        self.inner.generation.fetch_add(1, Ordering::Release);
        // Taking the lock orders this notification after a sleeper's generation check, so a
        // sleeper cannot check, miss this wake, and then block until its timeout.
        drop(self.inner.lock.lock());
        self.inner.condvar.notify_all();
    }

    /// Returns the current wake generation.
    pub fn generation(&self) -> u64 {
        self.inner.generation.load(Ordering::Acquire)
    }

    /// Blocks for up to `timeout`, returning early once the generation differs from `seen`.
    ///
    /// Returns immediately when a wake already arrived after `seen`. Not available on wasm,
    /// where the browser owns frame scheduling and blocking the main thread is not allowed.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn wait_timeout(&self, seen: u64, timeout: Duration) {
        let Ok(guard) = self.inner.lock.lock() else {
            return;
        };
        if self.generation() != seen {
            return;
        }
        let _ = self.inner.condvar.wait_timeout(guard, timeout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A wake issued before waiting returns immediately instead of sleeping the full timeout.
    #[test]
    fn wait_returns_immediately_after_prior_wake() {
        let waker = FrameWaker::default();
        let seen = waker.generation();
        waker.wake();

        let start = std::time::Instant::now();
        waker.wait_timeout(seen, Duration::from_secs(5));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    /// A wake from another thread interrupts a sleeper blocked on the condition variable.
    #[test]
    fn wake_interrupts_blocked_sleeper() {
        let waker = FrameWaker::default();
        let seen = waker.generation();
        let remote = waker.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            remote.wake();
        });

        let start = std::time::Instant::now();
        waker.wait_timeout(seen, Duration::from_secs(5));
        handle.join().expect("waking thread should finish");
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_ne!(waker.generation(), seen);
    }
}
