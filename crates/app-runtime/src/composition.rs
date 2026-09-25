// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy::{
    app::{ScheduleRunnerPlugin, TaskPoolThreadAssignmentPolicy},
    diagnostic::FrameTimeDiagnosticsPlugin,
    prelude::*,
};
use bevy_state::{app::AppExtStates, condition::in_state};
use nightfall::constants::FRAMES_PER_SECOND;
use nightfall_actions::ActionInvocationHandling;
use nightfall_config::RuntimeConfig;
use nightfall_desk::resources::log_config::LogConfig;
use nightfall_engine::prelude::*;
use nightfall_framepace::prelude::*;
use nightfall_io::{IoRuntimeSettings, TransportRuntimePolicy};

use crate::{
    engine_log_time::EngineLogTimePlugin,
    plugin_groups,
    shutdown::handle_process_shutdown_request,
    swap_orchestrator::{CommandProcessingState, PendingWorldSwapRequest, RuntimeOutputState},
    systems,
    world_factory::WorldFactory,
};

/// System set for loading, saving, and snapshotting showfile state after domain updates.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct ShowfileHandling;

const PERIODIC_DRAFT_AUTOSAVE_INTERVAL: Duration = Duration::from_secs(60);

/// Repeating timer that controls best-effort background showfile draft autosaves.
#[derive(Resource, Debug)]
pub(super) struct PeriodicDraftAutosaveTimer {
    timer: Timer,
}

impl Default for PeriodicDraftAutosaveTimer {
    /// Create a one-minute repeating timer for periodic draft autosave checks.
    fn default() -> Self {
        Self {
            timer: Timer::new(PERIODIC_DRAFT_AUTOSAVE_INTERVAL, TimerMode::Repeating),
        }
    }
}

impl PeriodicDraftAutosaveTimer {
    /// Advance the timer and return whether a draft autosave check is due.
    pub(super) fn tick(&mut self, delta: Duration) -> bool {
        self.timer.tick(delta);
        self.timer.just_finished()
    }
}

/// Builds the backend Bevy application from typed startup configuration.
pub fn init_bevy(log_config: LogConfig, runtime_config: RuntimeConfig) -> App {
    let factory = WorldFactory::for_config(log_config, runtime_config);
    init_bevy_with_transport_policy(
        factory.log_config,
        factory.transport_policy,
        &factory.runtime_config,
    )
}

/// Builds and configures a Bevy app with process-scoped runtime settings.
pub(super) fn init_bevy_with_transport_policy(
    log_config: LogConfig,
    transport_policy: TransportRuntimePolicy,
    runtime_config: &RuntimeConfig,
) -> App {
    tracing::debug!("Initializing...");
    tracing::debug!(
        path = %std::env::current_dir()
            .expect("failed to obtain working dir")
            .display(),
        "working directory"
    );

    let mut app = App::new();
    app.insert_resource(transport_policy);
    app.insert_resource(native_runtime_capabilities(
        runtime_config,
        transport_policy,
    ));
    app.insert_resource(PendingWorldSwapRequest::default());
    app.insert_resource(systems::showfile_events::CurrentShowfile::default());
    app.add_plugins(
        MinimalPlugins
            // 1ms delay between Update runs to ease CPU
            .set(ScheduleRunnerPlugin::run_loop(Duration::from_millis(1)))
            // See https://bevy-cheatbook.github.io/setup/perf.html
            // Defaults split threads between compute (system), async, asset I/O - we are compute heavy
            .set(TaskPoolPlugin {
                task_pool_options: TaskPoolOptions {
                    compute: TaskPoolThreadAssignmentPolicy {
                        // set the minimum # of compute threads to the total number of available threads
                        min_threads: bevy::tasks::available_parallelism(),
                        max_threads: usize::MAX, // unlimited max threads
                        percent: 1.0,            // this value is irrelevant in this case
                        on_thread_spawn: None,
                        on_thread_destroy: None,
                    },
                    ..default()
                },
            }),
    );
    app.add_plugins(EngineLogTimePlugin);

    app.add_plugins(FrameTimeDiagnosticsPlugin::default());
    app.add_plugins(FramepacePlugin);
    app.world_mut().resource_mut::<FramepaceSettings>().limiter =
        Limiter::from_framerate(FRAMES_PER_SECOND.into());

    app.add_plugins(plugin_groups::CorePlugins {
        websocket_port: runtime_config.server_port,
    });
    systems::showfile_events::register_showfile_http_routes(
        &mut app
            .world_mut()
            .resource_mut::<nightfall_websocket::prelude::HttpRouteRegistry>(),
    );
    #[cfg(feature = "beatgrid-detect")]
    crate::beat_model_http::register_routes(
        &mut app
            .world_mut()
            .resource_mut::<nightfall_websocket::prelude::HttpRouteRegistry>(),
    );
    crate::diagnostic_http::register_routes(
        &mut app
            .world_mut()
            .resource_mut::<nightfall_websocket::prelude::HttpRouteRegistry>(),
    );
    app.add_plugins(plugin_groups::DeskPlugins { log_config });
    app.add_plugins(plugin_groups::FxPlugins);
    app.add_plugins(plugin_groups::TimecodePlugins {
        timeline_audio_enabled: runtime_config.timeline_audio_enabled,
    });
    app.add_plugins(plugin_groups::OutputPlugins {
        network_output_enabled: transport_policy.allow_network_output,
    });
    app.add_plugins(plugin_groups::InputPlugins {
        network_input_enabled: transport_policy.allow_network_input,
        osc_bind_addr: runtime_config.osc_bind_addr,
    });

    app.init_resource::<systems::showfile_events::ShowfileCleanSnapshotHash>();
    app.init_resource::<PeriodicDraftAutosaveTimer>();
    app.insert_state(CommandProcessingState::Running);
    app.insert_state(RuntimeOutputState::Running);

    app.configure_sets(
        Update,
        (
            InputHandling.run_if(in_state(CommandProcessingState::Running)),
            ActionInvocationHandling
                .run_if(in_state(CommandProcessingState::Running))
                .after(InputHandling)
                .before(EventHandling),
            EventHandling.run_if(in_state(CommandProcessingState::Running)),
            ShowfileHandling
                .run_if(in_state(CommandProcessingState::Running))
                .after(EventHandling)
                .before(ClockUpdate),
            ClientOutput.run_if(in_state(RuntimeOutputState::Running)),
            DmxOutput.run_if(in_state(RuntimeOutputState::Running)),
        ),
    );

    {
        let mut settings = app.world_mut().resource_mut::<IoRuntimeSettings>();
        settings.network_output_enabled = transport_policy.allow_network_output;
        settings.network_input_enabled = transport_policy.allow_network_input;
        settings.usb_output_enabled = transport_policy.allow_usb_output;
    }

    // event handling - plugins add more here
    app.add_systems(
        Update,
        (
            // event generation based on showfile
            systems::showfile_events::handle_events,
            bevy::ecs::schedule::ApplyDeferred,
            systems::deleted_object_instances::release_deleted_object_instances,
            systems::quit_event::handle_events,
            handle_periodic_draft_autosave,
            handle_process_shutdown_request,
        )
            .chain()
            .in_set(ShowfileHandling),
    );

    app
}

/// Derive the client-visible native capability snapshot from build features and host policy.
fn native_runtime_capabilities(
    runtime_config: &RuntimeConfig,
    transport_policy: TransportRuntimePolicy,
) -> RuntimeCapabilities {
    RuntimeCapabilities {
        runtime_mode: RuntimeMode::Native,
        experimental_flows: runtime_config.experimental_flows,
        persistence: PersistenceCapability::Native,
        fixture_library: if cfg!(feature = "fixture-library") {
            LibraryCapability::Native
        } else {
            LibraryCapability::Unavailable
        },
        object_library: if cfg!(feature = "object-library") {
            LibraryCapability::Native
        } else {
            LibraryCapability::Unavailable
        },
        fx_modules: FxModuleCapability::Native,
        timeline_audio: if cfg!(feature = "audio") && runtime_config.timeline_audio_enabled {
            TimelineAudioCapability::Native
        } else {
            TimelineAudioCapability::Unavailable
        },
        midi_input: cfg!(feature = "midi"),
        osc_input: cfg!(feature = "osc"),
        network_dmx_input: (cfg!(feature = "artnet") || cfg!(feature = "sacn"))
            && transport_policy.allow_network_input,
        network_dmx_output: (cfg!(feature = "artnet") || cfg!(feature = "sacn"))
            && transport_policy.allow_network_output,
        usb_dmx_output: cfg!(feature = "usb") && transport_policy.allow_usb_output,
    }
}

/// Persist a dirty working draft whenever the periodic autosave interval elapses.
pub(super) fn handle_periodic_draft_autosave(
    mut showfile_save_state: systems::showfile_events::ShowfileSaveState,
    current_showfile: Res<systems::showfile_events::CurrentShowfile>,
    mut clean_snapshot_hash: ResMut<systems::showfile_events::ShowfileCleanSnapshotHash>,
    time: Res<Time>,
    mut autosave_timer: ResMut<PeriodicDraftAutosaveTimer>,
) {
    if is_process_shutdown_requested() || !autosave_timer.tick(time.delta()) {
        return;
    }

    match systems::showfile_events::save_draft_showfile_if_dirty(
        &mut showfile_save_state,
        current_showfile.name(),
        &mut clean_snapshot_hash,
        &Default::default(),
    ) {
        Ok(systems::showfile_events::DraftSaveOutcome::SavedDirtyDraft) => {
            tracing::debug!("Periodic showfile draft autosave wrote a dirty draft");
        }
        Ok(systems::showfile_events::DraftSaveOutcome::NormalizedCleanDraft) => {
            tracing::debug!("Periodic showfile draft autosave normalized clean draft");
        }
        Ok(systems::showfile_events::DraftSaveOutcome::SkippedClean) => {
            tracing::debug!("Periodic showfile draft autosave skipped clean showfile");
        }
        Err(error) => {
            tracing::warn!("Periodic showfile draft autosave failed: {}", error);
        }
    }
}
