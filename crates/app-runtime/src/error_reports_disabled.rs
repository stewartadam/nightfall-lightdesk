// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Error reporting for builds without the `telemetry` feature: every entry point does nothing.

use nightfall_desk::prelude::TelemetryState;
use nightfall_websocket::prelude::HttpRouteRegistry;
use tracing::Subscriber;
use tracing_subscriber::{Layer, layer::Identity, registry::LookupSpan};

/// Matches the reporting build's test lock; consent has no process-wide effect here.
#[cfg(test)]
pub(crate) static CONSENT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Stands in for the error-report client; holds nothing.
pub struct ErrorReportsGuard;

/// Error reports are compiled out, so there is nothing to start.
pub(crate) fn init(_configured_dsn: Option<&str>) -> ErrorReportsGuard {
    ErrorReportsGuard
}

/// There are no queued reports to write.
pub fn flush_error_reports() {}

/// Consent has no effect without an error-report client.
pub(crate) fn apply_consent(_state: &TelemetryState) {}

/// Returns a layer that ignores every record.
pub(crate) fn tracing_layer<S>() -> impl Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    Identity::new()
}

/// The client-error endpoint is omitted, so the web UI's reports get a `404` and are dropped.
pub(crate) fn register_routes(_registry: &mut HttpRouteRegistry) {}
