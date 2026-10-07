// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Accepted-frame routing through fixture-owned processing.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use bevy_ecs::system::RunSystemOnce;
use nightfall_compositor::types::Layer;
use nightfall_dmx::prelude::{DmxValueResolution, MAX_CHANNELS_PER_UNIVERSE, ParameterValue};
use nightfall_engine::prelude::{Compositing, LayerGeneration, Render, add_render_schedule};
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::{input_apply::TransportInputPlugin, prelude::*};
use nightfall_io::{
    AcceptedDmxFrame, BindingTransport, DmxInputSet, OutputTransport, SacnDelivery,
};
use web_time::Instant;

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

/// Verifies accepted frames preserve records frames without transport bindings.
#[test]
fn accepted_input_records_frames_without_transport_bindings() {
    let mut app = App::new();
    add_render_schedule(&mut app);
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
    add_render_schedule(&mut app);
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
            value: (42.0_f32 / 255.0).into()
        })
    );
    assert_eq!(unbound.values.current_value, 0.0);
}

/// Verifies accepted frames preserve sets console channels for transport console mapping.
#[test]
fn accepted_input_sets_console_channels_for_transport_console_mapping() {
    let mut app = App::new();
    add_render_schedule(&mut app);
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
    add_render_schedule(&mut app);
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
    add_render_schedule(&mut app);
    app.add_plugins(TransportInputPlugin);
    app.configure_sets(Render, Compositing.after(LayerGeneration));
    app.add_systems(
        Render,
        (publish_artnet, publish_sacn).in_set(DmxInputSet::Ingress),
    );
    app.add_systems(Render, observe_compositing.in_set(Compositing));
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
    add_render_schedule(&mut app);
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
            value: (42.0_f32 / 255.0).into()
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

/// Builds resolved bindings from Art-Net universes 1 and 2 (address 1) to `destination`, in
/// resolved precedence order: universe 1 at priority 10 ahead of universe 2 at priority 1.
fn competing_source_bindings(destination: ResolvedInputDestination) -> Vec<ResolvedInputBinding> {
    [(1, 10), (2, 1)]
        .into_iter()
        .map(|(universe, priority)| ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe,
                address: 1,
            },
            priority,
            destination: destination.clone(),
        })
        .collect()
}

/// Delivers one frame per `(universe, channel 1 value)` entry, each in its own update, and
/// returns the app so the caller can inspect the routed result.
fn deliver_frames_in_separate_updates(mut app: App, frames: &[(u16, u8)]) -> App {
    for &(universe, value) in frames {
        app.world_mut()
            .write_message(make_frame(universe, &[(1, value)]));
        app.update();
    }
    app
}

/// Returns the absolute value the transport input layer asserts for its single parameter.
fn single_layer_value(app: &App, input_layer: Entity) -> ParameterValue {
    let layer = app
        .world()
        .get::<Layer>(input_layer)
        .expect("input layer must exist");
    assert_eq!(layer.absolute.len(), 1);
    layer.absolute.values().next().expect("one assertion").0
}

/// Verifies that when two source universes drive one fixture parameter, the higher-priority
/// binding's value holds no matter which source's frame arrives last.
#[test]
fn fixture_target_keeps_highest_priority_source_across_frames() {
    for arrival_order in [[(1, 42), (2, 99)], [(2, 99), (1, 42)]] {
        let mut app = App::new();
        add_render_schedule(&mut app);
        app.add_plugins(TransportInputPlugin);
        let parameter = app.world_mut().spawn(make_coarse_parameter()).id();
        let input_layer = spawn_transport_input_layer(&mut app);
        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = competing_source_bindings(ResolvedInputDestination::Fixture {
            targets: vec![ResolvedInputTarget {
                entity: parameter,
                offsets: vec![0],
            }],
        });

        let app = deliver_frames_in_separate_updates(app, &arrival_order);

        assert_eq!(
            single_layer_value(&app, input_layer),
            ParameterValue::AbsolutePercent {
                value: (42.0_f32 / 255.0).into()
            },
            "arrival order {arrival_order:?}"
        );
    }
}

/// Verifies a lower-priority source takes over a fixture parameter once the higher-priority
/// owner's assertion is cleared as stale.
#[test]
fn fixture_target_falls_back_to_lower_priority_source_after_owner_goes_stale() {
    let mut app = App::new();
    add_render_schedule(&mut app);
    app.add_plugins(TransportInputPlugin);
    let parameter = app.world_mut().spawn(make_coarse_parameter()).id();
    let input_layer = spawn_transport_input_layer(&mut app);
    app.world_mut()
        .resource_mut::<ResolvedInputBindings>()
        .bindings = competing_source_bindings(ResolvedInputDestination::Fixture {
        targets: vec![ResolvedInputTarget {
            entity: parameter,
            offsets: vec![0],
        }],
    });
    let mut app = deliver_frames_in_separate_updates(app, &[(1, 42)]);

    app.world_mut()
        .run_system_once(
            |mut layers: Query<(&mut Layer, &mut TransportInputAssertionOwners)>,
             input_universes: Res<InputDmxUniverses>| {
                let (mut layer, mut owners) = layers.single_mut().expect("one input layer");
                // A zero timeout treats every source, including the priority 10 owner, as stale.
                clear_stale_parameter_assertions(
                    &mut layer,
                    &mut owners,
                    &input_universes,
                    Instant::now(),
                    std::time::Duration::ZERO,
                );
            },
        )
        .expect("stale clearing should run");
    let app = deliver_frames_in_separate_updates(app, &[(2, 99)]);

    assert_eq!(
        single_layer_value(&app, input_layer),
        ParameterValue::AbsolutePercent {
            value: (99.0_f32 / 255.0).into()
        }
    );
}

/// Verifies a lower-priority source takes over a console channel once the higher-priority
/// binding is removed, even though the old owner's origin is still recorded on the channel.
#[test]
fn console_target_falls_back_to_lower_priority_source_after_owner_binding_removed() {
    let mut app = App::new();
    add_render_schedule(&mut app);
    app.add_plugins(TransportInputPlugin);
    app.world_mut()
        .resource_mut::<ResolvedInputBindings>()
        .bindings = competing_source_bindings(ResolvedInputDestination::Console {
        target: ResolvedConsoleTarget {
            universe: 3,
            address: 1,
        },
        targets: vec![],
    });
    let mut app = deliver_frames_in_separate_updates(app, &[(1, 17)]);

    app.world_mut()
        .resource_mut::<ResolvedInputBindings>()
        .bindings
        .remove(0);
    let app = deliver_frames_in_separate_updates(app, &[(2, 66)]);

    assert_eq!(
        app.world()
            .resource::<ConsoleDmxUniverses>()
            .get_value(3, 1),
        Some(66)
    );
}

/// Verifies that when two source universes map onto one console channel, the higher-priority
/// binding's value holds no matter which source's frame arrives last.
#[test]
fn console_target_keeps_highest_priority_source_across_frames() {
    for arrival_order in [[(1, 17), (2, 66)], [(2, 66), (1, 17)]] {
        let mut app = App::new();
        add_render_schedule(&mut app);
        app.add_plugins(TransportInputPlugin);
        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = competing_source_bindings(ResolvedInputDestination::Console {
            target: ResolvedConsoleTarget {
                universe: 3,
                address: 1,
            },
            targets: vec![],
        });

        let app = deliver_frames_in_separate_updates(app, &arrival_order);

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(
            universes.get_value(3, 1),
            Some(17),
            "arrival order {arrival_order:?}"
        );
    }
}
