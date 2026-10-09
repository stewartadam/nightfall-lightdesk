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
use nightfall_engine::prelude::{ClientEventSink, OutboundFrame};
use nightfall_fixtures::prelude::{
    ConsoleDmxUniverses, FixtureDataProviderExt, Parameter, ParameterStateProjection,
};
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
            let output_transport = transport.transport();
            let universes = app.world().resource::<ConsoleDmxUniverses>();
            assert!(
                (1..=bench_universe_count(fixture_count) as u16)
                    .all(|universe| universes.has_output_universe(&output_transport, universe)),
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

/// Shares of parameters, in percent, that change between parameter-state frames.
const CHANGED_PERCENTS: &[usize] = &[0, 1, 10, 100];

/// Registers the parameter-state build and encode benchmark group.
///
/// Every frame changes the output of a fixed share of the parameters, so the group measures how
/// the cost and the size of a frame scale with how much of the rig moves. A keyframe of the same
/// rig is printed alongside each delta size for comparison.
fn bench_parameter_state(c: &mut Criterion) {
    let mut group = c.benchmark_group("parameter_state_broadcast");
    for fixture_count in fixture_counts() {
        group.throughput(Throughput::Elements(parameter_count(fixture_count)));
        for &changed_percent in CHANGED_PERCENTS {
            let (mut app, parameters) = fixture_app(fixture_count, TransportShape::ArtNet);
            assert_every_parameter(&mut app, &parameters);
            let receiver = install_client_sink(&mut app);
            app.add_plugins(DiagnosticsPlugin);
            register_fixture_websocket_diagnostics(&mut app);
            app.init_resource::<ParameterStateProjection>();
            app.add_systems(Update, send_parameter_state);
            app.update();
            assert!(
                drain_bytes(&receiver) > 0,
                "the first frame should publish the layout and values"
            );
            let changed = &parameters[..parameters.len() * changed_percent / 100];
            let mut generation = 0;
            change_outputs(&mut app, changed, &mut generation);
            app.update();
            let frame_bytes = drain_bytes(&receiver);
            app.world_mut()
                .resource_mut::<ParameterStateProjection>()
                .request_keyframe();
            app.update();
            let keyframe_bytes = drain_bytes(&receiver);
            println!(
                "parameter_state_broadcast fixtures={fixture_count} changed={changed_percent}%: \
                 {frame_bytes} bytes per frame, {keyframe_bytes} bytes per keyframe"
            );

            let id = format!("changed={changed_percent}%/fixtures={fixture_count}");
            group.bench_function(BenchmarkId::from_parameter(id), |b| {
                b.iter(|| {
                    change_outputs(&mut app, changed, &mut generation);
                    app.update();
                    black_box(drain_bytes(&receiver));
                });
            });
        }
    }
    group.finish();
}

/// Gives every parameter in `changed` a new output value, advancing `generation` so the next call
/// differs again.
fn change_outputs(app: &mut App, changed: &[BenchParameter], generation: &mut u32) {
    *generation = generation.wrapping_add(1);
    let value = (*generation % 256) as f32;
    for parameter in changed {
        app.world_mut()
            .get_mut::<Parameter>(parameter.instance.entity())
            .expect("benchmark parameters should exist")
            .set_raw_value(value);
    }
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
fn install_client_sink(app: &mut App) -> Receiver<OutboundFrame> {
    let (sender, receiver) = async_channel::unbounded();
    app.insert_resource(ClientEventSink::new(sender));
    receiver
}

/// Drains every queued client message and returns the total encoded byte count.
fn drain_bytes(receiver: &Receiver<OutboundFrame>) -> usize {
    std::iter::from_fn(|| receiver.try_recv().ok())
        .map(|message| message.bytes.len())
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
