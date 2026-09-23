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
use nightfall_fixture_library::gdtf_activation::compile_activation;
use nightfall_fixture_library::gdtf_archive::{ArchiveLimits, ArchiveSnapshot};
use nightfall_fixture_library::gdtf_bindings::bind_selectors;
use nightfall_fixture_library::gdtf_channels::{ChannelLimits, compile_channels};
use nightfall_fixture_library::gdtf_compiler::{CompileLimits, compile_mode};
use nightfall_fixture_library::gdtf_functions::resolve_functions;
use nightfall_fixture_library::gdtf_physical::compile_physical;
use nightfall_fixture_library::gdtf_profiles::compile_profiles;
use nightfall_fixture_library::gdtf_relations::{plan_relations, resolve_relations};
use nightfall_fixture_library::gdtf_resolver::{ResolveError, ResolveLimits, resolve_mode};
use nightfall_fixture_library::gdtf_sets::resolve_sets;
use nightfall_fixture_library::gdtf_wire::resolve_wires;
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
    let resolver_source = metadata.reparse();
    let snapshot_source =
        ArchiveSnapshot::read(Path::new(&args[0]), ArchiveLimits::default().archive_bytes)
            .and_then(|snapshot| snapshot.parse(ArchiveLimits::default()));
    for mode in modes {
        let started = Instant::now();
        let definition = snapshot_source
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|source| source.compile(&mode, CompileLimits::default()));
        match definition {
            Ok(definition) => emit(json!({
                "stage": "definition", "status": "passed", "mode": mode,
                "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                "key": definition.key(),
                "geometry_count": definition.mode().geometry().nodes().len(),
                "channel_count": definition.mode().channels().channels().len(),
                "control_group_count": definition.mode().controls().groups().len(),
            })),
            Err(error) => {
                failed = true;
                emit(
                    json!({"stage": "definition", "status": "failed", "mode": mode,
                    "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                    "error": error.to_string(), "diagnostic": error}),
                );
            }
        }
        let started = Instant::now();
        let resolved = resolver_source
            .as_ref()
            .map_err(|error| ResolveError {
                code: "source_parse",
                path: mode.clone(),
                message: error.to_string(),
            })
            .and_then(|(archive, _digest)| {
                let fixture =
                    archive
                        .description
                        .fixture_types
                        .first()
                        .ok_or_else(|| ResolveError {
                            code: "missing_fixture",
                            path: mode.clone(),
                            message: "Missing fixture type".into(),
                        })?;
                resolve_mode(fixture, &mode, ResolveLimits::default()).map(|resolved| {
                    (
                        resolved,
                        &fixture.attribute_definitions,
                        &fixture.physical_descriptions.dmx_profiles,
                        fixture,
                    )
                })
            });
        match resolved {
            Ok((resolved, attributes, profile_sources, fixture)) => {
                emit(json!({
                "stage": "resolution", "status": "passed", "mode": mode,
                "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                "root_count": resolved.geometries.iter().filter(|g| g.parent.is_none()).count(),
                "beam_count": resolved.geometries.iter().filter(|g| matches!(g.source, gdtf::geometry::Geometry::Beam(_))).count(),
                "resolved": resolved,
                }));
                let started = Instant::now();
                match compile_mode(fixture, &mode, CompileLimits::default()) {
                    Ok(program) => emit(json!({
                        "stage": "compiled_mode", "status": "passed", "mode": mode,
                        "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                        "geometry": program.geometry(), "channel_count": program.channels().channels().len(),
                        "controls": program.controls(),
                    })),
                    Err(error) => {
                        failed = true;
                        emit(
                            json!({"stage": "compiled_mode", "status": "failed", "mode": mode,
                            "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                            "error": error.to_string(), "diagnostic": error}),
                        );
                    }
                }
                let started = Instant::now();
                let compiled = compile_channels(
                    &resolved,
                    attributes,
                    profile_sources,
                    ChannelLimits::default(),
                )
                .and_then(|program| {
                    let values = program.evaluate_physical(&program.defaults())?;
                    Ok((program.channels().len(), values))
                });
                match compiled {
                    Ok((channels, values)) => emit(json!({
                        "stage": "compiled_channels", "status": "passed", "mode": mode,
                        "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                        "channel_count": channels, "physical_defaults": values,
                    })),
                    Err(error) => {
                        failed = true;
                        emit(
                            json!({"stage": "compiled_channels", "status": "failed", "mode": mode,
                            "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                            "error": error.to_string(), "diagnostic": error}),
                        );
                    }
                }
                let started = Instant::now();
                match resolve_wires(&resolved) {
                    Ok(wires) => emit(json!({"stage": "wire", "status": "passed", "mode": mode,
                        "duration_ms": started.elapsed().as_secs_f64() * 1000.0, "wires": wires})),
                    Err(error) => {
                        failed = true;
                        emit(json!({"stage": "wire", "status": "failed", "mode": mode,
                            "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                            "error": error.to_string(), "diagnostic": error}));
                    }
                }
                let started = Instant::now();
                match resolve_functions(&resolved) {
                    Ok(functions) => {
                        emit(
                            json!({"stage": "functions", "status": "passed", "mode": mode,
                        "duration_ms": started.elapsed().as_secs_f64() * 1000.0, "channels": functions}),
                        );
                        let started = Instant::now();
                        match resolve_relations(&resolved, &functions, 1_000_000)
                            .and_then(|relations| plan_relations(&functions, relations))
                        {
                            Ok(plan) => emit(
                                json!({"stage": "relations", "status": "passed", "mode": mode,
                                "duration_ms": started.elapsed().as_secs_f64() * 1000.0, "relations": plan.relations(),
                                "channel_order": plan.channel_order()}),
                            ),
                            Err(error) => {
                                failed = true;
                                emit(
                                    json!({"stage": "relations", "status": "failed", "mode": mode,
                                    "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                                    "error": error.to_string(), "diagnostic": error}),
                                );
                            }
                        }
                        let started = Instant::now();
                        let physical = compile_profiles(profile_sources, 100_000)
                            .and_then(|profiles| {
                                compile_physical(&functions, profiles, 1_000_000, 1_000_000)
                            })
                            .and_then(|physical| {
                                functions
                                    .iter()
                                    .enumerate()
                                    .map(|(channel, source)| {
                                        source
                                            .functions
                                            .iter()
                                            .enumerate()
                                            .map(|(function, source)| {
                                                for set in
                                                    physical.channel_sets(channel, function)?
                                                {
                                                    physical.evaluate(
                                                        channel,
                                                        function,
                                                        set.raw_from,
                                                    )?;
                                                    physical
                                                        .evaluate(channel, function, set.raw_to)?;
                                                }
                                                Ok((
                                                    physical.evaluate_function(
                                                        channel,
                                                        function,
                                                        source.raw_from,
                                                    )?,
                                                    physical.evaluate_function(
                                                        channel,
                                                        function,
                                                        source.raw_to,
                                                    )?,
                                                ))
                                            })
                                            .collect::<Result<Vec<_>, ResolveError>>()
                                    })
                                    .collect::<Result<Vec<_>, ResolveError>>()
                            });
                        match physical {
                            Ok(endpoints) => emit(
                                json!({"stage": "physical", "status": "passed", "mode": mode,
                                "duration_ms": started.elapsed().as_secs_f64() * 1000.0, "endpoints": endpoints,
                                "set_endpoints_checked": true}),
                            ),
                            Err(error) => {
                                failed = true;
                                emit(
                                    json!({"stage": "physical", "status": "failed", "mode": mode,
                                    "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                                    "error": error.to_string(), "diagnostic": error}),
                                );
                            }
                        }
                        let started = Instant::now();
                        match resolve_sets(&functions, 1_000_000) {
                            Ok(sets) => {
                                emit(json!({"stage": "sets", "status": "passed", "mode": mode,
                                "duration_ms": started.elapsed().as_secs_f64() * 1000.0, "sets": sets}))
                            }
                            Err(error) => {
                                failed = true;
                                emit(json!({"stage": "sets", "status": "failed", "mode": mode,
                                    "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                                    "error": error.to_string(), "diagnostic": error}));
                            }
                        }
                        let started = Instant::now();
                        match bind_selectors(&resolved, &functions) {
                            Ok(bindings) => {
                                emit(
                                    json!({"stage": "bindings", "status": "passed", "mode": mode,
                                "duration_ms": started.elapsed().as_secs_f64() * 1000.0, "bindings": bindings}),
                                );
                                let started = Instant::now();
                                let defaults: Vec<_> =
                                    functions.iter().map(|channel| channel.default).collect();
                                match compile_activation(&functions, &bindings, 1_000_000)
                                    .and_then(|program| program.evaluate(&defaults))
                                {
                                    Ok(active) => emit(
                                        json!({"stage": "activation", "status": "passed", "mode": mode,
                                        "duration_ms": started.elapsed().as_secs_f64() * 1000.0, "active_defaults": active}),
                                    ),
                                    Err(error) => {
                                        failed = true;
                                        emit(
                                            json!({"stage": "activation", "status": "failed", "mode": mode,
                                            "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                                            "error": error.to_string(), "diagnostic": error}),
                                        );
                                    }
                                }
                            }
                            Err(error) => {
                                failed = true;
                                emit(
                                    json!({"stage": "bindings", "status": "failed", "mode": mode,
                                    "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                                    "error": error.to_string(), "diagnostic": error}),
                                );
                                emit(
                                    json!({"stage": "activation", "status": "failed", "mode": mode,
                                    "error": "Selector binding failed; activation unavailable"}),
                                );
                            }
                        }
                    }
                    Err(error) => {
                        failed = true;
                        emit(
                            json!({"stage": "functions", "status": "failed", "mode": mode,
                            "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                            "error": error.to_string(), "diagnostic": error}),
                        );
                        emit(
                            json!({"stage": "bindings", "status": "failed", "mode": mode,
                            "error": "Function normalization failed; selector binding unavailable"}),
                        );
                        emit(json!({"stage": "sets", "status": "failed", "mode": mode,
                            "error": "Function normalization failed; channel sets unavailable"}));
                        emit(
                            json!({"stage": "physical", "status": "failed", "mode": mode,
                            "error": "Function normalization failed; physical mapping unavailable"}),
                        );
                        emit(
                            json!({"stage": "relations", "status": "failed", "mode": mode,
                            "error": "Function normalization failed; relation binding unavailable"}),
                        );
                        emit(
                            json!({"stage": "activation", "status": "failed", "mode": mode,
                            "error": "Function normalization failed; activation unavailable"}),
                        );
                    }
                }
            }
            Err(error) => {
                failed = true;
                emit(
                    json!({"stage": "resolution", "status": "failed", "mode": mode,
                    "duration_ms": started.elapsed().as_secs_f64() * 1000.0,
                    "error": error.to_string(), "diagnostic": error}),
                );
                emit(json!({"stage": "wire", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; wire compilation unavailable"}));
                emit(
                    json!({"stage": "compiled_channels", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; owned channel compilation unavailable"}),
                );
                emit(
                    json!({"stage": "compiled_mode", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; owned mode compilation unavailable"}),
                );
                emit(
                    json!({"stage": "functions", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; function compilation unavailable"}),
                );
                emit(
                    json!({"stage": "bindings", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; selector binding unavailable"}),
                );
                emit(json!({"stage": "sets", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; channel sets unavailable"}));
                emit(
                    json!({"stage": "physical", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; physical mapping unavailable"}),
                );
                emit(
                    json!({"stage": "relations", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; relation binding unavailable"}),
                );
                emit(
                    json!({"stage": "activation", "status": "failed", "mode": mode,
                    "error": "Geometry resolution failed; activation unavailable"}),
                );
            }
        }
        let started = Instant::now();
        match convert_gdtf_to_fixture(&metadata, &mode, 1) {
            Ok((mut fixture, geometry)) => {
                // Generated runtime identifiers do not belong in structural baselines.
                fixture.identifiers.uid = uuid::Uuid::nil();
                let mut geometry = geometry;
                if let Some(source) = geometry
                    .as_mut()
                    .and_then(|geometry| geometry.gdtf.as_mut())
                {
                    source.path.clear();
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
