// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OFL to Fixture conversion

use nightfall::prelude::Identifiers;
use nightfall_dmx::prelude::*;
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::*;
use uuid::Uuid;

use crate::converters::{apply_position_physical_range, default_merge_strategy};
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
    let physical = Some(extract_physical_properties(ofl, mode));

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

/// The element an OFL channel belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ElementSlot {
    /// Fixture-wide channels: "Main" for plain fixtures, "Master" for matrix fixtures.
    Shared,
    /// The matrix pixel at this index in `pixelKeys` reading order.
    Pixel(usize),
}

/// The OFL definition a mode channel key resolves to.
#[derive(Debug, Clone, Copy)]
enum ChannelSource<'a> {
    /// A key of `availableChannels`.
    Available(&'a open_fixture_library::OflChannel),
    /// A `templateChannels` entry instantiated for one pixel.
    Template(&'a open_fixture_library::schema::OflTemplateChannel),
}

impl ChannelSource<'_> {
    /// Returns the capabilities used to infer the parameter attribute.
    fn capabilities(&self) -> &[open_fixture_library::OflCapability] {
        match self {
            Self::Available(channel) => &channel.capabilities,
            Self::Template(channel) => &channel.capabilities,
        }
    }
}

/// One byte of a parameter, as named by a key in a mode's channel list.
#[derive(Debug, Clone)]
struct ChannelByte<'a> {
    /// Key of the parameter's coarse channel, which identifies the parameter.
    coarse_key: String,
    /// Byte index: 0 for the coarse channel, 1 and up for `fineChannelAliases`.
    byte: usize,
    element: ElementSlot,
    source: ChannelSource<'a>,
}

/// A parameter collected while walking a mode's channel list.
#[derive(Debug)]
struct ModeParameter<'a> {
    coarse_key: String,
    element: ElementSlot,
    source: ChannelSource<'a>,
    /// 1-based footprint slot of each byte, indexed by byte, filled as the mode names them.
    offsets: Vec<Option<u16>>,
}

/// Indexes every channel key a mode may name: coarse channels, their fine
/// aliases and, for matrix fixtures, template channels instantiated per pixel.
fn channel_byte_index<'a>(
    ofl: &'a open_fixture_library::OflFixture,
) -> std::collections::HashMap<String, ChannelByte<'a>> {
    let mut index = std::collections::HashMap::new();
    let mut insert = |coarse_key: String,
                      fine_aliases: &[String],
                      element: ElementSlot,
                      source: ChannelSource<'a>| {
        for (byte, alias) in fine_aliases.iter().enumerate() {
            index.insert(
                alias.clone(),
                ChannelByte {
                    coarse_key: coarse_key.clone(),
                    byte: byte + 1,
                    element,
                    source,
                },
            );
        }
        index.insert(
            coarse_key.clone(),
            ChannelByte {
                coarse_key,
                byte: 0,
                element,
                source,
            },
        );
    };

    for (key, channel) in ofl.available_channels() {
        insert(
            key.clone(),
            channel.fine_channel_aliases.as_deref().unwrap_or_default(),
            ElementSlot::Shared,
            ChannelSource::Available(channel),
        );
    }

    if let (Some(matrix), Some(templates)) = (ofl.matrix(), ofl.template_channels()) {
        for (pixel, pixel_key) in matrix.pixel_keys.iter().flatten().enumerate() {
            for (template_key, template) in templates {
                let fine_aliases: Vec<String> = template
                    .fine_channel_aliases
                    .iter()
                    .flatten()
                    .map(|alias| alias.replace("$pixelKey", pixel_key))
                    .collect();
                insert(
                    template_key.replace("$pixelKey", pixel_key),
                    &fine_aliases,
                    ElementSlot::Pixel(pixel),
                    ChannelSource::Template(template),
                );
            }
        }
    }

    index
}

/// Walks a mode's channel list by position and collects each parameter with the
/// footprint slot of every byte the mode names.
///
/// Positions matter on the wire: a `null` entry, an unknown key (such as a
/// switching-channel alias) or a fine alias all occupy a DMX slot, so every
/// parameter gets explicit 1-based offsets taken from its position in the list
/// instead of being packed after the previous parameter.
fn collect_mode_parameters<'a>(
    ofl: &'a open_fixture_library::OflFixture,
    mode: &open_fixture_library::OflMode,
) -> Vec<ModeParameter<'a>> {
    let index = channel_byte_index(ofl);
    let mut parameters: Vec<ModeParameter<'a>> = Vec::new();
    let mut parameter_by_coarse_key = std::collections::HashMap::new();

    for (position, key) in mode.channels.iter().enumerate() {
        let Some(channel) = key.as_ref().and_then(|key| index.get(key)) else {
            continue;
        };
        let Ok(slot) = u16::try_from(position + 1) else {
            continue;
        };
        let parameter_index = *parameter_by_coarse_key
            .entry(channel.coarse_key.as_str())
            .or_insert_with(|| {
                parameters.push(ModeParameter {
                    coarse_key: channel.coarse_key.clone(),
                    element: channel.element,
                    source: channel.source,
                    offsets: Vec::new(),
                });
                parameters.len() - 1
            });
        let parameter = &mut parameters[parameter_index];
        if parameter.offsets.len() <= channel.byte {
            parameter.offsets.resize(channel.byte + 1, None);
        }
        parameter.offsets[channel.byte].get_or_insert(slot);
    }

    parameters
}

/// Returns the parameter resolution for a number of DMX bytes.
fn resolution_for_width(width: usize) -> Option<DmxValueResolution> {
    match width {
        1 => Some(DmxValueResolution::Coarse),
        2 => Some(DmxValueResolution::Fine),
        3 => Some(DmxValueResolution::UltraFine),
        4 => Some(DmxValueResolution::Uber),
        _ => None,
    }
}

/// Converts the channels of an OFL mode to fixture elements.
///
/// Plain fixtures get one "Main" element. Matrix fixtures get a "Master"
/// element for fixture-wide channels followed by one element per pixel that
/// the mode uses. Each parameter keeps the DMX slots its channels occupy in
/// the mode, and a parameter whose mode also lists its fine aliases is widened
/// to 16, 24 or 32 bits.
fn convert_mode_channels(
    ofl: &open_fixture_library::OflFixture,
    mode: &open_fixture_library::OflMode,
) -> Result<Vec<FixtureElement>> {
    let mut by_element: std::collections::BTreeMap<ElementSlot, Vec<(u16, ParameterMetadata)>> =
        std::collections::BTreeMap::new();

    for parameter in collect_mode_parameters(ofl, mode) {
        // Only bytes named contiguously from the coarse channel are usable: a
        // fine alias without its coarse channel cannot be driven on its own. Widths
        // beyond 32 bits keep their four most significant bytes.
        let offsets: Vec<u16> = parameter
            .offsets
            .iter()
            .map_while(|slot| *slot)
            .take(4)
            .collect();
        let Some(resolution) = resolution_for_width(offsets.len()) else {
            continue;
        };
        let coarse_slot = offsets[0];
        if let Some(metadata) = convert_channel_to_parameter(
            &parameter.coarse_key,
            parameter.source,
            resolution,
            DmxSlots::Explicit {
                dmx_break: 1,
                offsets,
            },
        ) {
            by_element
                .entry(parameter.element)
                .or_default()
                .push((coarse_slot, metadata));
        }
    }

    let pixel_labels = ofl.matrix().map(pixel_labels).unwrap_or_default();
    Ok(by_element
        .into_iter()
        .map(|(element, mut parameters)| {
            parameters.sort_by_key(|(slot, _)| *slot);
            let label = match element {
                ElementSlot::Shared if ofl.matrix().is_some() => "Master".to_string(),
                ElementSlot::Shared => "Main".to_string(),
                ElementSlot::Pixel(pixel) => pixel_labels[pixel].clone(),
            };
            FixtureElement {
                label,
                parameters: parameters
                    .into_iter()
                    .map(|(_, parameter)| parameter)
                    .collect(),
            }
        })
        .collect())
}

/// Returns the element label of every matrix pixel in `pixelKeys` reading order.
///
/// Multi-row matrices use row-column labels ("Pixel 2-3"); single rows or
/// columns are numbered sequentially ("Pixel 7").
fn pixel_labels(matrix: &open_fixture_library::schema::OflMatrix) -> Vec<String> {
    let needs_2d_labels =
        matrix.pixel_keys.len() > 1 && matrix.pixel_keys.iter().any(|row| row.len() > 1);
    let mut labels = Vec::new();
    for (row_index, row) in matrix.pixel_keys.iter().enumerate() {
        for col_index in 0..row.len() {
            labels.push(if needs_2d_labels {
                format!("Pixel {}-{}", row_index + 1, col_index + 1)
            } else {
                format!("Pixel {}", labels.len() + 1)
            });
        }
    }
    labels
}

/// Converts one OFL channel (plain or pixel template) to parameter metadata.
///
/// `resolution` and `dmx_slots` come from the mode layout, since OFL expresses
/// width through the fine aliases a mode lists rather than on the channel.
fn convert_channel_to_parameter(
    channel_key: &str,
    source: ChannelSource<'_>,
    resolution: DmxValueResolution,
    dmx_slots: DmxSlots,
) -> Option<ParameterMetadata> {
    let attribute = infer_attribute_from_capabilities(channel_key, source.capabilities())?;

    let (precedence, is_inverted) = match source {
        ChannelSource::Available(channel) => (
            channel.precedence.as_deref(),
            channel.invert.unwrap_or(false),
        ),
        ChannelSource::Template(_) => (None, false),
    };
    let merge_type = match precedence {
        Some("HTP") => MergeStrategy::HTP,
        Some("LTP") => MergeStrategy::LTP,
        _ => default_merge_strategy(&attribute),
    };

    let use_grandmaster = matches!(
        attribute,
        Attribute::Intensity | Attribute::VirtualIntensity
    );

    Some(ParameterMetadata {
        dmx_slots,
        functions: Vec::new(),
        default_dmx: None,
        highlight_dmx: None,
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        resolution,
        min: 0.0,
        max: resolution.dmx_max() as f32,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted,
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
        "Focus" => Some(Attribute::Focus),
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
        Some(Attribute::Focus)
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

/// Lens angles, in degrees, assumed when an OFL profile states none.
const DEFAULT_LENS_DEGREES: (f32, f32) = (15.0, 40.0);

/// Extracts photometry from OFL, filling what the profile omits.
///
/// Every OFL fixture gets photometry so renderers never invent their own: a
/// profile without a physical block, bulb flux or lens angles falls back to
/// [`DEFAULT_LUMENS`] and [`DEFAULT_LENS_DEGREES`].
fn extract_physical_properties(
    ofl: &open_fixture_library::OflFixture,
    mode: &open_fixture_library::OflMode,
) -> FixturePhysical {
    // Check mode-specific physical first, then fixture-level
    let physical = mode.physical.as_ref().or_else(|| ofl.physical());
    let bulb = physical.and_then(|physical| physical.bulb.as_ref());
    let (beam_angle, field_angle) = physical
        .and_then(|physical| physical.lens.as_ref())
        .and_then(|lens| lens.degrees_min_max)
        .map_or(DEFAULT_LENS_DEGREES, |[min, max]| (min, max));

    FixturePhysical {
        beam_angle,
        field_angle,
        lumens: bulb.and_then(|bulb| bulb.lumens).unwrap_or(DEFAULT_LUMENS),
        color_temperature: bulb.and_then(|bulb| bulb.color_temperature),
        // Infer beam type from fixture categories
        beam_type: infer_beam_type_from_categories(ofl.categories()),
    }
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
