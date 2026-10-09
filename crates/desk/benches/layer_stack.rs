// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{env, hint::black_box, time::Duration};

use async_channel::Receiver;
use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use nightfall::data::Priority;
use nightfall::prelude::{FadeCurve, MaterializedTransition, ObjectRef, ObjectType};
use nightfall_compositor::prelude::{Layer, ObjectRefMarker, OutputLayer};
use nightfall_desk::websocket::{LayerSnapshotData, send_layer_stack};
use nightfall_dmx::prelude::ParameterValue;
use nightfall_engine::prelude::{ClientEventSink, OutboundFrame};
use nightfall_fixtures::prelude::{FixtureDataProviderExt, Parameter};
use nightfall_fixtures::testing::{BENCH_FIXTURE_PARAMETERS, BenchParameter, patch_bench_fixtures};
use nightfall_io::OutputTransport;

const DEFAULT_FIXTURE_COUNTS: &[usize] = &[64, 512];
const DEFAULT_LAYER_COUNTS: &[usize] = &[4, 16];

/// Registers the layer-stack snapshot build and encode benchmark group.
///
/// Each iteration builds and publishes one snapshot of `layers` layers that each assert every
/// patched parameter with a fade, as a busy show sends ten times a second.
fn bench_layer_stack(c: &mut Criterion) {
    let fixture_counts = configured_counts(
        "NIGHTFALL_LAYER_STACK_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
    );
    let layer_counts = configured_counts(
        "NIGHTFALL_LAYER_STACK_BENCH_LAYER_COUNTS",
        DEFAULT_LAYER_COUNTS,
    );

    let mut group = c.benchmark_group("layer_stack_snapshot");
    for &fixture_count in &fixture_counts {
        for &layer_count in &layer_counts {
            let (mut app, receiver) = layer_stack_app(fixture_count, layer_count);
            app.update();
            let message_bytes = drain_bytes(&receiver);
            assert!(message_bytes > 0, "layer stack should be published");
            println!(
                "layer_stack_snapshot fixtures={fixture_count} layers={layer_count}: \
                 {message_bytes} bytes per snapshot"
            );

            group.throughput(Throughput::Elements(
                (fixture_count * BENCH_FIXTURE_PARAMETERS.len() * layer_count) as u64,
            ));
            let id = format!("layers={layer_count}/fixtures={fixture_count}");
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

/// Publishes the layer stack every update, bypassing the low-frequency rate limiter.
fn publish_layer_stack(
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameters_query: Query<&Parameter>,
    layers: Query<LayerSnapshotData>,
    broadcaster: Res<ClientEventSink>,
) {
    send_layer_stack(
        &fixture_data_provider,
        parameters_query,
        layers,
        None,
        &broadcaster,
    );
}

/// Builds an app of patched fixtures and `layer_count` fully asserting layers.
fn layer_stack_app(fixture_count: usize, layer_count: usize) -> (App, Receiver<OutboundFrame>) {
    let mut app = App::new();
    let parameters =
        patch_bench_fixtures(app.world_mut(), fixture_count, &OutputTransport::Disabled);
    for layer_index in 0..layer_count {
        spawn_layer(&mut app, &parameters, layer_index);
    }

    let (sender, receiver) = async_channel::unbounded();
    app.insert_resource(ClientEventSink::new(sender));
    app.add_systems(Update, publish_layer_stack);
    (app, receiver)
}

/// Spawns a cue layer asserting every parameter, with matching computed output values.
fn spawn_layer(app: &mut App, parameters: &[BenchParameter], layer_index: usize) {
    let mut layer = Layer::new(
        format!("bench layer {layer_index}"),
        Priority(layer_index as i8),
    );
    let mut output = OutputLayer::default();
    for (parameter_index, parameter) in parameters.iter().enumerate() {
        let value = ((parameter_index + layer_index) % 256) as f32;
        layer.absolute.insert(
            parameter.instance,
            (ParameterValue::Absolute { value }, Some(fade())),
        );
        output.0.absolute.insert(parameter.instance, value);
    }

    app.world_mut().spawn((
        layer,
        output,
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: layer_index as u32 + 1,
        }),
    ));
}

/// Returns a one-second linear fade in and out.
fn fade() -> MaterializedTransition {
    MaterializedTransition {
        delay_in: Duration::ZERO,
        fade_in: Duration::from_secs(1),
        curve_in: FadeCurve::Linear,
        delay_out: Duration::ZERO,
        fade_out: Duration::from_secs(1),
        curve_out: FadeCurve::Linear,
        start_position: Duration::ZERO,
        release_position: None,
    }
}

/// Drains every queued client message and returns the total encoded byte count.
fn drain_bytes(receiver: &Receiver<OutboundFrame>) -> usize {
    std::iter::from_fn(|| receiver.try_recv().ok())
        .map(|message| message.bytes.len())
        .sum()
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

criterion_group!(benches, bench_layer_stack);
criterion_main!(benches);
