// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::sync::Once;

use bevy::prelude::{AppExit, Local, MessageWriter, Res, ResMut};
use nightfall_config::ShutdownConfig;
use nightfall_engine::prelude::{
    DebugPanicTarget, init_process_shutdown, is_process_shutdown_requested,
    maybe_trigger_debug_worker_panic, process_shutdown_grace_period, process_shutdown_reason,
    request_process_shutdown, subscribe_process_shutdown,
};

use crate::systems;

/// Install the process-wide panic hook that initiates a graceful backend shutdown.
pub fn install_panic_shutdown_hook(config: &ShutdownConfig) {
    static INSTALL: Once = Once::new();
    let config = *config;
    INSTALL.call_once(|| {
        init_process_shutdown(config.grace_period, config.watchdog_disabled);
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            default_hook(info);
            let panic_message = info.to_string();
            request_process_shutdown(format!("panic: {panic_message}"));
            tracing::error!(panic = %panic_message, "Fatal panic in backend; shutdown requested");
        }));
    });
}

/// Wait for the Bevy session to finish or coordinate its fatal-shutdown grace period.
pub async fn monitor_bevy_session(mut bevy_task: tokio::task::JoinHandle<()>) -> i32 {
    let mut shutdown_rx = subscribe_process_shutdown();

    tokio::select! {
        result = &mut bevy_task => {
            handle_bevy_task_result(result).await
        }
        _ = shutdown_rx.recv() => {
            let grace_period = process_shutdown_grace_period();
            tracing::error!(
                reason = ?process_shutdown_reason(),
                grace_ms = grace_period.as_millis() as u64,
                "Process shutdown requested; waiting for Bevy thread to exit"
            );

            match tokio::time::timeout(grace_period, &mut bevy_task).await {
                Ok(Ok(())) => 1,
                Ok(Err(error)) => {
                    tracing::error!(
                        error = %error,
                        "Bevy thread exited with panic after shutdown request"
                    );
                    1
                }
                Err(_) => {
                    tracing::error!("Bevy thread did not exit within grace period; aborting");
                    std::process::abort();
                }
            }
        }
    }
}

/// Convert the Bevy worker result into the process exit code expected by the shell.
pub(super) async fn handle_bevy_task_result(result: Result<(), tokio::task::JoinError>) -> i32 {
    match result {
        Ok(()) => {
            if is_process_shutdown_requested() {
                tracing::error!(
                    reason = ?process_shutdown_reason(),
                    "Bevy thread exited after fatal shutdown request"
                );
                return 1;
            }

            tracing::debug!("Bevy thread exited; terminating app");
            0
        }
        Err(error) => {
            request_process_shutdown(format!("bevy panic: {error}"));
            let grace_period = process_shutdown_grace_period();
            tracing::error!(
                error = %error,
                grace_ms = grace_period.as_millis() as u64,
                "Bevy thread panicked; returning fatal exit code immediately"
            );
            1
        }
    }
}

/// Persist dirty state and request one graceful Bevy exit after fatal process shutdown.
pub(super) fn handle_process_shutdown_request(
    mut showfile_save_state: systems::showfile_events::ShowfileSaveState,
    current_showfile: Res<systems::showfile_events::CurrentShowfile>,
    mut clean_snapshot_hash: ResMut<systems::showfile_events::ShowfileCleanSnapshotHash>,
    mut quit_event: MessageWriter<AppExit>,
    mut sent: Local<bool>,
) {
    maybe_trigger_debug_worker_panic(DebugPanicTarget::BevyMain);

    if *sent || !is_process_shutdown_requested() {
        return;
    }

    tracing::error!(
        reason = ?process_shutdown_reason(),
        "Process shutdown requested; signaling AppExit for graceful teardown"
    );
    if let Err(error) = systems::showfile_events::save_draft_showfile_if_dirty(
        &mut showfile_save_state,
        current_showfile.name(),
        &mut clean_snapshot_hash,
        &Default::default(),
    ) {
        tracing::warn!(
            "Failed to preserve showfile draft before process shutdown: {}",
            error
        );
    }
    quit_event.write(AppExit::Success);
    *sent = true;
}
