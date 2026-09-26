// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// Starts the headless application with shared configuration and logging.
fn main() {
    let (log_config, runtime_config, _log_guard) = app_runtime::initialize();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime")
        .block_on(app_runtime::run_headless(log_config, runtime_config));
    tracing::info!("Application exiting");
}
