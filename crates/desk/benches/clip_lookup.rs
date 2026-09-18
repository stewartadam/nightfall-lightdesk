// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{env, hint::black_box};

use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use nightfall::prelude::Identifiers;
use nightfall_clips::{Clip, ClipLookup, MaterializedClip};
use nightfall_instances::InstanceId;
use uuid::Uuid;

const DEFAULT_DEFINED_COUNTS: &[usize] = &[0, 100, 500, 1_000, 2_500, 5_000, 10_000];
const DEFAULT_LOOKUP_COUNTS: &[usize] = &[1, 8, 64, 512];
const DEFAULT_ACTIVE_COUNTS: &[usize] = &[0, 1, 16, 64, 256];
const ACTIVE_SCAN_LOOKUPS: usize = 8;

/// Identifier pairs resolved by one benchmark system invocation.
#[derive(Resource)]
struct LookupTargets {
    identifiers: Vec<(u32, Uuid)>,
}

/// Persistent clip UUIDs resolved before scanning active clip instances.
#[derive(Resource)]
struct ActiveScanTargets {
    clip_uids: Vec<Uuid>,
}

/// Lookup implementation exercised by a strategy benchmark case.
#[derive(Clone, Copy)]
enum LookupStrategy {
    Direct,
    Snapshot,
}

/// Registers all clip lookup benchmark groups.
fn bench_clip_lookup(c: &mut Criterion) {
    let defined_counts = configured_counts(
        "NIGHTFALL_CLIP_BENCH_DEFINED_COUNTS",
        DEFAULT_DEFINED_COUNTS,
    );
    let lookup_counts =
        configured_counts("NIGHTFALL_CLIP_BENCH_LOOKUP_COUNTS", DEFAULT_LOOKUP_COUNTS);
    let active_counts =
        configured_counts("NIGHTFALL_CLIP_BENCH_ACTIVE_COUNTS", DEFAULT_ACTIVE_COUNTS);

    bench_snapshot_builds(c, &defined_counts);
    bench_lookup_strategies(c, &defined_counts, &lookup_counts);
    bench_active_scans(c, &defined_counts, &active_counts);
}

/// Measures one snapshot consumer and the three consumers currently run by timeline updates.
fn bench_snapshot_builds(c: &mut Criterion, defined_counts: &[usize]) {
    let mut group = c.benchmark_group("clip_snapshot_build");

    for &defined_count in defined_counts {
        group.bench_with_input(
            BenchmarkId::new("one_consumer", defined_count),
            &defined_count,
            |b, &defined_count| {
                let mut app = clip_app(defined_count);
                app.add_systems(Update, build_snapshot_once);
                app.update();

                b.iter(|| app.update());
            },
        );

        group.bench_with_input(
            BenchmarkId::new("three_consumers", defined_count),
            &defined_count,
            |b, &defined_count| {
                let mut app = clip_app(defined_count);
                app.add_systems(
                    Update,
                    (
                        build_first_timeline_snapshot,
                        build_second_timeline_snapshot,
                        build_third_timeline_snapshot,
                    )
                        .chain(),
                );
                app.update();

                b.iter(|| app.update());
            },
        );
    }

    group.finish();
}

/// Measures when repeated identifier scans become more expensive than building a snapshot.
fn bench_lookup_strategies(c: &mut Criterion, defined_counts: &[usize], lookup_counts: &[usize]) {
    let mut group = c.benchmark_group("clip_lookup_strategy");

    for &defined_count in defined_counts {
        for &lookup_count in lookup_counts {
            group.bench_function(
                BenchmarkId::new(
                    format!("direct/defined={defined_count}"),
                    format!("lookups={lookup_count}"),
                ),
                |b| {
                    let mut app = lookup_app(defined_count, lookup_count, LookupStrategy::Direct);
                    app.update();

                    b.iter(|| app.update());
                },
            );

            group.bench_function(
                BenchmarkId::new(
                    format!("snapshot/defined={defined_count}"),
                    format!("lookups={lookup_count}"),
                ),
                |b| {
                    let mut app = lookup_app(defined_count, lookup_count, LookupStrategy::Snapshot);
                    app.update();

                    b.iter(|| app.update());
                },
            );
        }
    }

    group.finish();
}

/// Measures snapshot resolution together with the active-instance scan used by rate masters.
fn bench_active_scans(c: &mut Criterion, defined_counts: &[usize], active_counts: &[usize]) {
    let mut group = c.benchmark_group("clip_lookup_with_active_scan");

    for &defined_count in defined_counts.iter().filter(|&&count| count > 0) {
        for &active_count in active_counts {
            group.bench_function(
                BenchmarkId::new(
                    format!("defined={defined_count}"),
                    format!("active={active_count}"),
                ),
                |b| {
                    let mut app = active_scan_app(defined_count, active_count);
                    app.update();

                    b.iter(|| app.update());
                },
            );
        }
    }

    group.finish();
}

/// Builds an ECS app containing the requested number of persistent clip definitions.
fn clip_app(defined_count: usize) -> App {
    let mut app = App::new();
    for index in 0..defined_count {
        app.world_mut().spawn(clip(index));
    }
    app
}

/// Builds an app that executes one direct or snapshot lookup workload per update.
fn lookup_app(defined_count: usize, lookup_count: usize, strategy: LookupStrategy) -> App {
    let mut app = clip_app(defined_count);
    app.insert_resource(LookupTargets {
        identifiers: lookup_targets(defined_count, lookup_count),
    });
    match strategy {
        LookupStrategy::Direct => app.add_systems(Update, direct_lookups),
        LookupStrategy::Snapshot => app.add_systems(Update, snapshot_lookups),
    };
    app
}

/// Builds an app with persistent definitions and independently sized active clip instances.
fn active_scan_app(defined_count: usize, active_count: usize) -> App {
    let mut app = clip_app(defined_count);

    for index in 0..active_count {
        app.world_mut().spawn(MaterializedClip {
            clip_id: clip_id(index % defined_count),
            attached_instance: InstanceId(Uuid::from_u128((index + 1) as u128)),
            auto_release_on_stop: false,
        });
    }

    app.insert_resource(ActiveScanTargets {
        clip_uids: (0..ACTIVE_SCAN_LOOKUPS)
            .map(|index| clip_uid(index % defined_count))
            .collect(),
    });
    app.add_systems(Update, snapshot_lookups_with_active_scan);
    app
}

/// Creates one persistent clip definition with deterministic unique identifiers.
fn clip(index: usize) -> Clip {
    let id = clip_id(index);
    Clip {
        identifiers: Identifiers {
            id,
            uid: clip_uid(index),
            label: format!("Clip {id}"),
        },
        ..Default::default()
    }
}

/// Converts a zero-based benchmark index into a console-facing clip ID.
fn clip_id(index: usize) -> u32 {
    u32::try_from(index + 1).expect("benchmark clip count must fit in u32")
}

/// Converts a zero-based benchmark index into a persistent clip UUID.
fn clip_uid(index: usize) -> Uuid {
    Uuid::from_u128((index + 1) as u128)
}

/// Generates alternating hit and miss targets so both resolution outcomes remain represented.
fn lookup_targets(defined_count: usize, lookup_count: usize) -> Vec<(u32, Uuid)> {
    (0..lookup_count)
        .map(|index| {
            if defined_count > 0 && index % 2 == 0 {
                let clip_index = index % defined_count;
                (clip_id(clip_index), clip_uid(clip_index))
            } else {
                let miss_offset = index as u128;
                (
                    u32::MAX.saturating_sub(index as u32),
                    Uuid::from_u128(u128::MAX - miss_offset),
                )
            }
        })
        .collect()
}

/// Builds and consumes one duplicate-aware clip snapshot.
fn build_snapshot_once(lookup: ClipLookup) {
    black_box(lookup.snapshot());
}

/// Represents the snapshot built by the timeline parameter system.
fn build_first_timeline_snapshot(lookup: ClipLookup) {
    black_box(lookup.snapshot());
}

/// Represents the snapshot built by the timeline live action system.
fn build_second_timeline_snapshot(lookup: ClipLookup) {
    black_box(lookup.snapshot());
}

/// Represents the snapshot built by the timeline seek system.
fn build_third_timeline_snapshot(lookup: ClipLookup) {
    black_box(lookup.snapshot());
}

/// Resolves all workload targets by repeatedly scanning the clip query.
fn direct_lookups(lookup: ClipLookup, targets: Res<LookupTargets>) {
    for (id, uid) in &targets.identifiers {
        black_box(lookup.by_id(*id).is_ok());
        black_box(lookup.by_uid(*uid).is_ok());
    }
}

/// Resolves all workload targets through one snapshot built for this update.
fn snapshot_lookups(lookup: ClipLookup, targets: Res<LookupTargets>) {
    let snapshot = lookup.snapshot();
    for (id, uid) in &targets.identifiers {
        black_box(snapshot.by_id(*id).is_ok());
        black_box(snapshot.by_uid(*uid).is_ok());
    }
}

/// Resolves rate-master-like targets before scanning independently sized active instances.
fn snapshot_lookups_with_active_scan(
    lookup: ClipLookup,
    targets: Res<ActiveScanTargets>,
    active_clips: Query<&MaterializedClip>,
) {
    let snapshot = lookup.snapshot();
    for uid in &targets.clip_uids {
        let Ok((_, clip)) = snapshot.by_uid(*uid) else {
            continue;
        };
        let matching_active_count = active_clips
            .iter()
            .filter(|active| active.clip_id == clip.identifiers.id)
            .count();
        black_box(matching_active_count);
    }
}

/// Reads a comma-separated positive or zero count list from the environment.
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

criterion_group!(benches, bench_clip_lookup);
criterion_main!(benches);
