// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy::prelude::World;

#[cfg(feature = "beat-detection")]
mod beat_detection_backend;
#[cfg(feature = "beat-detection")]
mod beat_model_http;
mod composition;
mod diagnostic_bundle;
mod diagnostic_http;
mod diagnostic_logs;
mod diagnostic_showfile;
mod engine_log_time;
#[cfg_attr(not(feature = "telemetry"), path = "error_reports_disabled.rs")]
mod error_reports;
mod feature_integration;
mod logging;
mod plugin_groups;
#[cfg_attr(
    all(target_os = "macos", not(target_arch = "aarch64")),
    path = "process_policy_fallback.rs"
)]
mod process_policy;
mod runtime_config;
pub mod sample_data;
mod session;
mod shutdown;
mod startup_commands;
mod swap_orchestrator;
mod systems;
mod telemetry;
#[cfg(feature = "telemetry")]
mod telemetry_outbox;
#[cfg(test)]
mod tests;
#[cfg_attr(not(feature = "telemetry"), path = "usage_reports_disabled.rs")]
mod usage_reports;
mod world_factory;

pub use composition::init_bevy;
pub use diagnostic_bundle::{BundleOptions, BundleResult, ShowfileMode, write_bundle};
pub use diagnostic_logs::{DiagnosticLogMode, DiagnosticLogPage, collect_diagnostic_logs};
pub use diagnostic_showfile::{DiagnosticShowfile, capture_showfile};
pub use engine_log_time::EngineLogTimer;
pub use logging::{RuntimeGuard, initialize};
pub use runtime_config::load_runtime_config;
pub use session::{run_bevy_session, run_headless};
pub use shutdown::install_panic_shutdown_hook;
pub use shutdown::monitor_bevy_session;
pub use startup_commands::get_stdin;
pub use swap_orchestrator::{
    CommandProcessingState, PendingWorldSwap, PendingWorldSwapRequest, RuntimeOutputState,
    SwapOrchestrator,
};
pub use systems::showfile_events::export::{
    PreparedShowfileExport, ShowfileExportPolicy, prepare_showfile_export,
};
pub use world_factory::{WorldBootstrap, WorldFactory};

/// The program hosting the engine, which usage reports name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostShell {
    /// The desktop app, whose own window shows the web UI.
    Desktop,
    /// The headless server, reached only from browsers.
    Headless,
}

/// Writes error and usage reports still waiting in memory to disk, for shells that exit the
/// process without dropping the [`RuntimeGuard`].
pub fn flush_reports() {
    error_reports::flush_error_reports();
    usage_reports::flush_usage_reports();
}

/// Validate showfile JSON by parsing it through the runtime snapshot loader path.
#[doc(hidden)]
pub fn validate_showfile_snapshot_json(json: &str, source: &str) -> Result<(), String> {
    systems::showfile_events::validate_showfile_snapshot_json(json, source)
}

/// Serialize a standalone world through the same snapshot path used by runtime showfile saves.
#[doc(hidden)]
pub fn serialize_showfile_snapshot_json_from_world(
    world: &mut World,
    last_saved_unix_sec: u64,
) -> Result<String, String> {
    systems::showfile_events::serialize_showfile_snapshot_json_from_world(
        world,
        last_saved_unix_sec,
    )
}

/// Returns the mutex used to serialize tests that mutate process-wide configuration.
#[cfg(test)]
pub(crate) fn process_config_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(std::sync::Mutex::default)
}
