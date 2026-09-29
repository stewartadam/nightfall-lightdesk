// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, env, hint::black_box};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use nightfall::prelude::{FixtureRef, SelectionExpr, SpatialSelection, UnresolvedFixtureRef};
use nightfall_selection::{
    SelectionDataSource, SelectionFixture, SelectionResolver, SpatialSelectionResolver,
};
use uuid::Uuid;

const DEFAULT_FIXTURE_COUNTS: &[usize] = &[64, 512, 4_096];

/// Fixture lookup with constant-time ID and reference indexes, like the engine's data provider.
struct BenchDataSource {
    by_id: HashMap<u32, SelectionFixture>,
    by_uid: HashMap<Uuid, SelectionFixture>,
}

impl SelectionDataSource for BenchDataSource {
    fn fixture_by_id(&self, fixture_id: u32) -> Option<SelectionFixture> {
        self.by_id.get(&fixture_id).cloned()
    }

    fn fixture_by_ref(&self, fixture_ref: &FixtureRef) -> Option<SelectionFixture> {
        self.by_uid.get(&fixture_ref.fixture_uid).cloned()
    }
}

/// Selection expression shape measured by a benchmark case.
#[derive(Clone, Copy)]
enum ExprShape {
    /// `1 thru N`.
    Range,
    /// `1 thru N - 2 thru N-1`, which removes almost every fixture from the range.
    Sub,
}

impl ExprShape {
    /// Returns the benchmark ID segment for this shape.
    fn name(self) -> &'static str {
        match self {
            Self::Range => "range",
            Self::Sub => "sub",
        }
    }

    /// Builds the selection expression for `fixture_count` fixtures.
    fn expr(self, fixture_count: usize) -> SelectionExpr {
        let last = fixture_count as u32;
        match self {
            Self::Range => range(1, last),
            Self::Sub => SelectionExpr::Sub {
                lhs: Box::new(range(1, last)),
                rhs: Box::new(range(2, last.saturating_sub(1).max(2))),
            },
        }
    }
}

/// Registers the selection resolution benchmark groups.
fn bench_selection(c: &mut Criterion) {
    let fixture_counts = configured_counts(
        "NIGHTFALL_SELECTION_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
    );

    for (group_name, spatial) in [
        ("selection_resolve", false),
        ("spatial_selection_resolve", true),
    ] {
        let mut group = c.benchmark_group(group_name);
        for &fixture_count in &fixture_counts {
            let data_source = data_source(fixture_count);
            group.throughput(Throughput::Elements(fixture_count as u64));
            for shape in [ExprShape::Range, ExprShape::Sub] {
                let expr = shape.expr(fixture_count);
                let id = format!("{}/fixtures={fixture_count}", shape.name());
                if spatial {
                    let selection = SpatialSelection::identity(expr);
                    let resolver = SpatialSelectionResolver::new(&data_source);
                    group.bench_function(BenchmarkId::from_parameter(id), |b| {
                        b.iter(|| black_box(resolver.resolve(black_box(&selection))));
                    });
                } else {
                    let resolver = SelectionResolver::new(&data_source);
                    group.bench_function(BenchmarkId::from_parameter(id), |b| {
                        b.iter(|| black_box(resolver.resolve_expr(black_box(&expr))));
                    });
                }
            }
        }
        group.finish();
    }
}

/// Builds single-element fixtures with IDs `1..=fixture_count`.
fn data_source(fixture_count: usize) -> BenchDataSource {
    let fixtures = (1..=fixture_count as u32)
        .map(|id| SelectionFixture {
            fixture_ref: FixtureRef {
                fixture_uid: Uuid::from_u128(id as u128),
                index: None,
            },
            element_count: 1,
        })
        .collect::<Vec<_>>();
    BenchDataSource {
        by_id: fixtures
            .iter()
            .enumerate()
            .map(|(index, fixture)| (index as u32 + 1, fixture.clone()))
            .collect(),
        by_uid: fixtures
            .into_iter()
            .map(|fixture| (fixture.fixture_ref.fixture_uid, fixture))
            .collect(),
    }
}

/// Builds a whole-fixture `start thru end` range expression.
fn range(start: u32, end: u32) -> SelectionExpr {
    SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: start,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: end,
            element_index: None,
        },
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

criterion_group!(benches, bench_selection);
criterion_main!(benches);
