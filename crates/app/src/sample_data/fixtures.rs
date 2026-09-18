// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Pixel layout presets used by sample fixture generation.
enum PixelType {
    Rgb,
    Rgbw,
}

/// Bind a sample fixture to its configured output or retain a disabled binding.
fn apply_output_binding(
    world: &mut World,
    fixture_uid: Uuid,
    output_target_id: Option<&str>,
    universe: u16,
    address: u16,
) {
    let mut system_state: SystemState<(ResMut<OutputBindings>, ResMut<DisabledBindings>)> =
        SystemState::new(world);
    let (mut output_bindings, mut disabled_bindings) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    let source = OutputSource::Fixture {
        uids: vec![fixture_uid],
        element: None,
        param: None,
    };

    if let Some(target_id) = output_target_id {
        output_bindings.bindings.push(OutputBinding {
            source,
            target: OutputTarget::Transport {
                target: target_id.to_owned(),
                universe: Some(DmxRange::single(universe)),
                address: Some(address),
            },
            priority: 0,
            clone: false,
        });
    } else {
        disabled_bindings.bindings.push(DisabledBinding::Output {
            source,
            priority: 0,
            clone: false,
        });
    }
}

/// Build and patch one multi-pixel LED bar with deterministic metadata.
fn add_ledbar(
    world: &mut World,
    make: &str,
    model: &str,
    size: u16,
    pixel_type: PixelType,
    universe: u16,
    start_channel: u16,
    id: u32,
    output_target_id: Option<&str>,
    placement: FixturePlacement,
) {
    let mut parameters = vec![
        // VirtualIntensity is NOT patched to DMX - it scales RGB values in post-processing
        ParameterMetadata {
            attribute: Attribute::VirtualIntensity,
            native_unit: Attribute::VirtualIntensity.native_unit(),
            value_polarity: Attribute::VirtualIntensity.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::HTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: true,
        },
        ParameterMetadata {
            attribute: Attribute::Red,
            native_unit: Attribute::Red.native_unit(),
            value_polarity: Attribute::Red.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Green,
            native_unit: Attribute::Green.native_unit(),
            value_polarity: Attribute::Green.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Blue,
            native_unit: Attribute::Blue.native_unit(),
            value_polarity: Attribute::Blue.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];
    if let PixelType::Rgbw = pixel_type {
        parameters.push(ParameterMetadata {
            attribute: Attribute::White,
            native_unit: Attribute::White.native_unit(),
            value_polarity: Attribute::White.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        });
    }

    let fixture = Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(), // Sample fixture, no library mode
        elements: (1..=size)
            .map(|index| FixtureElement {
                label: format!("Pixel {}", index),
                parameters: parameters.to_owned(),
            })
            .collect(),
        physical: None,
        placement,
        layout: Some(nightfall_fixtures::fixture::FixtureLayout::LedBar),
        library_asset_etag: None,
    };

    for (element_idx, element) in fixture.elements.iter().enumerate() {
        let element_ref = FixtureRef {
            index: Some(element_idx as u32 + 1),
            fixture_uid: fixture.identifiers.uid,
        };

        element.parameters.iter().for_each(|parameter_metadata| {
            let mut commands: Commands<'_, '_> = world.commands();

            // VirtualIntensity defaults to 100% (255) so fixtures are visible when patched
            let values = if parameter_metadata.attribute == Attribute::VirtualIntensity {
                ParameterValues {
                    default_value: 255.0,
                    current_value: 255.0,
                    // FIXME: we might want a highlight preset instead of this, as here it would be helpful for color to change
                    highlight_value: 255.0,
                }
            } else {
                ParameterValues::default()
            };

            let parameter_cmds = commands.spawn_instance(Parameter {
                metadata: parameter_metadata.clone(),
                values,
            });
            let parameter_entity = parameter_cmds.instance();

            let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
                SystemState::new(world);
            let (fixture_data_provider,) = system_state
                .get_mut(world)
                .expect("sample data system parameters should be available");

            fixture_data_provider.add_parameter(
                element_ref.clone(),
                parameter_metadata.attribute.clone(),
                parameter_entity,
            );
        });
    }

    {
        let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
            SystemState::new(world);
        let (mut fixture_data_provider,) = system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");

        let _ = fixture_data_provider.inner.add(fixture.clone());
    }
    apply_output_binding(
        world,
        fixture.identifiers.uid,
        output_target_id,
        universe,
        start_channel,
    );
}

const STROBE_PIXEL_COUNT: usize = 96;
const STROBE_WHITE_COUNT: usize = 16;

/// Build and patch the explicit high-density strobe sample profile.
fn add_manual_strobe_fixture(
    world: &mut World,
    make: &str,
    model: &str,
    universe: u16,
    start_channel: u16,
    id: u32,
    output_target_id: Option<&str>,
    placement: FixturePlacement,
) {
    let vdim_parameter = ParameterMetadata {
        attribute: Attribute::VirtualIntensity,
        native_unit: Attribute::VirtualIntensity.native_unit(),
        value_polarity: Attribute::VirtualIntensity.value_polarity(),
        is_inverted: false,
        is_snap: false,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type: MergeStrategy::HTP,
        min: 0.0,
        resolution: DmxValueResolution::Coarse,
        use_grandmaster: true,
    };

    let rgb_parameters = vec![
        vdim_parameter.clone(),
        ParameterMetadata {
            attribute: Attribute::Red,
            native_unit: Attribute::Red.native_unit(),
            value_polarity: Attribute::Red.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Green,
            native_unit: Attribute::Green.native_unit(),
            value_polarity: Attribute::Green.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Blue,
            native_unit: Attribute::Blue.native_unit(),
            value_polarity: Attribute::Blue.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];

    let tilt_parameter = ParameterMetadata {
        attribute: Attribute::Tilt,
        native_unit: Attribute::Tilt.native_unit(),
        value_polarity: Attribute::Tilt.value_polarity(),
        is_inverted: false,
        is_snap: false,
        max: 270.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type: MergeStrategy::LTP,
        min: 0.0,
        resolution: DmxValueResolution::Fine,
        use_grandmaster: false,
    };

    let rotation_speed_parameter = ParameterMetadata {
        attribute: Attribute::Custom {
            label: "Rotation Speed".to_owned(),
        },
        native_unit: ParameterUnit::Percent,
        value_polarity: ParameterValuePolarity::Unsigned,
        is_inverted: false,
        is_snap: false,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type: MergeStrategy::LTP,
        min: 0.0,
        resolution: DmxValueResolution::Coarse,
        use_grandmaster: false,
    };

    let reset_parameter = ParameterMetadata {
        attribute: Attribute::Custom {
            label: "Reset".to_owned(),
        },
        native_unit: ParameterUnit::Percent,
        value_polarity: ParameterValuePolarity::Unsigned,
        is_inverted: false,
        is_snap: true,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type: MergeStrategy::LTP,
        min: 0.0,
        resolution: DmxValueResolution::Coarse,
        use_grandmaster: false,
    };

    let strobe_dimmer_parameters: Vec<(String, Vec<ParameterMetadata>)> = (0..STROBE_WHITE_COUNT)
        .map(|index| {
            let label = format!("Strobe Dimmer {}", index + 1);
            (
                label.clone(),
                vec![
                    vdim_parameter.clone(),
                    ParameterMetadata {
                        attribute: Attribute::White,
                        native_unit: Attribute::White.native_unit(),
                        value_polarity: Attribute::White.value_polarity(),
                        is_inverted: false,
                        is_snap: false,
                        max: 255.0,
                        offset: ParameterValue::Absolute { value: 0.0 },
                        merge_type: MergeStrategy::HTP,
                        min: 0.0,
                        resolution: DmxValueResolution::Coarse,
                        use_grandmaster: false,
                    },
                ],
            )
        })
        .collect();

    let mut elements = Vec::with_capacity(STROBE_PIXEL_COUNT + STROBE_WHITE_COUNT + 3);

    // Control elements first to match DMX channel order.
    elements.push(FixtureElement {
        label: "Tilt Axis".to_owned(),
        parameters: vec![tilt_parameter.clone()],
    });
    elements.push(FixtureElement {
        label: "Rotation Speed".to_owned(),
        parameters: vec![rotation_speed_parameter.clone()],
    });
    elements.push(FixtureElement {
        label: "Reset".to_owned(),
        parameters: vec![reset_parameter.clone()],
    });

    for (label, dim_params) in &strobe_dimmer_parameters {
        elements.push(FixtureElement {
            label: label.clone(),
            parameters: dim_params.clone(),
        });
    }

    for index in 0..STROBE_PIXEL_COUNT {
        elements.push(FixtureElement {
            label: format!("RGB Pixel {}", index + 1),
            parameters: rgb_parameters.clone(),
        });
    }

    let fixture = Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(), // Sample fixture, no library mode
        elements,
        physical: None,
        placement,
        layout: Some(nightfall_fixtures::fixture::FixtureLayout::StrobeMatrix),
        library_asset_etag: None,
    };

    for element_idx in 0..fixture.elements.len() {
        let element = &fixture.elements[element_idx];
        let element_ref = FixtureRef {
            fixture_uid: fixture.identifiers.uid,
            index: Some(element_idx as u32 + 1),
        };

        for parameter_metadata in &element.parameters {
            let mut commands: Commands<'_, '_> = world.commands();

            let values = if parameter_metadata.attribute == Attribute::VirtualIntensity {
                ParameterValues {
                    default_value: 255.0,
                    current_value: 255.0,
                    highlight_value: 255.0,
                }
            } else {
                ParameterValues::default()
            };

            let parameter_cmds = commands.spawn_instance(Parameter {
                metadata: parameter_metadata.clone(),
                values,
            });
            let parameter_entity = parameter_cmds.instance();

            let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
                SystemState::new(world);
            let (fixture_data_provider,) = system_state
                .get_mut(world)
                .expect("sample data system parameters should be available");

            fixture_data_provider.add_parameter(
                element_ref.clone(),
                parameter_metadata.attribute.clone(),
                parameter_entity,
            );
        }
    }

    {
        let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
            SystemState::new(world);
        let (mut fixture_data_provider,) = system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");
        let _ = fixture_data_provider.inner.add(fixture.clone());
    }
    apply_output_binding(
        world,
        fixture.identifiers.uid,
        output_target_id,
        universe,
        start_channel,
    );
}

/// Adds a single moving head fixture with the specified parameters.
#[allow(clippy::too_many_arguments)]
fn add_moving_head(
    world: &mut World,
    make: &str,
    model: &str,
    parameters: Vec<ParameterMetadata>,
    physical: FixturePhysical,
    universe: u16,
    start_channel: u16,
    id: u32,
    label: &str,
    output_target_id: Option<&str>,
    placement: FixturePlacement,
) {
    let fixture = Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            label: label.to_owned(),
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(), // Sample fixture, no library mode
        elements: vec![FixtureElement {
            label: "Head".to_owned(),
            parameters: parameters.clone(),
        }],
        physical: Some(physical),
        placement,
        layout: Some(nightfall_fixtures::fixture::FixtureLayout::MovingHead),
        library_asset_etag: None,
    };

    let element_ref = FixtureRef {
        fixture_uid: fixture.identifiers.uid,
        index: Some(1),
    };

    for param_meta in &parameters {
        let mut commands = world.commands();

        // All parameters default to 0 (home/blackout state)
        // Highlight values set for useful behavior when highlighting fixtures
        let values = match param_meta.attribute {
            Attribute::Intensity => ParameterValues {
                default_value: 0.0,
                current_value: 0.0,
                highlight_value: 255.0,
            },
            Attribute::Pan | Attribute::Tilt => ParameterValues {
                default_value: 0.0,
                current_value: 0.0,
                highlight_value: 0.0,
            },
            Attribute::Zoom => ParameterValues {
                default_value: 0.0,
                current_value: 0.0,
                highlight_value: param_meta.max / 2.0,
            },
            _ => ParameterValues::default(),
        };

        let parameter_cmds = commands.spawn_instance(Parameter {
            metadata: param_meta.clone(),
            values,
        });
        let parameter_entity = parameter_cmds.instance();

        let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
            SystemState::new(world);
        let (fixture_data_provider,) = system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");

        fixture_data_provider.add_parameter(
            element_ref.clone(),
            param_meta.attribute.clone(),
            parameter_entity,
        );
    }

    {
        let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
            SystemState::new(world);
        let (mut fixture_data_provider,) = system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");
        let _ = fixture_data_provider.inner.add(fixture.clone());
    }
    apply_output_binding(
        world,
        fixture.identifiers.uid,
        output_target_id,
        universe,
        start_channel,
    );
}

/// Seed the complete fixture inventory in stable patch and insertion order.
pub(super) fn add_fixtures(world: &mut World) {
    // Helper to add an RGB pixel tape with position and rotation.
    // x, y, z: position in meters
    // rotation_x: absolute degrees around X axis
    // rotation_y: absolute degrees around Y axis (0 = facing +Z/audience)
    // rotation_z: absolute degrees around Z axis (0 = horizontal, 90 = vertical)
    let add_led_pixeltape = |world: &mut World,
                             size: u16,
                             universe: u16,
                             start_channel: u16,
                             id: u32,
                             output_target_id: Option<&str>,
                             x: f32,
                             y: f32,
                             z: f32,
                             rotation_x_deg: f32,
                             rotation_y_deg: f32,
                             rotation_z_deg: f32| {
        add_ledbar(
            world,
            "Generic",
            "RGBPixelTape 180ch",
            size,
            PixelType::Rgb,
            universe,
            start_channel,
            id,
            output_target_id,
            FixturePlacement {
                position: PlacementPosition { x, y, z },
                rotation: PlacementRotation {
                    x: rotation_x_deg,
                    y: rotation_y_deg,
                    z: rotation_z_deg,
                },
            },
        );
    };

    // Add our test DMX fixture as 13 with its elements patched as 1-12
    add_ledbar(
        world,
        "Generic",
        "12-segment RGBW Bar",
        12,
        PixelType::Rgbw,
        1,
        17,
        13,
        Some("artnet"),
        FixturePlacement {
            position: PlacementPosition {
                x: -3.0,
                y: 1.05,
                z: -9.0,
            },
            rotation: PlacementRotation {
                x: -90.0,
                y: 0.0,
                z: 0.0,
            },
        },
    );

    // Generic 16ch Moving Head Spot on uDMX for testing
    {
        use nightfall_fixtures::physical::{BeamType, FixturePhysical};
        let spot_16ch_params = vec![
            ParameterMetadata {
                attribute: Attribute::Pan,
                native_unit: Attribute::Pan.native_unit(),
                value_polarity: Attribute::Pan.value_polarity(),
                is_inverted: false,
                is_snap: false,
                max: 540.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Fine,
                use_grandmaster: false,
            },
            ParameterMetadata {
                attribute: Attribute::Tilt,
                native_unit: Attribute::Tilt.native_unit(),
                value_polarity: Attribute::Tilt.value_polarity(),
                is_inverted: false,
                is_snap: false,
                max: 270.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Fine,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // 0 = normal, 255 = slowest
                attribute: Attribute::Custom {
                    label: "Pan/Tilt Speed".to_owned(),
                },
                native_unit: ParameterUnit::Percent,
                value_polarity: ParameterValuePolarity::Unsigned,
                is_inverted: false,
                is_snap: false,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                attribute: Attribute::Intensity,
                native_unit: Attribute::Intensity.native_unit(),
                value_polarity: Attribute::Intensity.value_polarity(),
                is_inverted: false,
                is_snap: false,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::HTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: true,
            },
            ParameterMetadata {
                // 0-15 = closed, 16-255 = open, slow to fast
                // not equal parts on/off, is a pulse wave
                // 16 = 43bpm (0.7hz)
                // 120 (50%) = 250.1 (268.0bpm, 4.4Hz)
                // 255 = 485 bpm (8Hz)
                attribute: Attribute::StrobeShutter,
                native_unit: Attribute::StrobeShutter.native_unit(),
                value_polarity: Attribute::StrobeShutter.value_polarity(),
                is_inverted: false,
                is_snap: true,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // 0-95 = full colors:
                // 0-7 = white
                // 8-16 = red
                // 17-23 = yellow
                // 24-31 = blue
                // 32-39 = green
                // 40-47 = orange
                // 48-55 = pink
                // 56-63 = purple
                // 64-71 = cyan
                // 72-79 = cream
                // 80-87 = light green
                // 88-95 = white

                // 96-175 = half colors:
                // 96-103 = white/green
                // 104-111 = green/cream
                // 112-119 = cream/blue
                // 120-127 = blue/pink
                // 128-135 = pink/purple
                // 136-143 = purple/orange
                // 144-151 = orange/green
                // 152-159 = green/blue
                // 160-167 = blue/yellow
                // 168-175 = yellow/red

                // 176-215 = spin, fast (125bpm) to slow (40bpm)
                // 216-255 = spin (reverse), slow to fast
                attribute: Attribute::Custom {
                    label: "Color Wheel".to_owned(),
                },
                native_unit: ParameterUnit::Percent,
                value_polarity: ParameterValuePolarity::Unsigned,
                is_inverted: false,
                is_snap: true,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // 0-5 = normal (circle)

                // 6-89 = select gobos 1-14:
                // 6-11 = gobo 1 (medium circle)
                // 12-17 = gobo 2 (small circle)
                // 18-23 = gobo 3 (very small circle)
                // 24-29 = gobo 4 (line)
                // 30-35 = gobo 5 (star)
                // 36-41 = gobo 6 (crossed lines)
                // 42-47 = gobo 7 (wifi symbol)
                // 48-53 = gobo 8 (star with curved edges)
                // 54-59 = gobo 9 (triangle)
                // 60-65 = gobo 10 (three triangles/nuclear)
                // 66-71 = gobo 11 (square)
                // 72-77 = gobo 12 (dots)
                // 78-83 = gobo 13 (star)
                // 84-89 = gobo 14 (flower)

                // 90-179 = gobo (reverse order) with jitter, slow to fast:
                // 90-95 = flower
                // 96-101 = star
                // 102-107 = dots
                // 108-113 = square
                // 114-119 = three triangles/nuclear
                // 120-125 = triangle
                // 126-131 = star with curved edges
                // 132-137 = wifi symbol
                // 138-143 = crossed lines
                // 144-149 = star
                // 150-155 = line
                // 156-161 = very small circle
                // 162-167 = small circle
                // 168-173 = medium circle
                // 174-179 = circle
                // 180 - 217 = swap through gobos in reverse order, fast (125bpm) to slow (41bpm):
                // 218-255 = swap through gobos in order (reverse), slow (41bpm) to fast (125bpm)
                attribute: Attribute::Gobo,
                native_unit: Attribute::Gobo.native_unit(),
                value_polarity: Attribute::Gobo.value_polarity(),
                is_inverted: false,
                is_snap: true,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // 0 - 99 = closed
                // 100 - 127 = open, 18 dots in two rings
                // 128 - 255 = spin, slow (14s per rotation or ~4.2bpm) to fast (1Hz/rotation)
                attribute: Attribute::Prism,
                native_unit: Attribute::Prism.native_unit(),
                value_polarity: Attribute::Prism.value_polarity(),
                is_inverted: false,
                is_snap: true,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // 0 - 4 = frost off
                // 5 - 126 = frost on
                // 127-255 = rainbow on
                attribute: Attribute::Frost,
                native_unit: Attribute::Frost.native_unit(),
                value_polarity: Attribute::Frost.value_polarity(),
                is_inverted: false,
                is_snap: false,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // wide to narrow
                attribute: Attribute::Custom {
                    label: "Focus".to_owned(),
                },
                native_unit: ParameterUnit::Percent,
                value_polarity: ParameterValuePolarity::Unsigned,
                is_inverted: false,
                is_snap: false,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                attribute: Attribute::Custom {
                    label: "Auto Run".to_owned(),
                },
                native_unit: ParameterUnit::Percent,
                value_polarity: ParameterValuePolarity::Unsigned,
                is_inverted: false,
                is_snap: true,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // 0 - 249 = nothing
                // 250-255 = reset after 3s
                attribute: Attribute::Custom {
                    label: "Reset".to_owned(),
                },
                native_unit: ParameterUnit::Percent,
                value_polarity: ParameterValuePolarity::Unsigned,
                is_inverted: false,
                is_snap: true,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // 0 - 4 = light ring off
                // 5 - 14 = red
                // 15 - 24 = green
                // 25 - 34 = blue
                // 35 - 44 = yellow
                // 45 - 54 = purple
                // 55 - 64 = cyan
                // 65 - 74 = white
                // 75 - 248 = effect selection
                // 249 - 255 = random
                attribute: Attribute::Custom {
                    label: "Ring Color".to_owned(),
                },
                native_unit: ParameterUnit::Percent,
                value_polarity: ParameterValuePolarity::Unsigned,
                is_inverted: false,
                is_snap: false,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
            ParameterMetadata {
                // effect speed from fast to slow (only applies when ch15 value is 75-248)
                attribute: Attribute::Custom {
                    label: "Ring Speed".to_owned(),
                },
                native_unit: ParameterUnit::Percent,
                value_polarity: ParameterValuePolarity::Unsigned,
                is_inverted: false,
                is_snap: false,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                merge_type: MergeStrategy::LTP,
                min: 0.0,
                resolution: DmxValueResolution::Coarse,
                use_grandmaster: false,
            },
        ];

        let spot_physical = FixturePhysical {
            beam_angle: 8.0,
            field_angle: 15.0,
            lumens: Some(8000.0),
            color_temperature: Some(6500.0),
            beam_type: BeamType::Spot,
        };

        add_moving_head(
            world,
            "Generic",
            "Moving Head Spot 16ch",
            spot_16ch_params,
            spot_physical,
            1,
            1,
            14,
            "Spot 1",
            Some("artnet"),
            FixturePlacement {
                position: PlacementPosition {
                    x: -3.0,
                    y: 0.05,
                    z: -9.0,
                },
                rotation: PlacementRotation {
                    x: -90.0,
                    y: 0.0,
                    z: 0.0,
                },
            },
        );
    }

    // Tubes Left (Art-Net) - spread along truss at y=5m
    let art_net_output_target_id = Some("artnet");
    add_led_pixeltape(
        world,
        60,
        2,
        1,
        211,
        art_net_output_target_id,
        -2.0,
        0.55,
        -4.0,
        -90.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        2,
        181,
        212,
        art_net_output_target_id,
        -3.05,
        0.55,
        -3.9,
        -60.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        3,
        1,
        213,
        art_net_output_target_id,
        -3.85,
        0.55,
        -3.05,
        -45.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        3,
        181,
        214,
        art_net_output_target_id,
        -3.8,
        0.55,
        -2.0,
        -45.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        4,
        1,
        215,
        art_net_output_target_id,
        -3.8,
        0.55,
        -1.0,
        -45.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        4,
        181,
        216,
        art_net_output_target_id,
        -3.8,
        0.55,
        0.0,
        -45.0,
        0.0,
        90.0,
    );

    // Tubes Right (sACN)
    let sacn_output_target_id = Some("sacn");
    add_led_pixeltape(
        world,
        60,
        5,
        1,
        221,
        sacn_output_target_id,
        2.0,
        0.55,
        -4.0,
        -90.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        5,
        181,
        222,
        sacn_output_target_id,
        3.05,
        0.55,
        -3.9,
        -120.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        6,
        1,
        223,
        sacn_output_target_id,
        3.85,
        0.55,
        -3.05,
        -135.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        6,
        181,
        224,
        sacn_output_target_id,
        3.8,
        0.55,
        -2.0,
        -135.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        7,
        1,
        225,
        sacn_output_target_id,
        3.8,
        0.55,
        -1.0,
        -135.0,
        0.0,
        90.0,
    );
    add_led_pixeltape(
        world,
        60,
        7,
        181,
        226,
        sacn_output_target_id,
        3.8,
        0.55,
        0.0,
        -135.0,
        0.0,
        90.0,
    );

    // bstrip 1 left - L-shape corner, y=0
    // 311: horizontal facing audience, 312: diagonal, 313-315: vertical facing wall
    add_led_pixeltape(
        world,
        20,
        8,
        1,
        311,
        sacn_output_target_id,
        -2.5,
        0.05,
        -4.0,
        -90.0,
        0.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        8,
        61,
        312,
        sacn_output_target_id,
        -3.5,
        0.05,
        -3.5,
        -90.0,
        -45.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        8,
        121,
        313,
        sacn_output_target_id,
        -4.0,
        0.05,
        -2.5,
        -90.0,
        -90.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        8,
        181,
        314,
        sacn_output_target_id,
        -4.0,
        0.05,
        -1.5,
        -90.0,
        -90.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        8,
        241,
        315,
        sacn_output_target_id,
        -4.0,
        0.05,
        -0.5,
        -90.0,
        -90.0,
        180.0,
    );

    // bstrip 1 right - mirrored along z-axis
    add_led_pixeltape(
        world,
        20,
        9,
        1,
        321,
        sacn_output_target_id,
        2.5,
        0.05,
        -4.0,
        -90.0,
        0.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        9,
        61,
        322,
        sacn_output_target_id,
        3.5,
        0.05,
        -3.5,
        -90.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        9,
        121,
        323,
        sacn_output_target_id,
        4.0,
        0.05,
        -2.5,
        -90.0,
        -90.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        9,
        181,
        324,
        sacn_output_target_id,
        4.0,
        0.05,
        -1.5,
        -90.0,
        -90.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        9,
        241,
        325,
        sacn_output_target_id,
        4.0,
        0.05,
        -0.5,
        -90.0,
        -90.0,
        0.0,
    );

    // bstrip 2 left - L-shape corner, y=0.5
    add_led_pixeltape(
        world,
        20,
        10,
        1,
        331,
        sacn_output_target_id,
        -2.5,
        0.5,
        -4.0,
        -90.0,
        0.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        10,
        61,
        332,
        sacn_output_target_id,
        -3.5,
        0.5,
        -3.5,
        -90.0,
        -45.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        10,
        121,
        333,
        sacn_output_target_id,
        -4.0,
        0.5,
        -2.5,
        -90.0,
        -90.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        10,
        181,
        334,
        sacn_output_target_id,
        -4.0,
        0.5,
        -1.5,
        -90.0,
        -90.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        10,
        241,
        335,
        sacn_output_target_id,
        -4.0,
        0.5,
        -0.5,
        -90.0,
        -90.0,
        180.0,
    );

    // bstrip 2 right - mirrored along z-axis
    add_led_pixeltape(
        world,
        20,
        11,
        1,
        341,
        sacn_output_target_id,
        2.5,
        0.5,
        -4.0,
        -90.0,
        0.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        11,
        61,
        342,
        sacn_output_target_id,
        3.5,
        0.5,
        -3.5,
        -90.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        11,
        121,
        343,
        sacn_output_target_id,
        4.0,
        0.5,
        -2.5,
        -90.0,
        -90.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        11,
        181,
        344,
        sacn_output_target_id,
        4.0,
        0.5,
        -1.5,
        -90.0,
        -90.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        11,
        241,
        345,
        sacn_output_target_id,
        4.0,
        0.5,
        -0.5,
        -90.0,
        -90.0,
        0.0,
    );

    // bstrip 3 left - L-shape corner, y=1.0
    add_led_pixeltape(
        world,
        20,
        12,
        1,
        351,
        sacn_output_target_id,
        -2.5,
        1.0,
        -4.0,
        -90.0,
        0.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        12,
        61,
        352,
        sacn_output_target_id,
        -3.5,
        1.0,
        -3.5,
        -90.0,
        -45.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        12,
        121,
        353,
        sacn_output_target_id,
        -4.0,
        1.0,
        -2.5,
        -90.0,
        -90.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        12,
        181,
        354,
        sacn_output_target_id,
        -4.0,
        1.0,
        -1.5,
        -90.0,
        -90.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        12,
        241,
        355,
        sacn_output_target_id,
        -4.0,
        1.0,
        -0.5,
        -90.0,
        -90.0,
        180.0,
    );

    // bstrip 3 right - mirrored along z-axis
    add_led_pixeltape(
        world,
        20,
        13,
        1,
        361,
        sacn_output_target_id,
        2.5,
        1.0,
        -4.0,
        -90.0,
        0.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        13,
        61,
        362,
        sacn_output_target_id,
        3.5,
        1.0,
        -3.5,
        -90.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        13,
        121,
        363,
        sacn_output_target_id,
        4.0,
        1.0,
        -2.5,
        -90.0,
        -90.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        13,
        181,
        364,
        sacn_output_target_id,
        4.0,
        1.0,
        -1.5,
        -90.0,
        -90.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        13,
        241,
        365,
        sacn_output_target_id,
        4.0,
        1.0,
        -0.5,
        -90.0,
        -90.0,
        0.0,
    );

    // bstrip 4 left - L-shape corner, y=1.5
    add_led_pixeltape(
        world,
        20,
        14,
        1,
        371,
        sacn_output_target_id,
        -2.5,
        1.5,
        -4.0,
        -90.0,
        0.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        14,
        61,
        372,
        sacn_output_target_id,
        -3.5,
        1.5,
        -3.5,
        -90.0,
        -45.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        14,
        121,
        373,
        sacn_output_target_id,
        -4.0,
        1.5,
        -2.5,
        -90.0,
        -90.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        14,
        181,
        374,
        sacn_output_target_id,
        -4.0,
        1.5,
        -1.5,
        -90.0,
        -90.0,
        180.0,
    );
    add_led_pixeltape(
        world,
        20,
        14,
        241,
        375,
        sacn_output_target_id,
        -4.0,
        1.5,
        -0.5,
        -90.0,
        -90.0,
        180.0,
    );

    // bstrip 4 right - mirrored along z-axis
    add_led_pixeltape(
        world,
        20,
        15,
        1,
        381,
        sacn_output_target_id,
        2.5,
        1.5,
        -4.0,
        -90.0,
        0.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        15,
        61,
        382,
        sacn_output_target_id,
        3.5,
        1.5,
        -3.5,
        -90.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        15,
        121,
        383,
        sacn_output_target_id,
        4.0,
        1.5,
        -2.5,
        -90.0,
        -90.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        15,
        181,
        384,
        sacn_output_target_id,
        4.0,
        1.5,
        -1.5,
        -90.0,
        -90.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        15,
        241,
        385,
        sacn_output_target_id,
        4.0,
        1.5,
        -0.5,
        -90.0,
        -90.0,
        0.0,
    );

    // Overhead Left - LED bars along truss in alternating V pattern
    // Flat (LEDs down), alternating ±45° Y rotation in XZ plane
    add_led_pixeltape(
        world,
        20,
        16,
        1,
        411,
        sacn_output_target_id,
        -5.0,
        5.7,
        0.0,
        0.0,
        45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        16,
        61,
        412,
        sacn_output_target_id,
        -5.0,
        5.7,
        -1.0,
        0.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        16,
        121,
        413,
        sacn_output_target_id,
        -5.0,
        5.7,
        -2.0,
        0.0,
        45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        16,
        181,
        414,
        sacn_output_target_id,
        -5.0,
        5.7,
        -3.0,
        0.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        16,
        241,
        415,
        sacn_output_target_id,
        -5.0,
        5.7,
        -4.0,
        0.0,
        45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        16,
        301,
        416,
        sacn_output_target_id,
        -5.0,
        5.7,
        -5.0,
        0.0,
        -45.0,
        0.0,
    );

    // Overhead Right - LED bars along truss in alternating V pattern
    add_led_pixeltape(
        world,
        20,
        17,
        1,
        421,
        sacn_output_target_id,
        5.0,
        5.7,
        0.0,
        0.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        17,
        61,
        422,
        sacn_output_target_id,
        5.0,
        5.7,
        -1.0,
        0.0,
        45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        17,
        121,
        423,
        sacn_output_target_id,
        5.0,
        5.7,
        -2.0,
        0.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        17,
        181,
        424,
        sacn_output_target_id,
        5.0,
        5.7,
        -3.0,
        0.0,
        45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        17,
        241,
        425,
        sacn_output_target_id,
        5.0,
        5.7,
        -4.0,
        0.0,
        -45.0,
        0.0,
    );
    add_led_pixeltape(
        world,
        20,
        17,
        301,
        426,
        sacn_output_target_id,
        5.0,
        5.7,
        -5.0,
        0.0,
        45.0,
        0.0,
    );

    let manual_strobe_transport = Some("artnet");
    let strobes = [
        (601, -4.0, 20),
        (602, -2.5, 21),
        (603, -1.0, 22),
        (604, 1.0, 23),
        (605, 2.5, 24),
        (606, 4.0, 25),
    ];
    for &(id, x, universe) in &strobes {
        let mut placement = FixturePlacement::at_position(x, 0.05, 1.0);
        placement.rotation = PlacementRotation {
            x: 180.0,
            y: 0.00,
            z: 0.0,
        };
        add_manual_strobe_fixture(
            world,
            "Generic",
            "Strobe Matrix 308ch",
            universe,
            1,
            id,
            if id == 601 {
                Some("udmx")
            } else {
                manual_strobe_transport
            },
            placement,
        );
    }

    if let Some(mut fixture) = nightfall_fixtures::library::create_fixture_from_library(
        607,
        "Generic",
        "12-segment Rotating Wash Beam",
        "",
    ) {
        fixture.placement = FixturePlacement::at_position(0.0, 0.5, 0.0);
        add_fixture_with_patching(world, fixture, 26, 1, manual_strobe_transport);
    }

    // Moving heads on universe 18-19, distributed along the truss
    // 24 fixtures: 12 on front truss (z=0), 12 on rear truss (z=-4)
    // Fixture IDs 501-524
    add_moving_heads(world, sacn_output_target_id);

    // Add fixtures from library
    add_library_fixtures(world);
}

/// Adds 24 moving head fixtures distributed along two trusses.
fn add_moving_heads(world: &mut World, output_target_id: Option<&str>) {
    use nightfall_fixtures::physical::{BeamType, FixturePhysical};

    // Moving head channel layout (20 channels per fixture):
    // 0: Intensity, 1: Pan, 2: Pan Fine, 3: Tilt, 4: Tilt Fine
    // 5: Red, 6: Green, 7: Blue, 8: White, 9: Zoom
    const CHANNELS_PER_FIXTURE: u16 = 20;

    let physical = FixturePhysical {
        beam_angle: 8.0,
        field_angle: 40.0,
        lumens: Some(20000.0),
        color_temperature: Some(6500.0),
        beam_type: BeamType::Spot,
    };

    let parameters = vec![
        ParameterMetadata {
            attribute: Attribute::Intensity,
            native_unit: Attribute::Intensity.native_unit(),
            value_polarity: Attribute::Intensity.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::HTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: true,
        },
        ParameterMetadata {
            attribute: Attribute::Pan,
            native_unit: Attribute::Pan.native_unit(),
            value_polarity: Attribute::Pan.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 540.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Fine,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Tilt,
            native_unit: Attribute::Tilt.native_unit(),
            value_polarity: Attribute::Tilt.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 270.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Fine,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Red,
            native_unit: Attribute::Red.native_unit(),
            value_polarity: Attribute::Red.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Green,
            native_unit: Attribute::Green.native_unit(),
            value_polarity: Attribute::Green.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Blue,
            native_unit: Attribute::Blue.native_unit(),
            value_polarity: Attribute::Blue.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::White,
            native_unit: Attribute::White.native_unit(),
            value_polarity: Attribute::White.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            attribute: Attribute::Zoom,
            native_unit: Attribute::Zoom.native_unit(),
            value_polarity: Attribute::Zoom.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];

    // Front truss positions (z=0, y=5m): 12 fixtures from x=-7.27 to x=7.27
    // Offset by 0.73m from LED tubes to avoid overlap
    let front_truss: Vec<(f32, f32, f32)> = (0..12)
        .map(|i| {
            let x = -7.27 + (i as f32) * (14.54 / 11.0);
            (x, 5.0, 0.0)
        })
        .collect();

    // Rear truss positions (z=-4, y=5m): 12 fixtures from x=-7.27 to x=7.27
    let rear_truss: Vec<(f32, f32, f32)> = (0..12)
        .map(|i| {
            let x = -7.27 + (i as f32) * (14.54 / 11.0);
            (x, 5.0, -4.0)
        })
        .collect();

    let all_positions: Vec<(f32, f32, f32)> = front_truss.into_iter().chain(rear_truss).collect();

    let mut universe: u16 = 18;
    let mut channel: u16 = 1;

    for (index, (x, y, z)) in all_positions.into_iter().enumerate() {
        let fixture_id = 501 + index as u32;

        // Check if we need to move to next universe
        if channel + CHANNELS_PER_FIXTURE > 512 {
            universe += 1;
            channel = 1;
        }

        let fixture = Fixture {
            identifiers: Identifiers {
                id: fixture_id,
                uid: Uuid::new_v4(),
                label: format!("MH-{:02}", index + 1),
            },
            make: "Generic".to_owned(),
            model: "Moving Head Spot 16ch".to_owned(),
            mode: String::new(), // Sample fixture, no library mode
            elements: vec![FixtureElement {
                label: "Head".to_owned(),
                parameters: parameters.clone(),
            }],
            physical: Some(physical.clone()),
            placement: FixturePlacement {
                position: PlacementPosition { x, y, z },
                rotation: PlacementRotation {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
            },
            layout: Some(nightfall_fixtures::fixture::FixtureLayout::MovingHead),
            library_asset_etag: None,
        };

        // Spawn parameters for this fixture
        let element_ref = FixtureRef {
            fixture_uid: fixture.identifiers.uid,
            index: Some(1),
        };

        let base_channel = channel;
        let mut param_channel = channel;
        for param_meta in &parameters {
            let mut commands = world.commands();

            // All parameters default to 0 (home/blackout state)
            // Highlight values set for useful behavior when highlighting fixtures
            let values = match param_meta.attribute {
                Attribute::Intensity => ParameterValues {
                    default_value: 0.0,
                    current_value: 0.0,
                    highlight_value: 255.0,
                },
                Attribute::Pan => ParameterValues {
                    default_value: 0.0,
                    current_value: 0.0,
                    highlight_value: 0.0,
                },
                Attribute::Tilt => ParameterValues {
                    default_value: 0.0,
                    current_value: 0.0,
                    highlight_value: 0.0,
                },
                _ => ParameterValues::default(),
            };

            let parameter_cmds = commands.spawn_instance(Parameter {
                metadata: param_meta.clone(),
                values,
            });
            let parameter_entity = parameter_cmds.instance();

            let channels_needed = match param_meta.resolution {
                DmxValueResolution::Fine => 2,
                _ => 1,
            };
            param_channel += channels_needed;

            let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
                SystemState::new(world);
            let (fixture_data_provider,) = system_state
                .get_mut(world)
                .expect("sample data system parameters should be available");

            fixture_data_provider.add_parameter(
                element_ref.clone(),
                param_meta.attribute.clone(),
                parameter_entity,
            );
        }

        // Add fixture to data provider
        {
            let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
                SystemState::new(world);
            let (mut fixture_data_provider,) = system_state
                .get_mut(world)
                .expect("sample data system parameters should be available");
            let _ = fixture_data_provider.inner.add(fixture.clone());
        }
        apply_output_binding(
            world,
            fixture.identifiers.uid,
            output_target_id,
            universe,
            base_channel,
        );

        channel = param_channel;
    }
}

/// Adds repository-defined generic profiles without consulting locally installed libraries.
fn add_library_fixtures(world: &mut World) {
    for (id, model, universe, x, y, z, rotation_x) in [
        (1001, "Moving Head RGBW", 30, -2.0, 0.05, -9.0, 180.0),
        (1002, "100-segment LED Bar", 31, -1.0, 0.05, -9.0, -90.0),
        (
            1003,
            "10-segment Rotating RGBW Bar",
            32,
            2.0,
            0.05,
            -9.0,
            180.0,
        ),
        (1004, "Strobe Matrix 308ch", 33, -1.0, 4.0, -1.0, 0.0),
    ] {
        let mut fixture =
            nightfall_fixtures::library::create_fixture_from_library(id, "Generic", model, "")
                .expect("sample profiles must be shipped with the application");
        fixture.placement = FixturePlacement::at_position(x, y, z);
        fixture.placement.rotation.x = rotation_x;
        add_fixture_with_patching(world, fixture, universe, 1, None);
    }
}

/// Persist a fixture and create element-level DMX output bindings.
fn add_fixture_with_patching(
    world: &mut World,
    fixture: Fixture,
    universe: u16,
    start_channel: u16,
    output_target_id: Option<&str>,
) {
    for (element_idx, element) in fixture.elements.iter().enumerate() {
        let element_ref = FixtureRef {
            index: Some(element_idx as u32 + 1),
            fixture_uid: fixture.identifiers.uid,
        };

        element.parameters.iter().for_each(|parameter_metadata| {
            let mut commands: Commands<'_, '_> = world.commands();

            // VirtualIntensity defaults to 100% (255) so fixtures are visible when patched
            let values = if parameter_metadata.attribute == Attribute::VirtualIntensity {
                ParameterValues {
                    default_value: 255.0,
                    current_value: 255.0,
                    highlight_value: 255.0,
                }
            } else {
                ParameterValues::default()
            };

            let parameter_cmds = commands.spawn_instance(Parameter {
                metadata: parameter_metadata.clone(),
                values,
            });
            let parameter_entity = parameter_cmds.instance();

            let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
                SystemState::new(world);
            let (fixture_data_provider,) = system_state
                .get_mut(world)
                .expect("sample data system parameters should be available");

            fixture_data_provider.add_parameter(
                element_ref.clone(),
                parameter_metadata.attribute.clone(),
                parameter_entity,
            );
        });
    }

    {
        let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
            SystemState::new(world);
        let (mut fixture_data_provider,) = system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");

        // Store the fixture (geometry is provided separately via the library at runtime)
        let _ = fixture_data_provider.inner.add(fixture.clone());
    }
    apply_output_binding(
        world,
        fixture.identifiers.uid,
        output_target_id,
        universe,
        start_channel,
    );
}
