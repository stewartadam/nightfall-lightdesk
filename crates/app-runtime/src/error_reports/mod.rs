// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Automatic error reports sent to the project's Sentry-compatible error service (GlitchTip),
//! only while the operator has agreed to share them.
//!
//! Panics and `error!` events become reports; recent warnings ride along as breadcrumbs. Reports
//! are scrubbed of local paths, showfile names, and network addresses, then queued on disk and
//! uploaded in the background whenever the service is reachable.

mod client_errors;
mod outbox;
mod scrub;

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(crate) use client_errors::register_routes;
use nightfall_desk::prelude::TelemetryState;
use outbox::{Endpoint, Outbox, OutboxStore};
use scrub::Scrubber;
use sentry::{
    ClientOptions,
    integrations::tracing::EventFilter,
    protocol::{Breadcrumb, Event, User},
    types::Dsn,
};
use tracing::{Level, Metadata, Subscriber, callsite::Identifier};
use tracing_subscriber::{Layer, registry::LookupSpan};

/// Error service used when the build does not name another; submit-only, so safe to ship.
const DEFAULT_DSN: &str = "https://9162256fdd2a46b7b0b520a8aa19bfa3@app.glitchtip.com/28629";
/// Client name sent with reports.
const USER_AGENT: &str = concat!("nightfall/", env!("CARGO_PKG_VERSION"));
/// Folder in the data directory holding reports that have not been uploaded yet.
const OUTBOX_DIR_NAME: &str = "error-reports";
/// Field that marks the panic hook's own log record, which repeats the panic report.
const PANIC_FIELD: &str = "panic";
/// A log statement that keeps failing is reported once per window; repeats become breadcrumbs.
const REPEAT_WINDOW: Duration = Duration::from_secs(60);
/// Breadcrumbs kept for the next report.
const MAX_BREADCRUMBS: usize = 30;
/// Longest wait for queued reports to reach disk when a shell exits without dropping the guard.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether the operator currently shares error reports.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// Anonymous install identifier attached to reports as the user.
static INSTALL_ID: RwLock<String> = RwLock::new(String::new());
/// The running outbox, present once reporting is initialized.
static OUTBOX: OnceLock<Outbox> = OnceLock::new();

/// Serializes tests that change the process-wide consent, directly or through the telemetry
/// plugin.
#[cfg(test)]
pub(crate) static CONSENT_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Returns whether reports may currently be captured and sent.
fn reports_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Keeps the error-report client alive; dropping it waits briefly for queued reports to be
/// written to disk.
pub struct ErrorReportsGuard {
    _client: Option<sentry::ClientInitGuard>,
}

/// Resolves the error service: the runtime configuration's value wins, then
/// `NIGHTFALL_ERROR_REPORTS_DSN` at build time, then the project's service. An empty value turns
/// reporting off, so forks and test harnesses can opt out.
fn resolve_dsn(configured: Option<&str>) -> Option<Dsn> {
    let dsn = configured
        .or(option_env!("NIGHTFALL_ERROR_REPORTS_DSN"))
        .unwrap_or(DEFAULT_DSN);
    if dsn.is_empty() {
        return None;
    }
    match dsn.parse() {
        Ok(dsn) => Some(dsn),
        Err(error) => {
            eprintln!("Error reports are off: invalid error service address: {error}");
            None
        }
    }
}

/// Starts the error-report client and its outbox. Reports stay off until [`apply_consent`]
/// sees the operator's agreement, but earlier reports left on disk are kept for that moment.
pub(crate) fn init(configured_dsn: Option<&str>) -> ErrorReportsGuard {
    let disabled = ErrorReportsGuard { _client: None };
    let (Some(dsn), Some(data_dir)) =
        (resolve_dsn(configured_dsn), nightfall::nightfall_data_dir())
    else {
        return disabled;
    };
    let endpoint = Endpoint {
        url: dsn.envelope_api_url().to_string(),
        auth: dsn.to_auth(Some(USER_AGENT)).to_string(),
    };
    let outbox = match Outbox::start(OutboxStore::new(data_dir.join(OUTBOX_DIR_NAME)), endpoint) {
        Ok(outbox) => outbox,
        Err(error) => {
            eprintln!("Error reports are unavailable: {error}");
            return disabled;
        }
    };
    let _ = OUTBOX.set(outbox.clone());
    let options = ClientOptions::new()
        .release(format!("nightfall@{}", env!("CARGO_PKG_VERSION")))
        .environment(if cfg!(debug_assertions) {
            "development"
        } else {
            "production"
        })
        .user_agent(USER_AGENT)
        // Capturing and symbolicating a backtrace for a logged error would stall the thread
        // that logged it, often the frame loop; panics still carry their own stack trace.
        .attach_stacktrace(false)
        .send_default_pii(false)
        .max_breadcrumbs(MAX_BREADCRUMBS)
        .in_app_include(["nightfall", "app_runtime", "app_tauri"])
        .before_send(prepare_event)
        .before_breadcrumb(prepare_breadcrumb)
        .transport(Arc::new(outbox));
    let client = sentry::init((dsn, options));
    ErrorReportsGuard {
        _client: Some(client),
    }
}

/// Final pass over every report: drops it without consent, attaches the install identifier as
/// the only user detail, and scrubs paths, names, and addresses.
fn prepare_event(mut event: Event<'static>) -> Option<Event<'static>> {
    if !reports_enabled() {
        return None;
    }
    let install_id = INSTALL_ID.read().map(|id| id.clone()).unwrap_or_default();
    event.user = (!install_id.is_empty()).then(|| User {
        id: Some(install_id),
        ..Default::default()
    });
    Scrubber::for_host().event(&mut event);
    Some(event)
}

/// Keeps a breadcrumb only while reports are shared, scrubbed against the show open when it was
/// logged, since a later show swap would leave the earlier show's name unmasked.
fn prepare_breadcrumb(mut breadcrumb: Breadcrumb) -> Option<Breadcrumb> {
    if !reports_enabled() {
        return None;
    }
    Scrubber::for_host().breadcrumb(&mut breadcrumb);
    Some(breadcrumb)
}

/// Writes reports still waiting in memory to disk, for shells that exit the process without
/// dropping the [`ErrorReportsGuard`].
pub fn flush_error_reports() {
    if let Some(client) = sentry::Hub::main().client() {
        client.flush(Some(FLUSH_TIMEOUT));
    }
}

/// Applies the operator's current choice: starts uploading when reports are shared. While they
/// are not, anything queued is deleted, including reports left by an earlier session.
pub(crate) fn apply_consent(state: &TelemetryState) {
    let enabled = state.available && state.consent.share_errors;
    if let Ok(mut install_id) = INSTALL_ID.write()
        && *install_id != state.install_id
    {
        install_id.clone_from(&state.install_id);
    }
    let was_enabled = ENABLED.swap(enabled, Ordering::Relaxed);
    let Some(outbox) = OUTBOX.get() else {
        return;
    };
    if !enabled {
        outbox.purge();
    } else if !was_enabled {
        outbox.wake();
    }
}

/// Builds the tracing layer that turns `error!` events into reports and warnings into
/// breadcrumbs. It does no work while reports are off, records no spans, and reports each
/// failing log statement at most once per minute.
pub(crate) fn tracing_layer<S>() -> impl Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    let recent = Mutex::new(HashMap::new());
    sentry::integrations::tracing::layer()
        .span_filter(|_| false)
        .event_filter(move |metadata| classify_event(metadata, &recent, Instant::now()))
}

/// Decides how a log record contributes to reports, given when each statement last reported.
fn classify_event(
    metadata: &Metadata<'_>,
    recent: &Mutex<HashMap<Identifier, Instant>>,
    now: Instant,
) -> EventFilter {
    if !reports_enabled() {
        return EventFilter::Ignore;
    }
    match *metadata.level() {
        Level::ERROR if metadata.fields().field(PANIC_FIELD).is_some() => EventFilter::Breadcrumb,
        Level::ERROR => {
            let Ok(mut recent) = recent.lock() else {
                return EventFilter::Breadcrumb;
            };
            let callsite = metadata.callsite();
            if recent
                .get(&callsite)
                .is_some_and(|last| now.duration_since(*last) < REPEAT_WINDOW)
            {
                return EventFilter::Breadcrumb;
            }
            recent.insert(callsite, now);
            EventFilter::Event
        }
        Level::WARN => EventFilter::Breadcrumb,
        _ => EventFilter::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns a telemetry state that shares errors or not.
    fn state(share_errors: bool) -> TelemetryState {
        let mut state = TelemetryState {
            available: true,
            install_id: "install-1".into(),
            ..Default::default()
        };
        state.consent.decided = true;
        state.consent.share_errors = share_errors;
        state
    }

    /// Without consent nothing is captured; with it, a failing statement reports once per window
    /// and the panic hook's own record only adds context to the panic report.
    #[test]
    fn classifies_log_records_by_consent_and_repetition() {
        let _guard = CONSENT_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let recent = Mutex::new(HashMap::new());
        let error = tracing::Level::ERROR;
        let metadata = tracing::Metadata::new(
            "failure",
            "nightfall",
            error,
            None,
            None,
            None,
            tracing::field::FieldSet::new(&["message"], tracing::callsite::Identifier(&CALLSITE)),
            tracing::metadata::Kind::EVENT,
        );
        let now = Instant::now();
        let classify = |at| classify_event(&metadata, &recent, at).bits();

        apply_consent(&state(false));
        assert_eq!(classify(now), EventFilter::Ignore.bits());

        apply_consent(&state(true));
        assert_eq!(classify(now), EventFilter::Event.bits());
        assert_eq!(
            classify(now + Duration::from_secs(5)),
            EventFilter::Breadcrumb.bits()
        );
        assert_eq!(classify(now + REPEAT_WINDOW), EventFilter::Event.bits());
        apply_consent(&state(false));
    }

    /// Reports carry the install identifier as the only user detail and are dropped once
    /// consent is withdrawn.
    #[test]
    fn prepares_events_only_with_consent() {
        let _guard = CONSENT_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        apply_consent(&state(true));
        let event = prepare_event(Event {
            server_name: Some("desk".into()),
            ..Default::default()
        })
        .expect("consent allows the report");
        assert_eq!(
            event.user.and_then(|user| user.id).as_deref(),
            Some("install-1")
        );
        assert_eq!(event.server_name, None);

        apply_consent(&state(false));
        assert!(prepare_event(Event::default()).is_none());
    }

    /// Callsite used to build test metadata.
    struct TestCallsite;

    impl tracing::Callsite for TestCallsite {
        /// Test callsites never change interest.
        fn set_interest(&self, _: tracing::subscriber::Interest) {}

        /// Test metadata is built inline, so the callsite has none of its own.
        fn metadata(&self) -> &tracing::Metadata<'_> {
            unreachable!("test metadata is built inline")
        }
    }

    static CALLSITE: TestCallsite = TestCallsite;
}
