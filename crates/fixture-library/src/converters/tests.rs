// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Unit tests for fixture converters

#[cfg(test)]
mod native_unit_tests {
    use nightfall_dmx::prelude::{Attribute, ParameterUnit};
    use nightfall_fixtures::prelude::ParameterMetadata;

    use super::super::apply_position_physical_range;

    /// Verifies position imports without physical bounds retain percentage semantics.
    #[test]
    fn missing_position_bounds_fall_back_to_percent() {
        let mut metadata = ParameterMetadata {
            attribute: Attribute::Pan,
            native_unit: ParameterUnit::Degrees,
            max: 65_535.0,
            ..Default::default()
        };

        apply_position_physical_range(&mut metadata, None);

        assert_eq!(metadata.native_unit, ParameterUnit::Percent);
        assert_eq!(metadata.min, 0.0);
        assert_eq!(metadata.max, 65_535.0);
    }

    /// Verifies physical position bounds replace raw DMX ranges with degree ranges.
    #[test]
    fn position_bounds_enable_degree_units() {
        let mut metadata = ParameterMetadata {
            attribute: Attribute::Tilt,
            native_unit: ParameterUnit::Percent,
            max: 65_535.0,
            ..Default::default()
        };

        apply_position_physical_range(&mut metadata, Some((270.0, 0.0)));

        assert_eq!(metadata.native_unit, ParameterUnit::Degrees);
        assert_eq!(metadata.min, 0.0);
        assert_eq!(metadata.max, 270.0);
        assert!(metadata.is_inverted);
    }
}

#[cfg(test)]
mod gdtf_tests {
    use nightfall_dmx::prelude::*;
    use nightfall_fixtures::prelude::*;

    use super::super::gdtf::*;

    #[test]
    fn test_map_gdtf_attribute_dimmer() {
        let attr = map_gdtf_attribute_to_nightfall(&"Dimmer");
        assert_eq!(attr, Some(Attribute::Intensity));
    }

    #[test]
    fn test_map_gdtf_attribute_rgb() {
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"ColorAdd_R"),
            Some(Attribute::Red)
        );
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"ColorAdd_G"),
            Some(Attribute::Green)
        );
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"ColorAdd_B"),
            Some(Attribute::Blue)
        );
    }

    #[test]
    fn test_map_gdtf_attribute_position() {
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"Pan"),
            Some(Attribute::Pan)
        );
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"Tilt"),
            Some(Attribute::Tilt)
        );
    }

    #[test]
    fn test_map_gdtf_attribute_beam() {
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"Zoom"),
            Some(Attribute::Zoom)
        );
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"Gobo1"),
            Some(Attribute::Gobo)
        );
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"Prism1"),
            Some(Attribute::Prism)
        );
    }

    #[test]
    fn test_map_gdtf_attribute_shutter() {
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"Shutter1"),
            Some(Attribute::StrobeShutter)
        );
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"StrobeRate"),
            Some(Attribute::StrobeRate)
        );
    }

    #[test]
    fn test_map_gdtf_attribute_unknown() {
        let attr = map_gdtf_attribute_to_nightfall(&"CustomAttr");
        assert!(matches!(attr, Some(Attribute::Custom { label }) if label == "CustomAttr"));
    }

    #[test]
    fn test_map_gdtf_beam_type() {
        use gdtf::geometry::BeamType as GdtfBeamType;

        assert_eq!(map_gdtf_beam_type(&GdtfBeamType::Spot), BeamType::Spot);
        assert_eq!(map_gdtf_beam_type(&GdtfBeamType::Wash), BeamType::Wash);
        assert_eq!(
            map_gdtf_beam_type(&GdtfBeamType::Fresnel),
            BeamType::Fresnel
        );
        assert_eq!(map_gdtf_beam_type(&GdtfBeamType::Pc), BeamType::Pc);
        // None, Glow, Rectangle should map to Glow (no spotlight rendering)
        assert_eq!(map_gdtf_beam_type(&GdtfBeamType::None), BeamType::Glow);
        assert_eq!(map_gdtf_beam_type(&GdtfBeamType::Glow), BeamType::Glow);
        assert_eq!(map_gdtf_beam_type(&GdtfBeamType::Rectangle), BeamType::Glow);
    }
}

#[cfg(test)]
mod ofl_tests {
    use nightfall_dmx::prelude::*;
    use nightfall_fixtures::prelude::*;

    use super::super::ofl::*;

    #[test]
    fn test_map_color_to_attribute() {
        assert_eq!(map_color_to_attribute("red"), Some(Attribute::Red));
        assert_eq!(map_color_to_attribute("Red"), Some(Attribute::Red));
        assert_eq!(map_color_to_attribute("RED"), Some(Attribute::Red));
        assert_eq!(map_color_to_attribute("green"), Some(Attribute::Green));
        assert_eq!(map_color_to_attribute("blue"), Some(Attribute::Blue));
        assert_eq!(map_color_to_attribute("white"), Some(Attribute::White));
        assert_eq!(
            map_color_to_attribute("warm white"),
            Some(Attribute::WarmWhite)
        );
        assert_eq!(
            map_color_to_attribute("cool white"),
            Some(Attribute::CoolWhite)
        );
        assert_eq!(map_color_to_attribute("amber"), Some(Attribute::Amber));
        assert_eq!(map_color_to_attribute("uv"), Some(Attribute::UV));
        assert_eq!(map_color_to_attribute("cyan"), Some(Attribute::Cyan));
        assert_eq!(map_color_to_attribute("magenta"), Some(Attribute::Magenta));
        assert_eq!(map_color_to_attribute("yellow"), Some(Attribute::Yellow));
    }

    #[test]
    fn test_map_color_to_attribute_custom() {
        let attr = map_color_to_attribute("lime");
        assert!(matches!(attr, Some(Attribute::Custom { label }) if label == "lime Intensity"));
    }

    #[test]
    fn test_map_channel_key_to_attribute() {
        assert_eq!(
            map_channel_key_to_attribute("Dimmer"),
            Some(Attribute::Intensity)
        );
        assert_eq!(
            map_channel_key_to_attribute("Intensity"),
            Some(Attribute::Intensity)
        );
        assert_eq!(map_channel_key_to_attribute("Pan"), Some(Attribute::Pan));
        assert_eq!(map_channel_key_to_attribute("Tilt"), Some(Attribute::Tilt));
        assert_eq!(map_channel_key_to_attribute("Red"), Some(Attribute::Red));
        assert_eq!(
            map_channel_key_to_attribute("Green"),
            Some(Attribute::Green)
        );
        assert_eq!(map_channel_key_to_attribute("Blue"), Some(Attribute::Blue));
        assert_eq!(map_channel_key_to_attribute("Zoom"), Some(Attribute::Zoom));
    }

    #[test]
    fn test_map_channel_key_to_attribute_custom() {
        let attr = map_channel_key_to_attribute("Focus");
        assert!(matches!(attr, Some(Attribute::Custom { label }) if label == "Focus"));

        let attr = map_channel_key_to_attribute("Iris");
        assert!(matches!(attr, Some(Attribute::Custom { label }) if label == "Iris"));

        let attr = map_channel_key_to_attribute("Shutter");
        assert_eq!(attr, Some(Attribute::StrobeShutter));
    }

    #[test]
    fn test_infer_beam_type_wash() {
        assert_eq!(
            infer_beam_type_from_categories(&["Wash".to_string()]),
            BeamType::Wash
        );
        assert_eq!(
            infer_beam_type_from_categories(&["Blinder".to_string()]),
            BeamType::Wash
        );
        assert_eq!(
            infer_beam_type_from_categories(&["Strobe".to_string()]),
            BeamType::Wash
        );
        assert_eq!(
            infer_beam_type_from_categories(&["Effect".to_string()]),
            BeamType::Wash
        );
        assert_eq!(
            infer_beam_type_from_categories(&["Matrix".to_string()]),
            BeamType::Wash
        );
        assert_eq!(
            infer_beam_type_from_categories(&["Pixel Bar".to_string()]),
            BeamType::Wash
        );
    }

    #[test]
    fn test_infer_beam_type_spot() {
        assert_eq!(
            infer_beam_type_from_categories(&["Spot".to_string()]),
            BeamType::Spot
        );
        assert_eq!(
            infer_beam_type_from_categories(&["Profile".to_string()]),
            BeamType::Spot
        );
        assert_eq!(
            infer_beam_type_from_categories(&["Moving Head".to_string(), "Gobo".to_string()]),
            BeamType::Spot
        );
    }

    #[test]
    fn test_infer_beam_type_fresnel() {
        assert_eq!(
            infer_beam_type_from_categories(&["Fresnel".to_string()]),
            BeamType::Fresnel
        );
    }

    #[test]
    fn test_infer_beam_type_pc() {
        assert_eq!(
            infer_beam_type_from_categories(&["PC".to_string()]),
            BeamType::Pc
        );
        assert_eq!(
            infer_beam_type_from_categories(&["Plano-Convex".to_string()]),
            BeamType::Pc
        );
    }

    #[test]
    fn test_infer_beam_type_case_insensitive() {
        assert_eq!(
            infer_beam_type_from_categories(&["WASH".to_string()]),
            BeamType::Wash
        );
        assert_eq!(
            infer_beam_type_from_categories(&["spot".to_string()]),
            BeamType::Spot
        );
        assert_eq!(
            infer_beam_type_from_categories(&["FrEsNeL".to_string()]),
            BeamType::Fresnel
        );
    }

    #[test]
    fn test_parse_dmx_value_number() {
        let value = Some(serde_json::json!(128));
        assert_eq!(parse_dmx_value(&value), Some(128.0));
    }

    #[test]
    fn test_parse_dmx_value_string() {
        let value = Some(serde_json::json!("200"));
        assert_eq!(parse_dmx_value(&value), Some(200.0));
    }

    #[test]
    fn test_parse_dmx_value_percentage() {
        let value = Some(serde_json::json!("50%"));
        assert_eq!(parse_dmx_value(&value), Some(127.5)); // 50% of 255

        let value = Some(serde_json::json!("100%"));
        assert_eq!(parse_dmx_value(&value), Some(255.0));

        let value = Some(serde_json::json!("0%"));
        assert_eq!(parse_dmx_value(&value), Some(0.0));
    }

    #[test]
    fn test_parse_dmx_value_none() {
        assert_eq!(parse_dmx_value(&None), None);
    }

    #[test]
    fn test_parse_dmx_value_invalid() {
        let value = Some(serde_json::json!(true));
        assert_eq!(parse_dmx_value(&value), None);

        let value = Some(serde_json::json!("invalid"));
        assert_eq!(parse_dmx_value(&value), None);
    }

    #[test]
    fn test_matrix_fixture_conversion() {
        use open_fixture_library::OflFixture;

        use super::super::ofl::*;

        // Create a simple matrix fixture JSON
        let matrix_fixture_json = r#"{
            "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
            "name": "Test Matrix 4x1",
            "categories": ["Matrix", "Pixel Bar"],
            "meta": {
                "authors": ["Test"],
                "createDate": "2024-01-01",
                "lastModifyDate": "2024-01-01"
            },
            "matrix": {
                "pixelKeys": [
                    ["1", "2", "3", "4"]
                ],
                "pixelCount": [4, 1, 1]
            },
            "templateChannels": {
                "$pixelKey Red": {
                    "name": "Red",
                    "capabilities": [
                        {
                            "type": "ColorIntensity",
                            "color": "Red",
                            "dmxRange": [0, 255]
                        }
                    ]
                },
                "$pixelKey Green": {
                    "name": "Green",
                    "capabilities": [
                        {
                            "type": "ColorIntensity",
                            "color": "Green",
                            "dmxRange": [0, 255]
                        }
                    ]
                },
                "$pixelKey Blue": {
                    "name": "Blue",
                    "capabilities": [
                        {
                            "type": "ColorIntensity",
                            "color": "Blue",
                            "dmxRange": [0, 255]
                        }
                    ]
                }
            },
            "availableChannels": {
                "Master Dimmer": {
                    "capabilities": [
                        {
                            "type": "Intensity",
                            "dmxRange": [0, 255]
                        }
                    ]
                }
            },
            "modes": [
                {
                    "name": "4-channel",
                    "channels": [
                        "Master Dimmer",
                        "1 Red", "1 Green", "1 Blue",
                        "2 Red", "2 Green", "2 Blue",
                        "3 Red", "3 Green", "3 Blue",
                        "4 Red", "4 Green", "4 Blue"
                    ]
                }
            ]
        }"#;

        let ofl = OflFixture::from_json(matrix_fixture_json)
            .expect("Failed to parse matrix fixture JSON");
        let (fixture, _geometry) =
            convert_ofl_to_fixture(&ofl, "4-channel", 1).expect("Failed to convert matrix fixture");

        // Should have 5 elements: 1 master + 4 pixels
        assert_eq!(fixture.elements.len(), 5);

        // First element should be the master
        assert_eq!(fixture.elements[0].label, "Master");
        assert_eq!(fixture.elements[0].parameters.len(), 1);
        assert_eq!(
            fixture.elements[0].parameters[0].attribute,
            Attribute::Intensity
        );

        // Next 4 elements should be pixels
        for i in 1..=4 {
            let element = &fixture.elements[i];
            assert_eq!(element.label, format!("Pixel {}", i));
            assert_eq!(element.parameters.len(), 3); // R, G, B

            // Check that we have RGB parameters
            let has_red = element
                .parameters
                .iter()
                .any(|p| p.attribute == Attribute::Red);
            let has_green = element
                .parameters
                .iter()
                .any(|p| p.attribute == Attribute::Green);
            let has_blue = element
                .parameters
                .iter()
                .any(|p| p.attribute == Attribute::Blue);

            assert!(has_red, "Pixel {} missing Red", i);
            assert!(has_green, "Pixel {} missing Green", i);
            assert!(has_blue, "Pixel {} missing Blue", i);
        }
    }

    #[test]
    fn test_non_matrix_fixture_single_element() {
        use open_fixture_library::OflFixture;

        use super::super::ofl::*;

        // Create a simple non-matrix fixture JSON
        let fixture_json = r#"{
            "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
            "name": "Test Par",
            "categories": ["Dimmer"],
            "meta": {
                "authors": ["Test"],
                "createDate": "2024-01-01",
                "lastModifyDate": "2024-01-01"
            },
            "availableChannels": {
                "Dimmer": {
                    "capabilities": [
                        {
                            "type": "Intensity",
                            "dmxRange": [0, 255]
                        }
                    ]
                }
            },
            "modes": [
                {
                    "name": "1-channel",
                    "channels": ["Dimmer"]
                }
            ]
        }"#;

        let ofl = OflFixture::from_json(fixture_json).expect("Failed to parse fixture JSON");
        let (fixture, _geometry) =
            convert_ofl_to_fixture(&ofl, "1-channel", 1).expect("Failed to convert fixture");

        // Should have only 1 element labeled "Main"
        assert_eq!(fixture.elements.len(), 1);
        assert_eq!(fixture.elements[0].label, "Main");
        assert_eq!(fixture.elements[0].parameters.len(), 1);
        assert_eq!(
            fixture.elements[0].parameters[0].attribute,
            Attribute::Intensity
        );
        assert_eq!(
            fixture.elements[0].parameters[0].native_unit,
            ParameterUnit::Percent
        );
    }

    /// Verifies OFL focus metadata turns raw position channels into degree-valued parameters.
    #[test]
    fn test_position_channels_use_declared_focus_ranges() {
        use open_fixture_library::OflFixture;

        use super::super::ofl::*;

        let fixture_json = r#"{
            "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
            "name": "Test Moving Head",
            "categories": ["Moving Head"],
            "meta": {
                "authors": ["Test"],
                "createDate": "2024-01-01",
                "lastModifyDate": "2024-01-01"
            },
            "physical": {
                "focus": {
                    "type": "Head",
                    "panMax": 540,
                    "tiltMax": 270
                }
            },
            "availableChannels": {
                "Pan": {
                    "dmxValueResolution": 16,
                    "capabilities": [{ "type": "Pan", "dmxRange": [0, 65535] }]
                },
                "Tilt": {
                    "dmxValueResolution": 16,
                    "capabilities": [{ "type": "Tilt", "dmxRange": [0, 65535] }]
                }
            },
            "modes": [{
                "name": "16-bit",
                "physical": {
                    "focus": {
                        "type": "Head",
                        "panMax": 360
                    }
                },
                "channels": ["Pan", "Tilt"]
            }]
        }"#;

        let ofl = OflFixture::from_json(fixture_json).expect("fixture JSON should parse");
        let (fixture, _) =
            convert_ofl_to_fixture(&ofl, "16-bit", 1).expect("fixture should convert");
        let pan = &fixture.elements[0].parameters[0];
        let tilt = &fixture.elements[0].parameters[1];

        assert_eq!(pan.native_unit, ParameterUnit::Degrees);
        assert_eq!(pan.logical_min(), -180.0);
        assert_eq!(pan.logical_max(), 180.0);
        assert_eq!(tilt.native_unit, ParameterUnit::Degrees);
        assert_eq!(tilt.logical_min(), -135.0);
        assert_eq!(tilt.logical_max(), 135.0);
    }
}
