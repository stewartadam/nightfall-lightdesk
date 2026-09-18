// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#[cfg(feature = "beatgrid-detect")]
use std::env;
#[cfg(feature = "beatgrid-detect")]
use std::error::Error;
#[cfg(feature = "beatgrid-detect")]
use std::path::PathBuf;

/// Command-line arguments accepted by this diagnostic example.
#[cfg(feature = "beatgrid-detect")]
#[derive(Debug)]
struct CliArgs {
    audio_path: PathBuf,
    max_events: Option<usize>,
}

/// Argument parsing outcomes for the beatgrid details example.
#[cfg(feature = "beatgrid-detect")]
enum CliParse {
    Run(CliArgs),
    Help,
}

#[cfg(feature = "beatgrid-detect")]
fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    let parsed = match parse_args(&args) {
        Ok(CliParse::Run(parsed)) => parsed,
        Ok(CliParse::Help) => {
            print_usage(&args[0]);
            return Ok(());
        }
        Err(error) => {
            eprintln!("error: {error}");
            print_usage(&args[0]);
            return Ok(());
        }
    };

    let model_paths = nightfall_timeline::beat_this_detection::BeatThisModelPaths::resolve(None)?;
    let analysis =
        nightfall_timeline::beat_this_detection::analyze_path(&parsed.audio_path, &model_paths)?;
    let bpm = nightfall_timeline::beat_this_detection::calculate_bpm(&analysis.beats);
    let beats_per_bar = nightfall_timeline::beat_this_detection::infer_beats_per_bar(
        &analysis.beats,
        &analysis.downbeats,
    );
    let first_downbeat = nightfall_timeline::beat_this_detection::first_downbeat_index(
        &analysis.beats,
        &analysis.downbeats,
    );

    println!("track={}", parsed.audio_path.display());
    println!("beat_model={}", model_paths.beat_model.display());
    println!(
        "beat_this: beats={} downbeats={} bpm={} inferred_beats_per_bar={} first_downbeat_index={}",
        analysis.beats.len(),
        analysis.downbeats.len(),
        bpm.map(|value| format!("{value:.3}"))
            .unwrap_or_else(|| "unknown".to_string()),
        beats_per_bar
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        first_downbeat
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
    );

    println!();
    println!("detected beat events:");
    let max_events = parsed.max_events.unwrap_or(analysis.beats.len());
    for (index, beat_time) in analysis.beats.iter().take(max_events).enumerate() {
        let is_downbeat = nightfall_timeline::beat_this_detection::is_model_downbeat(
            *beat_time,
            &analysis.downbeats,
        );
        let instant_bpm = if index == 0 {
            None
        } else {
            let delta = beat_time - analysis.beats[index - 1];
            (delta > 0.0).then_some(60.0 / delta)
        };
        println!(
            "  #{:03} t={:9.3}s inst_bpm={} downbeat={}",
            index,
            beat_time,
            instant_bpm
                .map(|value| format!("{value:7.3}"))
                .unwrap_or_else(|| "   n/a ".to_string()),
            is_downbeat
        );
    }

    Ok(())
}

#[cfg(feature = "beatgrid-detect")]
fn parse_args(args: &[String]) -> Result<CliParse, String> {
    let mut audio_path: Option<PathBuf> = None;
    let mut max_events: Option<usize> = None;

    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "-h" | "--help" => return Ok(CliParse::Help),
            "--max-events" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| "--max-events requires a value".to_string())?;
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| format!("invalid --max-events value: '{value}'"))?;
                if parsed == 0 {
                    return Err("--max-events must be > 0".to_string());
                }
                max_events = Some(parsed);
            }
            token if token.starts_with('-') => {
                return Err(format!("unknown flag: '{token}'"));
            }
            token => {
                if audio_path.is_none() {
                    audio_path = Some(PathBuf::from(token));
                } else {
                    return Err(format!("unexpected argument: '{token}'"));
                }
            }
        }
        index += 1;
    }

    Ok(CliParse::Run(CliArgs {
        audio_path: audio_path.ok_or_else(|| "missing <audio-file>".to_string())?,
        max_events,
    }))
}

#[cfg(feature = "beatgrid-detect")]
fn print_usage(bin_name: &str) {
    eprintln!("Usage: {bin_name} <audio-file> [--max-events N]");
    eprintln!();
    eprintln!("Uses bundled model: webui/assets/models/beat-this/beat_this.onnx");
}

#[cfg(not(feature = "beatgrid-detect"))]
fn main() {
    eprintln!(
        "This example requires the `beatgrid-detect` feature. Run with: \n\
         cargo run -p nightfall-timeline --example beatgrid_details --features beatgrid-detect -- <audio-file>"
    );
    std::process::exit(1);
}
