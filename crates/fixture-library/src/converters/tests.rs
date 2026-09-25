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

    /// Preserves angular zoom values instead of treating them as raw DMX percentages.
    #[test]
    fn zoom_bounds_enable_degree_units() {
        let mut metadata = ParameterMetadata {
            attribute: Attribute::Zoom,
            max: 255.0,
            ..Default::default()
        };
        apply_position_physical_range(&mut metadata, Some((5.0, 45.0)));
        assert_eq!(metadata.native_unit, ParameterUnit::Degrees);
        assert_eq!(metadata.min, 5.0);
        assert_eq!(metadata.max, 45.0);
    }

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

    /// Converts coarse-encoded boundaries to a fine channel without losing inclusive slot ends.
    #[test]
    fn test_optical_function_resolution_and_slots() {
        let mode: gdtf::dmx_mode::DmxMode = serde_json::from_value(serde_json::json!({
            "@Name": "Mode", "@Geometry": "Head",
            "DMXChannels": [{ "DMXChannel": [{
                "@Geometry": "Head", "@Offset": "1,2", "@Highlight": "None",
                "LogicalChannel": [{ "@Attribute": "Gobo1", "ChannelFunction": [
                    { "@Attribute": "Gobo1", "@DMXFrom": "0/1", "@Wheel": "Gobos", "@PhysicalFrom": 1, "@PhysicalTo": 2,
                      "ChannelSet": [
                        { "@DMXFrom": "0/1", "@WheelSlotIndex": 1 },
                        { "@DMXFrom": "64/1", "@WheelSlotIndex": 2 }
                      ] },
                    { "@Attribute": "Gobo1PosRotate", "@DMXFrom": "128/1", "@PhysicalFrom": -60, "@PhysicalTo": 60 }
                ] }]
            }] }]
        })).unwrap();
        let channels = convert_optical_channels(&mode, None);
        assert_eq!(channels.len(), 1);
        let channel = &channels[0];
        assert_eq!(channel.dmx_max, 65535);
        assert_eq!(channel.functions[0].dmx_to, 32895);
        assert_eq!(channel.functions[1].dmx_from, 32896);
        assert_eq!(channel.functions[1].dmx_to, 65535);
        assert_eq!(channel.functions[0].sets[0].dmx_to, 16447);
        assert_eq!(channel.functions[0].sets[1].dmx_from, 16448);
        assert_eq!(channel.functions[0].sets[1].wheel_slot, Some(2));
        assert_eq!(channel.functions[1].physical_from, -60.0);
    }

    /// Conditional alternatives at the same DMX boundary must both survive import.
    #[test]
    fn test_optical_mode_alternatives_share_the_full_interval() {
        let mode: gdtf::dmx_mode::DmxMode = serde_json::from_value(serde_json::json!({
            "@Name": "Mode", "@Geometry": "Head",
            "DMXChannels": [{ "DMXChannel": [
                { "@Geometry": "Head", "@Offset": "1", "@Highlight": "None",
                  "LogicalChannel": [{ "@Attribute": "Control", "ChannelFunction": [
                    { "@Attribute": "Control", "@DMXFrom": "0/1" }
                  ] }] },
                { "@Geometry": "Head", "@Offset": "2", "@Highlight": "None",
                  "LogicalChannel": [{ "@Attribute": "Gobo1Pos", "ChannelFunction": [
                    { "@Attribute": "Gobo1Pos", "@DMXFrom": "0/1", "@PhysicalFrom": 0, "@PhysicalTo": 360,
                      "@ModeMaster": "Head_Control", "@ModeFrom": "0/1", "@ModeTo": "127/1" },
                    { "@Attribute": "Gobo1PosRotate", "@DMXFrom": "0/1", "@PhysicalFrom": -180, "@PhysicalTo": 180,
                      "@ModeMaster": "Head_Control", "@ModeFrom": "128/1", "@ModeTo": "255/1" }
                  ] }] }
            ] }]
        })).unwrap();
        let channels = convert_optical_channels(&mode, None);
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].functions.len(), 2);
        for function in &channels[0].functions {
            assert_eq!((function.dmx_from, function.dmx_to), (0, 255));
            assert!(function.mode_master.is_some());
        }
        assert_eq!(channels[0].functions[0].attribute, "Gobo1Pos");
        assert_eq!(channels[0].functions[1].attribute, "Gobo1PosRotate");
        let condition = &channels[0].functions[1].mode_conditions.as_ref().unwrap()[0];
        assert_eq!(condition.geometry, "Head");
        assert_eq!(condition.parameter_key, "Control");
        assert_eq!(
            (condition.dmx_from, condition.dmx_to, condition.dmx_max),
            (128, 255, 255)
        );

        // A speed breakpoint in the rotation container must not shorten indexed positioning.
        let mut mode = mode;
        let functions = &mut mode.dmx_channels[1].logical_channels[0].channel_functions;
        let mut second_speed = functions[1].clone();
        second_speed.dmx_from = serde_json::from_value(serde_json::json!("128/1")).unwrap();
        functions.push(second_speed);
        let channels = convert_optical_channels(&mode, None);
        assert_eq!(channels[0].functions[0].dmx_to, 255);
        assert_eq!(channels[0].functions[1].dmx_to, 127);
        assert_eq!(channels[0].functions[2].dmx_to, 255);
    }

    /// Resolves nested function masters at each channel's resolution and rejects cyclic links.
    #[test]
    fn test_optical_nested_mode_conditions() {
        let mut mode: gdtf::dmx_mode::DmxMode = serde_json::from_value(serde_json::json!({
            "@Name": "Mode", "@Geometry": "Head",
            "DMXChannels": [{ "DMXChannel": [
                { "@Geometry": "Base", "@Offset": "1,2", "@Highlight": "None",
                  "LogicalChannel": [{ "@Attribute": "Control", "ChannelFunction": [
                    { "@Name": "Enable", "@Attribute": "Control", "@DMXFrom": "0/1" }
                  ] }] },
                { "@Geometry": "Head", "@Offset": "3", "@Highlight": "None",
                  "LogicalChannel": [{ "@Attribute": "Gobo1", "ChannelFunction": [
                    { "@Name": "Indexed", "@Attribute": "Gobo1", "@DMXFrom": "0/1",
                      "@ModeMaster": "Base_Control", "@ModeFrom": "128/1", "@ModeTo": "255/1" },
                    { "@Name": "Rotating", "@Attribute": "Gobo1", "@DMXFrom": "100/1",
                      "@ModeMaster": "Base_Control", "@ModeFrom": "128/1", "@ModeTo": "255/1" }
                  ] }] },
                { "@Geometry": "Head", "@Offset": "4", "@Highlight": "None",
                  "LogicalChannel": [{ "@Attribute": "Gobo1Pos", "ChannelFunction": [
                    { "@Name": "Position", "@Attribute": "Gobo1Pos", "@DMXFrom": "0/1",
                      "@ModeMaster": "Head_Gobo1.Gobo1.Indexed", "@ModeFrom": "20/1", "@ModeTo": "200/1" }
                  ] }] }
            ] }]
        })).unwrap();
        let channels = convert_optical_channels(&mode, None);
        let conditions = channels[1].functions[0].mode_conditions.as_ref().unwrap();
        assert_eq!(conditions.len(), 2);
        assert_eq!((conditions[0].dmx_from, conditions[0].dmx_to), (20, 99));
        assert_eq!(conditions[0].geometry, "Head");
        assert_eq!(
            (
                conditions[1].dmx_from,
                conditions[1].dmx_to,
                conditions[1].dmx_max
            ),
            (32896, 65535, 65535)
        );
        assert_eq!(conditions[1].geometry, "Base");

        mode.dmx_channels[1].logical_channels[0].channel_functions[0].mode_master =
            mode.dmx_channels[2].logical_channels[0].channel_functions[0]
                .mode_master
                .clone();
        let channels = convert_optical_channels(&mode, None);
        assert!(channels[1].functions[0].mode_conditions.is_none());
        assert!(channels[1].functions[0].mode_master.is_some());
    }

    /// Sorts profile segments without dropping nonlinear coefficients or physical limits.
    #[test]
    fn test_optical_profile_preserves_segments_and_physical_limits() {
        let profile: gdtf::physical_descriptions::DmxProfile = serde_json::from_value(serde_json::json!({
            "@Name": "FocusCurve",
            "Point": [
                { "@DMXPercentage": 75, "@CFC0": 20, "@CFC1": -2, "@CFC2": 0.5, "@CFC3": -0.01 },
                { "@DMXPercentage": 0, "@CFC0": 2, "@CFC1": 1 }
            ]
        })).unwrap();
        let converted = convert_optical_profile(&profile, 2.0, 30.0);
        assert_eq!((converted.min, converted.max), (2.0, 30.0));
        assert_eq!(converted.points[0].dmx_percentage, 0.0);
        assert_eq!(converted.points[1].dmx_percentage, 75.0);
        assert_eq!(converted.points[1].coefficients, [20.0, -2.0, 0.5, -0.01]);
        assert_eq!(converted.points[0].coefficients, [2.0, 1.0, 0.0, 0.0]);
    }

    /// Preserves open slots, gobo resource references, and non-symmetric prism matrices.
    #[test]
    fn test_convert_optical_wheel_slots() {
        let wheel: gdtf::wheel::Wheel = serde_json::from_value(serde_json::json!({
            "@Name": "Optics",
            "Slot": [
                { "@Name": "Open", "@Color": "0.3127,0.329,100" },
                { "@Name": "Gobo", "@Color": "0.3127,0.329,100", "@MediaFileName": "pattern" },
                { "@Name": "Prism", "@Color": "0.3127,0.329,100", "Facet": [
                    { "@Color": "0.3,0.4,100", "@Rotation": "{1,2,3}{4,5,6}{7,8,9}" }
                ] }
            ]
        }))
        .unwrap();
        let converted = convert_optical_wheels(&[wheel]);
        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].name, "Optics");
        assert_eq!(converted[0].slots.len(), 3);
        assert!(converted[0].slots[0].media_name.is_none());
        assert!(converted[0].slots[0].facets.is_empty());
        assert_eq!(converted[0].slots[1].media_name.as_deref(), Some("pattern"));
        assert_eq!(
            converted[0].slots[2].facets[0].transform,
            [1., 4., 7., 2., 5., 8., 3., 6., 9.]
        );
        assert_eq!(converted[0].slots[2].facets[0].color_cie, [0.3, 0.4, 100.]);
    }

    /// Keeps lens focus distinct from beam-angle zoom during import.
    #[test]
    fn test_map_gdtf_focus() {
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"Focus1"),
            Some(Attribute::Focus)
        );
        assert_eq!(
            map_gdtf_attribute_to_nightfall(&"Focus"),
            Some(Attribute::Focus)
        );
        assert_eq!(Attribute::Focus.category(), AttributeCategory::Focus);
    }

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

    /// Rectangular projectors must retain their distribution instead of becoming glow-only pixels.
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
        assert_eq!(map_gdtf_beam_type(&GdtfBeamType::None), BeamType::Glow);
        assert_eq!(map_gdtf_beam_type(&GdtfBeamType::Glow), BeamType::Glow);
        assert_eq!(
            map_gdtf_beam_type(&GdtfBeamType::Rectangle),
            BeamType::Rectangle
        );
    }

    /// Different apertures keep their own distribution and photometry through conversion.
    #[test]
    fn test_convert_per_emitter_optics() {
        let mut beam = gdtf::geometry::BeamGeometry {
            name: None,
            model: None,
            position: gdtf::values::Matrix::identity(),
            children: Vec::new(),
            lamp_type: gdtf::geometry::LampType::Led,
            power_consumption: 10.0,
            luminous_flux: 700.0,
            color_temperature: 5600.0,
            beam_angle: 2.0,
            field_angle: 4.0,
            throw_ratio: 2.5,
            rectangle_ratio: 12.0,
            beam_radius: 0.012,
            beam_type: gdtf::geometry::BeamType::Rectangle,
            color_rendering_index: 90,
            emitter_spectrum: None,
        };
        let rectangle = convert_beam_optics(&beam);
        beam.beam_type = gdtf::geometry::BeamType::Wash;
        beam.beam_angle = 40.0;
        beam.luminous_flux = 1200.0;
        let wash = convert_beam_optics(&beam);
        assert_eq!(rectangle.physical.beam_type, BeamType::Rectangle);
        assert_eq!(rectangle.physical.beam_angle, 2.0);
        assert_eq!(rectangle.physical.field_angle, 4.0);
        assert_eq!(rectangle.physical.lumens, Some(700.0));
        assert_eq!(rectangle.radius, 0.012);
        assert_eq!(rectangle.throw_ratio, 2.5);
        assert_eq!(rectangle.rectangle_ratio, 12.0);
        assert_eq!(wash.physical.beam_type, BeamType::Wash);
        assert_eq!(wash.physical.beam_angle, 40.0);
        assert_eq!(wash.physical.lumens, Some(1200.0));
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
