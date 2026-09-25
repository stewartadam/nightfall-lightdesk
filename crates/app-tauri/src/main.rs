// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Prevent an additional console window in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_shell;

/// Starts the desktop shell and retains the logging guard until shutdown.
fn main() {
    let (log_config, runtime_config, _log_guard) = app_runtime::initialize();
    desktop_shell::run_tauri(log_config, runtime_config);
    tracing::info!("Application exiting");
}
