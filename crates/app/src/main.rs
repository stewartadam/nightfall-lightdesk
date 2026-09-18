// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::File,
    io::IsTerminal,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use nightfall::{constants::APP_LOG_FILE_NAME, nightfall_data_dir, set_nightfall_data_dir};
use nightfall_app_lib::EngineLogTimer;
use nightfall_desk::resources::log_config::{LogConfig, TracingTarget};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{
    EnvFilter, fmt::writer::BoxMakeWriter, layer::SubscriberExt, reload, util::SubscriberInitExt,
};

fn app_log_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(APP_LOG_FILE_NAME)
}

fn open_log_file(path: &Path) -> Result<File, String> {
    File::create(path)
        .map_err(|error| format!("failed to open log file {}: {}", path.display(), error))
}

fn create_log_file_writer() -> Result<(BoxMakeWriter, WorkerGuard, PathBuf), String> {
    let data_dir = nightfall_data_dir()
        .ok_or_else(|| "could not determine Nightfall data directory".to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "failed to create Nightfall data directory {} for logging: {}",
            data_dir.display(),
            error
        )
    })?;

    let log_path = app_log_file_path(&data_dir);
    let log_file = open_log_file(&log_path)?;
    let (non_blocking, guard) = tracing_appender::non_blocking(log_file);
    Ok((BoxMakeWriter::new(non_blocking), guard, log_path))
}

/// Initializes console and file tracing from the resolved startup filter.
fn init_logging(log_filter: Option<&str>) -> (LogConfig, Option<WorkerGuard>) {
    let initial_tracing_target = TracingTarget::new(log_filter);
    let initial_filter = EnvFilter::new(initial_tracing_target.filter_str.clone());
    let (filter_layer, reload_handle) = reload::Layer::new(initial_filter);
    let engine_log_timer = EngineLogTimer;

    let console_writer = BoxMakeWriter::new(std::io::stdout);
    let (file_writer, file_guard, log_file_status) = match create_log_file_writer() {
        Ok((writer, guard, path)) => (writer, Some(guard), Ok(path)),
        Err(error) => (BoxMakeWriter::new(std::io::sink), None, Err(error)),
    };

    tracing_subscriber::registry()
        .with(filter_layer)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(console_writer)
                .with_timer(engine_log_timer)
                .with_ansi(std::io::stdout().is_terminal()),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_writer(file_writer)
                .with_ansi(false),
        )
        .init();

    let tracing_target = Arc::new(RwLock::new(initial_tracing_target));
    let log_config = LogConfig::new(move |filter| reload_handle.reload(filter), tracing_target);

    match log_file_status {
        Ok(path) => tracing::info!(path = %path.display(), "Writing logs to file"),
        Err(error) => tracing::warn!("{error}"),
    }

    (log_config, file_guard)
}

/// Loads startup configuration and launches the desktop or headless application.
fn main() {
    let runtime_config = nightfall_app_lib::load_runtime_config().unwrap_or_else(|error| {
        eprintln!("Failed to load startup configuration: {error}");
        std::process::exit(2);
    });
    set_nightfall_data_dir(runtime_config.data_dir.clone());
    let (log_config, _log_file_guard) = init_logging(runtime_config.log_filter.as_deref());
    nightfall_app_lib::install_panic_shutdown_hook(&runtime_config.shutdown);

    // Initialize and run either the Tauri app or headless app
    {
        #[cfg(feature = "tauri")]
        nightfall_app_lib::run_tauri(log_config, runtime_config);

        #[cfg(not(feature = "tauri"))]
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime")
            .block_on(nightfall_app_lib::run_headless(log_config, runtime_config));
    }

    tracing::info!("Application exiting");
}

#[cfg(test)]
mod tests {
    use std::{io::Write, path::Path};

    use super::{app_log_file_path, open_log_file};

    #[test]
    fn app_log_file_path_uses_nightfall_log_name() {
        let data_dir = Path::new("temp").join("nightfall");
        let path = app_log_file_path(&data_dir);
        assert_eq!(path, data_dir.join("nightfall.log"));
    }

    #[test]
    fn open_log_file_truncates_existing_log() {
        let temp_dir =
            std::env::temp_dir().join(format!("nightfall-open-log-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).expect("create temp dir");
        let log_path = temp_dir.join("nightfall.log");
        std::fs::write(&log_path, b"stale log contents").expect("write old log");

        let mut log_file = open_log_file(&log_path).expect("open log file");
        log_file.write_all(b"fresh").expect("write fresh log");
        drop(log_file);

        assert_eq!(
            std::fs::read_to_string(&log_path).expect("read log"),
            "fresh"
        );

        std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
    }
}
