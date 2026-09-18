// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Structural regression tests for built-in fixture profiles.

use nightfall_dmx::DmxValueResolution;
use nightfall_dmx::prelude::{Attribute, ParameterUnit};

use super::{create_fixture_from_library, moving_heads, normalize_fixture_profile, strobes};
use crate::prelude::Fixture;

/// Calculates the non-virtual DMX footprint of a built-in fixture profile.
fn footprint(fixture: &Fixture) -> u16 {
    fixture
        .elements
        .iter()
        .flat_map(|element| element.parameters.iter())
        .filter(|parameter| parameter.attribute != Attribute::VirtualIntensity)
        .map(|parameter| parameter.resolution.channel_width())
        .sum()
}

/// Verifies every generic pixel profile preserves its element count, footprint, and channel order.
#[test]
fn generic_pixel_profiles_preserve_structure_and_channel_order() {
    let rgbw_bar = create_fixture_from_library(1, "Generic", "12-segment RGBW Bar", "")
        .expect("generic RGBW bar should be available");
    assert_eq!(rgbw_bar.elements.len(), 12);
    assert_eq!(footprint(&rgbw_bar), 48);
    assert_eq!(rgbw_bar.elements[0].label, "Pixel 1");
    assert_eq!(rgbw_bar.elements[11].label, "Pixel 12");
    assert_eq!(
        rgbw_bar.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
            &Attribute::White,
        ]
    );

    let rgb_tape = create_fixture_from_library(2, "Generic", "RGBPixelTape 180ch", "")
        .expect("generic 180-channel RGB tape should be available");
    assert_eq!(rgb_tape.elements.len(), 60);
    assert_eq!(footprint(&rgb_tape), 180);
    assert_eq!(rgb_tape.elements[0].label, "Pixel 1");
    assert_eq!(rgb_tape.elements[59].label, "Pixel 60");
    assert_eq!(
        rgb_tape.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
        ]
    );

    let rgb_tape_40 = create_fixture_from_library(3, "Generic", "RGBPixelTape 120ch RGB", "")
        .expect("generic 120-channel RGB tape should be available");
    assert_eq!(rgb_tape_40.elements.len(), 40);
    assert_eq!(footprint(&rgb_tape_40), 120);
    assert_eq!(rgb_tape_40.elements[0].label, "Pixel 1");
    assert_eq!(rgb_tape_40.elements[39].label, "Pixel 40");
    assert_eq!(
        rgb_tape_40.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
        ]
    );
}

/// Verifies the generic moving-head profile keeps its single-element ten-channel layout.
#[test]
fn generic_moving_head_preserves_structure_and_channel_order() {
    let fixture = create_fixture_from_library(1, "Generic", "Moving Head RGBW", "")
        .expect("generic moving head should be available");
    let parameters = &fixture.elements[0].parameters;

    assert_eq!(fixture.elements.len(), 1);
    assert_eq!(fixture.elements[0].label, "Head");
    assert_eq!(parameters.len(), 8);
    assert_eq!(footprint(&fixture), 10);
    assert_eq!(
        parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::Intensity,
            &Attribute::Pan,
            &Attribute::Tilt,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
            &Attribute::White,
            &Attribute::Zoom,
        ]
    );
    assert_eq!(parameters[1].resolution, DmxValueResolution::Fine);
    assert_eq!(parameters[2].resolution, DmxValueResolution::Fine);
}

/// Verifies the GRB pixel tape profile has 40 elements and 120 non-virtual DMX channels.
#[test]
fn grb_pixel_tape_profile_matches_120_channel_order() {
    let fixture = create_fixture_from_library(1, "Generic", "RGBPixelTape 120ch GRB", "GRB")
        .expect("GRB pixel tape should be available");

    assert_eq!(fixture.elements.len(), 40);
    assert_eq!(footprint(&fixture), 120);
    assert_eq!(fixture.elements[0].label, "Pixel 1");
    assert_eq!(fixture.elements[39].label, "Pixel 40");
    assert_eq!(
        fixture.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Green,
            &Attribute::Red,
            &Attribute::Blue,
        ]
    );
}

/// Verifies that the strobe matrix element order and non-virtual footprint match the fixture profile.
#[test]
fn strobe_matrix_profile_matches_308_channel_order() {
    let fixture = strobes::create_strobe(1, "Generic", "Strobe Matrix 308ch", 16);

    assert_eq!(fixture.elements.len(), 115);
    assert_eq!(footprint(&fixture), 308);
    assert_eq!(fixture.elements[0].label, "Tilt Axis");
    assert_eq!(fixture.elements[1].label, "Rotation Speed");
    assert_eq!(fixture.elements[2].label, "Reset");
    assert_eq!(fixture.elements[3].label, "Strobe Dimmer 1");
    assert_eq!(fixture.elements[18].label, "Strobe Dimmer 16");
    assert_eq!(fixture.elements[19].label, "RGB Pixel 1");
    assert_eq!(fixture.elements[114].label, "RGB Pixel 96");
    assert_eq!(
        fixture.elements[3]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![&Attribute::VirtualIntensity, &Attribute::White]
    );
}

/// Verifies the 312-channel variant inserts four white segments before the RGB pixels.
#[test]
fn strobe_matrix_profile_matches_312_channel_order() {
    let fixture = strobes::create_strobe(1, "Generic", "Strobe Matrix 312ch", 20);

    assert_eq!(fixture.elements.len(), 119);
    assert_eq!(footprint(&fixture), 312);
    assert_eq!(fixture.elements[0].label, "Tilt Axis");
    assert_eq!(fixture.elements[1].label, "Rotation Speed");
    assert_eq!(fixture.elements[2].label, "Reset");
    assert_eq!(fixture.elements[3].label, "Strobe Dimmer 1");
    assert_eq!(fixture.elements[22].label, "Strobe Dimmer 20");
    assert_eq!(fixture.elements[23].label, "RGB Pixel 1");
    assert_eq!(fixture.elements[118].label, "RGB Pixel 96");
}

/// Verifies the Generic RGB strobe bar preserves its segment layout and DMX footprint.
#[test]
fn rgb_strobe_bar_profile_matches_168_channel_footprint_and_element_order() {
    let fixture = strobes::create_rgb_strobe_bar_168(1, "Generic", "RGB Strobe Bar 168ch");

    assert_eq!(fixture.elements.len(), 72);
    assert_eq!(footprint(&fixture), 168);
    assert_eq!(fixture.elements[0].label, "White Segment 1");
    assert_eq!(fixture.elements[23].label, "White Segment 24");
    assert_eq!(
        fixture.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![&Attribute::VirtualIntensity, &Attribute::White]
    );
    assert_eq!(fixture.elements[24].label, "Top RGB Segment 1");
    assert_eq!(fixture.elements[47].label, "Top RGB Segment 24");
    assert_eq!(fixture.elements[48].label, "Bottom RGB Segment 1");
    assert_eq!(fixture.elements[71].label, "Bottom RGB Segment 24");
}

/// Verifies the Generic wash beam preserves its control, beam, and strip layout.
#[test]
fn rotating_wash_beam_profile_matches_194_channel_footprint_and_element_order() {
    let fixture =
        moving_heads::create_rotating_wash_beam_194(1, "Generic", "12-segment Rotating Wash Beam");

    assert_eq!(fixture.elements.len(), 37);
    assert_eq!(footprint(&fixture), 194);
    assert_eq!(fixture.elements[0].label, "Control");
    assert_eq!(fixture.elements[1].label, "Beam 1");
    assert_eq!(fixture.elements[12].label, "Beam 12");
    assert_eq!(fixture.elements[13].label, "Top Strip Pixel 1");
    assert_eq!(fixture.elements[24].label, "Top Strip Pixel 12");
    assert_eq!(fixture.elements[25].label, "Bottom Strip Pixel 1");
    assert_eq!(fixture.elements[36].label, "Bottom Strip Pixel 12");
    assert_eq!(
        fixture.elements[13]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
            &Attribute::White,
            &Attribute::Yellow,
        ]
    );
}

/// Verifies persisted wash-beam emitters gain one virtual intensity without duplicate insertion.
#[test]
fn wash_beam_normalization_restores_missing_virtual_intensity_once() {
    let mut fixture =
        moving_heads::create_rotating_wash_beam_194(1, "Generic", "12-segment Rotating Wash Beam");
    for element in fixture.elements.iter_mut().skip(1) {
        element
            .parameters
            .retain(|parameter| parameter.attribute != Attribute::VirtualIntensity);
    }

    normalize_fixture_profile(&mut fixture);
    normalize_fixture_profile(&mut fixture);

    for element in fixture.elements.iter().skip(1) {
        assert_eq!(
            element
                .parameters
                .iter()
                .filter(|parameter| parameter.attribute == Attribute::VirtualIntensity)
                .count(),
            1
        );
        assert_eq!(element.parameters[0].attribute, Attribute::VirtualIntensity);
    }
}

/// Verifies the Generic spot built-in matches its 16-channel hardware profile.
#[test]
fn moving_spot_profile_matches_16_channel_order() {
    let fixture = create_fixture_from_library(1, "Generic", "Moving Head Spot 16ch", "Spot")
        .expect("Generic moving spot should be available");
    let parameters = &fixture.elements[0].parameters;

    assert_eq!(fixture.elements.len(), 1);
    assert_eq!(fixture.elements[0].label, "Head");
    assert_eq!(parameters.len(), 14);
    assert_eq!(footprint(&fixture), 16);
    assert_eq!(
        parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::Pan,
            &Attribute::Tilt,
            &Attribute::Custom {
                label: "Pan/Tilt Speed".to_owned(),
            },
            &Attribute::Intensity,
            &Attribute::StrobeShutter,
            &Attribute::Custom {
                label: "Color Wheel".to_owned(),
            },
            &Attribute::Gobo,
            &Attribute::Prism,
            &Attribute::Frost,
            &Attribute::Custom {
                label: "Focus".to_owned(),
            },
            &Attribute::Custom {
                label: "Auto Run".to_owned(),
            },
            &Attribute::Custom {
                label: "Reset".to_owned(),
            },
            &Attribute::Custom {
                label: "Ring Color".to_owned(),
            },
            &Attribute::Custom {
                label: "Ring Speed".to_owned(),
            },
        ],
    );
    assert_eq!(parameters[0].resolution, DmxValueResolution::Fine);
    assert_eq!(parameters[1].resolution, DmxValueResolution::Fine);
    assert_eq!(parameters[0].native_unit, ParameterUnit::Degrees);
    assert_eq!(parameters[1].native_unit, ParameterUnit::Degrees);
    assert_eq!(parameters[3].native_unit, ParameterUnit::Percent);
    assert_eq!(parameters[0].max, 540.0);
    assert_eq!(parameters[1].max, 270.0);
}

/// Ensures tilt-capable Generic built-ins share the same declared tilt range.
#[test]
fn generic_tilt_fixtures_share_270_degree_tilt_range() {
    let spot = moving_heads::create_moving_spot_16ch(1, "Generic", "Moving Head Spot 16ch");
    let strobe = strobes::create_strobe(2, "Generic", "Strobe Matrix 308ch", 16);
    let wash =
        moving_heads::create_rotating_wash_beam_194(3, "Generic", "12-segment Rotating Wash Beam");

    let spot_tilt = spot.elements[0]
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == Attribute::Tilt)
        .expect("spot should include tilt metadata");
    let strobe_tilt = strobe.elements[0]
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == Attribute::Tilt)
        .expect("strobe should include tilt metadata");
    let wash_tilt = wash.elements[0]
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == Attribute::Tilt)
        .expect("wash beam should include tilt metadata");

    assert_eq!(spot_tilt.max, 270.0);
    assert_eq!(strobe_tilt.max, 270.0);
    assert_eq!(wash_tilt.max, 270.0);
}
