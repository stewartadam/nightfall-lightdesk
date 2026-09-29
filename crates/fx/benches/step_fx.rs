// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{env, hint::black_box, time::Duration};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_fx::prelude::{
    CurveType, FxLane, FxStep, FxTrack, Linear, StepFx, StepFxLanePhaseOffsets,
};

const DEFAULT_SELECTION_COUNTS: &[usize] = &[16, 128, 1_024];
const DEFAULT_LANE_COUNTS: &[usize] = &[1, 4];
const STEPS_PER_TRACK: usize = 4;
const LANE_ATTRIBUTES: &[Attribute] = &[
    Attribute::Intensity,
    Attribute::Pan,
    Attribute::Tilt,
    Attribute::Red,
    Attribute::Green,
    Attribute::Blue,
];

/// Registers the Step FX sampling benchmark group.
fn bench_step_fx(c: &mut Criterion) {
    let selection_counts = configured_counts(
        "NIGHTFALL_STEP_FX_BENCH_SELECTION_COUNTS",
        DEFAULT_SELECTION_COUNTS,
    );
    let lane_counts = configured_counts("NIGHTFALL_STEP_FX_BENCH_LANE_COUNTS", DEFAULT_LANE_COUNTS);
    let offsets = StepFxLanePhaseOffsets::default();
    let elapsed = Duration::from_millis(1_337);

    let mut group = c.benchmark_group("step_fx_sample");
    for &lane_count in &lane_counts {
        let step_fx = step_fx(lane_count);
        for &selection_count in &selection_counts {
            group.throughput(Throughput::Elements((selection_count * lane_count) as u64));
            let id = format!("lanes={lane_count}/selection={selection_count}");
            group.bench_function(BenchmarkId::from_parameter(id), |b| {
                b.iter(|| {
                    // Mirrors the evaluator, which samples every lane once per selection member.
                    for selection_index in 0..selection_count {
                        black_box(
                            step_fx.sample_for_selection_index_with_offsets_and_blueprints(
                                black_box(elapsed),
                                selection_index,
                                selection_count,
                                &offsets,
                                None,
                            ),
                        );
                    }
                });
            });
        }
    }
    group.finish();
}

/// Builds a Step FX with `lane_count` linear lanes of alternating absolute percent steps.
fn step_fx(lane_count: usize) -> StepFx {
    let lanes = LANE_ATTRIBUTES
        .iter()
        .cycle()
        .take(lane_count)
        .map(|attribute| FxLane {
            attribute: attribute.clone(),
            timing_override: None,
            phase_override: None,
            absolute: Some(FxTrack {
                steps: (0..STEPS_PER_TRACK)
                    .map(|step| {
                        FxStep::new(
                            ParameterValue::AbsolutePercent {
                                value: ((step % 2) as f32).into(),
                            },
                            1.0,
                            0.5.into(),
                            CurveType::Linear(Linear {}),
                        )
                    })
                    .collect(),
            }),
            relative: None,
        })
        .collect();
    StepFx {
        lanes,
        ..StepFx::default()
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

criterion_group!(benches, bench_step_fx);
criterion_main!(benches);
