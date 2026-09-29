// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{env, hint::black_box, time::Duration};

use bevy_app::prelude::*;
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use nightfall::blueprint::Blueprint;
use nightfall::data::{Group, Priority};
use nightfall::prelude::{SelectionExpr, SpatialSelection, UnresolvedFixtureRef};
use nightfall_compositor::prelude::Layer;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::testing::patch_bench_fixtures;
use nightfall_fx::evaluate_step_fx;
use nightfall_fx::prelude::{
    ActiveStepFx, CurveType, FxLane, FxStep, FxTrack, Linear, StepFx, StepFxLanePhaseOffsets,
};
use nightfall_instances::InstanceClock;
use nightfall_io::OutputTransport;

const DEFAULT_SELECTION_COUNTS: &[usize] = &[16, 128, 1_024];
const DEFAULT_LANE_COUNTS: &[usize] = &[1, 4];
const DEFAULT_EVALUATE_FIXTURE_COUNTS: &[usize] = &[64, 512];
const DEFAULT_FX_COUNTS: &[usize] = &[1, 32];
/// Intensity, pan and tilt lanes, all patched on every benchmark fixture.
const EVALUATE_LANE_COUNT: usize = 3;
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

/// Registers the full Step FX evaluator benchmark group.
///
/// Each iteration runs `evaluate_step_fx` once over `fx` playing effects that all select
/// `1 thru N` patched fixtures, covering selection resolution, sampling, parameter lookup and
/// layer insertion as a frame does.
fn bench_step_fx_evaluate(c: &mut Criterion) {
    let fixture_counts = configured_counts(
        "NIGHTFALL_STEP_FX_BENCH_FIXTURE_COUNTS",
        DEFAULT_EVALUATE_FIXTURE_COUNTS,
    );
    let fx_counts = configured_counts("NIGHTFALL_STEP_FX_BENCH_FX_COUNTS", DEFAULT_FX_COUNTS);

    let mut group = c.benchmark_group("step_fx_evaluate");
    for &fixture_count in &fixture_counts {
        for &fx_count in &fx_counts {
            let mut app = evaluate_app(fixture_count, fx_count);
            app.update();
            let layer_count = app
                .world_mut()
                .query::<&Layer>()
                .iter(app.world())
                .filter(|layer| layer.absolute.len() == fixture_count * EVALUATE_LANE_COUNT)
                .count();
            assert_eq!(layer_count, fx_count, "every FX should write every lane");

            group.throughput(Throughput::Elements((fixture_count * fx_count) as u64));
            let id = format!("fx={fx_count}/fixtures={fixture_count}");
            group.bench_function(BenchmarkId::from_parameter(id), |b| {
                b.iter(|| {
                    app.update();
                });
            });
        }
    }
    group.finish();
}

/// Builds an app of patched fixtures and `fx_count` playing Step FX selecting all of them.
fn evaluate_app(fixture_count: usize, fx_count: usize) -> App {
    let mut app = App::new();
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(DataProvider::<Blueprint>::default());
    patch_bench_fixtures(app.world_mut(), fixture_count, &OutputTransport::Disabled);

    let selection = SpatialSelection::identity(SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: fixture_count as u32,
            element_index: None,
        },
    });
    for fx_index in 0..fx_count {
        let fx_entity = app
            .world_mut()
            .spawn(StepFx {
                selection: selection.clone(),
                ..step_fx(EVALUATE_LANE_COUNT)
            })
            .id();
        app.world_mut().spawn((
            ActiveStepFx {
                fx_entity,
                priority: Priority(fx_index as i8),
                rate: 1.0,
                is_playing: true,
            },
            InstanceClock {
                position: Duration::from_millis(1_337),
                ..Default::default()
            },
        ));
    }
    app.add_systems(Update, evaluate_step_fx);
    app
}

criterion_group!(benches, bench_step_fx, bench_step_fx_evaluate);
criterion_main!(benches);
