// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OFL to Fixture conversion

use std::collections::{BTreeMap, HashMap, HashSet};

use nightfall::prelude::Identifiers;
use nightfall_dmx::prelude::*;
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::*;
use open_fixture_library::schema::OflPrecedence;
use open_fixture_library::{OflChannel, OflFixture, OflMatrix, OflMode};
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
    let elements = convert_mode_channels(ofl, mode);

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

/// The element an OFL channel belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ElementSlot {
    /// Fixture-wide channels: "Main" for plain fixtures, "Master" for matrix fixtures.
    Shared,
    /// The matrix pixel at this index in [`OflMatrix::pixels`] order.
    Pixel(usize),
    /// The matrix pixel group at this index in definition order.
    Group(usize),
}

/// One byte of a parameter, as named by a key in a mode's channel list.
#[derive(Debug, Clone)]
struct ChannelByte<'a> {
    /// Key of the parameter's coarse channel, which identifies the parameter.
    coarse_key: String,
    /// Byte index: 0 for the coarse channel, 1 and up for `fineChannelAliases`.
    byte: usize,
    element: ElementSlot,
    /// The available or template channel the byte belongs to.
    channel: &'a OflChannel,
}

/// A parameter collected while walking a mode's channel list.
#[derive(Debug)]
struct ModeParameter<'a> {
    coarse_key: String,
    element: ElementSlot,
    channel: &'a OflChannel,
    /// 1-based footprint slot of each byte, indexed by byte, filled as the mode names them.
    offsets: Vec<Option<u16>>,
}

/// Indexes every channel key a mode may name: coarse channels and their fine aliases,
/// template channels instantiated for every matrix pixel and pixel group, and
/// switching channel aliases.
///
/// A switching channel alias stands for whichever channel its trigger channel selects;
/// it resolves to the channel selected while the trigger rests at its default value,
/// as its own parameter so it never merges with that channel's own slot.
fn channel_byte_index(ofl: &OflFixture) -> ChannelIndex<'_> {
    let mut index = HashMap::new();
    // (alias, target channel key) of every switching channel alias.
    let mut switches: Vec<(String, String)> = Vec::new();

    for (key, channel) in ofl.available_channels() {
        index_channel(
            &mut index,
            &mut switches,
            None,
            key,
            ElementSlot::Shared,
            channel,
        );
    }

    if let Some(matrix) = ofl.matrix() {
        let pixels = matrix
            .pixels()
            .into_iter()
            .enumerate()
            .map(|(index, pixel)| (pixel.key, ElementSlot::Pixel(index)));
        let groups = matrix
            .pixel_groups()
            .into_iter()
            .enumerate()
            .map(|(index, (group_key, _))| (group_key, ElementSlot::Group(index)));
        for (pixel_key, element) in pixels.chain(groups) {
            for (template_key, template) in ofl.template_channels() {
                index_channel(
                    &mut index,
                    &mut switches,
                    Some(&pixel_key),
                    template_key,
                    element,
                    template,
                );
            }
        }
    }

    // A switching alias of a coarse channel becomes its own parameter. A switching
    // alias of a fine channel stays a byte of that fine channel's coarse parameter;
    // `collect_mode_parameters` moves it to a switching alias when the mode lists
    // the coarse channel only through one.
    switches.sort();
    let mut aliases_by_target: HashMap<String, Vec<String>> = HashMap::new();
    for (alias, target) in &switches {
        let Some(target_byte) = index.get(target).cloned() else {
            continue;
        };
        let coarse_key = if target_byte.byte == 0 {
            aliases_by_target
                .entry(target.clone())
                .or_default()
                .push(alias.clone());
            alias.clone()
        } else {
            target_byte.coarse_key.clone()
        };
        let switched = ChannelByte {
            coarse_key,
            ..target_byte
        };
        index.entry(alias.clone()).or_insert(switched);
    }

    ChannelIndex {
        bytes: index,
        aliases_by_target,
    }
}

/// Every channel key a fixture's modes may name, with the switching aliases of each
/// switched coarse channel.
struct ChannelIndex<'a> {
    /// The parameter byte each channel key drives.
    bytes: HashMap<String, ChannelByte<'a>>,
    /// The switching aliases that select each coarse channel by default.
    aliases_by_target: HashMap<String, Vec<String>>,
}

/// Adds one channel's coarse key and fine aliases to `index`, and records its switching
/// channel aliases in `switches` with the channel each selects by default.
///
/// For a template channel, `pixel_key` replaces `$pixelKey` in every key it names.
fn index_channel<'a>(
    index: &mut HashMap<String, ChannelByte<'a>>,
    switches: &mut Vec<(String, String)>,
    pixel_key: Option<&str>,
    coarse_template: &str,
    element: ElementSlot,
    channel: &'a OflChannel,
) {
    let key_for = |template: &str| match pixel_key {
        Some(pixel_key) => template.replace("$pixelKey", pixel_key),
        None => template.to_string(),
    };
    let coarse_key = key_for(coarse_template);
    for (byte, alias) in channel.fine_channel_aliases.iter().enumerate() {
        index.insert(
            key_for(alias),
            ChannelByte {
                coarse_key: coarse_key.clone(),
                byte: byte + 1,
                element,
                channel,
            },
        );
    }
    for alias in channel
        .capabilities()
        .iter()
        .flat_map(|capability| capability.switch_channels.keys())
    {
        // The slot stays controllable when the default selects no channel: fall back
        // to the first channel the alias can switch to.
        let target = channel.default_switch_target(alias).flatten().or_else(|| {
            channel
                .capabilities()
                .iter()
                .find_map(|capability| capability.switch_channels.get(alias)?.as_deref())
        });
        if let Some(target) = target {
            switches.push((key_for(alias), key_for(target)));
        }
    }
    index.insert(
        coarse_key.clone(),
        ChannelByte {
            coarse_key,
            byte: 0,
            element,
            channel,
        },
    );
}

/// Walks a mode's resolved channel list by position and collects each parameter with
/// the footprint slot of every byte the mode names.
///
/// Positions matter on the wire: a `null` entry, an unknown key or a fine alias all
/// occupy a DMX slot, so every parameter gets explicit 1-based offsets taken from its
/// position in the list instead of being packed after the previous parameter.
fn collect_mode_parameters<'a>(ofl: &'a OflFixture, mode: &OflMode) -> Vec<ModeParameter<'a>> {
    let index = channel_byte_index(ofl);
    let keys = ofl.mode_channel_keys(mode);
    let listed: HashSet<&str> = keys.iter().flatten().map(String::as_str).collect();
    let mut parameters: Vec<ModeParameter<'a>> = Vec::new();
    let mut parameter_by_coarse_key = HashMap::new();

    for (position, key) in keys.iter().enumerate() {
        let Some(channel) = key.as_ref().and_then(|key| index.bytes.get(key)) else {
            continue;
        };
        let Ok(slot) = u16::try_from(position + 1) else {
            continue;
        };
        // A fine alias whose coarse channel the mode only lists through a switching
        // alias widens that switching parameter.
        let switched_coarse_key = (channel.byte > 0
            && !listed.contains(channel.coarse_key.as_str()))
        .then(|| index.aliases_by_target.get(&channel.coarse_key))
        .flatten()
        .and_then(|aliases| aliases.iter().find(|alias| listed.contains(alias.as_str())));
        let coarse_key = switched_coarse_key.unwrap_or(&channel.coarse_key);
        let parameter_index = *parameter_by_coarse_key
            .entry(coarse_key.clone())
            .or_insert_with(|| {
                parameters.push(ModeParameter {
                    coarse_key: coarse_key.clone(),
                    element: channel.element,
                    channel: channel.channel,
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
/// Plain fixtures get one "Main" element. Matrix fixtures get a "Master" element for
/// fixture-wide channels, then one element per pixel and per pixel group that the mode
/// uses. Each parameter keeps the DMX slots its channels occupy in the mode, and a
/// parameter whose mode also lists its fine aliases is widened to 16, 24 or 32 bits.
fn convert_mode_channels(ofl: &OflFixture, mode: &OflMode) -> Vec<FixtureElement> {
    let mut by_element: BTreeMap<ElementSlot, Vec<(u16, ParameterMetadata)>> = BTreeMap::new();

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
        let bytes = offsets.len() as u8;
        if let Some(metadata) = convert_channel_to_parameter(
            &parameter.coarse_key,
            parameter.channel,
            resolution,
            bytes,
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
    let group_keys: Vec<String> = ofl
        .matrix()
        .map(|matrix| matrix.pixel_groups.keys().cloned().collect())
        .unwrap_or_default();
    by_element
        .into_iter()
        .map(|(element, mut parameters)| {
            parameters.sort_by_key(|(slot, _)| *slot);
            let label = match element {
                ElementSlot::Shared if ofl.matrix().is_some() => "Master".to_string(),
                ElementSlot::Shared => "Main".to_string(),
                ElementSlot::Pixel(pixel) => pixel_labels[pixel].clone(),
                ElementSlot::Group(group) => group_keys[group].clone(),
            };
            FixtureElement {
                label,
                parameters: parameters
                    .into_iter()
                    .map(|(_, parameter)| parameter)
                    .collect(),
            }
        })
        .collect()
}

/// Returns the element label of every matrix pixel in [`OflMatrix::pixels`] order.
///
/// Matrices spanning several axes use their positions on those axes, outermost first
/// ("Pixel 2-3" for row 2, column 3); a single row or column uses its position along
/// that axis ("Pixel 7"), so a gap in the matrix leaves a gap in the numbering.
fn pixel_labels(matrix: &OflMatrix) -> Vec<String> {
    let axes = matrix.defined_axes();
    matrix
        .pixels()
        .iter()
        .map(|pixel| {
            let position: Vec<String> = axes
                .iter()
                .map(|axis| pixel.position[*axis].to_string())
                .collect();
            match position.is_empty() {
                true => "Pixel 1".to_string(),
                false => format!("Pixel {}", position.join("-")),
            }
        })
        .collect()
}

/// Returns the rotation range, in degrees, that a Pan or Tilt channel covers across
/// its DMX range: the first matching capability's start angle and the last one's end
/// angle. Returns `None` when the angles are not given in degrees.
fn position_range_degrees(channel: &OflChannel, capability_type: &str) -> Option<(f32, f32)> {
    let matching: Vec<_> = channel
        .capabilities()
        .iter()
        .filter(|capability| capability.capability_type == capability_type)
        .collect();
    let (start, _) = matching.first()?.angle_range_degrees()?;
    let (_, end) = matching.last()?.angle_range_degrees()?;
    Some((start, end))
}

/// Converts one OFL channel (plain or pixel template) to parameter metadata.
///
/// `resolution` and `dmx_slots` come from the mode layout, since OFL expresses width
/// through the fine aliases a mode lists rather than on the channel. Default and
/// highlight values are rescaled to that width, and Pan and Tilt take their degree
/// range from the capabilities' angles.
fn convert_channel_to_parameter(
    channel_key: &str,
    channel: &OflChannel,
    resolution: DmxValueResolution,
    bytes: u8,
    dmx_slots: DmxSlots,
) -> Option<ParameterMetadata> {
    let attribute = infer_attribute_from_capabilities(channel_key, channel.capabilities())?;

    let merge_type = match channel.precedence {
        Some(OflPrecedence::Htp) => MergeStrategy::HTP,
        Some(OflPrecedence::Ltp) => MergeStrategy::LTP,
        None => default_merge_strategy(&attribute),
    };

    let use_grandmaster = matches!(
        attribute,
        Attribute::Intensity | Attribute::VirtualIntensity
    );

    let position_range = match attribute {
        Attribute::Pan => position_range_degrees(channel, "Pan"),
        Attribute::Tilt => position_range_degrees(channel, "Tilt"),
        _ => None,
    };

    let mut metadata = ParameterMetadata {
        dmx_slots,
        functions: Vec::new(),
        default_dmx: channel.default_value_at(bytes),
        highlight_dmx: channel.highlight_value_at(bytes),
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        resolution,
        min: 0.0,
        max: resolution.dmx_max() as f32,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type,
        use_grandmaster,
    };
    apply_position_physical_range(&mut metadata, position_range);
    Some(metadata)
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
