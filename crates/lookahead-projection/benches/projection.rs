// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, env, hint::black_box, time::Duration};

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use nightfall::prelude::{
    CueTriggerType, FixtureRef, PartialTransition, Transition, TransitionMode, ValueSource,
};
use nightfall_dmx::prelude::ParameterValue;
use nightfall_lookahead_projection::{
    project_sequence_lookahead, sequence_duration_summary, ProjectionCue, ProjectionInstruction,
    SequenceDurationProfile, SequenceDurationStep, SequenceDurationSummaryRequest,
    SequenceLookaheadProjectionRequest,
};
use uuid::Uuid;

const DEFAULT_CUE_COUNTS: &[usize] = &[16, 128, 512];
const DEFAULT_FIXTURE_COUNTS: &[usize] = &[16, 128];

/// Number of fixtures each lit cue turns on, bounding how many fixtures later cues block.
const LIT_WINDOW: usize = 8;

/// Registers all sequence lookahead projection benchmark groups.
fn bench_lookahead_projection(c: &mut Criterion) {
    let cue_counts = configured_counts("NIGHTFALL_LOOKAHEAD_BENCH_CUE_COUNTS", DEFAULT_CUE_COUNTS);
    let fixture_counts = configured_counts(
        "NIGHTFALL_LOOKAHEAD_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
    );

    bench_projection(c, &cue_counts, &fixture_counts);
    bench_duration_summary(c, &cue_counts);
}

/// Measures projecting lookahead values for the first row of a sequence, which scans every
/// downstream cue, for each cue and fixture count.
fn bench_projection(c: &mut Criterion, cue_counts: &[usize], fixture_counts: &[usize]) {
    let mut group = c.benchmark_group("lookahead_projection");

    for &cue_count in cue_counts {
        for &fixture_count in fixture_counts {
            let request = projection_request(cue_count, fixture_count);
            group.throughput(Throughput::Elements((cue_count * fixture_count) as u64));
            group.bench_with_input(
                BenchmarkId::from_parameter(format!("cues={cue_count}/fixtures={fixture_count}")),
                &request,
                |b, request| {
                    b.iter(|| black_box(project_sequence_lookahead(black_box(request)).len()));
                },
            );
        }
    }

    group.finish();
}

/// Measures computing sequence-view cue start offsets and durations for each cue count.
fn bench_duration_summary(c: &mut Criterion, cue_counts: &[usize]) {
    let mut group = c.benchmark_group("sequence_duration_summary");

    for &cue_count in cue_counts {
        let request = duration_summary_request(cue_count);
        group.throughput(Throughput::Elements(cue_count as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("cues={cue_count}")),
            &request,
            |b, request| {
                b.iter(|| black_box(sequence_duration_summary(black_box(request)).total));
            },
        );
    }

    group.finish();
}

/// Builds a sequence targeting its first cue where cues alternate between lookahead cues that
/// fan Pan and Tilt across every dark fixture, and lit cues that turn on a sliding window of
/// fixtures so later lookahead cues must skip blocked fixtures.
fn projection_request(
    cue_count: usize,
    fixture_count: usize,
) -> SequenceLookaheadProjectionRequest {
    let fixtures = (0..fixture_count).map(fixture).collect::<Vec<_>>();
    let setup_instructions = vec![ProjectionInstruction {
        fixtures: fixtures.clone(),
        values: HashMap::from([("Intensity".to_owned(), absolute_percent(0.0))]),
    }];

    let cues = (0..cue_count)
        .map(|index| {
            let instruction = if index % 2 == 0 {
                ProjectionInstruction {
                    fixtures: fixtures.clone(),
                    values: HashMap::from([
                        ("Intensity".to_owned(), absolute_percent(0.0)),
                        ("Pan".to_owned(), fanned(0.0, 100.0)),
                        ("Tilt".to_owned(), fanned(100.0, 0.0)),
                    ]),
                }
            } else {
                let window_start = (index * LIT_WINDOW) % fixture_count.max(1);
                ProjectionInstruction {
                    fixtures: fixtures
                        .iter()
                        .cycle()
                        .skip(window_start)
                        .take(LIT_WINDOW.min(fixture_count))
                        .cloned()
                        .collect(),
                    values: HashMap::from([("Intensity".to_owned(), absolute_percent(100.0))]),
                }
            };

            ProjectionCue {
                cue_uid: format!("cue-{index}"),
                cue_id: index as u32 + 1,
                lookahead: index % 2 == 0,
                instructions: vec![instruction],
                parts: Vec::new(),
            }
        })
        .collect::<Vec<_>>();

    SequenceLookaheadProjectionRequest {
        sequence_id: 1,
        wrap: true,
        target_cue_uid: cues
            .first()
            .map(|cue| cue.cue_uid.clone())
            .unwrap_or_default(),
        setup_instructions,
        cues,
    }
}

/// Builds a wrapping sequence whose cues all follow automatically with varied fade times.
fn duration_summary_request(cue_count: usize) -> SequenceDurationSummaryRequest {
    SequenceDurationSummaryRequest {
        wrap: true,
        default_timing: Transition {
            fade_in: TransitionMode::Fixed(Duration::from_secs(2)),
            ..Default::default()
        },
        steps: (0..cue_count)
            .map(|index| SequenceDurationStep {
                cue_uid: format!("cue-{index}"),
                trigger: CueTriggerType::FollowPrevious,
                transitions: PartialTransition::default(),
                parts: Vec::new(),
                duration_profile: SequenceDurationProfile {
                    max_transition_duration: Duration::from_millis((index as u64 % 7) * 250),
                },
            })
            .collect(),
    }
}

/// Builds a whole-fixture reference with a stable UID derived from its index.
fn fixture(index: usize) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(index as u128 + 1),
        index: None,
    }
}

/// Builds an inline percentage value source.
fn absolute_percent(value: f64) -> ValueSource {
    ValueSource::Inline(ParameterValue::AbsolutePercent {
        value: value.into(),
    })
}

/// Builds a two-point percentage fan interpolated across the instruction's selection.
fn fanned(start: f64, end: f64) -> ValueSource {
    ValueSource::Fanned {
        values: vec![
            ParameterValue::AbsolutePercent {
                value: start.into(),
            },
            ParameterValue::AbsolutePercent { value: end.into() },
        ],
    }
}

/// Reads a comma-separated count list from the environment, falling back to `defaults`.
fn configured_counts(variable: &str, defaults: &[usize]) -> Vec<usize> {
    env::var(variable)
        .ok()
        .map(|value| {
            value
                .split(',')
                .filter_map(|part| part.trim().parse::<usize>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| defaults.to_vec())
}

criterion_group!(benches, bench_lookahead_projection);
criterion_main!(benches);
