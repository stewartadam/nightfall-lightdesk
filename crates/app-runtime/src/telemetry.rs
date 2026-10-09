// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Host-scoped telemetry consent: loading, persistence, and the anonymous install identifier.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use bevy::prelude::*;
use nightfall_desk::prelude::{TelemetryConsent, TelemetryState};
use nightfall_websocket::host_preferences::{
    LoadedPreferences, load_preferences, save_preferences,
};
use serde::{Deserialize, Serialize};

/// File name of the telemetry preferences inside the host data directory.
const TELEMETRY_FILE_NAME: &str = "telemetry.json";

/// On-disk form of the host's telemetry preferences.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct StoredTelemetry {
    consent: TelemetryConsent,
    install_id: String,
}

impl StoredTelemetry {
    /// Captures the persisted portion of the runtime state.
    fn from_state(state: &TelemetryState) -> Self {
        Self {
            consent: state.consent,
            install_id: state.install_id.clone(),
        }
    }
}

/// Telemetry preferences loaded once per process and shared by every world the session builds,
/// so showfile swaps neither re-read the file nor lose unsaved state.
#[derive(Resource, Clone)]
pub(crate) struct TelemetryHost {
    path: PathBuf,
    state: Arc<Mutex<TelemetryState>>,
}

impl TelemetryHost {
    /// Loads the host's preferences from its data directory, or returns `None` when the
    /// directory cannot be resolved.
    pub(crate) fn load() -> Option<Self> {
        let path = nightfall::nightfall_data_dir()?.join(TELEMETRY_FILE_NAME);
        Some(Self::load_from(path))
    }

    /// Loads preferences from `path`. Nothing is written until the operator changes a choice,
    /// so a file that could not be read is never silently replaced by defaults.
    fn load_from(path: PathBuf) -> Self {
        let (stored, error) = match load_preferences::<StoredTelemetry>(&path) {
            LoadedPreferences::Loaded(stored) => (stored, None),
            LoadedPreferences::Missing => (StoredTelemetry::default(), None),
            LoadedPreferences::Unreadable(error) => (
                StoredTelemetry::default(),
                Some(format!("Could not read telemetry preferences: {error}")),
            ),
        };
        let install_id = if stored.install_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            stored.install_id
        };
        Self {
            path,
            state: Arc::new(Mutex::new(TelemetryState {
                available: true,
                consent: stored.consent,
                install_id,
                error,
            })),
        }
    }

    /// Returns the session's current telemetry state.
    fn snapshot(&self) -> TelemetryState {
        self.state
            .lock()
            .expect("telemetry host lock should not be poisoned")
            .clone()
    }

    /// Persists a world's changed choices and records them as the session's state. Returns the
    /// error to show the operator: `None` after a successful save, which also clears any earlier
    /// read or save failure.
    fn save(&self, state: &TelemetryState) -> Option<String> {
        let mut current = self
            .state
            .lock()
            .expect("telemetry host lock should not be poisoned");
        if StoredTelemetry::from_state(&current) == StoredTelemetry::from_state(state) {
            return current.error.clone();
        }
        let error = save_preferences(&self.path, &StoredTelemetry::from_state(state))
            .err()
            .map(|error| format!("Could not save telemetry preferences: {error}"));
        if error.is_none() {
            *current = state.clone();
        }
        current.error = error.clone();
        error
    }
}

/// Mirrors the session's telemetry preferences into each world and saves operator changes.
pub(crate) struct TelemetryPlugin {
    pub(crate) host: TelemetryHost,
}

impl Plugin for TelemetryPlugin {
    /// Installs the shared host and the systems that load and persist its state.
    fn build(&self, app: &mut App) {
        app.insert_resource(self.host.clone())
            .add_systems(Startup, load_telemetry_state)
            .add_systems(Last, persist_telemetry_state);
    }
}

/// Startup system that replaces the default (unavailable) state with the session's preferences.
fn load_telemetry_state(host: Res<TelemetryHost>, mut state: ResMut<TelemetryState>) {
    *state = host.snapshot();
}

/// Saves consent or identifier changes as soon as a command applies them.
fn persist_telemetry_state(host: Res<TelemetryHost>, mut state: ResMut<TelemetryState>) {
    if !state.is_changed() || state.is_added() {
        return;
    }
    let error = host.save(&state);
    if state.error != error {
        state.error = error;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns a consent record that differs from the defaults in every field.
    fn chosen_consent() -> TelemetryConsent {
        TelemetryConsent {
            decided: true,
            share_usage: false,
            share_errors: true,
        }
    }

    /// A first run has not been asked yet, shares nothing, receives a random identifier, and
    /// writes nothing until the operator chooses.
    #[test]
    fn missing_file_starts_undecided_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(TELEMETRY_FILE_NAME);
        let state = TelemetryHost::load_from(path.clone()).snapshot();
        assert!(state.available);
        assert_eq!(state.consent, TelemetryConsent::default());
        assert!(uuid::Uuid::parse_str(&state.install_id).is_ok());
        assert_eq!(state.error, None);
        assert!(!path.exists());
    }

    /// Saved choices and identifiers are reloaded unchanged by the next session.
    #[test]
    fn saved_preferences_survive_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(TELEMETRY_FILE_NAME);
        let host = TelemetryHost::load_from(path.clone());
        let mut state = host.snapshot();
        state.consent = chosen_consent();
        assert_eq!(host.save(&state), None);
        let reloaded = TelemetryHost::load_from(path).snapshot();
        assert_eq!(reloaded.consent, chosen_consent());
        assert_eq!(reloaded.install_id, state.install_id);
    }

    /// A damaged file shares nothing, reports the problem, and stays on disk until the operator
    /// makes a new choice, which then clears the error.
    #[test]
    fn damaged_file_is_reported_and_kept_until_a_new_choice() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(TELEMETRY_FILE_NAME);
        std::fs::write(&path, b"{not json").unwrap();
        let host = TelemetryHost::load_from(path.clone());
        let mut state = host.snapshot();
        assert!(!state.consent.decided);
        assert!(!state.consent.share_usage && !state.consent.share_errors);
        assert!(state.error.is_some());
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");

        state.consent = chosen_consent();
        assert_eq!(host.save(&state), None);
        assert_eq!(host.snapshot().error, None);
    }

    /// Worlds built after a change start from the saved choice, and the plugin persists commands.
    #[test]
    fn plugin_shares_choices_across_worlds() {
        let directory = tempfile::tempdir().unwrap();
        let host = TelemetryHost::load_from(directory.path().join(TELEMETRY_FILE_NAME));
        let build_world = || {
            let mut app = App::new();
            app.init_resource::<TelemetryState>();
            app.add_plugins(TelemetryPlugin { host: host.clone() });
            app.update();
            app
        };
        let mut first = build_world();
        first.world_mut().resource_mut::<TelemetryState>().consent = chosen_consent();
        first.update();

        let second = build_world();
        assert_eq!(
            second.world().resource::<TelemetryState>().consent,
            chosen_consent()
        );
    }
}
