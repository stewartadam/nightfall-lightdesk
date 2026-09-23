// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Emit JSON Lines for actual Nightfall GDTF parsing and mode conversion.
//!
//! Invoke with an archive path and optionally one exact mode name. The corpus
//! orchestrator bounds process time; each completed stage flushes independently.

use std::io::{self, Write};
use std::path::Path;
use std::time::Instant;

use nightfall_fixture_library::GdtfMetadata;
use nightfall_fixture_library::converters::gdtf::convert_gdtf_to_fixture;
use serde_json::json;

/// Flush a completed stage so a timeout does not erase earlier measurements.
fn emit(value: serde_json::Value) {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value).expect("write probe result");
    writeln!(stdout).expect("terminate probe result");
    stdout.flush().expect("flush probe result");
}

/// Parse one real archive and measure conversion without blessing its output.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !(1..=2).contains(&args.len()) {
        eprintln!("Usage: gdtf_probe <archive.gdtf> [exact-mode-name]");
        std::process::exit(2);
    }
    let started = Instant::now();
    let metadata = match GdtfMetadata::from_file(Path::new(&args[0])) {
        Ok(metadata) => metadata,
        Err(error) => {
            emit(
                json!({"stage": "parse", "status": "failed", "error": error.to_string(),
                "duration_ms": started.elapsed().as_secs_f64() * 1000.0}),
            );
            std::process::exit(1);
        }
    };
    emit(
        json!({"stage": "parse", "status": "passed", "modes": metadata.modes,
        "duration_ms": started.elapsed().as_secs_f64() * 1000.0}),
    );
    let modes = args
        .get(1)
        .map_or_else(|| metadata.modes.clone(), |mode| vec![mode.clone()]);
    let mut failed = false;
    for mode in modes {
        let started = Instant::now();
        match convert_gdtf_to_fixture(&metadata, &mode, 1) {
            Ok((mut fixture, geometry)) => {
                // Generated runtime identifiers do not belong in structural baselines.
                fixture.identifiers.uid = uuid::Uuid::nil();
                let mut geometry = geometry;
                if let Some(geometry) = geometry.as_mut() {
                    geometry.gdtf_path = None;
                }
                emit(
                    json!({"stage": "conversion", "status": "passed", "mode": mode,
                    "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                    "fixture": fixture, "geometry": geometry}),
                );
            }
            Err(error) => {
                failed = true;
                emit(
                    json!({"stage": "conversion", "status": "failed", "mode": mode,
                    "error": error.to_string(),
                    "duration_ms": started.elapsed().as_secs_f64() * 1000.0}),
                );
            }
        }
    }
    std::process::exit(i32::from(failed));
}
