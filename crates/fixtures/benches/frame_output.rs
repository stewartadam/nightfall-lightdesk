// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{env, hint::black_box};

use async_channel::Receiver;
use bevy_app::prelude::*;
use bevy_diagnostic::DiagnosticsPlugin;
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use nightfall::prelude::{ObjectRef, ObjectType};
use nightfall_compositor::prelude::FinalLayerAttributedAssertions;
use nightfall_dmx::prelude::ParameterValue;
use nightfall_engine::prelude::ClientEventSink;
use nightfall_fixtures::prelude::{ConsoleDmxUniverses, FixtureDataProviderExt};
use nightfall_fixtures::testing::{
    BENCH_FIXTURE_PARAMETERS, BenchParameter, bench_universe_count, patch_bench_fixtures,
};
use nightfall_fixtures::universe::dmx_universes;
use nightfall_fixtures::websocket::{register_fixture_websocket_diagnostics, send_parameter_state};
use nightfall_io::{ArtNetDelivery, OutputTransport};

const DEFAULT_FIXTURE_COUNTS: &[usize] = &[64, 512, 2_048];

/// Output transport assigned to every benchmark destination.
#[derive(Clone, Copy)]
enum TransportShape {
    ArtNet,
    Udmx,
}

impl TransportShape {
    /// Returns the benchmark ID segment for this transport.
    fn name(self) -> &'static str {
        match self {
            Self::ArtNet => "artnet",
            Self::Udmx => "udmx",
        }
    }

    /// Builds the concrete output transport, where uDMX carries a heap-allocated device name.
    fn transport(self) -> OutputTransport {
        match self {
            Self::ArtNet => OutputTransport::ArtNet {
                mode: ArtNetDelivery::Broadcast,
            },
            Self::Udmx => OutputTransport::Udmx {
                device: "bench-udmx-device".to_owned(),
            },
        }
    }
}

/// Registers the DMX universe packing benchmark group.
fn bench_dmx_packing(c: &mut Criterion) {
    let mut group = c.benchmark_group("dmx_universe_packing");
    for fixture_count in fixture_counts() {
        group.throughput(Throughput::Elements(parameter_count(fixture_count)));
        for transport in [TransportShape::ArtNet, TransportShape::Udmx] {
            let (mut app, _) = fixture_app(fixture_count, transport);
            app.add_systems(Update, dmx_universes);
            app.update();
            assert_eq!(
                app.world()
                    .resource::<ConsoleDmxUniverses>()
                    .universe_ids()
                    .count(),
                bench_universe_count(fixture_count),
                "every patched universe should be packed"
            );

            let id = format!("{}/fixtures={fixture_count}", transport.name());
            group.bench_function(BenchmarkId::from_parameter(id), |b| {
                b.iter(|| {
                    app.update();
                    black_box(app.world().resource::<ConsoleDmxUniverses>());
                });
            });
        }
    }
    group.finish();
}

/// Registers the parameter-state build and encode benchmark group.
fn bench_parameter_state(c: &mut Criterion) {
    let mut group = c.benchmark_group("parameter_state_broadcast");
    for fixture_count in fixture_counts() {
        group.throughput(Throughput::Elements(parameter_count(fixture_count)));
        for asserted in [false, true] {
            let (mut app, parameters) = fixture_app(fixture_count, TransportShape::ArtNet);
            if asserted {
                assert_every_parameter(&mut app, &parameters);
            }
            let receiver = install_client_sink(&mut app);
            app.add_plugins(DiagnosticsPlugin);
            register_fixture_websocket_diagnostics(&mut app);
            app.add_systems(Update, send_parameter_state);
            app.update();
            let message_bytes = drain_bytes(&receiver);
            assert!(message_bytes > 0, "parameter state should be published");
            println!(
                "parameter_state_broadcast fixtures={fixture_count} asserted={asserted}: \
                 {message_bytes} bytes per frame"
            );

            let assertions = if asserted { "absolute" } else { "defaults" };
            let id = format!("{assertions}/fixtures={fixture_count}");
            group.bench_function(BenchmarkId::from_parameter(id), |b| {
                b.iter(|| {
                    app.update();
                    black_box(drain_bytes(&receiver));
                });
            });
        }
    }
    group.finish();
}

/// Registers the fixture parameter lookup benchmark group.
///
/// Each iteration looks up every patched parameter once, so throughput is lookups per second.
/// `logical` is the Step FX path, `element` the direct forward lookup, `element_guard` the same
/// lookup under one held read guard as the websocket projections do, and `reverse` the
/// parameter-to-fixture lookup used by layer snapshots.
fn bench_parameter_lookup(c: &mut Criterion) {
    let mut group = c.benchmark_group("fixture_parameter_lookup");
    for fixture_count in fixture_counts() {
        group.throughput(Throughput::Elements(parameter_count(fixture_count)));
        let (app, parameters) = fixture_app(fixture_count, TransportShape::ArtNet);
        let provider = app.world().resource::<FixtureDataProviderExt>();

        group.bench_function(
            BenchmarkId::from_parameter(format!("logical/fixtures={fixture_count}")),
            |b| {
                b.iter(|| {
                    for parameter in &parameters {
                        black_box(provider.try_parameter_for_logical_attribute(
                            black_box(&parameter.fixture_ref),
                            &parameter.attribute,
                        ));
                    }
                });
            },
        );
        group.bench_function(
            BenchmarkId::from_parameter(format!("element/fixtures={fixture_count}")),
            |b| {
                b.iter(|| {
                    for parameter in &parameters {
                        black_box(provider.try_parameter_for_element_attribute(
                            black_box(&parameter.fixture_ref),
                            &parameter.attribute,
                        ));
                    }
                });
            },
        );
        group.bench_function(
            BenchmarkId::from_parameter(format!("element_guard/fixtures={fixture_count}")),
            |b| {
                b.iter(|| {
                    let index = provider.parameter_index();
                    for parameter in &parameters {
                        black_box(
                            index
                                .parameter(black_box(&parameter.fixture_ref), &parameter.attribute),
                        );
                    }
                });
            },
        );
        group.bench_function(
            BenchmarkId::from_parameter(format!("reverse/fixtures={fixture_count}")),
            |b| {
                b.iter(|| {
                    for parameter in &parameters {
                        black_box(
                            provider.try_fixture_ref_for_parameter(black_box(&parameter.instance)),
                        );
                    }
                });
            },
        );
    }
    group.finish();
}

/// Builds an app of patched fixtures with the resources the frame-output systems read.
fn fixture_app(fixture_count: usize, transport: TransportShape) -> (App, Vec<BenchParameter>) {
    let mut app = App::new();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<FinalLayerAttributedAssertions>();
    let parameters = patch_bench_fixtures(app.world_mut(), fixture_count, &transport.transport());
    (app, parameters)
}

/// Adds an absolute cue assertion for every patched parameter.
fn assert_every_parameter(app: &mut App, parameters: &[BenchParameter]) {
    let mut assertions = app
        .world_mut()
        .resource_mut::<FinalLayerAttributedAssertions>();
    for (index, parameter) in parameters.iter().enumerate() {
        assertions.0.absolute.insert(
            parameter.instance,
            (
                ObjectRef::ById {
                    object_type: ObjectType::Cue,
                    id: 1,
                },
                (
                    ParameterValue::Absolute {
                        value: (index % 256) as f32,
                    },
                    None,
                ),
            ),
        );
    }
}

/// Installs an unbounded client sink and returns the receiver the benchmark drains.
fn install_client_sink(app: &mut App) -> Receiver<Vec<u8>> {
    let (sender, receiver) = async_channel::unbounded();
    app.insert_resource(ClientEventSink::new(sender));
    receiver
}

/// Drains every queued client message and returns the total encoded byte count.
fn drain_bytes(receiver: &Receiver<Vec<u8>>) -> usize {
    std::iter::from_fn(|| receiver.try_recv().ok())
        .map(|message| message.len())
        .sum()
}

/// Returns the number of parameters patched for `fixture_count` fixtures.
fn parameter_count(fixture_count: usize) -> u64 {
    (fixture_count * BENCH_FIXTURE_PARAMETERS.len()) as u64
}

/// Returns the fixture counts to benchmark, honoring the environment override.
fn fixture_counts() -> Vec<usize> {
    configured_counts(
        "NIGHTFALL_FRAME_OUTPUT_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
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

criterion_group!(
    benches,
    bench_dmx_packing,
    bench_parameter_state,
    bench_parameter_lookup
);
criterion_main!(benches);
