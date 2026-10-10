// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Anonymous usage reports sent to the project's OpenPanel service, only while the operator
//! has agreed to share them.
//!
//! `app_started` goes out at most once a UTC day and carries hardware details; it is what
//! monthly active installs count. Each show is checked at most once a day, and its snapshot
//! goes out only when it changed since the last one sent. Reports are queued on disk and
//! uploaded in the background whenever the service is reachable.

mod events;
mod schedule;
mod show;

use std::{
    hash::{Hash, Hasher},
    sync::{
        Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use bevy::{ecs::system::RunSystemOnce, prelude::*};
use events::Hardware;
use nightfall_desk::prelude::{GraphicsReport, ReportedGraphics, TelemetryState};
use nightfall_fixtures::prelude::{ConsoleDmxAddresses, OutputRouting};
use rustc_hash::FxHasher;
use schedule::Schedule;
use show::{FixtureOrigin, PatchedOutputs, ShowSummary, UsageEvent};

use crate::{
    HostShell,
    systems::showfile_events::{CurrentShowfile, ShowfileSaveState},
    telemetry_outbox::{Endpoint, Outbox, OutboxLimits, OutboxStore},
};

/// Client name sent with reports.
const USER_AGENT: &str = concat!("nightfall/", env!("CARGO_PKG_VERSION"));
/// Folder in the data directory holding reports that have not been uploaded yet.
const OUTBOX_DIR_NAME: &str = "usage-reports";
/// File in the data directory remembering which reports were sent today.
const SCHEDULE_FILE_NAME: &str = "usage-report-schedule.json";
/// Queue limits: a show snapshot is one report per fixture model, so the queue holds more,
/// smaller reports than the error queue. The schedule already limits how often reports are
/// made, so a desk that runs for weeks has no separate session budget.
const LIMITS: OutboxLimits = OutboxLimits {
    max_files: 1000,
    max_bytes: 2 * 1024 * 1024,
    max_per_session: usize::MAX,
};
/// Wait after a world starts before the first check, so startup and show loading settle first.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// Wait between checks, so a desk left running for days still reports each day.
const CHECK_INTERVAL: Duration = Duration::from_secs(15 * 60);
/// Longest the desktop app waits, after the operator starts sharing, for its window to report
/// the graphics hardware before sending `app_started` without it.
const GRAPHICS_WAIT: Duration = Duration::from_secs(10 * 60);

/// Whether the operator currently shares usage reports.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// Anonymous install identifier that reports are sent under.
static INSTALL_ID: RwLock<String> = RwLock::new(String::new());
/// The running service, present once usage reports are initialized.
static SERVICE: OnceLock<Service> = OnceLock::new();
/// Hardware details, read once on a background thread.
static HARDWARE: OnceLock<Hardware> = OnceLock::new();
/// The latest graphics report from the desktop app's window, kept across show swaps.
static GRAPHICS: Mutex<Option<GraphicsReport>> = Mutex::new(None);

/// Everything needed to queue reports.
struct Service {
    outbox: Outbox,
    schedule: Mutex<Schedule>,
    shell: HostShell,
    /// When sharing last started, which is when the window starts reporting its graphics.
    shared_since: Mutex<Instant>,
}

/// Keeps usage reports alive; dropping it waits briefly for queued reports to reach disk.
pub struct UsageReportsGuard;

impl Drop for UsageReportsGuard {
    /// Writes reports still waiting in memory to disk before the process exits.
    fn drop(&mut self) {
        flush_usage_reports();
    }
}

/// Longest wait for queued reports to reach disk at exit.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

/// Writes reports still waiting in memory to disk, for shells that exit the process without
/// dropping the [`UsageReportsGuard`].
pub(crate) fn flush_usage_reports() {
    if let Some(service) = SERVICE.get() {
        service.outbox.flush(FLUSH_TIMEOUT);
    }
}

/// Returns whether usage reports may currently be queued and sent.
fn reports_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Where usage reports go and the credentials that accept them.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ServiceAddress {
    url: String,
    client_id: String,
    client_secret: String,
}

/// Resolves the usage service: the runtime configuration's value wins, then
/// `NIGHTFALL_USAGE_REPORTS_URL` as it was when the app was compiled. Only the release workflow
/// sets it at compile time, so local, benchmark, and fork builds report nowhere. The value is
/// `https://<client id>:<client secret>@<host>/track`; an empty value turns reports off.
fn resolve_address(configured: Option<&str>) -> Option<ServiceAddress> {
    let value = configured
        .or(option_env!("NIGHTFALL_USAGE_REPORTS_URL"))
        .unwrap_or_default();
    if value.is_empty() {
        return None;
    }
    let invalid = |reason: &str| {
        eprintln!("Usage reports are off: invalid usage service address: {reason}");
        None
    };
    let Ok(mut url) = reqwest::Url::parse(value) else {
        return invalid("not a URL");
    };
    let client_id = url.username().to_string();
    let Some(client_secret) = url.password().map(str::to_string) else {
        return invalid("missing client secret");
    };
    if client_id.is_empty() || !matches!(url.scheme(), "http" | "https") {
        return invalid("missing client ID or unsupported scheme");
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    Some(ServiceAddress {
        url: url.to_string(),
        client_id,
        client_secret,
    })
}

/// Starts the outbox and schedule and reads the hardware details in the background. Reports
/// stay off until [`apply_consent`] sees the operator's agreement, but reports left on disk by
/// an earlier session are kept for that moment.
pub(crate) fn init(configured_url: Option<&str>, shell: HostShell) -> UsageReportsGuard {
    let (Some(address), Some(data_dir)) = (
        resolve_address(configured_url),
        nightfall::nightfall_data_dir(),
    ) else {
        return UsageReportsGuard;
    };
    let endpoint = Endpoint {
        url: address.url,
        headers: vec![
            ("openpanel-client-id", address.client_id),
            ("openpanel-client-secret", address.client_secret),
            ("user-agent", USER_AGENT.to_string()),
        ],
        content_type: "application/json",
    };
    let outbox = match Outbox::start(
        OutboxStore::new(data_dir.join(OUTBOX_DIR_NAME), &ENABLED, LIMITS),
        endpoint,
        "nightfall-usage-reports",
    ) {
        Ok(outbox) => outbox,
        Err(error) => {
            eprintln!("Usage reports are unavailable: {error}");
            return UsageReportsGuard;
        }
    };
    let _ = SERVICE.set(Service {
        outbox,
        schedule: Mutex::new(Schedule::load(data_dir.join(SCHEDULE_FILE_NAME))),
        shell,
        shared_since: Mutex::new(Instant::now()),
    });
    let _ = std::thread::Builder::new()
        .name("nightfall-usage-hardware".into())
        .spawn(|| {
            let _ = HARDWARE.set(Hardware::detect());
        });
    UsageReportsGuard
}

/// Applies the operator's current choice: starts uploading when usage reports are shared.
/// While they are not, anything queued is deleted, including reports left by an earlier session,
/// and the schedule forgets what was sent, so sharing again sends today's reports afresh.
pub(crate) fn apply_consent(state: &TelemetryState) {
    let enabled = state.available && state.consent.share_usage;
    if let Ok(mut install_id) = INSTALL_ID.write()
        && *install_id != state.install_id
    {
        install_id.clone_from(&state.install_id);
    }
    let was_enabled = ENABLED.swap(enabled, Ordering::Relaxed);
    let Some(service) = SERVICE.get() else {
        return;
    };
    if !enabled {
        service.outbox.purge();
        if was_enabled && let Ok(mut schedule) = service.schedule.lock() {
            schedule.forget();
        }
    } else if !was_enabled {
        if let Ok(mut shared_since) = service.shared_since.lock() {
            *shared_since = Instant::now();
        }
        service.outbox.wake();
    }
}

/// Adds the systems that send due reports to a world, when usage reports are configured.
pub(crate) fn add_systems(app: &mut App) {
    if SERVICE.get().is_none() {
        return;
    }
    app.add_systems(Last, (remember_graphics, check_due_reports));
}

/// Keeps the desktop window's latest graphics report for `app_started`, across show swaps.
/// The headless server ignores reports, since any browser on the network could send one.
fn remember_graphics(reported: Res<ReportedGraphics>) {
    if !reported.is_changed()
        || SERVICE
            .get()
            .is_none_or(|service| service.shell != HostShell::Desktop)
    {
        return;
    }
    if let (Some(report), Ok(mut graphics)) = (&reported.0, GRAPHICS.lock()) {
        *graphics = Some(report.clone());
    }
}

/// Checks for due reports shortly after the world starts and every quarter hour after that,
/// handing the work to a command so the frame only pays for it when something is due.
fn check_due_reports(mut next_check: Local<Option<Instant>>, mut commands: Commands) {
    let now = Instant::now();
    let due = *next_check.get_or_insert(now + FIRST_CHECK_DELAY);
    if now < due {
        return;
    }
    *next_check = Some(now + CHECK_INTERVAL);
    if reports_enabled() {
        commands.queue(send_due_reports);
    }
}

/// Queues `app_started` and the open show's snapshot when they are due today.
fn send_due_reports(world: &mut World) {
    let Some(service) = SERVICE.get() else {
        return;
    };
    let install_id = INSTALL_ID.read().map(|id| id.clone()).unwrap_or_default();
    if install_id.is_empty() {
        return;
    }
    let now = jiff::Timestamp::now();
    let today = now.to_zoned(jiff::tz::TimeZone::UTC).date().to_string();
    let timestamp = now.round(jiff::Unit::Second).unwrap_or(now).to_string();
    let Ok(mut schedule) = service.schedule.lock() else {
        return;
    };

    if schedule.app_started_due(&install_id, &today)
        && let Some(hardware) = HARDWARE.get()
    {
        let graphics = GRAPHICS.lock().ok().and_then(|graphics| graphics.clone());
        let waiting_for_graphics = service.shell == HostShell::Desktop
            && graphics.is_none()
            && service
                .shared_since
                .lock()
                .is_ok_and(|since| since.elapsed() < GRAPHICS_WAIT);
        if !waiting_for_graphics {
            let properties = events::app_started(service.shell, hardware, graphics.as_ref());
            if queue(
                service,
                &install_id,
                &timestamp,
                [("app_started", properties)],
            ) {
                schedule.record_app_started(&today);
            }
        }
    }

    let key = show_key(world.get_resource::<CurrentShowfile>());
    if !schedule.show_due(&install_id, &key, &today) {
        return;
    }
    let Some(summary) = summarize_show(world) else {
        return;
    };
    let fingerprint = summary.fingerprint();
    if !schedule.show_changed(&key, fingerprint)
        || queue(service, &install_id, &timestamp, summary.events())
    {
        schedule.record_show_check(&key, &today, fingerprint);
    }
}

/// Serializes and queues events for upload as one batch, returning whether it was accepted.
fn queue(
    service: &Service,
    install_id: &str,
    timestamp: &str,
    reports: impl IntoIterator<Item = UsageEvent>,
) -> bool {
    service.outbox.queue(
        reports
            .into_iter()
            .map(|(name, properties)| events::track_body(name, properties, install_id, timestamp))
            .collect(),
    )
}

/// Identifies the open show on this computer only; the key itself is never sent.
fn show_key(current: Option<&CurrentShowfile>) -> String {
    let mut hasher = FxHasher::default();
    current.and_then(CurrentShowfile::name).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Summarizes the world's show through the same path that saves it, or `None` when the world
/// cannot be saved.
fn summarize_show(world: &mut World) -> Option<ShowSummary> {
    let snapshot = world
        .run_system_once(|state: ShowfileSaveState| {
            nightfall_showfile::snapshot_from_save_state(&state)
        })
        .ok()?;
    let outputs = PatchedOutputs {
        console_universes: world
            .get_resource::<ConsoleDmxAddresses>()
            .map(|addresses| addresses.universes().into_iter().collect())
            .unwrap_or_default(),
        transport_universes: world
            .get_resource::<OutputRouting>()
            .map(|routing| routing.keys().iter().cloned().collect())
            .unwrap_or_default(),
    };
    Some(ShowSummary::new(
        &snapshot,
        |fixture| fixture_origin(world, fixture),
        &outputs,
    ))
}

/// Classifies a fixture by the library definition it was patched from.
#[cfg(feature = "fixture-library")]
fn fixture_origin(world: &World, fixture: &nightfall_fixtures::prelude::Fixture) -> FixtureOrigin {
    use nightfall_fixture_library::manager::{FixtureLibraryManager, FixtureSource};
    let profile = world
        .get_resource::<FixtureLibraryManager>()
        .and_then(|library| library.find_fixture(&fixture.make, &fixture.model));
    match profile.map(|profile| &profile.source) {
        Some(FixtureSource::BuiltIn { .. } | FixtureSource::Ofl(_)) => FixtureOrigin::Library,
        Some(FixtureSource::Gdtf(_)) => FixtureOrigin::Gdtf,
        None => FixtureOrigin::Custom,
    }
}

/// Without the fixture library no fixture can be traced to a public definition, so every
/// fixture is only counted.
#[cfg(not(feature = "fixture-library"))]
fn fixture_origin(
    _world: &World,
    _fixture: &nightfall_fixtures::prelude::Fixture,
) -> FixtureOrigin {
    FixtureOrigin::Custom
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The service address splits into the endpoint and its credentials, and anything
    /// incomplete turns reports off.
    #[test]
    fn resolves_the_service_address() {
        assert_eq!(
            resolve_address(Some("https://client:secret@api.example/track")),
            Some(ServiceAddress {
                url: "https://api.example/track".into(),
                client_id: "client".into(),
                client_secret: "secret".into(),
            })
        );
        assert_eq!(resolve_address(Some("")), None);
        assert_eq!(
            resolve_address(Some("https://client@api.example/track")),
            None
        );
        assert_eq!(
            resolve_address(Some("ftp://client:secret@api.example/")),
            None
        );
        assert_eq!(resolve_address(Some("not a url")), None);
    }

    /// A running sample show is summarized through the save path, including the console
    /// universes its patch occupies.
    #[test]
    fn summarizes_a_running_show() {
        use std::sync::{Arc, RwLock};

        use nightfall_desk::resources::log_config::{LogConfig, TracingTarget};

        let log_config =
            LogConfig::new(|_| Ok(()), Arc::new(RwLock::new(TracingTarget::default())));
        let mut app = crate::WorldFactory::new(log_config, false, false, false)
            .build(crate::WorldBootstrap::SampleData {
                showfile_name: None,
            })
            .expect("sample world");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _runtime = runtime.enter();
        app.update();
        let events = summarize_show(app.world_mut())
            .expect("the sample world can be saved")
            .events();
        let (name, show) = &events[0];
        assert_eq!(*name, "show_snapshot");
        assert!(show["fixtures"].as_u64().unwrap() > 0);
        assert!(show["cues"].as_u64().unwrap() > 0);
        assert!(show["console_universes"].as_u64().unwrap() > 0);
        assert_eq!(
            show["output_universes"], 0,
            "the sample patch stops at the console"
        );
        assert!(events.iter().any(|(name, _)| *name == "show_fixture_model"));
    }

    /// Shows are told apart by name without the name appearing in the key.
    #[test]
    fn show_keys_hide_names() {
        let mut named = CurrentShowfile::default();
        named.set_name(Some("Client Gala")).unwrap();
        let key = show_key(Some(&named));
        assert_eq!(key.len(), 16);
        assert!(!key.contains("Client"));
        assert_ne!(key, show_key(Some(&CurrentShowfile::default())));
        assert_eq!(show_key(None), show_key(Some(&CurrentShowfile::default())));
    }
}
