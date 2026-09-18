// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Explicit built-in profiles and compatibility normalization for moving heads.

use nightfall::prelude::Identifiers;
use nightfall_dmx::DmxValueResolution;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use uuid::Uuid;

use crate::prelude::*;

/// Updates known built-in fixture profiles that may have been persisted before profile fixes.
pub(super) fn normalize_fixture_profile(fixture: &mut Fixture) {
    if fixture.layout != Some(FixtureLayout::RotatingWashBeam) {
        return;
    }

    let vdim_parameter = parameter(
        Attribute::VirtualIntensity,
        DmxValueResolution::Coarse,
        MergeStrategy::HTP,
        true,
    );
    for element in fixture.elements.iter_mut().skip(1) {
        let has_intensity = element.parameters.iter().any(|parameter| {
            matches!(
                parameter.attribute,
                Attribute::Intensity | Attribute::VirtualIntensity
            )
        });
        let has_color = element.parameters.iter().any(|parameter| {
            matches!(
                parameter.attribute,
                Attribute::Red
                    | Attribute::Green
                    | Attribute::Blue
                    | Attribute::White
                    | Attribute::Yellow
                    | Attribute::Amber
                    | Attribute::UV
            )
        });
        if !has_intensity && has_color {
            element.parameters.insert(0, vdim_parameter.clone());
        }
    }
}

/// Creates a Generic 12-pixel rotating wash beam profile with decorative LED strips.
///
/// Elements are surfaced as one control element, beam emitters 1-12 left-to-right,
/// then the 24 decorative strip pixels top-left-to-right followed by bottom-left-to-right.
pub(super) fn create_rotating_wash_beam_194(id: u32, make: &str, model: &str) -> Fixture {
    let mut elements = Vec::with_capacity(37);
    let vdim_parameter = parameter(
        Attribute::VirtualIntensity,
        DmxValueResolution::Coarse,
        MergeStrategy::HTP,
        true,
    );

    elements.push(FixtureElement {
        label: "Control".to_owned(),
        parameters: vec![
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
            custom_parameter("Tilt Speed"),
            parameter(
                Attribute::Zoom,
                DmxValueResolution::Coarse,
                MergeStrategy::LTP,
                false,
            ),
            parameter(
                Attribute::Intensity,
                DmxValueResolution::Coarse,
                MergeStrategy::HTP,
                true,
            ),
            parameter(
                Attribute::StrobeRate,
                DmxValueResolution::Coarse,
                MergeStrategy::LTP,
                false,
            ),
            custom_parameter("All Beams Red"),
            custom_parameter("All Beams Green"),
            custom_parameter("All Beams Blue"),
            custom_parameter("All Beams White"),
            custom_parameter("Main Light Mode"),
            custom_parameter("All Beams Optical Speed"),
            custom_parameter("Main Light Background Color"),
            custom_parameter("Main Light Background Color Tone"),
            custom_parameter("Aux Strobe Light"),
            custom_parameter("Aux Strips Red"),
            custom_parameter("Aux Strips Green"),
            custom_parameter("Aux Strips Blue"),
            custom_parameter("Aux Strips White"),
            custom_parameter("Aux Strips Yellow"),
            custom_parameter("Aux Strips Light Mode"),
            custom_parameter("Aux Strips Light Speed"),
            custom_parameter("Aux Strips Light Direction"),
            custom_parameter("Aux Strips Background Color"),
            custom_parameter("Aux Strips Background Color Tone"),
            custom_parameter("Reset Light"),
        ],
    });

    let beam_parameters = vec![
        vdim_parameter.clone(),
        parameter(
            Attribute::Red,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
        parameter(
            Attribute::Green,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
        parameter(
            Attribute::Blue,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
        parameter(
            Attribute::White,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
    ];

    for index in 1..=12 {
        elements.push(FixtureElement {
            label: format!("Beam {}", index),
            parameters: beam_parameters.clone(),
        });
    }

    let strip_parameters = vec![
        vdim_parameter,
        parameter(
            Attribute::Red,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
        parameter(
            Attribute::Green,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
        parameter(
            Attribute::Blue,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
        parameter(
            Attribute::White,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
        parameter(
            Attribute::Yellow,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
    ];

    for index in 1..=12 {
        elements.push(FixtureElement {
            label: format!("Top Strip Pixel {}", index),
            parameters: strip_parameters.clone(),
        });
    }

    for index in 1..=12 {
        elements.push(FixtureElement {
            label: format!("Bottom Strip Pixel {}", index),
            parameters: strip_parameters.clone(),
        });
    }

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(),
        elements,
        physical: None,
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::RotatingWashBeam),
        library_asset_etag: None,
    }
}

/// Creates parameter metadata for a built-in fixture channel.
fn parameter(
    attribute: Attribute,
    resolution: DmxValueResolution,
    merge_type: MergeStrategy,
    use_grandmaster: bool,
) -> ParameterMetadata {
    ParameterMetadata {
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        is_inverted: false,
        is_snap: false,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type,
        min: 0.0,
        resolution,
        use_grandmaster,
    }
}

/// Creates coarse custom parameter metadata for documented but visually ignored channels.
fn custom_parameter(label: &str) -> ParameterMetadata {
    parameter(
        Attribute::Custom {
            label: label.to_owned(),
        },
        DmxValueResolution::Coarse,
        MergeStrategy::LTP,
        false,
    )
}

/// Creates a Generic 16-channel moving spot profile in hardware channel order.
pub(super) fn create_moving_spot_16ch(id: u32, make: &str, model: &str) -> Fixture {
    use crate::physical::{BeamType, FixturePhysical};

    let mut pan = parameter(
        Attribute::Pan,
        DmxValueResolution::Fine,
        MergeStrategy::LTP,
        false,
    );
    pan.max = 540.0;

    let mut tilt = parameter(
        Attribute::Tilt,
        DmxValueResolution::Fine,
        MergeStrategy::LTP,
        false,
    );
    tilt.max = 270.0;

    let mut strobe_shutter = parameter(
        Attribute::StrobeShutter,
        DmxValueResolution::Coarse,
        MergeStrategy::LTP,
        false,
    );
    strobe_shutter.is_snap = true;

    let mut color_wheel = custom_parameter("Color Wheel");
    color_wheel.is_snap = true;

    let mut gobo = parameter(
        Attribute::Gobo,
        DmxValueResolution::Coarse,
        MergeStrategy::LTP,
        false,
    );
    gobo.is_snap = true;

    let mut prism = parameter(
        Attribute::Prism,
        DmxValueResolution::Coarse,
        MergeStrategy::LTP,
        false,
    );
    prism.is_snap = true;

    let mut auto_run = custom_parameter("Auto Run");
    auto_run.is_snap = true;

    let mut reset = custom_parameter("Reset");
    reset.is_snap = true;

    let parameters = vec![
        pan,
        tilt,
        custom_parameter("Pan/Tilt Speed"),
        parameter(
            Attribute::Intensity,
            DmxValueResolution::Coarse,
            MergeStrategy::HTP,
            true,
        ),
        strobe_shutter,
        color_wheel,
        gobo,
        prism,
        parameter(
            Attribute::Frost,
            DmxValueResolution::Coarse,
            MergeStrategy::LTP,
            false,
        ),
        custom_parameter("Focus"),
        auto_run,
        reset,
        custom_parameter("Ring Color"),
        custom_parameter("Ring Speed"),
    ];

    let physical = FixturePhysical {
        beam_angle: 8.0,
        field_angle: 15.0,
        lumens: Some(8000.0),
        color_temperature: Some(6500.0),
        beam_type: BeamType::Spot,
    };

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(),
        elements: vec![FixtureElement {
            label: "Head".to_owned(),
            parameters,
        }],
        physical: Some(physical),
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::MovingHead),
        library_asset_etag: None,
    }
}

/// Creates a moving spot fixture with single element containing all parameters.
///
/// Includes: Intensity, Pan (16-bit), Tilt (16-bit), Red, Green, Blue, White, Zoom
pub(super) fn create_moving_spot(id: u32, make: &str, model: &str) -> Fixture {
    use crate::physical::{BeamType, FixturePhysical};

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

    let physical = FixturePhysical {
        beam_angle: 8.0,
        field_angle: 40.0,
        lumens: Some(20000.0),
        color_temperature: Some(6500.0),
        beam_type: BeamType::Spot,
    };

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(), // Built-in fixture, no library mode
        elements: vec![FixtureElement {
            label: "Head".to_owned(),
            parameters,
        }],
        physical: Some(physical),
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::MovingHead),
        library_asset_etag: None,
    }
}

/// Creates a ten-segment rotating RGBW bar with tilt, zoom, and master intensity controls.
pub(super) fn create_linear_wash_bar(id: u32, make: &str, model: &str) -> Fixture {
    let mut fixture = create_rotating_wash_beam_194(id, make, model);
    fixture.layout = Some(FixtureLayout::LinearWashBar);
    fixture.elements.truncate(11);
    fixture.elements[0].parameters.retain(|parameter| {
        matches!(
            parameter.attribute,
            Attribute::Tilt | Attribute::Zoom | Attribute::Intensity
        )
    });
    fixture
}
