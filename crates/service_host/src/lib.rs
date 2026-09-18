// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Process-lifetime worker infrastructure for domain-specific IO services.
//!
//! This crate intentionally provides only generic lifecycle primitives.
//! Domain crates own protocol- and transport-specific worker/client logic.

#![warn(missing_docs)]

use std::sync::{Mutex, OnceLock};

/// Generic slot for a single process-lifetime worker.
pub struct WorkerSlot<W> {
    /// Worker instance while the service is active.
    worker: Mutex<Option<W>>,
}

impl<W> Default for WorkerSlot<W> {
    fn default() -> Self {
        Self {
            worker: Mutex::new(None),
        }
    }
}

impl<W> WorkerSlot<W> {
    /// Create an empty worker slot.
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebind worker state by shutting down any existing worker then spawning a new one.
    ///
    /// Returns `true` when a worker is available after rebind.
    pub fn rebind(
        &self,
        spawn: impl FnOnce() -> Option<W>,
        mut shutdown: impl FnMut(&mut W),
    ) -> bool {
        let mut slot = self.worker.lock().expect("worker slot mutex poisoned");
        if let Some(mut worker) = slot.take() {
            shutdown(&mut worker);
        }
        *slot = spawn();
        slot.is_some()
    }

    /// Ensure a live worker exists without replacing an existing healthy one.
    ///
    /// Returns `true` when a worker is available after this call.
    pub fn ensure(
        &self,
        spawn: impl FnOnce() -> Option<W>,
        mut shutdown: impl FnMut(&mut W),
        is_alive: impl Fn(&W) -> bool,
    ) -> bool {
        let mut slot = self.worker.lock().expect("worker slot mutex poisoned");
        if let Some(worker) = slot.as_mut() {
            if is_alive(worker) {
                return true;
            }
            shutdown(worker);
        }
        *slot = spawn();
        slot.is_some()
    }

    /// Apply a closure while holding the worker slot lock.
    pub fn with_worker<R>(&self, f: impl FnOnce(Option<&mut W>) -> R) -> R {
        let mut slot = self.worker.lock().expect("worker slot mutex poisoned");
        f(slot.as_mut())
    }

    /// Shutdown and clear the worker slot.
    pub fn shutdown(&self, mut shutdown: impl FnMut(&mut W)) {
        let mut slot = self.worker.lock().expect("worker slot mutex poisoned");
        if let Some(mut worker) = slot.take() {
            shutdown(&mut worker);
        }
    }
}

/// Internal mode-tracked worker state for [`ModeWorkerSlot`].
struct ModeWorkerState<M, W> {
    /// Most recently configured mode.
    mode: Option<M>,
    /// Worker instance for the configured mode.
    worker: Option<W>,
}

impl<M, W> Default for ModeWorkerState<M, W> {
    fn default() -> Self {
        Self {
            mode: None,
            worker: None,
        }
    }
}

/// Worker slot that tracks a configured mode and only rebinds when mode changes.
pub struct ModeWorkerSlot<M, W> {
    /// Mode-aware worker state guarded by a mutex.
    state: Mutex<ModeWorkerState<M, W>>,
}

impl<M, W> Default for ModeWorkerSlot<M, W> {
    fn default() -> Self {
        Self {
            state: Mutex::new(ModeWorkerState::default()),
        }
    }
}

impl<M, W> ModeWorkerSlot<M, W>
where
    M: Clone + PartialEq,
{
    /// Create an empty mode-aware worker slot.
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebind worker state if mode changed, worker is absent, or worker is no longer alive.
    ///
    /// Returns `true` when a worker is available after rebind.
    pub fn rebind(
        &self,
        mode: M,
        spawn: impl FnOnce(M) -> Option<W>,
        mut shutdown: impl FnMut(&mut W),
        is_alive: impl Fn(&W) -> bool,
    ) -> bool {
        let mut state = self.state.lock().expect("mode worker slot mutex poisoned");
        let mode_unchanged = state.mode.as_ref() == Some(&mode);
        if mode_unchanged && let Some(worker) = state.worker.as_mut() {
            if is_alive(worker) {
                return true;
            }
            shutdown(worker);
        } else if let Some(worker) = state.worker.as_mut() {
            shutdown(worker);
        }

        state.mode = Some(mode.clone());
        state.worker = spawn(mode);
        state.worker.is_some()
    }

    /// Apply a closure while holding the worker slot lock.
    pub fn with_worker<R>(&self, f: impl FnOnce(Option<&mut W>) -> R) -> R {
        let mut state = self.state.lock().expect("mode worker slot mutex poisoned");
        f(state.worker.as_mut())
    }

    /// Shutdown worker state and clear the slot.
    pub fn shutdown(&self, mut shutdown: impl FnMut(&mut W)) {
        let mut state = self.state.lock().expect("mode worker slot mutex poisoned");
        if let Some(mut worker) = state.worker.take() {
            shutdown(&mut worker);
        }
    }
}

/// Return a process-wide singleton stored in the provided [`OnceLock`].
pub fn process_singleton<T>(cell: &'static OnceLock<T>, init: impl FnOnce() -> T) -> &'static T {
    cell.get_or_init(init)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{ModeWorkerSlot, WorkerSlot};

    /// Test worker implementation used to verify service-host lifecycle behavior.
    struct TestWorker {
        alive: bool,
        id: usize,
    }

    fn spawn_worker(spawn_count: &AtomicUsize, alive: bool) -> Option<TestWorker> {
        let id = spawn_count.fetch_add(1, Ordering::SeqCst) + 1;
        Some(TestWorker { alive, id })
    }

    #[test]
    fn worker_slot_ensure_restarts_dead_worker() {
        let slot = WorkerSlot::<TestWorker>::new();
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let shutdown_count = Arc::new(AtomicUsize::new(0));

        assert!(slot.ensure(
            {
                let spawn_count = Arc::clone(&spawn_count);
                move || spawn_worker(&spawn_count, false)
            },
            |_| panic!("initial spawn should not shutdown"),
            |worker| worker.alive,
        ));

        assert!(slot.ensure(
            {
                let spawn_count = Arc::clone(&spawn_count);
                move || spawn_worker(&spawn_count, true)
            },
            {
                let shutdown_count = Arc::clone(&shutdown_count);
                move |_| {
                    shutdown_count.fetch_add(1, Ordering::SeqCst);
                }
            },
            |worker| worker.alive,
        ));

        assert_eq!(spawn_count.load(Ordering::SeqCst), 2);
        assert_eq!(shutdown_count.load(Ordering::SeqCst), 1);
        let worker_id = slot.with_worker(|worker| worker.expect("worker present").id);
        assert_eq!(worker_id, 2);
    }

    #[test]
    fn worker_slot_ensure_keeps_alive_worker() {
        let slot = WorkerSlot::<TestWorker>::new();
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let shutdown_count = Arc::new(AtomicUsize::new(0));

        assert!(slot.ensure(
            {
                let spawn_count = Arc::clone(&spawn_count);
                move || spawn_worker(&spawn_count, true)
            },
            |_| panic!("initial spawn should not shutdown"),
            |worker| worker.alive,
        ));

        assert!(slot.ensure(
            {
                let spawn_count = Arc::clone(&spawn_count);
                move || spawn_worker(&spawn_count, true)
            },
            {
                let shutdown_count = Arc::clone(&shutdown_count);
                move |_| {
                    shutdown_count.fetch_add(1, Ordering::SeqCst);
                }
            },
            |worker| worker.alive,
        ));

        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
        assert_eq!(shutdown_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn mode_worker_slot_rebind_restarts_dead_worker_on_same_mode() {
        let slot = ModeWorkerSlot::<u8, TestWorker>::new();
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let shutdown_count = Arc::new(AtomicUsize::new(0));

        assert!(slot.rebind(
            7,
            {
                let spawn_count = Arc::clone(&spawn_count);
                move |_| spawn_worker(&spawn_count, false)
            },
            |_| panic!("initial spawn should not shutdown"),
            |worker| worker.alive,
        ));

        assert!(slot.rebind(
            7,
            {
                let spawn_count = Arc::clone(&spawn_count);
                move |_| spawn_worker(&spawn_count, true)
            },
            {
                let shutdown_count = Arc::clone(&shutdown_count);
                move |_| {
                    shutdown_count.fetch_add(1, Ordering::SeqCst);
                }
            },
            |worker| worker.alive,
        ));

        assert_eq!(spawn_count.load(Ordering::SeqCst), 2);
        assert_eq!(shutdown_count.load(Ordering::SeqCst), 1);
        let worker_id = slot.with_worker(|worker| worker.expect("worker present").id);
        assert_eq!(worker_id, 2);
    }

    #[test]
    fn mode_worker_slot_rebind_keeps_alive_worker_on_same_mode() {
        let slot = ModeWorkerSlot::<u8, TestWorker>::new();
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let shutdown_count = Arc::new(AtomicUsize::new(0));

        assert!(slot.rebind(
            9,
            {
                let spawn_count = Arc::clone(&spawn_count);
                move |_| spawn_worker(&spawn_count, true)
            },
            |_| panic!("initial spawn should not shutdown"),
            |worker| worker.alive,
        ));

        assert!(slot.rebind(
            9,
            {
                let spawn_count = Arc::clone(&spawn_count);
                move |_| spawn_worker(&spawn_count, true)
            },
            {
                let shutdown_count = Arc::clone(&shutdown_count);
                move |_| {
                    shutdown_count.fetch_add(1, Ordering::SeqCst);
                }
            },
            |worker| worker.alive,
        ));

        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
        assert_eq!(shutdown_count.load(Ordering::SeqCst), 0);
    }
}

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use crate::{ModeWorkerSlot, WorkerSlot, process_singleton};
}
