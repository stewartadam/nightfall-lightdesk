// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#[cfg(any(feature = "debug", debug_assertions))]
use std::{collections::HashSet, sync::Mutex};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

#[cfg(any(feature = "debug", debug_assertions))]
use once_cell::sync::Lazy;
use once_cell::sync::OnceCell;
use tokio::sync::broadcast;

const DEFAULT_FATAL_SHUTDOWN_GRACE: Duration = Duration::from_millis(1500);

/// Named worker targets for debug panic injection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DebugPanicTarget {
    /// The Bevy app update loop.
    BevyMain,
    /// Audio worker thread.
    AudioThread,
    /// Art-Net input listener thread.
    InputArtnetListener,
    /// sACN input listener thread.
    InputSacnListener,
    /// OSC input listener thread.
    InputOscListener,
    /// uDMX output worker thread.
    OutputUdmxThread,
}

#[cfg(any(feature = "debug", debug_assertions))]
impl DebugPanicTarget {
    fn as_str(self) -> &'static str {
        match self {
            DebugPanicTarget::BevyMain => "bevy_main",
            DebugPanicTarget::AudioThread => "audio_thread",
            DebugPanicTarget::InputArtnetListener => "input_artnet_listener",
            DebugPanicTarget::InputSacnListener => "input_sacn_listener",
            DebugPanicTarget::InputOscListener => "input_osc_listener",
            DebugPanicTarget::OutputUdmxThread => "output_udmx_thread",
        }
    }
}

const DEBUG_PANIC_TARGET_NAMES: &[&str] = &[
    "bevy_main",
    "audio_thread",
    "input_artnet_listener",
    "input_sacn_listener",
    "input_osc_listener",
    "output_udmx_thread",
];

/// Process-wide shutdown signal, reason, and grace-period configuration.
struct ProcessShutdownState {
    requested: AtomicBool,
    reason: OnceCell<String>,
    signal_tx: broadcast::Sender<()>,
    grace_period: Duration,
    watchdog_disabled: bool,
}

static PROCESS_SHUTDOWN: OnceCell<ProcessShutdownState> = OnceCell::new();

/// Builds process shutdown state with the supplied typed configuration.
fn new_process_shutdown_state(
    grace_period: Duration,
    watchdog_disabled: bool,
) -> ProcessShutdownState {
    let (signal_tx, _) = broadcast::channel::<()>(1);
    ProcessShutdownState {
        requested: AtomicBool::new(false),
        reason: OnceCell::new(),
        signal_tx,
        grace_period,
        watchdog_disabled,
    }
}

/// Returns initialized shutdown state, using defaults for non-application callers.
fn process_shutdown() -> &'static ProcessShutdownState {
    PROCESS_SHUTDOWN.get_or_init(|| new_process_shutdown_state(DEFAULT_FATAL_SHUTDOWN_GRACE, false))
}

#[cfg(any(feature = "debug", debug_assertions))]
static DEBUG_PANIC_TARGETS: Lazy<Mutex<HashSet<DebugPanicTarget>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

/// Starts the fatal shutdown watchdog unless startup configuration disables it.
fn spawn_watchdog_if_enabled(grace_period: Duration, watchdog_disabled: bool) {
    if watchdog_disabled {
        tracing::warn!("Fatal shutdown watchdog disabled by startup configuration");
        return;
    }

    let _ = thread::Builder::new()
        .name("fatal-shutdown-watchdog".to_string())
        .spawn(move || {
            thread::sleep(grace_period);
            tracing::error!(
                grace_ms = grace_period.as_millis() as u64,
                "Graceful shutdown deadline elapsed; aborting process"
            );
            std::process::abort();
        });
}

/// Initializes process-level shutdown state from typed startup configuration.
pub fn init_process_shutdown(grace_period: Duration, watchdog_disabled: bool) {
    PROCESS_SHUTDOWN
        .set(new_process_shutdown_state(grace_period, watchdog_disabled))
        .unwrap_or_else(|_| panic!("process shutdown state was initialized more than once"));
}

/// Subscribe to process-level shutdown notifications.
pub fn subscribe_process_shutdown() -> broadcast::Receiver<()> {
    process_shutdown().signal_tx.subscribe()
}

/// Returns true when process shutdown has been requested.
pub fn is_process_shutdown_requested() -> bool {
    process_shutdown().requested.load(Ordering::Acquire)
}

/// Returns the configured graceful shutdown window before forced abort.
pub fn process_shutdown_grace_period() -> Duration {
    process_shutdown().grace_period
}

/// Returns the first recorded shutdown reason, if any.
pub fn process_shutdown_reason() -> Option<String> {
    process_shutdown().reason.get().cloned()
}

/// Returns accepted debug panic worker names.
pub fn debug_panic_target_names() -> &'static [&'static str] {
    DEBUG_PANIC_TARGET_NAMES
}

/// Parse a debug panic worker target.
pub fn parse_debug_panic_target(value: &str) -> Option<DebugPanicTarget> {
    match value.trim().to_ascii_lowercase().as_str() {
        "bevy_main" => Some(DebugPanicTarget::BevyMain),
        "audio_thread" => Some(DebugPanicTarget::AudioThread),
        "input_artnet_listener" => Some(DebugPanicTarget::InputArtnetListener),
        "input_sacn_listener" => Some(DebugPanicTarget::InputSacnListener),
        "input_osc_listener" => Some(DebugPanicTarget::InputOscListener),
        "output_udmx_thread" => Some(DebugPanicTarget::OutputUdmxThread),
        _ => None,
    }
}

/// Queue a debug panic for the selected worker target.
#[cfg(any(feature = "debug", debug_assertions))]
pub fn request_debug_worker_panic(target: DebugPanicTarget) -> bool {
    let mut guard = DEBUG_PANIC_TARGETS
        .lock()
        .expect("debug panic target mutex poisoned");
    guard.insert(target)
}

/// Queue a debug panic for the selected worker target.
#[cfg(not(any(feature = "debug", debug_assertions)))]
#[inline(always)]
pub fn request_debug_worker_panic(_target: DebugPanicTarget) -> bool {
    false
}

/// Panic if a debug panic has been queued for this target.
#[cfg(any(feature = "debug", debug_assertions))]
pub fn maybe_trigger_debug_worker_panic(target: DebugPanicTarget) {
    let should_panic = {
        let mut guard = DEBUG_PANIC_TARGETS
            .lock()
            .expect("debug panic target mutex poisoned");
        guard.remove(&target)
    };

    if should_panic {
        panic!("Debug panic injected for worker target {}", target.as_str());
    }
}

/// Panic if a debug panic has been queued for this target.
#[cfg(not(any(feature = "debug", debug_assertions)))]
#[inline(always)]
pub fn maybe_trigger_debug_worker_panic(_target: DebugPanicTarget) {}

/// Request global process shutdown.
///
/// Returns `true` only for the first caller that initiated shutdown.
pub fn request_process_shutdown(reason: impl Into<String>) -> bool {
    let reason = reason.into();
    let shutdown = process_shutdown();
    let first_request = shutdown
        .requested
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok();

    if first_request {
        let _ = shutdown.reason.set(reason.clone());
        tracing::error!(
            reason = %reason,
            grace_ms = shutdown.grace_period.as_millis() as u64,
            "Process shutdown requested"
        );
        let _ = shutdown.signal_tx.send(());
        spawn_watchdog_if_enabled(shutdown.grace_period, shutdown.watchdog_disabled);
    } else {
        tracing::debug!(reason = %reason, "Process shutdown already requested");
    }

    first_request
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_debug_panic_target_accepts_known_values() {
        for &value in debug_panic_target_names() {
            assert!(
                parse_debug_panic_target(value).is_some(),
                "expected {value} to parse"
            );
        }
    }

    #[test]
    fn parse_debug_panic_target_rejects_unknown_values() {
        assert!(parse_debug_panic_target("unknown_worker").is_none());
    }
}
