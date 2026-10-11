// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Validates showfiles through the same migration and deserialization path the engine loads with.
//!
//! Accepts `.nightfall-show` directories (preferring `showfile.json.gz` over `showfile.json`, as
//! the engine does) or direct `.json` / `.json.gz` snapshot paths. Prints the schema version each
//! file migrated from and to with a summary of its contents, and exits non-zero if any fail.
//!
//! ```sh
//! cargo run -p nightfall-showfile --features midi,osc --example validate -- <showfile>...
//! ```

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::ExitCode,
};

use flate2::read::MultiGzDecoder;
use nightfall_showfile::{
    CURRENT_SHOWFILE_VERSION, ShowfileSnapshot, parse_showfile_snapshot_json,
    validate_showfile_asset_versions,
};

/// Plain snapshot filename inside a show directory.
const SNAPSHOT_FILENAME: &str = "showfile.json";
/// Gzip snapshot filename inside a show directory, preferred when present.
const COMPRESSED_SNAPSHOT_FILENAME: &str = "showfile.json.gz";

/// Validates every showfile path given on the command line and reports a combined exit status.
fn main() -> ExitCode {
    let paths: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if paths.is_empty() {
        eprintln!("Usage: validate <showfile-dir | showfile.json | showfile.json.gz>...");
        return ExitCode::from(2);
    }

    let mut failed = false;
    for path in &paths {
        match validate(path) {
            Ok(report) => println!("OK   {}\n     {report}", path.display()),
            Err(error) => {
                failed = true;
                eprintln!("FAIL {}\n     {error}", path.display());
            }
        }
    }

    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// Reads, migrates, and deserializes one showfile, returning a one-line summary on success.
fn validate(path: &Path) -> Result<String, String> {
    let snapshot_path = snapshot_path(path);
    let json = read_snapshot_json(&snapshot_path)?;
    let source = snapshot_path.display().to_string();
    let from_version = stored_version(&json, &source)?;
    let snapshot = parse_showfile_snapshot_json(&json, &source)?;
    validate_showfile_asset_versions(&snapshot)?;
    Ok(format!(
        "version {from_version} -> {CURRENT_SHOWFILE_VERSION}; {}",
        summarize(&snapshot)
    ))
}

/// Resolves a show directory to its snapshot file, matching the engine's gzip-first preference.
fn snapshot_path(path: &Path) -> PathBuf {
    if !path.is_dir() {
        return path.to_path_buf();
    }
    let compressed = path.join(COMPRESSED_SNAPSHOT_FILENAME);
    if compressed.exists() {
        compressed
    } else {
        path.join(SNAPSHOT_FILENAME)
    }
}

/// Reads snapshot JSON, transparently decoding gzip snapshots by their `.gz` extension.
fn read_snapshot_json(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let mut reader: Box<dyn Read> = if path.extension().is_some_and(|extension| extension == "gz") {
        Box::new(MultiGzDecoder::new(file))
    } else {
        Box::new(file)
    };
    let mut json = String::new();
    reader
        .read_to_string(&mut json)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    Ok(json)
}

/// Returns the schema version recorded in the file before any migration runs.
fn stored_version(json: &str, source: &str) -> Result<u64, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| format!("failed to parse showfile {source}: {error}"))?;
    value["metadata"]["showfileVersion"]
        .as_u64()
        .ok_or_else(|| format!("showfile {source} has no numeric metadata.showfileVersion"))
}

/// Summarizes the entity counts of a parsed snapshot for the success line.
fn summarize(snapshot: &ShowfileSnapshot) -> String {
    [
        format!("{} fixtures", snapshot.fixtures.len()),
        format!("{} groups", snapshot.groups.len()),
        format!("{} cues", snapshot.cues.len()),
        format!("{} clips", snapshot.clips.len()),
        format!("{} timelines", snapshot.timelines.len()),
        format!("{} input bindings", snapshot.bindings.input.len()),
        format!("{} MIDI mappings", snapshot.midi_mappings.len()),
        format!("{} OSC mappings", snapshot.osc_mappings.len()),
    ]
    .join(", ")
}
