// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, env, time::Duration};

use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemState;
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use moonshine_kind::prelude::InstanceRef;
use nightfall::prelude::{
    Group, Identifiers, PartialTransition, SelectionExpr, SpatialSelection, TransitionMode,
    UnresolvedFixtureRef, ValueSource,
};
use nightfall_compositor::prelude::Layer;
use nightfall_cues::materialized_cue::paint_materialized_cues;
use nightfall_cues::materialized_sequence::paint_materialized_sequences;
use nightfall_cues::prelude::{
    BoundCueInstruction, Cue, CueInstruction, MaterializedCue, MaterializedSequence, Sequence,
};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::prelude::{FixtureDataProviderExt, Parameter};
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_fixtures::testing::patch_bench_fixtures;
use nightfall_instances::InstanceClock;
use nightfall_io::OutputTransport;
use uuid::Uuid;

const DEFAULT_FIXTURE_COUNTS: &[usize] = &[64, 512];
const DEFAULT_PLAYBACK_COUNTS: &[usize] = &[1, 8];
/// Cues in every benchmark sequence.
const SEQUENCE_STEPS: usize = 4;
/// Attributes each benchmark cue asserts on every selected fixture.
const CUE_ATTRIBUTES: &[Attribute] = &[
    Attribute::Intensity,
    Attribute::Pan,
    Attribute::Tilt,
    Attribute::Red,
    Attribute::Green,
    Attribute::Blue,
];

/// Registers the standalone cue painting benchmark group.
///
/// Each iteration runs `paint_materialized_cues` over `cues` fading cues that each assert every
/// patched fixture, so the snapshot of the existing layer stack holds the previous frame's cue
/// layers as it does in a running show.
fn bench_cue_paint(c: &mut Criterion) {
    let mut group = c.benchmark_group("cue_paint");
    for fixture_count in fixture_counts() {
        for cue_count in playback_counts() {
            let mut app = playback_app(fixture_count);
            for cue_index in 0..cue_count {
                let cue = bench_cue(cue_index, fixture_count);
                let materialized = materialize_cue(app.world_mut(), &cue);
                app.world_mut().spawn((materialized, playback_clock()));
            }
            app.add_systems(Update, paint_materialized_cues);
            app.update();
            assert_painted_layers(&mut app, cue_count, fixture_count);

            group.throughput(Throughput::Elements((fixture_count * cue_count) as u64));
            let id = format!("cues={cue_count}/fixtures={fixture_count}");
            group.bench_function(BenchmarkId::from_parameter(id), |b| {
                b.iter(|| app.update());
            });
        }
    }
    group.finish();
}

/// Registers the sequence painting benchmark group.
///
/// Each iteration runs `paint_materialized_sequences` over `sequences` playing sequences of
/// fading cues that each assert every patched fixture.
fn bench_sequence_paint(c: &mut Criterion) {
    let mut group = c.benchmark_group("sequence_paint");
    for fixture_count in fixture_counts() {
        for sequence_count in playback_counts() {
            let mut app = playback_app(fixture_count);
            for sequence_index in 0..sequence_count {
                let steps = (0..SEQUENCE_STEPS)
                    .map(|step| bench_cue(sequence_index * SEQUENCE_STEPS + step, fixture_count))
                    .collect::<Vec<_>>();
                let sequence = Sequence {
                    identifiers: bench_identifiers(sequence_index, "sequence"),
                    steps: steps.iter().map(|cue| cue.identifiers.uid.into()).collect(),
                    ..Default::default()
                };
                let materialized = materialize_sequence(app.world_mut(), &sequence, steps);
                app.world_mut().spawn((materialized, playback_clock()));
            }
            app.add_systems(Update, paint_materialized_sequences);
            app.update();
            assert_painted_layers(&mut app, sequence_count, fixture_count);

            group.throughput(Throughput::Elements(
                (fixture_count * sequence_count) as u64,
            ));
            let id = format!("sequences={sequence_count}/fixtures={fixture_count}");
            group.bench_function(BenchmarkId::from_parameter(id), |b| {
                b.iter(|| app.update());
            });
        }
    }
    group.finish();
}

/// Builds an app of patched fixtures with the resources cue materialization reads.
fn playback_app(fixture_count: usize) -> App {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    patch_bench_fixtures(app.world_mut(), fixture_count, &OutputTransport::Disabled);
    app
}

/// Asserts that every playback painted a layer covering every cue attribute on every fixture.
fn assert_painted_layers(app: &mut App, playback_count: usize, fixture_count: usize) {
    let expected = fixture_count * CUE_ATTRIBUTES.len();
    let painted = app
        .world_mut()
        .query::<&Layer>()
        .iter(app.world())
        .filter(|layer| layer.absolute.len() == expected)
        .count();
    assert_eq!(
        painted, playback_count,
        "every playback should paint every fixture"
    );
}

/// Builds a cue fading every [`CUE_ATTRIBUTES`] entry to a value on fixtures `1..=fixture_count`.
fn bench_cue(cue_index: usize, fixture_count: usize) -> Cue {
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
    let values = CUE_ATTRIBUTES
        .iter()
        .map(|attribute| {
            let value = ((cue_index * 37) % 256) as f32;
            (
                attribute.clone(),
                ValueSource::Inline(ParameterValue::Absolute { value }),
            )
        })
        .collect::<HashMap<_, _>>();

    Cue {
        identifiers: bench_identifiers(cue_index, "cue"),
        transitions: PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(10))),
            ..Default::default()
        },
        instructions: vec![BoundCueInstruction {
            selection,
            cue_instruction: CueInstruction {
                values,
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Builds stable identifiers for a benchmark cue or sequence.
fn bench_identifiers(index: usize, kind: &str) -> Identifiers {
    Identifiers {
        id: index as u32 + 1,
        uid: Uuid::from_u128(((kind.len() as u128) << 64) | index as u128),
        label: format!("bench {kind} {}", index + 1),
    }
}

/// Returns a playback clock midway through every benchmark cue's fade.
fn playback_clock() -> InstanceClock {
    InstanceClock {
        position: Duration::from_secs(5),
        ..Default::default()
    }
}

/// Materializes `cue` against the patched fixtures in `world`.
fn materialize_cue(world: &mut World, cue: &Cue) -> MaterializedCue {
    let mut state = SystemState::<(
        Res<FixtureDataProviderExt>,
        SpatialSelectionResolver,
        Query<InstanceRef<Parameter>>,
    )>::new(world);
    let (fixtures, selection_resolver, parameters) = state.get(world).expect("cue resources");
    MaterializedCue::materialize(cue, &fixtures, &parameters, &selection_resolver)
}

/// Materializes `sequence` with explicit `steps` against the patched fixtures in `world`.
fn materialize_sequence(
    world: &mut World,
    sequence: &Sequence,
    steps: Vec<Cue>,
) -> MaterializedSequence {
    let mut state = SystemState::<(
        Res<FixtureDataProviderExt>,
        SpatialSelectionResolver,
        Query<InstanceRef<Parameter>>,
    )>::new(world);
    let (fixtures, selection_resolver, parameters) = state.get(world).expect("sequence resources");
    MaterializedSequence::materialize_from_steps(
        sequence,
        steps,
        &fixtures,
        &parameters,
        &selection_resolver,
    )
}

/// Returns the fixture counts to benchmark, honoring the environment override.
fn fixture_counts() -> Vec<usize> {
    configured_counts(
        "NIGHTFALL_PAINT_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
    )
}

/// Returns the cue or sequence counts to benchmark, honoring the environment override.
fn playback_counts() -> Vec<usize> {
    configured_counts(
        "NIGHTFALL_PAINT_BENCH_PLAYBACK_COUNTS",
        DEFAULT_PLAYBACK_COUNTS,
    )
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

criterion_group!(benches, bench_cue_paint, bench_sequence_paint);
criterion_main!(benches);
