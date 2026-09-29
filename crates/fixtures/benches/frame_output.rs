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
use moonshine_kind::Instance;
use nightfall::prelude::{FixtureRef, Identifiers, ObjectRef, ObjectType};
use nightfall_compositor::prelude::FinalLayerAttributedAssertions;
use nightfall_dmx::prelude::{Attribute, DmxValueResolution, ParameterValue};
use nightfall_engine::prelude::ClientEventSink;
use nightfall_fixtures::bindings::{OutputDestination, ResolvedOutputDestinations};
use nightfall_fixtures::prelude::{
    ConsoleDmxUniverses, Fixture, FixtureDataProviderExt, FixtureElement, MergeStrategy, Parameter,
    ParameterMetadata, ParameterValues,
};
use nightfall_fixtures::universe::dmx_universes;
use nightfall_fixtures::websocket::{register_fixture_websocket_diagnostics, send_parameter_state};
use nightfall_io::{ArtNetDelivery, OutputTransport};

const DEFAULT_FIXTURE_COUNTS: &[usize] = &[64, 512, 2_048];
/// Channels available to fixtures in one universe, leaving a partial fixture footprint unused.
const USABLE_CHANNELS_PER_UNIVERSE: u16 = 510;
/// Per-element attributes, modelled on a moving-head RGBW spot with 16-bit pan and tilt.
const FIXTURE_PARAMETERS: &[(Attribute, DmxValueResolution)] = &[
    (Attribute::Intensity, DmxValueResolution::Coarse),
    (Attribute::Pan, DmxValueResolution::Fine),
    (Attribute::Tilt, DmxValueResolution::Fine),
    (Attribute::Red, DmxValueResolution::Coarse),
    (Attribute::Green, DmxValueResolution::Coarse),
    (Attribute::Blue, DmxValueResolution::Coarse),
    (Attribute::White, DmxValueResolution::Coarse),
    (Attribute::StrobeShutter, DmxValueResolution::Coarse),
];

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
    let fixture_counts = configured_counts(
        "NIGHTFALL_FRAME_OUTPUT_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
    );
    let mut group = c.benchmark_group("dmx_universe_packing");
    for &fixture_count in &fixture_counts {
        group.throughput(Throughput::Elements(
            (fixture_count * FIXTURE_PARAMETERS.len()) as u64,
        ));
        for transport in [TransportShape::ArtNet, TransportShape::Udmx] {
            let mut app = fixture_app(fixture_count, transport);
            app.add_systems(Update, dmx_universes);
            app.update();
            assert_eq!(
                app.world()
                    .resource::<ConsoleDmxUniverses>()
                    .universe_ids()
                    .count(),
                universe_count(fixture_count),
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
    let fixture_counts = configured_counts(
        "NIGHTFALL_FRAME_OUTPUT_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
    );
    let mut group = c.benchmark_group("parameter_state_broadcast");
    for &fixture_count in &fixture_counts {
        group.throughput(Throughput::Elements(
            (fixture_count * FIXTURE_PARAMETERS.len()) as u64,
        ));
        for asserted in [false, true] {
            let mut app = fixture_app(fixture_count, TransportShape::ArtNet);
            if asserted {
                assert_every_parameter(&mut app);
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

/// Builds a world of patched single-element fixtures with resolved output destinations.
fn fixture_app(fixture_count: usize, transport: TransportShape) -> App {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<FinalLayerAttributedAssertions>();

    let footprint = fixture_footprint();
    let fixtures_per_universe = USABLE_CHANNELS_PER_UNIVERSE / footprint;
    let output_transport = transport.transport();

    for fixture_index in 0..fixture_count {
        let fixture = fixture(fixture_index);
        let fixture_uid = fixture.identifiers.uid;
        let universe = (fixture_index as u16 / fixtures_per_universe) + 1;
        let mut address = (fixture_index as u16 % fixtures_per_universe) * footprint + 1;

        let parameters = FIXTURE_PARAMETERS
            .iter()
            .enumerate()
            .map(|(parameter_index, (attribute, resolution))| {
                let byte_count = *resolution as u16 / 8;
                let addresses = (address..address + byte_count).collect();
                address += byte_count;

                let values = ParameterValues {
                    current_value: ((fixture_index + parameter_index) % 256) as f32,
                    ..Default::default()
                };
                let entity = app
                    .world_mut()
                    .spawn((
                        Parameter {
                            metadata: parameter_metadata(attribute.clone(), *resolution),
                            values,
                        },
                        ResolvedOutputDestinations {
                            destinations: vec![OutputDestination {
                                transport: output_transport.clone(),
                                universe,
                                addresses,
                            }],
                        },
                    ))
                    .id();
                // SAFETY: the entity was spawned with a `Parameter` component above.
                (attribute.clone(), unsafe {
                    Instance::<Parameter>::from_entity_unchecked(entity)
                })
            })
            .collect::<Vec<_>>();

        let mut data_provider = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture);
        for (attribute, parameter) in parameters {
            data_provider.add_parameter(
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                attribute,
                parameter,
            );
        }
    }

    app
}

/// Adds an absolute cue assertion for every spawned parameter.
fn assert_every_parameter(app: &mut App) {
    let parameters = app
        .world_mut()
        .query::<(bevy_ecs::entity::Entity, &Parameter)>()
        .iter(app.world())
        .map(|(entity, _)| entity)
        .collect::<Vec<_>>();
    let mut assertions = app
        .world_mut()
        .resource_mut::<FinalLayerAttributedAssertions>();
    for (index, entity) in parameters.into_iter().enumerate() {
        // SAFETY: the query only yields entities with a `Parameter` component.
        let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(entity) };
        assertions.0.absolute.insert(
            parameter,
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

/// Builds the fixture definition registered for `fixture_index`.
fn fixture(fixture_index: usize) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id: fixture_index as u32 + 1,
            uid: uuid::Uuid::from_u128(fixture_index as u128 + 1),
            label: format!("bench fixture {}", fixture_index + 1),
        },
        make: "bench".to_owned(),
        model: "bench spot".to_owned(),
        elements: vec![FixtureElement {
            label: "element 1".to_owned(),
            parameters: FIXTURE_PARAMETERS
                .iter()
                .map(|(attribute, resolution)| parameter_metadata(attribute.clone(), *resolution))
                .collect(),
        }],
        ..Default::default()
    }
}

/// Builds LTP parameter metadata for one attribute at the given DMX resolution.
fn parameter_metadata(attribute: Attribute, resolution: DmxValueResolution) -> ParameterMetadata {
    ParameterMetadata {
        dmx_slots: Default::default(),
        functions: Vec::new(),
        default_dmx: None,
        highlight_dmx: None,
        resolution,
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    }
}

/// Returns the number of DMX channels one benchmark fixture occupies.
fn fixture_footprint() -> u16 {
    FIXTURE_PARAMETERS
        .iter()
        .map(|(_, resolution)| *resolution as u16 / 8)
        .sum()
}

/// Returns the number of universes needed to patch `fixture_count` fixtures.
fn universe_count(fixture_count: usize) -> usize {
    let fixtures_per_universe = (USABLE_CHANNELS_PER_UNIVERSE / fixture_footprint()) as usize;
    fixture_count.div_ceil(fixtures_per_universe)
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

criterion_group!(benches, bench_dmx_packing, bench_parameter_state);
criterion_main!(benches);
