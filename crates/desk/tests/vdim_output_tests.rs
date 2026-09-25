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
use nightfall_compositor::prelude::*;
use nightfall_desk::prelude::{DEFAULT_GAMMA, apply_vdim};
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::universe::dmx_universes;
use nightfall_io::prelude::*;
use uuid::Uuid;

/// Reads one channel of the multicast sACN universe 1 output buffer.
fn sacn_output_value(universes: &ConsoleDmxUniverses, address: u16) -> ChannelDmxValue {
    let transport = OutputTransport::Sacn {
        mode: SacnDelivery::Multicast,
    };
    universes.get_output_universe(&transport, 1)[(address - 1) as usize]
}

fn param(attribute: Attribute, merge_type: MergeStrategy) -> ParameterMetadata {
    ParameterMetadata {
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        resolution: DmxValueResolution::Coarse,
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type,
        use_grandmaster: false,
    }
}

fn spawn_parameter(world: &mut World, metadata: ParameterMetadata) -> Instance<Parameter> {
    unsafe {
        Instance::from_entity_unchecked(
            world
                .spawn(Parameter {
                    metadata,
                    values: Default::default(),
                })
                .id(),
        )
    }
}

#[test]
fn virtual_intensity_scales_higher_priority_color_output() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.add_systems(
        Update,
        (compositor::<Parameter>, apply_vdim, dmx_universes).chain(),
    );

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 311,
            uid: fixture_uid,
            label: "fixture-311".to_string(),
        },
        make: "test".to_string(),
        model: "rgb".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "main".to_string(),
            parameters: vec![
                param(Attribute::VirtualIntensity, MergeStrategy::HTP),
                param(Attribute::Red, MergeStrategy::LTP),
                param(Attribute::White, MergeStrategy::HTP),
            ],
        }],
        ..Default::default()
    };

    let vdim_parameter = spawn_parameter(
        app.world_mut(),
        param(Attribute::VirtualIntensity, MergeStrategy::HTP),
    );
    let red_parameter = spawn_parameter(app.world_mut(), param(Attribute::Red, MergeStrategy::LTP));
    let white_parameter =
        spawn_parameter(app.world_mut(), param(Attribute::White, MergeStrategy::HTP));

    app.world_mut()
        .entity_mut(red_parameter.entity())
        .insert(ResolvedOutputDestinations {
            destinations: vec![OutputDestination {
                transport: OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                universe: 1,
                address: 1,
            }],
        });
    app.world_mut()
        .entity_mut(white_parameter.entity())
        .insert(ResolvedOutputDestinations {
            destinations: vec![OutputDestination {
                transport: OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                universe: 1,
                address: 2,
            }],
        });

    {
        let mut data_provider = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture);
        data_provider.add_parameter(
            fixture_ref.clone(),
            Attribute::VirtualIntensity,
            vdim_parameter,
        );
        data_provider.add_parameter(fixture_ref.clone(), Attribute::Red, red_parameter);
        data_provider.add_parameter(fixture_ref.clone(), Attribute::White, white_parameter);
    }

    let mut plugin_layer = Layer::new("plugin".to_string(), Priority(50));
    plugin_layer.absolute.insert(
        vdim_parameter,
        (ParameterValue::Absolute { value: 64.0 }, None),
    );

    let mut programmer_layer = Layer::new("programmer".to_string(), Priority(127));
    programmer_layer.absolute.insert(
        red_parameter,
        (ParameterValue::Absolute { value: 255.0 }, None),
    );
    programmer_layer.absolute.insert(
        white_parameter,
        (ParameterValue::Absolute { value: 255.0 }, None),
    );

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Fx,
            id: 1,
        }),
        plugin_layer,
    ));
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        programmer_layer,
    ));

    app.update();

    let red = app
        .world()
        .get::<Parameter>(red_parameter.entity())
        .unwrap();
    let white = app
        .world()
        .get::<Parameter>(white_parameter.entity())
        .unwrap();
    let vdim = app
        .world()
        .get::<Parameter>(vdim_parameter.entity())
        .unwrap();
    let universes = app.world().resource::<ConsoleDmxUniverses>();

    assert_eq!(vdim.values.current_value, 64.0);

    let expected_scale = nightfall_desk::prelude::gamma_correct(64.0 / 255.0, DEFAULT_GAMMA);
    let expected_color = 255.0 * expected_scale;
    assert!(
        (red.values.current_value - expected_color).abs() < 0.001,
        "expected red current value {expected_color}, got {}",
        red.values.current_value
    );
    assert!(
        (white.values.current_value - expected_color).abs() < 0.001,
        "expected white current value {expected_color}, got {}",
        white.values.current_value
    );

    let red_dmx = sacn_output_value(universes, 1);
    let white_dmx = sacn_output_value(universes, 2);
    assert!(
        red_dmx < 255,
        "expected red DMX output to be scaled below full, got {red_dmx}"
    );
    assert!(
        white_dmx < 255,
        "expected white DMX output to be scaled below full, got {white_dmx}"
    );

    app.update();

    let red_after_stable_update = app
        .world()
        .get::<Parameter>(red_parameter.entity())
        .unwrap()
        .values
        .current_value;
    let white_after_stable_update = app
        .world()
        .get::<Parameter>(white_parameter.entity())
        .unwrap()
        .values
        .current_value;
    let stable_universes = app.world().resource::<ConsoleDmxUniverses>();

    assert!(
        (red_after_stable_update - expected_color).abs() < 0.001,
        "expected red current value to stay {expected_color}, got {red_after_stable_update}"
    );
    assert!(
        (white_after_stable_update - expected_color).abs() < 0.001,
        "expected white current value to stay {expected_color}, got {white_after_stable_update}"
    );
    assert_eq!(
        sacn_output_value(stable_universes, 1),
        red_dmx,
        "expected stable red DMX output to be reused"
    );
    assert_eq!(
        sacn_output_value(stable_universes, 2),
        white_dmx,
        "expected stable white DMX output to be reused"
    );
}

/// Verifies virtual intensity above full does not amplify color output.
#[test]
fn virtual_intensity_above_full_is_capped_before_scaling_color_output() {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.add_systems(
        Update,
        (compositor::<Parameter>, apply_vdim, dmx_universes).chain(),
    );

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 370,
            uid: fixture_uid,
            label: "fixture-370".to_string(),
        },
        make: "test".to_string(),
        model: "rgb".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "main".to_string(),
            parameters: vec![
                param(Attribute::VirtualIntensity, MergeStrategy::HTP),
                param(Attribute::Red, MergeStrategy::LTP),
            ],
        }],
        ..Default::default()
    };

    let vdim_parameter = spawn_parameter(
        app.world_mut(),
        param(Attribute::VirtualIntensity, MergeStrategy::HTP),
    );
    let red_parameter = spawn_parameter(app.world_mut(), param(Attribute::Red, MergeStrategy::LTP));

    app.world_mut()
        .entity_mut(red_parameter.entity())
        .insert(ResolvedOutputDestinations {
            destinations: vec![OutputDestination {
                transport: OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                universe: 1,
                address: 1,
            }],
        });

    {
        let mut data_provider = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture);
        data_provider.add_parameter(
            fixture_ref.clone(),
            Attribute::VirtualIntensity,
            vdim_parameter,
        );
        data_provider.add_parameter(fixture_ref, Attribute::Red, red_parameter);
    }

    let mut layer = Layer::new("over-full-vdim".to_string(), Priority(127));
    layer.absolute.insert(
        vdim_parameter,
        (ParameterValue::Absolute { value: 510.0 }, None),
    );
    layer.absolute.insert(
        red_parameter,
        (ParameterValue::Absolute { value: 128.0 }, None),
    );
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        layer,
    ));

    app.update();

    let red = app
        .world()
        .get::<Parameter>(red_parameter.entity())
        .unwrap();
    let vdim = app
        .world()
        .get::<Parameter>(vdim_parameter.entity())
        .unwrap();
    let universes = app.world().resource::<ConsoleDmxUniverses>();

    assert_eq!(vdim.values.current_value, 510.0);
    assert_eq!(
        red.values.current_value, 128.0,
        "expected over-full virtual intensity to preserve color value instead of amplifying it"
    );
    assert_eq!(
        sacn_output_value(universes, 1),
        128,
        "expected red DMX output to stay at authored color level"
    );
}
