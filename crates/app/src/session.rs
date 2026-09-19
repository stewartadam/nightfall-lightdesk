// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy::prelude::{App, AppExit};
use nightfall_config::RuntimeConfig;
use nightfall_desk::{
    prelude::{UiNotification, UiNotificationState},
    resources::log_config::LogConfig,
};
use nightfall_engine::prelude::{
    ClientEventSink, CommandError, CommandId, CommandOutcome, CommandResult,
    DISCRIMINATOR_NON_DROPPABLE, EngineClientMessage, ResyncRequested, finish_command_in_world,
};

use crate::{
    process_policy::{apply_backend_thread_priority, pin_backend_thread_to_performance_core},
    shutdown::monitor_bevy_session,
    startup_commands::{STARTUP_CMDS_ENV, get_stdin, queue_startup_command},
    swap_orchestrator::{PendingWorldSwap, PendingWorldSwapRequest, SwapOrchestrator},
    systems,
    world_factory::{
        WorldFactory, bootstrap_world_with_fallback, initial_world_bootstrap,
        queue_startup_ui_notifications,
    },
};

/// Run one Bevy session and replace its world atomically when showfiles change.
pub(super) fn run_bevy_session(
    thread_role: &'static str,
    log_config: LogConfig,
    runtime_config: RuntimeConfig,
    stdin_commands: Option<String>,
) {
    apply_backend_thread_priority(thread_role);

    let bootstrap = initial_world_bootstrap(runtime_config.startup.sample_data);
    let startup_commands = runtime_config.startup.commands.clone();
    let factory = WorldFactory::for_config(log_config, runtime_config);
    let (mut bevy_app, startup_ui_notifications) = match bootstrap_world_with_fallback(
        |selected_bootstrap| factory.build(selected_bootstrap),
        bootstrap,
    ) {
        Ok(result) => result,
        Err(error) => {
            tracing::error!("Failed to bootstrap world: {}", error);
            return;
        }
    };
    if let Err(error) = crate::world_factory::persist_pending_sample_draft(&mut bevy_app) {
        tracing::error!("Failed to install sample show media: {error}");
        return;
    }
    pin_backend_thread_to_performance_core(thread_role);
    queue_startup_ui_notifications(&mut bevy_app, startup_ui_notifications);

    // Send startup commands through DeskCommand::Eval so they go through
    // the same scheduling pipeline as WebSocket/WebUI commands.
    if let Some(cmd_str) = startup_commands {
        queue_startup_command(&mut bevy_app, STARTUP_CMDS_ENV, cmd_str);
    }

    // Read command string from stdin when piped.
    if let Some(cmd_str) = stdin_commands {
        queue_startup_command(&mut bevy_app, "stdin", cmd_str);
    }

    bevy_app.set_runner(move |app| run_world_swap_session_loop(app, factory));
    let exit = bevy_app.run();
    tracing::debug!(?exit, "Bevy thread exiting");
}

/// Custom Bevy runner that preserves `app.run()` entrypoints while orchestrating world swaps.
pub(super) fn run_world_swap_session_loop(initial_app: App, factory: WorldFactory) -> AppExit {
    let mut orchestrator = SwapOrchestrator::new(initial_app);
    let diagnostic_requests = crate::diagnostic_showfile::register_requests();

    loop {
        orchestrator.active_app_mut().update();
        crate::diagnostic_showfile::respond_to_requests(
            &diagnostic_requests,
            orchestrator.active_app_mut().world_mut(),
        );

        if let Some(exit) = orchestrator.active_app().should_exit() {
            return exit;
        }

        let pending_world_swap_requests = orchestrator
            .active_app_mut()
            .world_mut()
            .get_resource_mut::<PendingWorldSwapRequest>()
            .map(|mut pending| pending.take_requests())
            .unwrap_or_default();
        for request in pending_world_swap_requests {
            match orchestrator.stage_and_swap_with_before_commit(
                &factory,
                request.bootstrap(),
                0,
                |active_app| {
                    complete_and_publish_world_swap_success(active_app, &request);
                },
            ) {
                Err(error) => {
                    tracing::error!(
                        "Failed to stage/swap world for {}: {}",
                        request.description(),
                        error
                    );
                    let command_id = CommandId::from(request.correlation_id());
                    if let Err(lifecycle_error) = finish_command_in_world(
                        orchestrator.active_app_mut().world_mut(),
                        command_id,
                        CommandOutcome::failed(CommandError::new(
                            "showfile.world_swap_failed",
                            error,
                        )),
                    ) {
                        tracing::error!(%command_id, %lifecycle_error, "world_swap_failure_completion_failed");
                    }
                }
                Ok(_previous_app) => {
                    queue_current_showfile_changed(orchestrator.active_app_mut(), &request);
                    queue_post_swap_resync(orchestrator.active_app_mut());
                }
            }
        }

        std::thread::sleep(Duration::from_millis(1));
    }
}

/// Completes and directly sends success before the current world is replaced.
///
/// The lifecycle messages written here belong to the outgoing world, which is
/// dropped immediately after this callback without another client-output
/// tick. The direct send is therefore the only transport delivery, not a
/// duplicate of the queued `CommandReply`.
pub(super) fn complete_and_publish_world_swap_success(
    bevy_app: &mut App,
    request: &PendingWorldSwap,
) {
    let result = CommandResult {
        command_id: CommandId::from(request.correlation_id()),
        outcome: CommandOutcome::succeeded(),
    };
    if let Err(error) = finish_command_in_world(
        bevy_app.world_mut(),
        result.command_id,
        result.outcome.clone(),
    ) {
        tracing::error!(command_id = %result.command_id, %error, "world_swap_success_completion_failed");
        return;
    }
    let Some(client_events) = bevy_app.world().get_resource::<ClientEventSink>() else {
        tracing::warn!(
            correlation_id = %request.correlation_id(),
            "Failed to publish world swap success; client event sink was missing"
        );
        return;
    };
    client_events.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &EngineClientMessage::CommandResult(&result),
    );
}

/// Queue a backend-confirmed current showfile change after a successful world swap.
pub(super) fn queue_current_showfile_changed(bevy_app: &mut App, _request: &PendingWorldSwap) {
    let current_showfile = bevy_app
        .world()
        .get_resource::<systems::showfile_events::CurrentShowfile>()
        .and_then(|showfile| showfile.name().map(str::to_string));
    let Some(mut pending_ui_notifications) = bevy_app
        .world_mut()
        .get_resource_mut::<UiNotificationState>()
    else {
        tracing::error!("Failed to get UiNotificationState resource for current showfile change");
        return;
    };

    pending_ui_notifications.push(UiNotification::current_showfile_changed(current_showfile));
}

/// Publishes an internal post-swap resync request in the active world.
pub(super) fn queue_post_swap_resync(bevy_app: &mut App) {
    bevy_app
        .world_mut()
        .write_message(ResyncRequested { command_id: None });
}

/// Runs the backend without a desktop shell and propagates fatal worker failures.
pub async fn run_headless(log_config: LogConfig, runtime_config: RuntimeConfig) {
    let stdin_commands = get_stdin();

    let bevy_task = tokio::task::spawn_blocking(move || {
        run_bevy_session("bevy-session", log_config, runtime_config, stdin_commands)
    });
    let exit_code = monitor_bevy_session(bevy_task).await;
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}
