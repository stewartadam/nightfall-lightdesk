// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use moonshine_kind::Instance;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::binding_resolution::{
    derive_console_addresses, resolve_input_bindings, resolve_output_bindings,
};
use nightfall_fixtures::prelude::*;
use nightfall_io::BindingTransport;
use nightfall_io::prelude::*;
use uuid::Uuid;

fn make_fixture(uid: Uuid, id: u32, params: Vec<ParameterMetadata>) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id,
            uid,
            label: format!("fixture-{id}"),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "main".to_string(),
            parameters: params,
        }],
        ..Default::default()
    }
}

fn param(attribute: Attribute) -> ParameterMetadata {
    ParameterMetadata {
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        resolution: DmxValueResolution::Coarse,
        ..Default::default()
    }
}

fn spawn_fixture_with_parameter(
    world: &mut World,
    uid: Uuid,
    id: u32,
    attribute: Attribute,
) -> Entity {
    let metadata = param(attribute.clone());
    let fixture = make_fixture(uid, id, vec![metadata.clone()]);
    let parameter_entity = world
        .spawn(Parameter {
            metadata,
            values: Default::default(),
        })
        .id();

    unsafe {
        let mut data_provider = world.resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture);
        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: uid,
                index: Some(1),
            },
            attribute,
            parameter,
        );
    }

    parameter_entity
}

/// Entity IDs created while probing RGB strobe bar binding resolution.
struct RgbStrobeBarProbeEntities {
    top_left_red: Entity,
    bottom_left_red: Entity,
    white_right: Entity,
    white_left: Entity,
}

/// Entity IDs created while probing Generic wash beam binding resolution.
struct RotatingWashBeamProbeEntities {
    control_tilt: Entity,
    beam_left_red: Entity,
    beam_right_red: Entity,
    top_strip_left_red: Entity,
    bottom_strip_right_yellow: Entity,
}

/// Entity IDs created while probing Generic moving spot binding resolution.
struct MovingSpotProbeEntities {
    tilt: Entity,
    pan: Entity,
    pan_tilt_speed: Entity,
    intensity: Entity,
    ring_speed: Entity,
}

fn spawn_generic_rgb_strobe_bar_probe_fixture(
    world: &mut World,
    uid: Uuid,
) -> RgbStrobeBarProbeEntities {
    let white_param = param(Attribute::White);
    let white_params = vec![param(Attribute::VirtualIntensity), white_param];
    let rgb_params = vec![
        param(Attribute::VirtualIntensity),
        param(Attribute::Red),
        param(Attribute::Green),
        param(Attribute::Blue),
    ];

    let mut elements = Vec::new();
    for index in 1..=24 {
        elements.push(FixtureElement {
            label: format!("White Segment {}", index),
            parameters: white_params.clone(),
        });
    }
    for index in 1..=24 {
        elements.push(FixtureElement {
            label: format!("Top RGB Segment {}", index),
            parameters: rgb_params.clone(),
        });
    }
    for index in 1..=24 {
        elements.push(FixtureElement {
            label: format!("Bottom RGB Segment {}", index),
            parameters: rgb_params.clone(),
        });
    }

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 999,
            uid,
            label: "rgb-strobe-bar".to_string(),
        },
        make: "Generic".to_string(),
        model: "Renamed fixture".to_string(),
        layout: Some(nightfall_fixtures::fixture::FixtureLayout::RgbStrobeBar),
        mode: "Strobe".to_string(),
        elements: elements.clone(),
        ..Default::default()
    };

    let mut probe = RgbStrobeBarProbeEntities {
        top_left_red: Entity::PLACEHOLDER,
        bottom_left_red: Entity::PLACEHOLDER,
        white_right: Entity::PLACEHOLDER,
        white_left: Entity::PLACEHOLDER,
    };

    {
        let mut data_provider = world.resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture);
    }

    for (element_index, element) in elements.iter().enumerate() {
        let fixture_ref = FixtureRef {
            fixture_uid: uid,
            index: Some(element_index as u32 + 1),
        };

        for parameter_metadata in &element.parameters {
            let attribute = parameter_metadata.attribute.clone();
            let entity = world
                .spawn(Parameter {
                    metadata: parameter_metadata.clone(),
                    values: Default::default(),
                })
                .id();
            unsafe {
                let parameter: Instance<Parameter> = Instance::from_entity_unchecked(entity);
                let data_provider = world.resource_mut::<FixtureDataProviderExt>();
                data_provider.add_parameter(fixture_ref.clone(), attribute.clone(), parameter);
            }

            match (element_index + 1, attribute) {
                (48, Attribute::Red) => probe.top_left_red = entity,
                (49, Attribute::Red) => probe.bottom_left_red = entity,
                (24, Attribute::White) => probe.white_right = entity,
                (1, Attribute::White) => probe.white_left = entity,
                _ => {}
            }
        }
    }

    probe
}

/// Spawns a Generic wash beam probe fixture and records parameters at key DMX addresses.
fn spawn_rotating_wash_beam_probe_fixture(
    world: &mut World,
    uid: Uuid,
) -> RotatingWashBeamProbeEntities {
    let mut fixture = nightfall_fixtures::library::create_fixture_from_library(
        1000,
        "Generic",
        "12-segment Rotating Wash Beam",
        "",
    )
    .expect("expected built-in Generic wash beam profile");
    fixture.identifiers.uid = uid;
    fixture.make = "User renamed manufacturer".to_owned();
    fixture.model = "User renamed model".to_owned();

    let elements = fixture.elements.clone();
    let mut probe = RotatingWashBeamProbeEntities {
        control_tilt: Entity::PLACEHOLDER,
        beam_left_red: Entity::PLACEHOLDER,
        beam_right_red: Entity::PLACEHOLDER,
        top_strip_left_red: Entity::PLACEHOLDER,
        bottom_strip_right_yellow: Entity::PLACEHOLDER,
    };

    {
        let mut data_provider = world.resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture);
    }

    for (element_index, element) in elements.iter().enumerate() {
        let fixture_ref = FixtureRef {
            fixture_uid: uid,
            index: Some(element_index as u32 + 1),
        };

        for parameter_metadata in &element.parameters {
            let attribute = parameter_metadata.attribute.clone();
            let entity = world
                .spawn(Parameter {
                    metadata: parameter_metadata.clone(),
                    values: Default::default(),
                })
                .id();
            unsafe {
                let parameter: Instance<Parameter> = Instance::from_entity_unchecked(entity);
                let data_provider = world.resource_mut::<FixtureDataProviderExt>();
                data_provider.add_parameter(fixture_ref.clone(), attribute.clone(), parameter);
            }

            match (element_index + 1, attribute) {
                (1, Attribute::Tilt) => probe.control_tilt = entity,
                (2, Attribute::Red) => probe.beam_left_red = entity,
                (13, Attribute::Red) => probe.beam_right_red = entity,
                (14, Attribute::Red) => probe.top_strip_left_red = entity,
                (37, Attribute::Yellow) => probe.bottom_strip_right_yellow = entity,
                _ => {}
            }
        }
    }

    probe
}

/// Spawns a Generic moving spot probe fixture and records parameters at key DMX addresses.
fn spawn_moving_spot_probe_fixture(world: &mut World, uid: Uuid) -> MovingSpotProbeEntities {
    let mut fixture = nightfall_fixtures::library::create_fixture_from_library(
        501,
        "Generic",
        "Moving Head Spot 16ch",
        "Spot",
    )
    .expect("expected built-in Generic moving spot profile");
    fixture.identifiers.uid = uid;

    let mut probe = MovingSpotProbeEntities {
        tilt: Entity::PLACEHOLDER,
        pan: Entity::PLACEHOLDER,
        pan_tilt_speed: Entity::PLACEHOLDER,
        intensity: Entity::PLACEHOLDER,
        ring_speed: Entity::PLACEHOLDER,
    };

    let element_ref = FixtureRef {
        fixture_uid: uid,
        index: Some(1),
    };

    for parameter_metadata in fixture.elements[0].parameters.clone() {
        let parameter_entity = world
            .spawn(Parameter {
                metadata: parameter_metadata.clone(),
                values: Default::default(),
            })
            .id();

        match &parameter_metadata.attribute {
            Attribute::Tilt => probe.tilt = parameter_entity,
            Attribute::Pan => probe.pan = parameter_entity,
            Attribute::Intensity => probe.intensity = parameter_entity,
            Attribute::Custom { label } if label == "Pan/Tilt Speed" => {
                probe.pan_tilt_speed = parameter_entity;
            }
            Attribute::Custom { label } if label == "Ring Speed" => {
                probe.ring_speed = parameter_entity;
            }
            _ => {}
        }

        unsafe {
            let data_provider = world.resource_mut::<FixtureDataProviderExt>();
            let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
            data_provider.add_parameter(
                element_ref.clone(),
                parameter_metadata.attribute.clone(),
                parameter,
            );
        }
    }

    {
        let mut data_provider = world.resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture);
    }

    probe
}

fn first_output_address(world: &World, entity: Entity) -> u16 {
    world
        .get::<ResolvedOutputDestinations>(entity)
        .expect("Expected ResolvedOutputDestinations component")
        .destinations
        .first()
        .expect("expected at least one output destination")
        .addresses[0]
}

#[test]
fn derive_console_addresses_respects_priority_over_insertion_order() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid = Uuid::new_v4();
    spawn_fixture_with_parameter(app.world_mut(), uid, 1, Attribute::Intensity);

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![
            OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Console {
                    universe: Some(DmxRange::single(2)),
                    address: Some(100),
                },
                priority: 10,
                clone: false,
            },
            OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Console {
                    universe: Some(DmxRange::single(1)),
                    address: Some(1),
                },
                priority: 0,
                clone: false,
            },
        ];
    }

    app.add_systems(Update, derive_console_addresses);
    app.update();

    let console_addresses = app.world().resource::<ConsoleDmxAddresses>();
    assert_eq!(
        console_addresses.addresses.get(&uid),
        Some(&ConsoleDmxAddress {
            universe: 2,
            address: 100
        })
    );
}

#[test]
fn resolve_output_bindings_orders_destinations_by_priority_then_insertion() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid = Uuid::new_v4();
    let parameter_entity = spawn_fixture_with_parameter(app.world_mut(), uid, 1, Attribute::Red);

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![
            OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(50),
                },
                priority: 10,
                clone: false,
            },
            OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(10),
                },
                priority: 0,
                clone: false,
            },
        ];
    }

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    let destinations = app
        .world()
        .get::<ResolvedOutputDestinations>(parameter_entity)
        .expect("Expected ResolvedOutputDestinations component");
    assert_eq!(
        destinations.destinations,
        vec![
            OutputDestination {
                transport: OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast
                },
                universe: 1,
                addresses: vec![10],
            },
            OutputDestination {
                transport: OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast
                },
                universe: 1,
                addresses: vec![50],
            },
        ]
    );
}

#[test]
fn resolve_output_bindings_uses_generic_rgb_strobe_bar_hardware_dmx_order() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid = Uuid::new_v4();
    let probe = spawn_generic_rgb_strobe_bar_probe_fixture(app.world_mut(), uid);

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![uid],
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: "sacn".to_string(),
                universe: Some(DmxRange::single(1)),
                address: Some(1),
            },
            priority: 0,
            clone: false,
        }];
    }

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    assert_eq!(first_output_address(app.world(), probe.top_left_red), 1);
    assert_eq!(first_output_address(app.world(), probe.bottom_left_red), 73);
    assert_eq!(first_output_address(app.world(), probe.white_right), 145);
    assert_eq!(first_output_address(app.world(), probe.white_left), 168);
}

#[test]
/// Verifies the Generic wash beam profile patches control, reversed beams, and strips to hardware order.
fn resolve_output_bindings_uses_rotating_wash_beam_hardware_dmx_order() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid = Uuid::new_v4();
    let probe = spawn_rotating_wash_beam_probe_fixture(app.world_mut(), uid);

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![uid],
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: "sacn".to_string(),
                universe: Some(DmxRange::single(1)),
                address: Some(1),
            },
            priority: 0,
            clone: false,
        }];
    }

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    assert_eq!(first_output_address(app.world(), probe.control_tilt), 1);
    assert_eq!(first_output_address(app.world(), probe.beam_right_red), 27);
    assert_eq!(first_output_address(app.world(), probe.beam_left_red), 71);
    assert_eq!(
        first_output_address(app.world(), probe.top_strip_left_red),
        75
    );
    assert_eq!(
        first_output_address(app.world(), probe.bottom_strip_right_yellow),
        194
    );
}

#[test]
/// Verifies the Generic moving spot patches all 16 channels in fixture-library hardware order.
fn resolve_output_bindings_uses_moving_spot_hardware_dmx_order() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid = Uuid::new_v4();
    let probe = spawn_moving_spot_probe_fixture(app.world_mut(), uid);

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![uid],
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: "sacn".to_string(),
                universe: Some(DmxRange::single(1)),
                address: Some(1),
            },
            priority: 0,
            clone: false,
        }];
    }

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    assert_eq!(first_output_address(app.world(), probe.pan), 1);
    assert_eq!(first_output_address(app.world(), probe.tilt), 3);
    assert_eq!(first_output_address(app.world(), probe.pan_tilt_speed), 5);
    assert_eq!(first_output_address(app.world(), probe.intensity), 6);
    assert_eq!(first_output_address(app.world(), probe.ring_speed), 16);
}

#[test]
fn resolve_output_bindings_supports_floating_fixtures() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid = Uuid::new_v4();
    let parameter_entity = spawn_fixture_with_parameter(app.world_mut(), uid, 1, Attribute::Blue);

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![uid],
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: "artnet".to_string(),
                universe: Some(DmxRange::single(5)),
                address: Some(7),
            },
            priority: 0,
            clone: false,
        }];
    }

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    let destinations = app
        .world()
        .get::<ResolvedOutputDestinations>(parameter_entity)
        .expect("Expected ResolvedOutputDestinations component");
    assert_eq!(
        destinations.destinations,
        vec![OutputDestination {
            transport: OutputTransport::ArtNet {
                mode: ArtNetDelivery::Broadcast
            },
            universe: 5,
            addresses: vec![7],
        }]
    );
}

#[test]
fn resolve_input_bindings_is_stable_for_equal_priority() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<ResolvedInputBindings>();

    let uid = Uuid::new_v4();
    spawn_fixture_with_parameter(app.world_mut(), uid, 1, Attribute::Intensity);

    {
        let mut input_bindings = app.world_mut().resource_mut::<InputBindings>();
        input_bindings.bindings = vec![
            InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: None,
                },
                target: InputTarget::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                priority: 5,
                clone: false,
            },
            InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(2)),
                    address: None,
                },
                target: InputTarget::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                priority: 5,
                clone: false,
            },
        ];
    }

    app.add_systems(Update, resolve_input_bindings);
    app.update();

    let resolved = app.world().resource::<ResolvedInputBindings>();
    assert_eq!(resolved.bindings.len(), 2);
    assert_eq!(
        resolved.bindings[0].source,
        ResolvedInputSource::Transport {
            transport: BindingTransport::Sacn,
            universe: 1,
            address: 1,
        }
    );
    assert_eq!(
        resolved.bindings[1].source,
        ResolvedInputSource::Transport {
            transport: BindingTransport::Sacn,
            universe: 2,
            address: 1,
        }
    );
}

#[test]
fn resolve_input_bindings_applies_disabled_filter_from_target_disabled() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<ResolvedInputBindings>();

    let uid = Uuid::new_v4();
    spawn_fixture_with_parameter(app.world_mut(), uid, 1, Attribute::Intensity);

    {
        let mut input_bindings = app.world_mut().resource_mut::<InputBindings>();
        input_bindings.bindings = vec![
            InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: None,
                },
                target: InputTarget::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                priority: 0,
                clone: false,
            },
            InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: None,
                },
                target: InputTarget::Disabled,
                priority: 0,
                clone: false,
            },
        ];
    }

    app.add_systems(Update, resolve_input_bindings);
    app.update();

    let resolved = app.world().resource::<ResolvedInputBindings>();
    assert!(resolved.bindings.is_empty());
}

#[test]
fn resolve_input_bindings_clone_resets_offsets() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<ResolvedInputBindings>();

    let uid_a = Uuid::new_v4();
    let uid_b = Uuid::new_v4();
    let param_a = spawn_fixture_with_parameter(app.world_mut(), uid_a, 1, Attribute::Intensity);
    let param_b = spawn_fixture_with_parameter(app.world_mut(), uid_b, 2, Attribute::Intensity);

    {
        let mut input_bindings = app.world_mut().resource_mut::<InputBindings>();
        input_bindings.bindings = vec![InputBinding {
            source: InputSource::Transport {
                transport: BindingTransport::Sacn,
                universe: Some(DmxRange::single(1)),
                address: None,
            },
            target: InputTarget::Fixture {
                uids: vec![uid_a, uid_b],
                element: None,
                param: None,
            },
            priority: 0,
            clone: true,
        }];
    }

    app.add_systems(Update, resolve_input_bindings);
    app.update();

    let resolved = app.world().resource::<ResolvedInputBindings>();
    assert_eq!(resolved.bindings.len(), 1);
    assert_eq!(
        resolved.bindings[0].destination,
        ResolvedInputDestination::Fixture {
            targets: vec![
                ResolvedInputTarget {
                    entity: param_a,
                    offsets: vec![0]
                },
                ResolvedInputTarget {
                    entity: param_b,
                    offsets: vec![0]
                }
            ]
        }
    );
}

#[test]
fn resolve_input_bindings_transport_console_mapping_by_universe() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<ResolvedInputBindings>();

    let uid_a = Uuid::new_v4();
    let uid_b = Uuid::new_v4();
    let param_a = spawn_fixture_with_parameter(app.world_mut(), uid_a, 1, Attribute::Intensity);
    let param_b = spawn_fixture_with_parameter(app.world_mut(), uid_b, 2, Attribute::Intensity);

    {
        let mut console_addresses = app.world_mut().resource_mut::<ConsoleDmxAddresses>();
        console_addresses.addresses.insert(
            uid_a,
            ConsoleDmxAddress {
                universe: 1,
                address: 1,
            },
        );
        console_addresses.addresses.insert(
            uid_b,
            ConsoleDmxAddress {
                universe: 3,
                address: 1,
            },
        );
    }

    {
        let mut input_bindings = app.world_mut().resource_mut::<InputBindings>();
        input_bindings.bindings = vec![InputBinding {
            source: InputSource::Transport {
                transport: BindingTransport::Sacn,
                universe: None,
                address: None,
            },
            target: InputTarget::Console {
                universe: None,
                address: None,
            },
            priority: 0,
            clone: false,
        }];
    }

    app.add_systems(Update, resolve_input_bindings);
    app.update();

    let resolved = app.world().resource::<ResolvedInputBindings>();
    assert_eq!(resolved.bindings.len(), 512);

    let universe_1 = resolved
        .bindings
        .iter()
        .find(|binding| {
            binding.source
                == ResolvedInputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: 1,
                    address: 1,
                }
        })
        .expect("expected transport binding for universe 1");
    assert_eq!(
        universe_1.destination,
        ResolvedInputDestination::Console {
            target: ResolvedConsoleTarget {
                universe: 1,
                address: 1
            },
            targets: vec![ResolvedInputTarget {
                entity: param_a,
                offsets: vec![0]
            }]
        }
    );

    let universe_2 = resolved
        .bindings
        .iter()
        .find(|binding| {
            binding.source
                == ResolvedInputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: 2,
                    address: 1,
                }
        })
        .expect("expected transport binding for universe 2");
    assert_eq!(
        universe_2.destination,
        ResolvedInputDestination::Console {
            target: ResolvedConsoleTarget {
                universe: 2,
                address: 1
            },
            targets: vec![]
        }
    );

    let universe_3 = resolved
        .bindings
        .iter()
        .find(|binding| {
            binding.source
                == ResolvedInputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: 3,
                    address: 1,
                }
        })
        .expect("expected transport binding for universe 3");
    assert_eq!(
        universe_3.destination,
        ResolvedInputDestination::Console {
            target: ResolvedConsoleTarget {
                universe: 3,
                address: 1
            },
            targets: vec![ResolvedInputTarget {
                entity: param_b,
                offsets: vec![0]
            }]
        }
    );
}

#[test]
fn resolve_input_bindings_transport_console_keeps_mapping_without_fixture_targets() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<ResolvedInputBindings>();

    {
        let mut input_bindings = app.world_mut().resource_mut::<InputBindings>();
        input_bindings.bindings = vec![InputBinding {
            source: InputSource::Transport {
                transport: BindingTransport::Sacn,
                universe: Some(DmxRange::single(2)),
                address: Some(100),
            },
            target: InputTarget::Console {
                universe: Some(DmxRange::single(5)),
                address: Some(20),
            },
            priority: 0,
            clone: false,
        }];
    }

    app.add_systems(Update, resolve_input_bindings);
    app.update();

    let resolved = app.world().resource::<ResolvedInputBindings>();
    assert_eq!(resolved.bindings.len(), 1);
    assert_eq!(
        resolved.bindings[0].source,
        ResolvedInputSource::Transport {
            transport: BindingTransport::Sacn,
            universe: 2,
            address: 100,
        }
    );
    assert_eq!(
        resolved.bindings[0].destination,
        ResolvedInputDestination::Console {
            target: ResolvedConsoleTarget {
                universe: 5,
                address: 20
            },
            targets: vec![]
        }
    );
}

#[test]
fn resolve_input_bindings_clone_false_offsets_are_contiguous() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<ResolvedInputBindings>();

    let uid_a = Uuid::new_v4();
    let uid_b = Uuid::new_v4();
    let param_a = spawn_fixture_with_parameter(app.world_mut(), uid_a, 1, Attribute::Intensity);
    let param_b = spawn_fixture_with_parameter(app.world_mut(), uid_b, 2, Attribute::Intensity);

    {
        let mut input_bindings = app.world_mut().resource_mut::<InputBindings>();
        input_bindings.bindings = vec![InputBinding {
            source: InputSource::Transport {
                transport: BindingTransport::Sacn,
                universe: Some(DmxRange::single(1)),
                address: None,
            },
            target: InputTarget::Fixture {
                uids: vec![uid_a, uid_b],
                element: None,
                param: None,
            },
            priority: 0,
            clone: false,
        }];
    }

    app.add_systems(Update, resolve_input_bindings);
    app.update();

    let resolved = app.world().resource::<ResolvedInputBindings>();
    assert_eq!(resolved.bindings.len(), 1);
    assert_eq!(
        resolved.bindings[0].destination,
        ResolvedInputDestination::Fixture {
            targets: vec![
                ResolvedInputTarget {
                    entity: param_a,
                    offsets: vec![0]
                },
                ResolvedInputTarget {
                    entity: param_b,
                    offsets: vec![1]
                }
            ]
        }
    );
}

#[test]
fn resolve_output_bindings_resets_per_fixture_address_when_cloning() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid_a = Uuid::new_v4();
    let uid_b = Uuid::new_v4();
    let param_a = spawn_fixture_with_parameter(app.world_mut(), uid_a, 1, Attribute::Intensity);
    let param_b = spawn_fixture_with_parameter(app.world_mut(), uid_b, 2, Attribute::Intensity);

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![uid_a, uid_b],
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: "sacn".to_string(),
                universe: Some(DmxRange::single(1)),
                address: Some(10),
            },
            priority: 0,
            clone: true,
        }];
    }

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    let dest_a = app
        .world()
        .get::<ResolvedOutputDestinations>(param_a)
        .expect("Expected destinations for param_a");
    let dest_b = app
        .world()
        .get::<ResolvedOutputDestinations>(param_b)
        .expect("Expected destinations for param_b");

    assert_eq!(
        dest_a.destinations,
        vec![OutputDestination {
            transport: OutputTransport::Sacn {
                mode: SacnDelivery::Multicast
            },
            universe: 1,
            addresses: vec![10],
        }]
    );
    assert_eq!(
        dest_b.destinations,
        vec![OutputDestination {
            transport: OutputTransport::Sacn {
                mode: SacnDelivery::Multicast
            },
            universe: 1,
            addresses: vec![10],
        }]
    );
}

#[test]
fn resolve_output_bindings_resolves_named_usb_targets() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid = Uuid::new_v4();
    let parameter_entity =
        spawn_fixture_with_parameter(app.world_mut(), uid, 1, Attribute::Intensity);

    {
        let mut usb_outputs = app.world_mut().resource_mut::<UsbDmxOutputTargets>();
        *usb_outputs = UsbDmxOutputTargets {
            targets: vec![
                UsbDmxOutputTarget {
                    id: "udmx".to_string(),
                    device: "default".to_string(),
                    device_label: None,
                },
                UsbDmxOutputTarget {
                    id: "front-usb".to_string(),
                    device: "usb-serial-1".to_string(),
                    device_label: Some("Anyma uDMX".to_string()),
                },
            ],
        }
        .sanitized();
    }

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![uid],
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: "front-usb".to_string(),
                universe: Some(DmxRange::single(1)),
                address: Some(10),
            },
            priority: 0,
            clone: false,
        }];
    }

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    let destinations = app
        .world()
        .get::<ResolvedOutputDestinations>(parameter_entity)
        .expect("Expected ResolvedOutputDestinations component");
    assert_eq!(
        destinations.destinations,
        vec![OutputDestination {
            transport: OutputTransport::Udmx {
                device: "usb-serial-1".to_string(),
            },
            universe: 1,
            addresses: vec![10],
        }]
    );
}

#[test]
fn resolve_output_bindings_applies_disabled_filter_from_target_disabled() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();

    let uid = Uuid::new_v4();
    let parameter_entity =
        spawn_fixture_with_parameter(app.world_mut(), uid, 1, Attribute::Intensity);

    {
        let mut output_bindings = app.world_mut().resource_mut::<OutputBindings>();
        output_bindings.bindings = vec![
            OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(10),
                },
                priority: 0,
                clone: false,
            },
            OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Disabled,
                priority: 0,
                clone: false,
            },
        ];
    }

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    let destinations = app
        .world()
        .get::<ResolvedOutputDestinations>(parameter_entity)
        .expect("Expected ResolvedOutputDestinations component");
    assert!(destinations.destinations.is_empty());
}

/// Builds break-1 parameter metadata placed at explicit 1-based footprint slots.
fn explicit_param(attribute: Attribute, offsets: &[u16]) -> ParameterMetadata {
    let resolution = match offsets.len() {
        1 => DmxValueResolution::Coarse,
        2 => DmxValueResolution::Fine,
        3 => DmxValueResolution::UltraFine,
        _ => DmxValueResolution::Uber,
    };
    ParameterMetadata {
        resolution,
        max: nightfall_fixtures::wire_layout::dmx_max(resolution) as ParameterDmxValue,
        value_polarity: ParameterValuePolarity::Unsigned,
        dmx_slots: DmxSlots::Explicit {
            dmx_break: 1,
            offsets: offsets.to_vec(),
        },
        ..param(attribute)
    }
}

/// Spawns a two-element fixture whose parameters use explicit, interleaved slots.
///
/// Wire layout (1-based): slot 1 head-1 tilt coarse, 2 head-2 tilt coarse,
/// 3 head-1 dimmer, 4 unused, 5 head-2 dimmer, 6 head-1 tilt fine,
/// 7 head-2 tilt fine. Returns entities in element order: `[tilt1, dim1, tilt2, dim2]`.
fn spawn_interleaved_fixture(world: &mut World, uid: Uuid) -> [Entity; 4] {
    let elements = [
        vec![
            explicit_param(Attribute::Tilt, &[1, 6]),
            explicit_param(Attribute::Intensity, &[3]),
        ],
        vec![
            explicit_param(Attribute::Tilt, &[2, 7]),
            explicit_param(Attribute::Intensity, &[5]),
        ],
    ];
    let mut fixture = make_fixture(uid, 1, Vec::new());
    fixture.elements = elements
        .iter()
        .enumerate()
        .map(|(index, parameters)| FixtureElement {
            label: format!("Head {}", index + 1),
            parameters: parameters.clone(),
        })
        .collect();

    let mut entities = Vec::new();
    for (index, parameters) in elements.into_iter().enumerate() {
        for metadata in parameters {
            let attribute = metadata.attribute.clone();
            let entity = world
                .spawn(Parameter {
                    metadata,
                    values: Default::default(),
                })
                .id();
            unsafe {
                let data_provider = world.resource_mut::<FixtureDataProviderExt>();
                let parameter: Instance<Parameter> = Instance::from_entity_unchecked(entity);
                data_provider.add_parameter(
                    FixtureRef {
                        fixture_uid: uid,
                        index: Some(index as u32 + 1),
                    },
                    attribute,
                    parameter,
                );
            }
            entities.push(entity);
        }
    }
    let _ = world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture);
    entities.try_into().expect("four parameters")
}

/// Registers resources needed by output resolution and console DMX rendering.
fn output_app() -> App {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxUniverses>();
    app
}

/// Returns an output binding patching fixtures to sACN universe 1 at `address`.
fn sacn_binding(uids: Vec<Uuid>, address: u16) -> OutputBinding {
    OutputBinding {
        source: OutputSource::Fixture {
            uids,
            element: None,
            param: None,
        },
        target: OutputTarget::Transport {
            target: "sacn".to_string(),
            universe: Some(DmxRange::single(1)),
            address: Some(address),
        },
        priority: 0,
        clone: false,
    }
}

/// Returns every byte address of a parameter's first output destination.
fn output_addresses(world: &World, entity: Entity) -> Vec<u16> {
    world
        .get::<ResolvedOutputDestinations>(entity)
        .expect("resolved destinations")
        .destinations[0]
        .addresses
        .clone()
}

/// Verifies explicit profile slots place interleaved heads and separated fine bytes exactly.
#[test]
fn resolve_output_bindings_uses_explicit_profile_slots() {
    let mut app = output_app();
    let uid = Uuid::new_v4();
    let [tilt1, dim1, tilt2, dim2] = spawn_interleaved_fixture(app.world_mut(), uid);
    app.world_mut().resource_mut::<OutputBindings>().bindings = vec![sacn_binding(vec![uid], 101)];

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    assert_eq!(output_addresses(app.world(), tilt1), vec![101, 106]);
    assert_eq!(output_addresses(app.world(), tilt2), vec![102, 107]);
    assert_eq!(output_addresses(app.world(), dim1), vec![103]);
    assert_eq!(output_addresses(app.world(), dim2), vec![105]);
}

/// Verifies the next fixture in a patch run starts after the explicit footprint, gaps included.
#[test]
fn resolve_output_bindings_advances_by_explicit_footprint() {
    let mut app = output_app();
    let uid = Uuid::new_v4();
    let next_uid = Uuid::new_v4();
    spawn_interleaved_fixture(app.world_mut(), uid);
    let next = spawn_fixture_with_parameter(app.world_mut(), next_uid, 2, Attribute::Red);
    app.world_mut().resource_mut::<OutputBindings>().bindings =
        vec![sacn_binding(vec![uid, next_uid], 1)];

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    assert_eq!(output_addresses(app.world(), next), vec![8]);
}

/// Verifies patching one element rebases its explicit slots to the binding address.
#[test]
fn resolve_output_bindings_rebases_element_selection() {
    let mut app = output_app();
    let uid = Uuid::new_v4();
    let [_, _, tilt2, dim2] = spawn_interleaved_fixture(app.world_mut(), uid);
    let mut binding = sacn_binding(vec![uid], 20);
    binding.source = OutputSource::Fixture {
        uids: vec![uid],
        element: Some(2),
        param: None,
    };
    app.world_mut().resource_mut::<OutputBindings>().bindings = vec![binding];

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    assert_eq!(output_addresses(app.world(), tilt2), vec![20, 25]);
    assert_eq!(output_addresses(app.world(), dim2), vec![23]);
}

/// Verifies a break-2 binding patches only that break's parameters from its own start address.
#[test]
fn resolve_output_bindings_patches_secondary_dmx_break() {
    let mut app = output_app();
    let uid = Uuid::new_v4();
    let [tilt1, dim1, _, dim2] = spawn_interleaved_fixture(app.world_mut(), uid);
    app.world_mut()
        .get_mut::<Parameter>(dim2)
        .expect("dimmer parameter")
        .metadata
        .dmx_slots = DmxSlots::Explicit {
        dmx_break: 2,
        offsets: vec![3],
    };
    let mut break_binding = sacn_binding(vec![uid], 201);
    break_binding.source = OutputSource::FixtureBreak {
        uids: vec![uid],
        dmx_break: 2,
    };
    app.world_mut().resource_mut::<OutputBindings>().bindings =
        vec![sacn_binding(vec![uid], 101), break_binding];

    app.add_systems(Update, resolve_output_bindings);
    app.update();

    assert_eq!(output_addresses(app.world(), tilt1), vec![101, 106]);
    assert_eq!(output_addresses(app.world(), dim1), vec![103]);
    let dim2_destinations = &app
        .world()
        .get::<ResolvedOutputDestinations>(dim2)
        .expect("break-2 destinations")
        .destinations;
    assert_eq!(dim2_destinations.len(), 1);
    assert_eq!(dim2_destinations[0].addresses, vec![203]);
}

/// Verifies rendered console bytes land on the explicit slots, most significant byte first.
#[test]
fn dmx_universes_writes_bytes_to_explicit_slots() {
    let mut app = output_app();
    let uid = Uuid::new_v4();
    let [tilt1, dim1, _, _] = spawn_interleaved_fixture(app.world_mut(), uid);
    app.world_mut().resource_mut::<OutputBindings>().bindings = vec![sacn_binding(vec![uid], 1)];
    {
        let mut tilt = app.world_mut().get_mut::<Parameter>(tilt1).unwrap();
        tilt.values.current_value = 0x1234 as ParameterDmxValue;
        let mut dimmer = app.world_mut().get_mut::<Parameter>(dim1).unwrap();
        dimmer.values.current_value = 200.0;
    }

    app.add_systems(
        Update,
        (
            resolve_output_bindings,
            nightfall_fixtures::universe::dmx_universes,
        )
            .chain(),
    );
    app.update();
    app.update();

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(universes.get_value(1, 1), Some(0x12));
    assert_eq!(universes.get_value(1, 6), Some(0x34));
    assert_eq!(universes.get_value(1, 3), Some(200));
    assert_eq!(universes.get_value(1, 2), Some(0));
}

/// Verifies input bindings decode explicit slots into per-byte source offsets.
#[test]
fn resolve_input_bindings_uses_explicit_profile_slots() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputBindings>();
    app.init_resource::<DisabledBindings>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<ResolvedInputBindings>();

    let uid = Uuid::new_v4();
    let [tilt1, dim1, tilt2, dim2] = spawn_interleaved_fixture(app.world_mut(), uid);
    app.world_mut().resource_mut::<InputBindings>().bindings = vec![InputBinding {
        source: InputSource::Transport {
            transport: BindingTransport::Sacn,
            universe: Some(DmxRange::single(1)),
            address: None,
        },
        target: InputTarget::Fixture {
            uids: vec![uid],
            element: None,
            param: None,
        },
        priority: 0,
        clone: false,
    }];

    app.add_systems(Update, resolve_input_bindings);
    app.update();

    let resolved = app.world().resource::<ResolvedInputBindings>();
    assert_eq!(
        resolved.bindings[0].destination,
        ResolvedInputDestination::Fixture {
            targets: vec![
                ResolvedInputTarget {
                    entity: tilt1,
                    offsets: vec![0, 5]
                },
                ResolvedInputTarget {
                    entity: dim1,
                    offsets: vec![2]
                },
                ResolvedInputTarget {
                    entity: tilt2,
                    offsets: vec![1, 6]
                },
                ResolvedInputTarget {
                    entity: dim2,
                    offsets: vec![4]
                },
            ]
        }
    );
}
