// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Accepted-frame routing through fixture-owned processing.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_compositor::types::Layer;
use nightfall_dmx::prelude::{DmxValueResolution, MAX_CHANNELS_PER_UNIVERSE, ParameterValue};
use nightfall_engine::{Compositing, LayerGeneration};
use nightfall_fixtures::{input_apply::TransportInputPlugin, prelude::*};
use nightfall_io::{
    AcceptedDmxFrame, BindingTransport, DmxInputSet, OutputTransport, SacnDelivery,
};
use web_time::Instant;

/// Four-byte input retains low bits through percentage assertions, compositing and sparse output.
#[test]
fn raw_32_bit_values_survive_the_complete_parameter_pipeline() {
    use nightfall_compositor::prelude::{FinalLayerAttributedAssertions, compositor};
    let mut app = App::new();
    app.add_plugins(TransportInputPlugin);
    app.init_resource::<FinalLayerAttributedAssertions>();
    let mut parameter = make_coarse_parameter();
    parameter.metadata.resolution = DmxValueResolution::Uber;
    parameter.metadata.max = f64::from(u32::MAX);
    let entity = app
        .world_mut()
        .spawn((
            parameter,
            ResolvedOutputDestinations {
                destinations: vec![OutputDestination {
                    transport: OutputTransport::Disabled,
                    universe: 8,
                    addresses: vec![4, 1, 3, 2],
                }],
            },
        ))
        .id();
    let input_layer = spawn_transport_input_layer(&mut app);
    app.world_mut()
        .entity_mut(input_layer)
        .insert(nightfall_compositor::types::ObjectRefMarker(
            nightfall::prelude::ObjectRef::ById {
                object_type: nightfall::prelude::ObjectType::Parameter,
                id: 0,
            },
        ));
    app.world_mut()
        .resource_mut::<ResolvedInputBindings>()
        .bindings = vec![ResolvedInputBinding {
        source: ResolvedInputSource::Transport {
            transport: BindingTransport::ArtNet,
            universe: 7,
            address: 100,
        },
        priority: 0,
        destination: ResolvedInputDestination::Fixture {
            targets: vec![ResolvedInputTarget {
                entity,
                offsets: vec![3, 0, 2, 1],
            }],
        },
    }];
    app.add_systems(
        Update,
        (
            compositor::<Parameter>,
            nightfall_fixtures::universe::dmx_universes,
        )
            .chain()
            .after(DmxInputSet::Apply),
    );
    let mut values = vec![
        0,
        1,
        65535,
        16777215,
        16777216,
        16777217,
        0x80000001,
        0xabcdef01,
        u32::MAX - 1,
        u32::MAX,
    ];
    let mut seed = 12345_u32;
    for _ in 0..256 {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        values.push(seed);
    }
    for raw in values {
        let [a, b, c, d] = raw.to_be_bytes();
        app.world_mut()
            .write_message(make_frame(7, &[(103, a), (100, b), (102, c), (101, d)]));
        app.update();
        assert!(
            (app.world()
                .get::<Parameter>(entity)
                .unwrap()
                .values
                .current_value
                - f64::from(raw))
            .abs()
                < 0.000001,
            "raw={raw}, actual={}",
            app.world()
                .get::<Parameter>(entity)
                .unwrap()
                .values
                .current_value
        );
        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(&universes.get_universe(8)[..4], &[b, d, c, a], "raw={raw}");
        assert_eq!(
            &universes.get_output_universe(&OutputTransport::Disabled, 8)[..4],
            &[b, d, c, a],
            "raw={raw}"
        );
    }
}

/// Creates a persistent assertion layer for routing tests.
fn spawn_transport_input_layer(app: &mut App) -> Entity {
    app.world_mut()
        .spawn((
            Layer::new("test input".into(), TRANSPORT_INPUT_LAYER_PRIORITY),
            TransportInputLayer,
            TransportInputAssertionOwners::default(),
        ))
        .id()
}

/// Creates a single-channel fixture parameter with a full unsigned DMX range.
fn make_coarse_parameter() -> Parameter {
    Parameter {
        metadata: ParameterMetadata {
            resolution: DmxValueResolution::Coarse,
            min: 0.0,
            max: 255.0,
            ..Default::default()
        },
        values: Default::default(),
    }
}

/// Builds an accepted frame with sparse channel values and its original receive time.
fn make_frame(universe: u16, channels: &[(u16, u8)]) -> AcceptedDmxFrame {
    let mut data = [0; MAX_CHANNELS_PER_UNIVERSE];
    for &(address, value) in channels {
        data[usize::from(address - 1)] = value;
    }
    AcceptedDmxFrame {
        transport: BindingTransport::ArtNet,
        universe,
        data,
        received_at: Instant::now(),
        is_self_frame: false,
    }
}

/// Sparse targets decode authored significance at every width through the accepted-frame plugin.
#[test]
fn accepted_input_decodes_sparse_significant_bytes() {
    for (resolution, offsets, raw, maximum) in [
        (DmxValueResolution::Coarse, vec![3], 0xab_u32, 255_u32),
        (DmxValueResolution::Fine, vec![3, 0], 0xabcd, 65535),
        (
            DmxValueResolution::UltraFine,
            vec![3, 0, 2],
            0xabcdef,
            16777215,
        ),
        (
            DmxValueResolution::Uber,
            vec![3, 0, 2, 1],
            0xabcdef01,
            u32::MAX,
        ),
    ] {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let mut parameter = make_coarse_parameter();
        parameter.metadata.resolution = resolution;
        let entity = app.world_mut().spawn(parameter).id();
        let input_layer = spawn_transport_input_layer(&mut app);
        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 7,
                address: 100,
            },
            priority: 0,
            destination: ResolvedInputDestination::Fixture {
                targets: vec![ResolvedInputTarget { entity, offsets }],
            },
        }];
        app.world_mut().write_message(make_frame(
            7,
            &[(100, 0xcd), (101, 0x01), (102, 0xef), (103, 0xab)],
        ));
        app.update();
        let layer = app.world().get::<Layer>(input_layer).unwrap();
        assert_eq!(layer.absolute.len(), 1);
        let ParameterValue::AbsolutePercent { value } = layer.absolute.values().next().unwrap().0
        else {
            panic!("expected absolute input percentage");
        };
        let expected = ParameterValue::AbsolutePercent {
            value: (raw as f64 / maximum as f64).into(),
        };
        assert_eq!(ParameterValue::AbsolutePercent { value }, expected);
    }
}

/// A malformed higher-priority mapping cannot assert a fabricated value or suppress a later valid target.
#[test]
fn invalid_input_mapping_does_not_claim_target_precedence() {
    for (base, offsets) in [
        (100, vec![]),
        (100, vec![0]),
        (100, vec![0, 1, 2]),
        (100, vec![0, 0]),
        (100, vec![0, 513]),
        (0, vec![3, 0]),
        (512, vec![0, 1]),
        (u16::MAX, vec![1, 0]),
    ] {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let mut parameter = make_coarse_parameter();
        parameter.metadata.resolution = DmxValueResolution::Fine;
        let entity = app.world_mut().spawn(parameter).id();
        let input_layer = spawn_transport_input_layer(&mut app);
        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = [(base, offsets), (100, vec![3, 0])]
            .into_iter()
            .enumerate()
            .map(|(priority, (address, offsets))| ResolvedInputBinding {
                source: ResolvedInputSource::Transport {
                    transport: BindingTransport::ArtNet,
                    universe: 7,
                    address,
                },
                priority: priority as i32,
                destination: ResolvedInputDestination::Fixture {
                    targets: vec![ResolvedInputTarget { entity, offsets }],
                },
            })
            .collect();
        app.world_mut()
            .write_message(make_frame(7, &[(100, 0xcd), (103, 0xab)]));
        app.update();
        let layer = app.world().get::<Layer>(input_layer).unwrap();
        assert_eq!(layer.absolute.len(), 1);
        assert_eq!(
            layer.absolute.values().next().unwrap().0,
            ParameterValue::AbsolutePercent {
                value: (43981.0_f64 / 65535.0).into(),
            }
        );
    }
}

/// Verifies accepted frames preserve records frames without transport bindings.
#[test]
fn accepted_input_records_frames_without_transport_bindings() {
    let mut app = App::new();
    app.add_plugins(TransportInputPlugin);

    app.init_resource::<ResolvedInputBindings>();
    app.init_resource::<InputDmxUniverses>();
    app.init_resource::<ConsoleDmxUniverses>();

    let parameter_entity = app.world_mut().spawn(make_coarse_parameter()).id();

    app.world_mut().write_message(make_frame(1, &[(1, 255)]));
    app.update();

    let parameter = app
        .world()
        .get::<Parameter>(parameter_entity)
        .expect("parameter must exist");
    assert_eq!(parameter.values.current_value, 0.0);

    let input_universes = app.world().resource::<InputDmxUniverses>();
    assert!(
        input_universes
            .frame_age_ms(BindingTransport::ArtNet, 1, Instant::now())
            .is_some()
    );
}

/// Verifies accepted frames preserve applies only bound channels.
#[test]
fn accepted_input_applies_only_bound_channels() {
    let mut app = App::new();
    app.add_plugins(TransportInputPlugin);

    app.init_resource::<ResolvedInputBindings>();
    app.init_resource::<InputDmxUniverses>();
    app.init_resource::<ConsoleDmxUniverses>();

    let bound_parameter = app.world_mut().spawn(make_coarse_parameter()).id();
    let unbound_parameter = app.world_mut().spawn(make_coarse_parameter()).id();
    let input_layer = spawn_transport_input_layer(&mut app);

    app.world_mut()
        .resource_mut::<ResolvedInputBindings>()
        .bindings = vec![ResolvedInputBinding {
        source: ResolvedInputSource::Transport {
            transport: BindingTransport::ArtNet,
            universe: 1,
            address: 100,
        },
        priority: 0,
        destination: ResolvedInputDestination::Fixture {
            targets: vec![ResolvedInputTarget {
                entity: bound_parameter,
                offsets: vec![0],
            }],
        },
    }];

    app.world_mut()
        .write_message(make_frame(1, &[(100, 42), (200, 255)]));
    app.update();

    let unbound = app
        .world()
        .get::<Parameter>(unbound_parameter)
        .expect("unbound parameter must exist");
    let layer = app
        .world()
        .get::<Layer>(input_layer)
        .expect("input layer must exist");

    assert_eq!(layer.absolute.len(), 1);
    assert_eq!(
        layer.absolute.values().next().map(|(value, _)| *value),
        Some(ParameterValue::AbsolutePercent {
            value: (42.0_f64 / 255.0).into()
        })
    );
    assert_eq!(unbound.values.current_value, 0.0);
}

/// Verifies accepted frames preserve sets console channels for transport console mapping.
#[test]
fn accepted_input_sets_console_channels_for_transport_console_mapping() {
    let mut app = App::new();
    app.add_plugins(TransportInputPlugin);

    app.init_resource::<ResolvedInputBindings>();
    app.init_resource::<InputDmxUniverses>();
    app.init_resource::<ConsoleDmxUniverses>();

    app.world_mut()
        .resource_mut::<ResolvedInputBindings>()
        .bindings = vec![ResolvedInputBinding {
        source: ResolvedInputSource::Transport {
            transport: BindingTransport::ArtNet,
            universe: 2,
            address: 1,
        },
        priority: 0,
        destination: ResolvedInputDestination::Console {
            target: ResolvedConsoleTarget {
                universe: 2,
                address: 1,
            },
            targets: vec![],
        },
    }];

    app.world_mut()
        .write_message(make_frame(2, &[(1, 17), (200, 66), (512, 99)]));
    app.update();

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert!(universes.has_universe(2));
    let universe = universes.get_universe(2);
    assert_eq!(universe[0], 17);
    assert_eq!(universe[199], 66);
    assert_eq!(universe[511], 99);
}

/// Verifies accepted frames preserve sets transport channels for transport mapping.
#[test]
fn accepted_input_sets_transport_channels_for_transport_mapping() {
    let mut app = App::new();
    app.add_plugins(TransportInputPlugin);

    app.init_resource::<ResolvedInputBindings>();
    app.init_resource::<InputDmxUniverses>();
    app.init_resource::<ConsoleDmxUniverses>();

    app.world_mut()
        .resource_mut::<ResolvedInputBindings>()
        .bindings = vec![ResolvedInputBinding {
        source: ResolvedInputSource::Transport {
            transport: BindingTransport::ArtNet,
            universe: 2,
            address: 1,
        },
        priority: 0,
        destination: ResolvedInputDestination::Transport {
            target: ResolvedTransportTarget {
                target: "sacn".to_string(),
                protocol: BindingTransport::Sacn,
                transport: OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                universe: 11,
                address: 1,
            },
        },
    }];

    app.world_mut()
        .write_message(make_frame(2, &[(1, 17), (200, 66), (512, 99)]));
    app.update();

    let input_universes = app.world().resource::<InputDmxUniverses>();
    let target = input_universes.get_universe(BindingTransport::Sacn, 11);
    assert_eq!(target[0], 17);
    assert_eq!(target[199], 66);
    assert_eq!(target[511], 99);

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert!(!universes.has_universe(11));
}

/// Frames queued by one protocol adapter before routing in this update.
#[derive(Resource)]
struct ArtNetFrames(Vec<AcceptedDmxFrame>);

/// Frames queued by another protocol adapter before routing in this update.
#[derive(Resource)]
struct SacnFrames(Vec<AcceptedDmxFrame>);

/// Publishes Art-Net frames in receive order through the production ingress boundary.
fn publish_artnet(mut pending: ResMut<ArtNetFrames>, mut frames: MessageWriter<AcceptedDmxFrame>) {
    frames.write_batch(pending.0.drain(..));
}

/// Publishes sACN frames in receive order through the production ingress boundary.
fn publish_sacn(mut pending: ResMut<SacnFrames>, mut frames: MessageWriter<AcceptedDmxFrame>) {
    frames.write_batch(pending.0.drain(..));
}

/// Captures the input state visible when compositing begins.
#[derive(Resource, Default)]
struct CompositingInput(Vec<(BindingTransport, u8)>);

/// Observes routing output at the first consumer phase after layer generation.
fn observe_compositing(input: Res<InputDmxUniverses>, mut observed: ResMut<CompositingInput>) {
    observed.0 = [BindingTransport::ArtNet, BindingTransport::Sacn]
        .into_iter()
        .map(|transport| (transport, input.get_universe(transport, 1)[0]))
        .collect();
}

/// Both protocols reach compositing in the same update, preserving order and receive metadata.
#[test]
fn mixed_protocol_ingress_is_applied_before_compositing_without_retimestamping() {
    let mut app = App::new();
    app.add_plugins(TransportInputPlugin);
    app.configure_sets(Update, Compositing.after(LayerGeneration));
    app.add_systems(
        Update,
        (publish_artnet, publish_sacn).in_set(DmxInputSet::Ingress),
    );
    app.add_systems(Update, observe_compositing.in_set(Compositing));
    app.init_resource::<CompositingInput>();
    let received_at = Instant::now() - std::time::Duration::from_millis(500);
    let first = make_frame(1, &[(1, 10)]);
    let mut last = make_frame(1, &[(1, 20)]);
    last.received_at = received_at;
    last.is_self_frame = true;
    let mut sacn = make_frame(1, &[(1, 30)]);
    sacn.transport = BindingTransport::Sacn;
    app.insert_resource(ArtNetFrames(vec![first, last]));
    app.insert_resource(SacnFrames(vec![sacn]));
    app.update();
    assert_eq!(
        app.world().resource::<CompositingInput>().0,
        vec![(BindingTransport::ArtNet, 20), (BindingTransport::Sacn, 30)]
    );
    let input = app.world().resource::<InputDmxUniverses>();
    assert_eq!(
        input.frame_age_ms(BindingTransport::ArtNet, 1, received_at),
        Some(0)
    );
    assert_eq!(
        input.frame_age_ms(
            BindingTransport::ArtNet,
            1,
            received_at + std::time::Duration::from_millis(500)
        ),
        Some(500)
    );
    assert_eq!(input.is_self_frame(BindingTransport::ArtNet, 1), Some(true));
}

/// Duplicate targets retain the first binding, and consumed frames cannot resurrect cleared assertions.
#[test]
fn routing_preserves_binding_precedence_and_consumes_each_frame_once() {
    let mut app = App::new();
    app.add_plugins(TransportInputPlugin);
    let parameter = app.world_mut().spawn(make_coarse_parameter()).id();
    let input_layer = spawn_transport_input_layer(&mut app);
    app.world_mut()
        .resource_mut::<ResolvedInputBindings>()
        .bindings = [1, 2]
        .into_iter()
        .enumerate()
        .map(|(priority, address)| ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 1,
                address,
            },
            priority: priority as i32,
            destination: ResolvedInputDestination::Fixture {
                targets: vec![ResolvedInputTarget {
                    entity: parameter,
                    offsets: vec![0],
                }],
            },
        })
        .collect();
    app.world_mut()
        .write_message(make_frame(1, &[(1, 42), (2, 99)]));
    app.update();
    assert_eq!(
        app.world()
            .get::<Layer>(input_layer)
            .unwrap()
            .absolute
            .values()
            .next()
            .unwrap()
            .0,
        ParameterValue::AbsolutePercent {
            value: (42.0_f64 / 255.0).into()
        }
    );
    app.world_mut()
        .get_mut::<Layer>(input_layer)
        .unwrap()
        .absolute = Default::default();
    app.update();
    assert!(
        app.world()
            .get::<Layer>(input_layer)
            .unwrap()
            .absolute
            .is_empty()
    );
}
