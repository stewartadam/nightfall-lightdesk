// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OFL to Fixture conversion

use nightfall::prelude::Identifiers;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use uuid::Uuid;

use crate::converters::apply_position_physical_range;
use crate::{FixtureLibraryError, Result};

/// Convert an OFL fixture to a nightfall Fixture.
///
/// OFL format does not include geometry data, so the returned geometry is `None`.
pub fn convert_ofl_to_fixture(
    ofl: &open_fixture_library::OflFixture,
    mode_name: &str,
    id: u32,
) -> Result<(Fixture, Option<FixtureGeometry>)> {
    // Find the requested mode
    let mode = ofl
        .modes()
        .iter()
        .find(|m| m.name == mode_name)
        .ok_or_else(|| FixtureLibraryError::ModeNotFound {
            make: ofl.manufacturer().to_string(),
            model: ofl.name().to_string(),
            mode: mode_name.to_string(),
        })?;

    // Extract manufacturer and model
    let make = ofl.manufacturer().to_string();
    let model = ofl.name().to_string();

    // Convert OFL channels to Elements
    let mut elements = convert_mode_channels(ofl, mode)?;
    apply_ofl_position_ranges(&mut elements, ofl, mode);

    // Extract physical properties
    let physical = extract_physical_properties(ofl, mode);

    let fixture = Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make,
        model,
        mode: mode_name.to_string(),
        elements,
        physical,
        placement: FixturePlacement::default(),
        layout: None,
        library_asset_etag: None,
    };

    // OFL doesn't have geometry data
    Ok((fixture, None))
}

/// Apply OFL fixture-level pan and tilt ranges to every matching parameter.
fn apply_ofl_position_ranges(
    elements: &mut [FixtureElement],
    ofl: &open_fixture_library::OflFixture,
    mode: &open_fixture_library::OflMode,
) {
    let mode_focus = mode
        .physical
        .as_ref()
        .and_then(|physical| physical.focus.as_ref());
    let fixture_focus = ofl.physical().and_then(|physical| physical.focus.as_ref());
    let pan_max = mode_focus
        .and_then(|focus| focus.pan_max)
        .or_else(|| fixture_focus.and_then(|focus| focus.pan_max));
    let tilt_max = mode_focus
        .and_then(|focus| focus.tilt_max)
        .or_else(|| fixture_focus.and_then(|focus| focus.tilt_max));

    for parameter in elements
        .iter_mut()
        .flat_map(|element| element.parameters.iter_mut())
    {
        let physical_range = match parameter.attribute {
            Attribute::Pan => pan_max.map(|max| (0.0, max)),
            Attribute::Tilt => tilt_max.map(|max| (0.0, max)),
            _ => None,
        };
        apply_position_physical_range(parameter, physical_range);
    }
}

/// Convert OFL mode channels to Elements
fn convert_mode_channels(
    ofl: &open_fixture_library::OflFixture,
    mode: &open_fixture_library::OflMode,
) -> Result<Vec<FixtureElement>> {
    // Check if this is a matrix fixture
    if let Some(matrix) = ofl.matrix() {
        convert_matrix_elements(ofl, mode, matrix)
    } else {
        // Non-matrix fixture: create a single element with all channels
        let mut parameters = Vec::new();
        let available_channels = ofl.available_channels();

        for channel_key in mode.channels.iter().flatten() {
            if let Some(channel) = available_channels.get(channel_key)
                && let Some(param_metadata) = convert_channel_to_parameter(channel_key, channel)
            {
                parameters.push(param_metadata);
            }
        }

        Ok(vec![FixtureElement {
            label: "Main".to_string(),
            parameters,
        }])
    }
}

/// Convert matrix fixture to multiple Elements (one per pixel)
fn convert_matrix_elements(
    ofl: &open_fixture_library::OflFixture,
    mode: &open_fixture_library::OflMode,
    matrix: &open_fixture_library::schema::OflMatrix,
) -> Result<Vec<FixtureElement>> {
    let available_channels = ofl.available_channels();
    let template_channels = ofl.template_channels();
    let mut elements = Vec::new();

    // First, collect non-pixel channels (master channels that apply to all pixels)
    let mut master_parameters = Vec::new();

    for channel_key in mode.channels.iter().flatten() {
        // Skip channels that contain pixel key placeholders (e.g., "$pixelKey")
        if channel_key.contains('$') {
            continue;
        }

        if let Some(channel) = available_channels.get(channel_key)
            && let Some(param_metadata) = convert_channel_to_parameter(channel_key, channel)
        {
            master_parameters.push(param_metadata);
        }
    }

    // If there are master channels, create a master element
    if !master_parameters.is_empty() {
        elements.push(FixtureElement {
            label: "Master".to_string(),
            parameters: master_parameters,
        });
    }

    // Create an element for each pixel
    // Determine if we need 2D labeling (for multi-row matrices)
    let needs_2d_labels =
        matrix.pixel_keys.len() > 1 && matrix.pixel_keys.iter().any(|row| row.len() > 1);

    let mut pixel_counter = 1;
    for (row_index, pixel_keys_row) in matrix.pixel_keys.iter().enumerate() {
        for (col_index, pixel_key) in pixel_keys_row.iter().enumerate() {
            let mut pixel_parameters = Vec::new();

            // Process template channels for this pixel
            if let Some(templates) = template_channels {
                for (template_key, template_channel) in templates {
                    // Replace $pixelKey with the actual pixel key
                    let channel_key = template_key.replace("$pixelKey", pixel_key);

                    // Check if this channel is used in the mode
                    if mode.channels.iter().flatten().any(|k| k == &channel_key) {
                        if let Some(param_metadata) =
                            convert_template_channel_to_parameter(&channel_key, template_channel)
                        {
                            pixel_parameters.push(param_metadata);
                        }
                    }
                }
            }

            // Create element for this pixel with appropriate label
            let element_label = if needs_2d_labels {
                // For 2D matrices, use row-column notation
                format!("Pixel {}-{}", row_index + 1, col_index + 1)
            } else {
                // For 1D arrays, use simple sequential numbering
                format!("Pixel {}", pixel_counter)
            };
            pixel_counter += 1;

            if !pixel_parameters.is_empty() {
                elements.push(FixtureElement {
                    label: element_label,
                    parameters: pixel_parameters,
                });
            }
        }
    }

    Ok(elements)
}

/// Convert an OFL channel to ParameterMetadata
fn convert_channel_to_parameter(
    channel_key: &str,
    channel: &open_fixture_library::OflChannel,
) -> Option<ParameterMetadata> {
    // Infer attribute from channel capabilities
    let attribute = infer_attribute_from_capabilities(channel_key, &channel.capabilities)?;

    // Get DMX resolution
    let resolution = match channel.dmx_value_resolution {
        8 => DmxValueResolution::Coarse,
        16 => DmxValueResolution::Fine,
        24 => DmxValueResolution::UltraFine,
        _ => DmxValueResolution::Coarse,
    };

    // Parse default value (TODO: currently unused because parameters are not stored in our parameter metadata)
    let _default_value = parse_dmx_value(&channel.default_value).unwrap_or(0.0);

    // Determine merge strategy from precedence
    let merge_type = match channel.precedence.as_deref() {
        Some("HTP") => MergeStrategy::HTP,
        Some("LTP") => MergeStrategy::LTP,
        _ => MergeStrategy::LTP,
    };

    let use_grandmaster = matches!(
        attribute,
        Attribute::Intensity | Attribute::VirtualIntensity
    );

    // Calculate max value based on resolution (2^bits - 1)
    let max = match resolution {
        DmxValueResolution::Coarse => 255.0,           // 2^8 - 1
        DmxValueResolution::Fine => 65_535.0,          // 2^16 - 1
        DmxValueResolution::UltraFine => 16_777_215.0, // 2^24 - 1
        DmxValueResolution::Uber => 4_294_967_295.0,   // 2^32 - 1
    };

    Some(ParameterMetadata {
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        resolution,
        min: 0.0,
        max,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: channel.invert.unwrap_or(false),
        is_snap: false,
        merge_type,
        use_grandmaster,
    })
}

/// Convert an OFL template channel to ParameterMetadata
fn convert_template_channel_to_parameter(
    channel_key: &str,
    template_channel: &open_fixture_library::schema::OflTemplateChannel,
) -> Option<ParameterMetadata> {
    // Infer attribute from channel capabilities
    let attribute = infer_attribute_from_capabilities(channel_key, &template_channel.capabilities)?;

    // Get DMX resolution
    let resolution = match template_channel.dmx_value_resolution {
        8 => DmxValueResolution::Coarse,
        16 => DmxValueResolution::Fine,
        24 => DmxValueResolution::UltraFine,
        _ => DmxValueResolution::Coarse,
    };

    // Template channels typically use HTP for intensity, LTP for everything else
    let merge_type = match attribute {
        Attribute::Intensity
        | Attribute::VirtualIntensity
        | Attribute::Red
        | Attribute::Green
        | Attribute::Blue
        | Attribute::White
        | Attribute::Amber
        | Attribute::UV
        | Attribute::Cyan
        | Attribute::Magenta
        | Attribute::Yellow
        | Attribute::WarmWhite
        | Attribute::CoolWhite => MergeStrategy::HTP,
        _ => MergeStrategy::LTP,
    };

    let use_grandmaster = matches!(
        attribute,
        Attribute::Intensity | Attribute::VirtualIntensity
    );

    // Calculate max value based on resolution (2^bits - 1)
    let max = match resolution {
        DmxValueResolution::Coarse => 255.0,           // 2^8 - 1
        DmxValueResolution::Fine => 65_535.0,          // 2^16 - 1
        DmxValueResolution::UltraFine => 16_777_215.0, // 2^24 - 1
        DmxValueResolution::Uber => 4_294_967_295.0,   // 2^32 - 1
    };

    Some(ParameterMetadata {
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        resolution,
        min: 0.0,
        max,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false, // Template channels typically don't have invert flags
        is_snap: false,
        merge_type,
        use_grandmaster,
    })
}

/// Infer nightfall Attribute from OFL channel capabilities
fn infer_attribute_from_capabilities(
    channel_key: &str,
    capabilities: &[open_fixture_library::OflCapability],
) -> Option<Attribute> {
    // Check first capability type (pass full capability for color info)
    if let Some(cap) = capabilities.first() {
        return map_ofl_capability_to_attribute(cap);
    }

    // Fallback: infer from channel key
    map_channel_key_to_attribute(channel_key)
}

/// Map OFL capability to nightfall Attribute
///
/// For ColorIntensity capabilities, checks the `color` field to determine
/// the specific attribute (Red, Green, Blue, White, Amber, UV, etc.)
fn map_ofl_capability_to_attribute(cap: &open_fixture_library::OflCapability) -> Option<Attribute> {
    match cap.capability_type.as_str() {
        "Intensity" => Some(Attribute::Intensity),
        "ColorIntensity" => {
            // Check the color field to determine specific color channel
            if let Some(color) = &cap.color {
                map_color_to_attribute(color)
            } else {
                // No color specified, use VirtualIntensity as fallback
                Some(Attribute::VirtualIntensity)
            }
        }
        "Pan" => Some(Attribute::Pan),
        "Tilt" => Some(Attribute::Tilt),
        "Focus" => Some(Attribute::Custom {
            label: "Focus".to_string(),
        }),
        "Zoom" => Some(Attribute::Zoom),
        "Iris" => Some(Attribute::Custom {
            label: "Iris".to_string(),
        }),
        "ShutterStrobe" => Some(Attribute::StrobeShutter),
        _ => Some(Attribute::Custom {
            label: cap.capability_type.clone(),
        }),
    }
}

/// Map OFL color name to nightfall Attribute
///
/// Handles common color names used in OFL ColorIntensity capabilities.
/// TODO: Implement mappings for all attributes in the OFL specification, per:
/// https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/fixture-format.md
pub(super) fn map_color_to_attribute(color: &str) -> Option<Attribute> {
    match color.to_lowercase().as_str() {
        "red" => Some(Attribute::Red),
        "green" => Some(Attribute::Green),
        "blue" => Some(Attribute::Blue),
        "white" => Some(Attribute::White),
        "warm white" | "warmwhite" => Some(Attribute::WarmWhite),
        "cool white" | "coolwhite" => Some(Attribute::CoolWhite),
        "amber" => Some(Attribute::Amber),
        "uv" | "ultraviolet" => Some(Attribute::UV),
        "cyan" => Some(Attribute::Cyan),
        "magenta" => Some(Attribute::Magenta),
        "yellow" => Some(Attribute::Yellow),
        // For colors not in the Attribute enum (like Lime), create custom attributes
        _ => Some(Attribute::Custom {
            label: format!("{} Intensity", color),
        }),
    }
}

/// Map channel key to attribute (fallback)
pub(super) fn map_channel_key_to_attribute(key: &str) -> Option<Attribute> {
    let key_lower = key.to_lowercase();

    if key_lower.contains("dimmer") || key_lower.contains("intensity") {
        Some(Attribute::Intensity)
    } else if key_lower.contains("pan") {
        Some(Attribute::Pan)
    } else if key_lower.contains("tilt") {
        Some(Attribute::Tilt)
    } else if key_lower.contains("red") {
        Some(Attribute::Red)
    } else if key_lower.contains("green") {
        Some(Attribute::Green)
    } else if key_lower.contains("blue") {
        Some(Attribute::Blue)
    } else if key_lower.contains("white") {
        Some(Attribute::White)
    } else if key_lower.contains("amber") {
        Some(Attribute::Amber)
    } else if key_lower.contains("zoom") {
        Some(Attribute::Zoom)
    } else if key_lower.contains("focus") {
        Some(Attribute::Custom {
            label: "Focus".to_string(),
        })
    } else if key_lower.contains("iris") {
        Some(Attribute::Custom {
            label: "Iris".to_string(),
        })
    } else if key_lower.contains("shutter") || key_lower.contains("strobe") {
        Some(Attribute::StrobeShutter)
    } else {
        Some(Attribute::Custom {
            label: key.to_string(),
        })
    }
}

/// Parse DMX value from JSON value
pub(super) fn parse_dmx_value(value: &Option<serde_json::Value>) -> Option<ParameterDmxValue> {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_f64().map(|v| v as ParameterDmxValue),
        Some(serde_json::Value::String(s)) => {
            // Handle percentage strings like "50%"
            if s.ends_with('%') {
                let percent = s.trim_end_matches('%').parse::<f32>().ok()?;
                Some(percent / 100.0 * 255.0)
            } else {
                s.parse::<ParameterDmxValue>().ok()
            }
        }
        _ => None,
    }
}

/// Extract physical properties from OFL
fn extract_physical_properties(
    ofl: &open_fixture_library::OflFixture,
    mode: &open_fixture_library::OflMode,
) -> Option<FixturePhysical> {
    // Check mode-specific physical first, then fixture-level
    let physical = mode.physical.as_ref().or_else(|| ofl.physical())?;

    // Extract bulb/lens information
    let lumens = physical.bulb.as_ref().and_then(|b| b.lumens);
    let color_temperature = physical.bulb.as_ref().and_then(|b| b.color_temperature);

    // Extract lens angles
    let (beam_angle, field_angle) = if let Some(lens) = &physical.lens {
        if let Some([min, max]) = lens.degrees_min_max {
            (min, max)
        } else {
            (15.0, 40.0) // Default values
        }
    } else {
        (15.0, 40.0) // Default values
    };

    // Infer beam type from fixture categories
    let beam_type = infer_beam_type_from_categories(ofl.categories());

    Some(FixturePhysical {
        beam_angle,
        field_angle,
        lumens,
        color_temperature,
        beam_type,
    })
}

/// Infer beam type from OFL fixture categories
///
/// Uses the fixture's category list to determine the most appropriate beam type.
/// Categories like "Blinder", "Strobe", "Effect", "Hazer" suggest wash-type beams,
/// while "Moving Head" or "Scanner" with specific features suggest spot beams.
pub(super) fn infer_beam_type_from_categories(categories: &[String]) -> BeamType {
    // Convert to lowercase for case-insensitive matching
    let categories_lower: Vec<String> = categories.iter().map(|c| c.to_lowercase()).collect();

    // Check for wash-type fixtures
    if categories_lower.iter().any(|c| {
        c.contains("wash")
            || c.contains("blinder")
            || c.contains("strobe")
            || c.contains("effect")
            || c.contains("flower")
            || c.contains("matrix")
            || c.contains("pixel")
    }) {
        return BeamType::Wash;
    }

    // Check for fresnel fixtures
    if categories_lower.iter().any(|c| c.contains("fresnel")) {
        return BeamType::Fresnel;
    }

    // Check for PC (plano-convex) fixtures
    if categories_lower
        .iter()
        .any(|c| c.contains("pc") || c.contains("plano"))
    {
        return BeamType::Pc;
    }

    // Check for spot fixtures (profile spots, moving heads with gobos, etc.)
    if categories_lower.iter().any(|c| {
        c.contains("spot")
            || c.contains("profile")
            || c.contains("gobo")
            || c.contains("scanner")
            || c.contains("beam")
    }) {
        return BeamType::Spot;
    }

    // Default to spot for moving heads and scanners, wash for everything else
    if categories_lower
        .iter()
        .any(|c| c.contains("moving head") || c.contains("scanner"))
    {
        BeamType::Spot
    } else {
        BeamType::Wash
    }
}
