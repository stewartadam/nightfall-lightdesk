// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy::prelude::{App, Resource};
use bevy_state::app::AppExtStates;
use nightfall_config::RuntimeConfig;
use nightfall_desk::{
    prelude::{PendingUiNotifications, ToastLevel, UiNotification},
    resources::log_config::LogConfig,
};
use nightfall_engine::prelude::AppState;
use nightfall_io::TransportRuntimePolicy;

use crate::{composition::init_bevy_with_transport_policy, sample_data};

/// Marks an in-memory sample world whose draft and bundled media must be installed before runtime starts.
#[derive(Resource)]
pub(super) struct PendingSampleDraft;

/// Initial world bootstrap source when creating a fresh Bevy app instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorldBootstrap {
    /// Leave the fresh world empty for callers that will populate it directly.
    Empty {
        /// Optional named `.nightfall-show` folder associated with the empty world.
        showfile_name: Option<String>,
    },
    /// Seed sample entities into the fresh world.
    SampleData {
        /// Optional name for a sample show and its initial draft.
        showfile_name: Option<String>,
    },
    /// Load persisted showfile data into the fresh world.
    Showfile {
        /// Logical showfile name used as the destination for explicit saves.
        name: Option<String>,
        /// Storage location to read while bootstrapping the world.
        source: std::path::PathBuf,
    },
}

/// Builds fresh app worlds with deterministic startup configuration.
///
/// A `WorldFactory` can be reused to create multiple isolated worlds that
/// share the same process-scoped transport permissions.
#[derive(Clone)]
pub struct WorldFactory {
    pub(super) log_config: LogConfig,
    pub(super) transport_policy: TransportRuntimePolicy,
    pub(super) runtime_config: RuntimeConfig,
}

impl WorldFactory {
    /// Builds a world factory from typed runtime configuration.
    pub fn for_config(log_config: LogConfig, runtime_config: RuntimeConfig) -> Self {
        Self {
            log_config,
            transport_policy: TransportRuntimePolicy::new(
                runtime_config.transports.network_output_enabled,
                runtime_config.transports.network_input_enabled,
                runtime_config.transports.usb_output_enabled,
            ),
            runtime_config,
        }
    }

    /// Build a world factory with explicit process transport permissions.
    pub fn new(
        log_config: LogConfig,
        network_output_enabled: bool,
        network_input_enabled: bool,
        usb_output_enabled: bool,
    ) -> Self {
        let runtime_config = RuntimeConfig::default();
        Self {
            log_config,
            transport_policy: TransportRuntimePolicy::new(
                network_output_enabled,
                network_input_enabled,
                usb_output_enabled,
            ),
            runtime_config,
        }
    }

    /// Create a fresh Bevy app and bootstrap it from empty, sample, or showfile data.
    pub fn build(&self, bootstrap: WorldBootstrap) -> Result<App, String> {
        let mut bevy_app = init_bevy_with_transport_policy(
            self.log_config.clone(),
            self.transport_policy,
            &self.runtime_config,
        );

        let clean_hash_result: Result<(), String> = match bootstrap {
            WorldBootstrap::Empty { showfile_name } => {
                finalize_new_world(&mut bevy_app, showfile_name.as_deref(), false)
            }
            WorldBootstrap::SampleData { showfile_name } => {
                sample_data::populate_sample_entities(bevy_app.world_mut());
                finalize_new_world(&mut bevy_app, showfile_name.as_deref(), true)
            }
            WorldBootstrap::Showfile { name, source } => {
                crate::systems::showfile_events::load_showfile_into_world(
                    bevy_app.world_mut(),
                    name.as_deref(),
                    source.clone(),
                )?;
                crate::systems::showfile_events::refresh_clean_snapshot_hash_after_showfile_bootstrap(
                    bevy_app.world_mut(),
                    name.as_deref(),
                    &source,
                )?;
                bevy_app.insert_state(AppState::Ready);
                Ok(())
            }
        };
        clean_hash_result?;

        Ok(bevy_app)
    }

    /// Run a fixed number of update ticks to warm staged systems/resources.
    pub fn warm_up(&self, bevy_app: &mut App, update_ticks: usize) {
        for _ in 0..update_ticks {
            bevy_app.update();
        }
    }
}

/// Build the requested startup world and fall back to sample data after showfile failures.
pub(super) fn bootstrap_world_with_fallback(
    mut build: impl FnMut(WorldBootstrap) -> Result<App, String>,
    bootstrap: WorldBootstrap,
) -> Result<(App, Vec<UiNotification>), String> {
    match build(bootstrap.clone()) {
        Ok(bevy_app) => Ok((bevy_app, Vec::new())),
        Err(error) if matches!(bootstrap, WorldBootstrap::Showfile { .. }) => {
            let message = format!(
                "Failed to load showfile during startup; loaded sample data instead: {error}"
            );
            tracing::error!("{message}");

            let bevy_app = build(WorldBootstrap::SampleData {
                showfile_name: None,
            })
            .map_err(|fallback_error| {
                format!("{message}; sample data bootstrap also failed: {fallback_error}")
            })?;

            Ok((
                bevy_app,
                vec![UiNotification::ShowToast {
                    level: ToastLevel::Error,
                    message,
                }],
            ))
        }
        Err(error) => Err(error),
    }
}

/// Queue bootstrap notifications for delivery after the backend session starts.
pub(super) fn queue_startup_ui_notifications(
    bevy_app: &mut App,
    notifications: Vec<UiNotification>,
) {
    if notifications.is_empty() {
        return;
    }

    let Some(mut pending_ui_notifications) = bevy_app
        .world_mut()
        .get_resource_mut::<PendingUiNotifications>()
    else {
        tracing::error!(
            "Failed to get PendingUiNotifications resource for startup UI notifications"
        );
        return;
    };

    for notification in notifications {
        pending_ui_notifications.push(notification);
    }
}

/// Choose the initial world bootstrap for a fresh backend process.
pub(super) fn initial_world_bootstrap(should_seed_sample_data: bool) -> WorldBootstrap {
    if should_seed_sample_data {
        WorldBootstrap::SampleData {
            showfile_name: None,
        }
    } else {
        WorldBootstrap::Empty {
            showfile_name: None,
        }
    }
}

/// Assigns a new show's identity and persists its complete initial contents before activation.
fn finalize_new_world(
    app: &mut App,
    showfile_name: Option<&str>,
    seeded: bool,
) -> Result<(), String> {
    app.world_mut()
        .resource_mut::<crate::systems::showfile_events::CurrentShowfile>()
        .set_name(showfile_name)?;
    if showfile_name.is_some() {
        crate::systems::showfile_events::persist_new_showfile_draft_from_world(
            app.world_mut(),
            showfile_name,
            if seeded {
                sample_data::SAMPLE_AUDIO
            } else {
                &[]
            },
        )?;
    } else {
        if seeded {
            app.insert_resource(PendingSampleDraft);
        }
        crate::systems::showfile_events::refresh_clean_snapshot_hash_from_world(app.world_mut())?;
    }
    if seeded || showfile_name.is_some() {
        app.insert_state(AppState::Ready);
    }
    Ok(())
}

/// Installs a CLI/fallback sample world's draft before runtime services consume its media paths.
pub(super) fn persist_pending_sample_draft(app: &mut App) -> Result<(), String> {
    if app.world().contains_resource::<PendingSampleDraft>() {
        crate::systems::showfile_events::persist_new_showfile_draft_from_world(
            app.world_mut(),
            None,
            sample_data::SAMPLE_AUDIO,
        )?;
        app.world_mut().remove_resource::<PendingSampleDraft>();
    }
    Ok(())
}
