// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, env, hint::black_box, time::Duration};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use nightfall_playback_planner::{PlannedPlaybackSource, PlaybackDurationProfile};
use nightfall_timeline::planner::{
    TimelinePlanningAction, TimelinePlaybackSourceResolver, plan_timeline_at,
};
use nightfall_timeline::prelude::ActionKind;
use uuid::Uuid;

const DEFAULT_ACTION_COUNTS: &[usize] = &[100, 1_000, 10_000];

/// Distinct clips the generated actions cycle through.
const CLIP_COUNT: usize = 64;

/// Spacing between consecutive generated actions.
const ACTION_SPACING: Duration = Duration::from_millis(100);

/// Resolves every benchmark clip to a sequence with a fixed finite duration profile.
struct BenchResolver {
    source_by_clip: HashMap<Uuid, PlannedPlaybackSource>,
    profile: PlaybackDurationProfile,
}

impl TimelinePlaybackSourceResolver for BenchResolver {
    fn clip_source(&self, clip_uid: Uuid) -> Option<PlannedPlaybackSource> {
        self.source_by_clip.get(&clip_uid).copied()
    }

    fn duration_profile(&self, _source: PlannedPlaybackSource) -> PlaybackDurationProfile {
        self.profile
    }
}

/// Registers all timeline planning benchmark groups.
fn bench_timeline_planner(c: &mut Criterion) {
    let action_counts = configured_counts(
        "NIGHTFALL_TIMELINE_BENCH_ACTION_COUNTS",
        DEFAULT_ACTION_COUNTS,
    );
    let resolver = resolver();

    bench_plan(c, &action_counts, &resolver);
    bench_evaluate(c, &action_counts, &resolver);
}

/// Measures planning a timeline at its final action, which replays every authored action, as
/// seeks and live playback do on each planning pass.
fn bench_plan(c: &mut Criterion, action_counts: &[usize], resolver: &BenchResolver) {
    let mut group = c.benchmark_group("timeline_plan");

    for &action_count in action_counts {
        let actions = timeline_actions(action_count);
        let target_time = end_of(&actions);
        group.throughput(Throughput::Elements(action_count as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("actions={action_count}")),
            &actions,
            |b, actions| {
                b.iter(|| {
                    black_box(
                        plan_timeline_at(
                            Uuid::nil(),
                            target_time,
                            actions.iter().cloned(),
                            resolver,
                        )
                        .instances
                        .len(),
                    )
                });
            },
        );
    }

    group.finish();
}

/// Measures evaluating an existing plan into materializer-facing playback states, including
/// rate-change replay for every active interval.
fn bench_evaluate(c: &mut Criterion, action_counts: &[usize], resolver: &BenchResolver) {
    let mut group = c.benchmark_group("timeline_plan_evaluate");

    for &action_count in action_counts {
        let actions = timeline_actions(action_count);
        let plan = plan_timeline_at(Uuid::nil(), end_of(&actions), actions, resolver);
        group.throughput(Throughput::Elements(plan.instances.len() as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("actions={action_count}")),
            &plan,
            |b, plan| {
                b.iter(|| black_box(plan.evaluate().instances.len()));
            },
        );
    }

    group.finish();
}

/// Builds evenly spaced actions that cycle each clip through start, rate change, sequence go,
/// stop and a fire-cue action, so plans mix active, releasing and completed intervals.
fn timeline_actions(action_count: usize) -> Vec<TimelinePlanningAction> {
    (0..action_count)
        .map(|index| {
            let clip_uid = clip_uid((index / 5) % CLIP_COUNT);
            let (action, duration) = match index % 5 {
                0 => (ActionKind::StartClip(clip_uid), Duration::ZERO),
                1 => (
                    ActionKind::SetClipRate {
                        uid: clip_uid,
                        rate: 1.0 + (index % 3) as f32 * 0.25,
                    },
                    Duration::ZERO,
                ),
                2 => (ActionKind::AdvanceSequence(clip_uid), Duration::ZERO),
                3 => (ActionKind::StopClip(clip_uid), Duration::ZERO),
                _ => (
                    ActionKind::FireCue(Uuid::from_u128(0x1_0000 + index as u128)),
                    Duration::from_secs(2),
                ),
            };

            TimelinePlanningAction {
                track_id: format!("track-{}", index % 8),
                action_id: format!("action-{index}"),
                action,
                position: ACTION_SPACING * index as u32,
                duration,
            }
        })
        .collect()
}

/// Returns the position of the last action, or zero for an empty timeline.
fn end_of(actions: &[TimelinePlanningAction]) -> Duration {
    actions
        .iter()
        .map(|action| action.position)
        .max()
        .unwrap_or_default()
}

/// Builds a resolver mapping every benchmark clip to its own sequence source.
fn resolver() -> BenchResolver {
    BenchResolver {
        source_by_clip: (0..CLIP_COUNT)
            .map(|index| {
                (
                    clip_uid(index),
                    PlannedPlaybackSource::Sequence(Uuid::from_u128(0x2_0000 + index as u128)),
                )
            })
            .collect(),
        profile: PlaybackDurationProfile::finite(Duration::from_secs(10), Duration::from_secs(2)),
    }
}

/// Returns a stable clip UID for a benchmark clip index.
fn clip_uid(index: usize) -> Uuid {
    Uuid::from_u128(index as u128 + 1)
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

criterion_group!(benches, bench_timeline_planner);
criterion_main!(benches);
