// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! GDTF to Fixture conversion

use std::collections::HashMap;

use gdtf::geometry::AnyGeometry;
use nightfall::prelude::Identifiers;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use uuid::Uuid;

use crate::converters::apply_position_physical_range;
use crate::gdtf_metadata::GdtfMetadata;
use crate::{FixtureLibraryError, Result};

/// Convert a GDTF fixture to a nightfall Fixture with optional geometry.
///
/// Returns a tuple of the user-configurable `Fixture` data and optionally
/// the runtime-derived geometry tree for 3D visualization.
pub fn convert_gdtf_to_fixture(
    metadata: &GdtfMetadata,
    mode_name: &str,
    id: u32,
) -> Result<(Fixture, Option<FixtureGeometry>)> {
    // Re-parse the GDTF file to access full data
    let mut gdtf = metadata.reparse()?;

    // Get the first fixture type (most GDTF files have only one)
    let fixture_type = gdtf
        .description
        .fixture_types
        .first()
        .ok_or_else(|| FixtureLibraryError::Conversion("No fixture types found".to_string()))?;

    // Find the requested DMX mode
    let dmx_mode = fixture_type
        .dmx_modes
        .iter()
        .find(|mode| {
            mode.name
                .as_ref()
                .map(|n| n.to_string() == mode_name)
                .unwrap_or(false)
        })
        .ok_or_else(|| FixtureLibraryError::ModeNotFound {
            make: metadata.manufacturer.clone(),
            model: metadata.model.clone(),
            mode: mode_name.to_string(),
        })?;

    // Group parameters by geometry to create elements, preserving GDTF channel order
    //
    // GDTF fixtures organize their physical structure as a tree of geometries.
    // Each DMX channel references a geometry name indicating which part it controls.
    // The gdtf crate's Vec<DmxChannel> preserves the XML ordering from the GDTF file.
    //
    // For simple fixtures (e.g., moving heads):
    //   - All channels may reference a single root geometry like "Yoke"
    //   - This creates a single element with all parameters
    //
    // For complex fixtures (e.g., LED bars with 100 pixels):
    //   - Each pixel is a separate geometry (e.g., "Segment4of100", "Segment5of100", ...)
    //   - Each pixel has its own RGB channels
    //   - This creates 100 elements, each with Red/Green/Blue parameters
    let mut geometry_params: HashMap<String, Vec<ParameterMetadata>> = HashMap::new();

    for channel in &dmx_mode.dmx_channels {
        let geometry_name = channel.geometry.to_string();

        // Logical channels of one DMX channel are mutually exclusive views of the
        // same bytes, so only the first becomes the output-bearing parameter.
        let Some(logical_channel) = channel.logical_channels.first() else {
            continue;
        };
        if let Some(param) =
            convert_logical_channel_to_parameter(logical_channel, channel, fixture_type)
        {
            geometry_params
                .entry(geometry_name)
                .or_default()
                .push(param);
        }
    }

    // Create elements in the order geometries first appeared in DMX channels.
    // We deduplicate geometries as we iterate through dmx_channels in order.
    let mut seen_geometries = std::collections::HashSet::new();
    let elements: Vec<FixtureElement> = dmx_mode
        .dmx_channels
        .iter()
        .map(|channel| channel.geometry.to_string())
        .filter(|name| seen_geometries.insert(name.clone()))
        .filter_map(|name| {
            geometry_params
                .remove(&name)
                .map(|parameters| FixtureElement {
                    label: name,
                    parameters,
                })
        })
        .collect();

    // Fallback: if no elements were created, create a single default element
    let elements = if elements.is_empty() {
        vec![FixtureElement {
            label: "Main".to_string(),
            parameters: vec![],
        }]
    } else {
        elements
    };

    // Extract physical properties from the first BeamGeometry found
    let physical = extract_physical_properties(fixture_type);

    // Extract geometry tree for 3D visualization
    let geometry = extract_geometry_tree(fixture_type, dmx_mode, &mut gdtf.resources, metadata);

    let fixture = Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: metadata.manufacturer.clone(),
        model: metadata.model.clone(),
        mode: mode_name.to_string(),
        elements,
        physical,
        // Coordinate system conversion is handled by convert_gdtf_matrix() which applies
        // the similarity transformation S * M * S⁻¹ to each geometry matrix
        placement: FixturePlacement::default(),
        layout: None,
        library_asset_etag: None,
    };

    Ok((fixture, geometry))
}

/// Extract geometry from a GDTF fixture for runtime materialization.
///
/// This extracts only the geometry tree without creating a full fixture,
/// useful for materializing fixtures that were loaded from a showfile.
pub fn get_gdtf_geometry(metadata: &GdtfMetadata, mode_name: &str) -> Result<FixtureGeometry> {
    // Re-parse the GDTF file to access full data
    let mut gdtf = metadata.reparse()?;

    // Get the first fixture type (most GDTF files have only one)
    let fixture_type = gdtf
        .description
        .fixture_types
        .first()
        .ok_or_else(|| FixtureLibraryError::Conversion("No fixture types found".to_string()))?;

    // Find the requested DMX mode to get element geometry names
    let dmx_mode = fixture_type
        .dmx_modes
        .iter()
        .find(|mode| {
            mode.name
                .as_ref()
                .map(|n| n.to_string() == mode_name)
                .unwrap_or(false)
        })
        .ok_or_else(|| FixtureLibraryError::ModeNotFound {
            make: metadata.manufacturer.clone(),
            model: metadata.model.clone(),
            mode: mode_name.to_string(),
        })?;

    // Extract geometry tree for 3D visualization
    extract_geometry_tree(fixture_type, dmx_mode, &mut gdtf.resources, metadata).ok_or_else(|| {
        FixtureLibraryError::Conversion("No geometry found in GDTF file".to_string())
    })
}

/// Convert a GDTF logical channel to a parameter
fn convert_logical_channel_to_parameter(
    logical_channel: &gdtf::dmx_mode::LogicalChannel,
    dmx_channel: &gdtf::dmx_mode::DmxChannel,
    fixture_type: &gdtf::fixture_type::FixtureType,
) -> Option<ParameterMetadata> {
    // Map GDTF attribute to nightfall Attribute
    let attribute = map_gdtf_attribute_to_nightfall(&logical_channel.attribute)?;

    let (resolution, dmx_slots) = gdtf_channel_slots(dmx_channel)?;

    // Determine merge strategy based on attribute
    let merge_type = match &attribute {
        Attribute::Intensity | Attribute::VirtualIntensity => MergeStrategy::HTP,
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

    let mut metadata = ParameterMetadata {
        dmx_slots,
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        resolution,
        min: 0.0,
        max,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: logical_channel.snap,
        merge_type,
        use_grandmaster,
    };
    apply_position_physical_range(
        &mut metadata,
        gdtf_position_physical_range(logical_channel, fixture_type),
    );
    Some(metadata)
}

/// Resolves a DMX channel's byte resolution and footprint slots from its GDTF `Offset` and `DMXBreak`.
///
/// Channels without an `Offset` are virtual and occupy no slots. `Overwrite`
/// breaks are supplied per geometry reference and default to break 1 here.
/// Returns `None` for offsets that cannot be represented (more than four
/// bytes, or slots outside `1..=512`).
pub(super) fn gdtf_channel_slots(
    dmx_channel: &gdtf::dmx_mode::DmxChannel,
) -> Option<(DmxValueResolution, DmxSlots)> {
    let Some(offsets) = &dmx_channel.offset else {
        return Some((DmxValueResolution::Coarse, DmxSlots::Virtual));
    };
    let resolution = match offsets.len() {
        1 => DmxValueResolution::Coarse,
        2 => DmxValueResolution::Fine,
        3 => DmxValueResolution::UltraFine,
        4 => DmxValueResolution::Uber,
        _ => return None,
    };
    let offsets = offsets
        .iter()
        .map(|offset| {
            u16::try_from(*offset)
                .ok()
                .filter(|slot| (1..=512).contains(slot))
        })
        .collect::<Option<Vec<u16>>>()?;
    let dmx_break = match dmx_channel.dmx_break {
        gdtf::dmx_mode::DmxBreak::Value(value) => u16::try_from(value).ok()?.max(1),
        gdtf::dmx_mode::DmxBreak::Overwrite => 1,
    };
    Some((resolution, DmxSlots::Explicit { dmx_break, offsets }))
}

/// Resolve an angular physical range from a GDTF logical channel.
fn gdtf_position_physical_range(
    logical_channel: &gdtf::dmx_mode::LogicalChannel,
    fixture_type: &gdtf::fixture_type::FixtureType,
) -> Option<(f32, f32)> {
    let [function] = logical_channel.channel_functions.as_slice() else {
        return None;
    };
    let physical_unit = function.attribute(fixture_type)?.physical_unit;
    if physical_unit != gdtf::attribute::PhysicalUnit::Angle
        || function.dmx_from.value() != 0
        || function.dmx_profile.is_some()
    {
        return None;
    }

    Some((function.physical_from as f32, function.physical_to as f32))
}

/// Map GDTF attribute name to nightfall Attribute
///
/// TODO: Implement mappings for all GDTF-supported attributes, per spec:
/// https://github.com/mvrdevelopment/spec/blob/main/gdtf-spec.md#annex-a-normative-attribute-definitions
pub(super) fn map_gdtf_attribute_to_nightfall(
    attr_node: &impl std::fmt::Display,
) -> Option<Attribute> {
    // Extract attribute name from Node by converting to string and taking last component
    // Node contains a path like "ColorAdd.R", we want the last part
    let attr_string = attr_node.to_string();
    let attr_name = attr_string.split('.').next_back()?;

    // Map GDTF attribute names to nightfall attributes
    match attr_name {
        // Intensity
        "Dimmer" => Some(Attribute::Intensity),

        // Color mixing
        "ColorAdd_R" | "ColorRGB_Red" => Some(Attribute::Red),
        "ColorAdd_G" | "ColorRGB_Green" => Some(Attribute::Green),
        "ColorAdd_B" | "ColorRGB_Blue" => Some(Attribute::Blue),
        "ColorAdd_C" | "ColorRGB_Cyan" => Some(Attribute::Cyan),
        "ColorAdd_M" | "ColorRGB_Magenta" => Some(Attribute::Magenta),
        "ColorAdd_Y" | "ColorRGB_Yellow" => Some(Attribute::Yellow),
        "ColorAdd_W" => Some(Attribute::White),
        "ColorAdd_WW" => Some(Attribute::WarmWhite),
        "ColorAdd_CW" => Some(Attribute::CoolWhite),
        "ColorAdd_UV" => Some(Attribute::UV),
        "ColorAdd_Amber" => Some(Attribute::Amber),

        // Position
        "Pan" => Some(Attribute::Pan),
        "Tilt" => Some(Attribute::Tilt),

        // Beam
        "Zoom" => Some(Attribute::Zoom),
        "Gobo1" | "Gobo" => Some(Attribute::Gobo),
        "Gobo1Rot" | "GoboRot" => Some(Attribute::GoboRot),
        "Prism1" | "Prism" => Some(Attribute::Prism),
        "Frost1" | "Frost" => Some(Attribute::Frost),

        // Shutter/Strobe
        "Shutter1" | "Shutter" => Some(Attribute::StrobeShutter),
        "Shutter1Strobe" | "ShutterStrobe" => Some(Attribute::StrobeShutter),
        "Shutter1StrobeRandom" => Some(Attribute::StrobeShutter),
        "StrobeRate" => Some(Attribute::StrobeRate),

        // For unknown attributes, create a custom attribute
        _ => Some(Attribute::Custom {
            label: attr_name.to_string(),
        }),
    }
}

/// Extract physical properties from GDTF fixture type
///
/// Searches the geometry tree for BeamGeometry instances and extracts physical
/// properties like beam angles, lumens, and color temperature.
fn extract_physical_properties(
    fixture_type: &gdtf::fixture_type::FixtureType,
) -> Option<FixturePhysical> {
    // Find the first BeamGeometry in the geometry tree
    let beam_geometry = find_beam_geometry(&fixture_type.geometries)?;

    // Convert GDTF beam type to nightfall beam type
    let beam_type = map_gdtf_beam_type(&beam_geometry.beam_type);

    // Extract physical properties
    Some(FixturePhysical {
        beam_angle: beam_geometry.beam_angle as f32,
        field_angle: beam_geometry.field_angle as f32,
        lumens: if beam_geometry.luminous_flux > 0.0 {
            Some(beam_geometry.luminous_flux as f32)
        } else {
            None
        },
        color_temperature: if beam_geometry.color_temperature > 0.0 {
            Some(beam_geometry.color_temperature as f32)
        } else {
            None
        },
        beam_type,
    })
}

/// Recursively search for a BeamGeometry in the geometry tree
fn find_beam_geometry(
    geometries: &[gdtf::geometry::Geometry],
) -> Option<&gdtf::geometry::BeamGeometry> {
    use gdtf::geometry::{AnyGeometry, Geometry};

    for geom in geometries {
        match geom {
            Geometry::Beam(beam) => return Some(beam),
            _ => {
                // Recursively search children
                if let Some(beam) = find_beam_geometry(geom.children()) {
                    return Some(beam);
                }
            }
        }
    }
    None
}

/// Map GDTF BeamType to nightfall BeamType
pub(super) fn map_gdtf_beam_type(gdtf_beam_type: &gdtf::geometry::BeamType) -> BeamType {
    use gdtf::geometry::BeamType as GdtfBeamType;

    match gdtf_beam_type {
        GdtfBeamType::Spot => BeamType::Spot,
        GdtfBeamType::Wash => BeamType::Wash,
        GdtfBeamType::Fresnel => BeamType::Fresnel,
        GdtfBeamType::Pc => BeamType::Pc,
        // Glow, Rectangle, and None are pixel/LED fixtures that shouldn't render spotlights
        GdtfBeamType::Glow | GdtfBeamType::Rectangle | GdtfBeamType::None => BeamType::Glow,
    }
}

/// Check if a GDTF attribute controls light emission (color or intensity).
///
/// Emitter attributes are those that affect what light comes out of a beam:
/// - Color mixing (RGB, CMY, White variants, UV, Amber)
/// - Intensity/Dimmer
///
/// Non-emitter attributes control other aspects:
/// - Position (Pan, Tilt)
/// - Beam shaping (Zoom, Focus, Iris)
/// - Effects (Gobo, Prism, Frost)
/// - Strobe/Shutter
fn is_emitter_attribute(attr_name: &str) -> bool {
    // Extract the final attribute name from paths like "ColorAdd.R"
    let attr = attr_name.split('.').next_back().unwrap_or(attr_name);

    matches!(
        attr,
        // Intensity
        "Dimmer"
            // Additive color mixing (RGB, White variants)
            | "ColorAdd_R"
            | "ColorAdd_G"
            | "ColorAdd_B"
            | "ColorAdd_W"
            | "ColorAdd_WW"
            | "ColorAdd_CW"
            | "ColorAdd_UV"
            | "ColorAdd_Amber"
            | "ColorAdd_C"
            | "ColorAdd_M"
            | "ColorAdd_Y"
            // RGB color (alternative naming)
            | "ColorRGB_Red"
            | "ColorRGB_Green"
            | "ColorRGB_Blue"
            | "ColorRGB_Cyan"
            | "ColorRGB_Magenta"
            | "ColorRGB_Yellow"
    )
}

/// Check if a DMX channel has any emitter attributes (color or intensity).
fn channel_has_emitter_attributes(channel: &gdtf::dmx_mode::DmxChannel) -> bool {
    channel.logical_channels.iter().any(|lc| {
        let attr_str = lc.attribute.to_string();
        is_emitter_attribute(&attr_str)
    })
}

/// Collect all beam names that are descendants of a geometry node.
fn collect_descendant_beam_names(geom: &gdtf::geometry::Geometry, beam_names: &mut Vec<String>) {
    use gdtf::geometry::Geometry;

    if let Geometry::Beam(_) = geom {
        if let Some(name) = geom.name() {
            beam_names.push(name.to_string());
        }
    }

    for child in geom.children() {
        collect_descendant_beam_names(child, beam_names);
    }
}

/// Find a geometry by name in the geometry tree.
fn find_geometry_by_name<'a>(
    geometries: &'a [gdtf::geometry::Geometry],
    name: &str,
) -> Option<&'a gdtf::geometry::Geometry> {
    for geom in geometries {
        if let Some(found) = find_geometry_by_name_recursive(geom, name) {
            return Some(found);
        }
    }
    None
}

fn find_geometry_by_name_recursive<'a>(
    geom: &'a gdtf::geometry::Geometry,
    name: &str,
) -> Option<&'a gdtf::geometry::Geometry> {
    if geom.name().map(|n| n.as_ref() == name).unwrap_or(false) {
        return Some(geom);
    }
    for child in geom.children() {
        if let Some(found) = find_geometry_by_name_recursive(child, name) {
            return Some(found);
        }
    }
    None
}

/// Build a mapping from beam names to their controlling element geometry.
///
/// For each DMX channel with emitter attributes, find all beam descendants
/// and map them to the channel's geometry. If a beam is controlled by multiple
/// geometries, the most specific one (deepest in hierarchy) wins.
///
/// Returns a HashMap where:
/// - Key: beam name (e.g., "Pixel 1")
/// - Value: element geometry name that controls this beam's color/intensity
fn build_beam_to_element_mapping(
    dmx_mode: &gdtf::dmx_mode::DmxMode,
    geometries: &[gdtf::geometry::Geometry],
) -> HashMap<String, String> {
    // First pass: collect all (beam_name, element_name, depth) tuples
    // where depth is how deep the element geometry is in the tree
    let mut beam_candidates: HashMap<String, Vec<(String, usize)>> = HashMap::new();

    for channel in &dmx_mode.dmx_channels {
        // Only consider channels with emitter attributes
        if !channel_has_emitter_attributes(channel) {
            continue;
        }

        let element_name = channel.geometry.to_string();

        // Find this geometry in the tree
        if let Some(geom) = find_geometry_by_name(geometries, &element_name) {
            // Calculate depth of this geometry
            let depth = calculate_geometry_depth(geometries, &element_name);

            // Collect all beam descendants
            let mut beam_names = Vec::new();
            collect_descendant_beam_names(geom, &mut beam_names);

            for beam_name in beam_names {
                beam_candidates
                    .entry(beam_name)
                    .or_default()
                    .push((element_name.clone(), depth));
            }
        }
    }

    // Second pass: for each beam, pick the most specific (deepest) element
    let mut result = HashMap::new();
    for (beam_name, candidates) in beam_candidates {
        if let Some((element_name, _)) = candidates.into_iter().max_by_key(|(_, depth)| *depth) {
            result.insert(beam_name, element_name);
        }
    }

    result
}

/// Calculate the depth of a geometry in the tree (0 = root level).
fn calculate_geometry_depth(geometries: &[gdtf::geometry::Geometry], name: &str) -> usize {
    for geom in geometries {
        if let Some(depth) = calculate_geometry_depth_recursive(geom, name, 0) {
            return depth;
        }
    }
    0
}

fn calculate_geometry_depth_recursive(
    geom: &gdtf::geometry::Geometry,
    name: &str,
    current_depth: usize,
) -> Option<usize> {
    if geom.name().map(|n| n.as_ref() == name).unwrap_or(false) {
        return Some(current_depth);
    }
    for child in geom.children() {
        if let Some(depth) = calculate_geometry_depth_recursive(child, name, current_depth + 1) {
            return Some(depth);
        }
    }
    None
}

/// Extract geometry tree from GDTF fixture type for 3D visualization
fn extract_geometry_tree(
    fixture_type: &gdtf::fixture_type::FixtureType,
    dmx_mode: &gdtf::dmx_mode::DmxMode,
    resources: &mut gdtf::ResourceMap,
    metadata: &GdtfMetadata,
) -> Option<FixtureGeometry> {
    if fixture_type.geometries.is_empty() {
        return None;
    }

    // Build model lookup from fixture type
    let models: HashMap<&str, &gdtf::model::Model> = fixture_type
        .models
        .iter()
        .filter_map(|m| m.name.as_ref().map(|n| (n.as_ref(), m)))
        .collect();

    // Build the beam→element mapping based on DMX channels with emitter attributes.
    // This ensures beams are only mapped to elements that control their color/intensity,
    // and that each beam maps to its most specific controlling element.
    let beam_to_element = build_beam_to_element_mapping(dmx_mode, &fixture_type.geometries);

    let mut nodes = Vec::new();
    let mut roots: Vec<u32> = Vec::new();
    let mut mesh_resources = HashMap::new();

    // Process all root geometries
    for root_geom in &fixture_type.geometries {
        let root_index = traverse_geometry(
            root_geom,
            -1,
            &mut nodes,
            &models,
            &mut mesh_resources,
            resources,
            &beam_to_element,
        );
        roots.push(root_index as u32);
    }

    if nodes.is_empty() {
        return None;
    }

    Some(FixtureGeometry {
        nodes,
        roots,
        mesh_resources,
        gdtf_path: Some(metadata.file_path.to_string_lossy().to_string()),
    })
}

/// Recursively traverse a geometry node and its children.
///
/// Builds the geometry tree by traversing the GDTF geometry hierarchy.
///
/// # Arguments
///
/// * `beam_to_element` - Pre-computed mapping from beam names to their controlling element.
///   This mapping is built by `build_beam_to_element_mapping` which ensures that:
///   - Only beams controlled by DMX channels with emitter attributes (color/intensity) are included
///   - Each beam maps to its most specific (deepest in hierarchy) controlling element
///
/// # Side Effects
///
/// This function modifies several mutable parameters:
/// - `nodes`: Appends new [`GeometryNode`] entries for each traversed geometry
/// - `mesh_resources`: Populated with mesh resource entries when models reference mesh files
/// - `resources`: GDTF resource map may be read from to extract mesh availability info
///
/// # Returns
///
/// The index of the newly created node in the `nodes` vector.
fn traverse_geometry(
    geom: &gdtf::geometry::Geometry,
    parent_index: i32,
    nodes: &mut Vec<GeometryNode>,
    models: &HashMap<&str, &gdtf::model::Model>,
    mesh_resources: &mut HashMap<String, MeshResource>,
    resources: &mut gdtf::ResourceMap,
    beam_to_element: &HashMap<String, String>,
) -> usize {
    use gdtf::geometry::Geometry;

    let node_index = nodes.len();

    // Determine geometry type and axis info
    let (geometry_type, axis) = match geom {
        Geometry::Axis(_) => {
            // Try to determine axis type from name
            let name = geom.name().map(|n| n.to_string()).unwrap_or_default();
            let name_lower = name.to_lowercase();
            let axis_type = if name_lower.contains("yoke") || name_lower.contains("pan") {
                Some(AxisType::Pan)
            } else if name_lower.contains("head") || name_lower.contains("tilt") {
                Some(AxisType::Tilt)
            } else {
                None
            };
            (GeometryType::Axis, axis_type)
        }
        Geometry::Beam(_) => (GeometryType::Beam, None),
        Geometry::Reference(_) => (GeometryType::Reference, None),
        Geometry::FilterBeam(_) => (GeometryType::FilterBeam, None),
        Geometry::FilterColor(_) => (GeometryType::FilterColor, None),
        Geometry::FilterGobo(_) => (GeometryType::FilterGobo, None),
        Geometry::Display(_) => (GeometryType::Display, None),
        Geometry::Generic(_) => (GeometryType::Generic, None),
        _ => (GeometryType::Generic, None),
    };

    // Get position matrix and convert to our Transform format
    let transform = convert_gdtf_matrix(geom);

    // Get model if present
    let model = geom.model_name().and_then(|model_name| {
        models.get(model_name.as_ref()).map(|m| {
            // Check for mesh resources
            if let Some(file) = &m.file {
                check_mesh_resource(file, resources, mesh_resources);
            }

            GeometryModel {
                name: model_name.to_string(),
                primitive_type: convert_primitive_type(&m.primitive_type),
                length: m.length as f32,
                width: m.width as f32,
                height: m.height as f32,
                mesh_file: m.file.clone(),
            }
        })
    });

    let node_name = geom.name().map(|n| n.to_string()).unwrap_or_default();

    // For Beam nodes, look up the element name from the pre-computed mapping.
    // This mapping only includes beams that are controlled by DMX channels with
    // emitter attributes (color/intensity), so beams not in the mapping will
    // have controlled_element = None and won't be rendered.
    let controlled_element = match geometry_type {
        GeometryType::Beam => beam_to_element.get(&node_name).cloned(),
        _ => None,
    };

    nodes.push(GeometryNode {
        name: node_name.clone(),
        geometry_type,
        transform,
        model,
        axis,
        parent_index,
        children: Vec::new(),
        controlled_element,
    });

    // Recursively process children
    let child_indices: Vec<u32> = geom
        .children()
        .iter()
        .map(|child| {
            traverse_geometry(
                child,
                node_index as i32,
                nodes,
                models,
                mesh_resources,
                resources,
                beam_to_element,
            ) as u32
        })
        .collect();

    // Update node with child indices
    nodes[node_index].children = child_indices;

    node_index
}

/// Convert GDTF position matrix to column-major Transform for Three.js.
///
/// This function passes through the GDTF matrix as-is, only converting from
/// row-major to column-major format for Three.js. Coordinate system conversion
/// (GDTF Z-up to Three.js Y-up) is handled in the frontend.
fn convert_gdtf_matrix(geom: &gdtf::geometry::Geometry) -> Transform {
    use gdtf::geometry::Geometry;

    // Get the position matrix from the geometry
    let matrix = match geom {
        Geometry::Generic(g) => &g.position,
        Geometry::Axis(g) => &g.position,
        Geometry::Beam(g) => &g.position,
        Geometry::FilterBeam(g) => &g.position,
        Geometry::FilterColor(g) => &g.position,
        Geometry::FilterGobo(g) => &g.position,
        Geometry::FilterShaper(g) => &g.position,
        Geometry::Display(g) => &g.position,
        Geometry::Reference(g) => &g.position,
        Geometry::MediaServerLayer(g) => &g.position,
        Geometry::MediaServerCamera(g) => &g.position,
        Geometry::MediaServerMaster(g) => &g.position,
        Geometry::Laser(g) => &g.position,
        Geometry::WiringObject(g) => &g.position,
        Geometry::Inventory(g) => &g.position,
        Geometry::Structure(g) => &g.position,
        Geometry::Support(g) => &g.position,
        Geometry::Magnet(g) => &g.position,
    };

    // GDTF Matrix has private inner data, so we serialize it to extract values.
    // Format: "{a,b,c,d}{e,f,g,h}{i,j,k,l}{m,n,o,p}" (4 rows of 4 values each)
    let m = parse_gdtf_matrix_string(matrix);

    // GDTF Matrix is row-major with translation in column 3:
    // m[row][col] where m[i][3] is translation
    //
    // Pass through as-is, only converting from row-major to column-major.
    // Three.js column-major: elements[col*4 + row]
    Transform {
        elements: [
            // Column 0
            m[0][0] as f32,
            m[1][0] as f32,
            m[2][0] as f32,
            0.0,
            // Column 1
            m[0][1] as f32,
            m[1][1] as f32,
            m[2][1] as f32,
            0.0,
            // Column 2
            m[0][2] as f32,
            m[1][2] as f32,
            m[2][2] as f32,
            0.0,
            // Column 3 (translation)
            m[0][3] as f32,
            m[1][3] as f32,
            m[2][3] as f32,
            1.0,
        ],
    }
}

/// Parse GDTF Matrix serialized string into a 4x4 array
///
/// Matrix serializes to "{a,b,c,d}{e,f,g,h}{i,j,k,l}{m,n,o,p}"
fn parse_gdtf_matrix_string(matrix: &gdtf::values::Matrix) -> [[f64; 4]; 4] {
    // Serialize the matrix to its string format (serde_json uses the Serialize impl)
    let serialized = serde_json::to_string(matrix).unwrap_or_default();
    // Remove surrounding quotes from JSON string
    let s = serialized.trim_matches('"');

    let mut result = [[0.0f64; 4]; 4];

    // Parse "{a,b,c,d}{e,f,g,h}{i,j,k,l}{m,n,o,p}"
    let rows: Vec<&str> = s.split('{').filter(|s| !s.is_empty()).collect();
    for (row_idx, row_str) in rows.iter().enumerate() {
        if row_idx >= 4 {
            break;
        }
        let row_clean = row_str.trim_end_matches('}');
        let values: Vec<&str> = row_clean.split(',').collect();
        for (col_idx, val_str) in values.iter().enumerate() {
            if col_idx >= 4 {
                break;
            }
            result[row_idx][col_idx] = val_str.parse().unwrap_or(0.0);
        }
    }

    result
}

/// Check if mesh resources exist and register them
fn check_mesh_resource(
    file_name: &str,
    resources: &mut gdtf::ResourceMap,
    mesh_resources: &mut HashMap<String, MeshResource>,
) {
    // Try GLB first (preferred format)
    if resources
        .read_model_mesh(
            file_name,
            gdtf::Model3Format::Gltf,
            gdtf::Model3Detail::Default,
        )
        .is_ok()
    {
        mesh_resources.insert(
            file_name.to_string(),
            MeshResource {
                format: MeshFormat::Glb,
                path: format!("models/gltf/{}.glb", file_name),
            },
        );
    } else if resources
        .read_model_mesh(
            file_name,
            gdtf::Model3Format::Max3ds,
            gdtf::Model3Detail::Default,
        )
        .is_ok()
    {
        mesh_resources.insert(
            file_name.to_string(),
            MeshResource {
                format: MeshFormat::Max3ds,
                path: format!("models/3ds/{}.3ds", file_name),
            },
        );
    }
}

/// Convert GDTF PrimitiveType to our PrimitiveType
fn convert_primitive_type(pt: &gdtf::model::PrimitiveType) -> PrimitiveType {
    use gdtf::model::PrimitiveType as GdtfPrimitive;

    match pt {
        GdtfPrimitive::Cube => PrimitiveType::Cube,
        GdtfPrimitive::Cylinder => PrimitiveType::Cylinder,
        GdtfPrimitive::Sphere => PrimitiveType::Sphere,
        GdtfPrimitive::Base => PrimitiveType::Base,
        GdtfPrimitive::Yoke => PrimitiveType::Yoke,
        GdtfPrimitive::Head => PrimitiveType::Head,
        GdtfPrimitive::Scanner => PrimitiveType::Scanner,
        GdtfPrimitive::Conventional => PrimitiveType::Conventional,
        GdtfPrimitive::Pigtail => PrimitiveType::Pigtail,
        GdtfPrimitive::Base1_1 => PrimitiveType::Base1_1,
        GdtfPrimitive::Scanner1_1 => PrimitiveType::Scanner1_1,
        GdtfPrimitive::Conventional1_1 => PrimitiveType::Conventional1_1,
        GdtfPrimitive::Undefined => PrimitiveType::Undefined,
    }
}
