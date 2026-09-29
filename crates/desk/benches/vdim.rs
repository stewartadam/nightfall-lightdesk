// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::env;

use bevy_app::{App, Update};
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use nightfall_desk::systems::vdim::apply_vdim;
use nightfall_dmx::prelude::{Attribute, DmxValueResolution};
use nightfall_fixtures::testing::{
    BENCH_FIXTURE_PARAMETERS, BENCH_VDIM_FIXTURE_PARAMETERS, patch_bench_fixtures_with_profile,
};
use nightfall_io::OutputTransport;

const DEFAULT_FIXTURE_COUNTS: &[usize] = &[64, 512, 2_048];

/// Registers the virtual dimmer benchmark group.
///
/// `rgbw_vdim` patches LED fixtures that each carry a virtual intensity channel, so every frame
/// looks up and scales their colour parameters. `spot` patches fixtures without one, isolating
/// the per-frame scan over all parameters that runs even when no virtual dimmer exists.
fn bench_vdim(c: &mut Criterion) {
    let fixture_counts = configured_counts(
        "NIGHTFALL_VDIM_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
    );
    let profiles: [(&str, &[(Attribute, DmxValueResolution)]); 2] = [
        ("rgbw_vdim", BENCH_VDIM_FIXTURE_PARAMETERS),
        ("spot", BENCH_FIXTURE_PARAMETERS),
    ];

    let mut group = c.benchmark_group("vdim_apply");
    for &fixture_count in &fixture_counts {
        group.throughput(Throughput::Elements(fixture_count as u64));
        for (name, profile) in profiles {
            let mut app = App::new();
            patch_bench_fixtures_with_profile(
                app.world_mut(),
                fixture_count,
                &OutputTransport::Disabled,
                profile,
            );
            app.add_systems(Update, apply_vdim);
            app.update();

            let id = format!("{name}/fixtures={fixture_count}");
            group.bench_function(BenchmarkId::from_parameter(id), |b| {
                b.iter(|| app.update());
            });
        }
    }
    group.finish();
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

criterion_group!(benches, bench_vdim);
criterion_main!(benches);
