// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! GDTF to Fixture conversion

use std::collections::HashMap;

use gdtf::geometry::Geometry;
use nightfall::prelude::Identifiers;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use uuid::Uuid;

use super::gdtf_resolve::{ResolvedChannel, ResolvedMode};
use crate::converters::apply_position_physical_range;
use crate::gdtf_metadata::GdtfMetadata;
use crate::{FixtureLibraryError, Result};

/// Fixture data converted from one GDTF DMX mode.
#[derive(Debug, Clone)]
pub struct ConvertedGdtfMode {
    /// Operator-facing fixture with elements and parameters.
    pub fixture: Fixture,
    /// Geometry tree for visualization, when the fixture type has geometry.
    pub geometry: Option<FixtureGeometry>,
    /// Problems found while resolving the mode.
    pub diagnostics: Vec<super::gdtf_resolve::GdtfDiagnostic>,
}

/// Convert a GDTF fixture to a nightfall Fixture with optional geometry.
///
/// Returns a tuple of the user-configurable `Fixture` data and optionally
/// the runtime-derived geometry tree for 3D visualization.
pub fn convert_gdtf_to_fixture(
    metadata: &GdtfMetadata,
    mode_name: &str,
    id: u32,
) -> Result<(Fixture, Option<FixtureGeometry>)> {
    let mut gdtf = metadata.reparse()?;
    let converted = convert_gdtf_mode(&mut gdtf, metadata, mode_name, id)?;
    for diagnostic in &converted.diagnostics {
        tracing::warn!(
            make = %metadata.manufacturer,
            model = %metadata.model,
            mode = mode_name,
            ?diagnostic,
            "GDTF mode resolved with a diagnostic"
        );
    }
    Ok((converted.fixture, converted.geometry))
}

/// Extract geometry from a GDTF fixture for runtime materialization.
///
/// This extracts only the geometry tree without creating a full fixture,
/// useful for materializing fixtures that were loaded from a showfile.
pub fn get_gdtf_geometry(metadata: &GdtfMetadata, mode_name: &str) -> Result<FixtureGeometry> {
    let mut gdtf = metadata.reparse()?;
    convert_gdtf_mode(&mut gdtf, metadata, mode_name, 0)?
        .geometry
        .ok_or_else(|| {
            FixtureLibraryError::Conversion("No geometry found in GDTF file".to_string())
        })
}

/// Converts one DMX mode of a parsed archive, resolving the mode exactly once.
///
/// Elements are geometry instances in the order their first channel appears
/// in the mode. Channels declared on a referenced template geometry produce
/// one parameter per reference instance, placed at the reference's offsets.
pub fn convert_gdtf_mode(
    gdtf: &mut gdtf::GdtfFile,
    metadata: &GdtfMetadata,
    mode_name: &str,
    id: u32,
) -> Result<ConvertedGdtfMode> {
    let fixture_type = gdtf
        .description
        .fixture_types
        .first()
        .ok_or_else(|| FixtureLibraryError::Conversion("No fixture types found".to_string()))?;

    let dmx_mode = fixture_type
        .dmx_modes
        .iter()
        .find(|mode| mode.name.as_ref().map(|n| n.as_ref()) == Some(mode_name))
        .ok_or_else(|| FixtureLibraryError::ModeNotFound {
            make: metadata.manufacturer.clone(),
            model: metadata.model.clone(),
            mode: mode_name.to_string(),
        })?;

    let Some(resolved) = ResolvedMode::new(fixture_type, dmx_mode) else {
        let fixture = build_fixture(metadata, mode_name, id, Vec::new(), None);
        return Ok(ConvertedGdtfMode {
            fixture,
            geometry: None,
            diagnostics: Vec::new(),
        });
    };

    let elements = build_elements(&resolved, fixture_type);
    let physical = extract_physical_properties(&resolved);
    let geometry = build_geometry_tree(&resolved, fixture_type, &mut gdtf.resources, metadata);
    let fixture = build_fixture(metadata, mode_name, id, elements, physical);

    Ok(ConvertedGdtfMode {
        fixture,
        geometry: Some(geometry),
        diagnostics: resolved.diagnostics,
    })
}

/// Assembles the operator-facing fixture record.
fn build_fixture(
    metadata: &GdtfMetadata,
    mode_name: &str,
    id: u32,
    elements: Vec<FixtureElement>,
    physical: Option<FixturePhysical>,
) -> Fixture {
    let elements = if elements.is_empty() {
        vec![FixtureElement {
            label: "Main".to_string(),
            parameters: vec![],
        }]
    } else {
        elements
    };
    Fixture {
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
        placement: FixturePlacement::default(),
        layout: None,
        library_asset_etag: None,
    }
}

/// Groups resolved channels into one element per geometry instance, in first-channel order.
fn build_elements(
    resolved: &ResolvedMode<'_>,
    fixture_type: &gdtf::fixture_type::FixtureType,
) -> Vec<FixtureElement> {
    let mut element_by_instance: HashMap<usize, usize> = HashMap::new();
    let mut elements: Vec<FixtureElement> = Vec::new();
    for channel in &resolved.channels {
        let Some(parameter) = convert_channel_to_parameter(channel, fixture_type) else {
            continue;
        };
        let element = *element_by_instance
            .entry(channel.instance)
            .or_insert_with(|| {
                elements.push(FixtureElement {
                    label: resolved.instances[channel.instance].name.clone(),
                    parameters: Vec::new(),
                });
                elements.len() - 1
            });
        elements[element].parameters.push(parameter);
    }
    elements
}

/// Converts a resolved DMX channel's first logical channel to a parameter.
///
/// Logical channels of one DMX channel are mutually exclusive views of the
/// same bytes, so only the first becomes the output-bearing parameter.
fn convert_channel_to_parameter(
    resolved: &ResolvedChannel<'_>,
    fixture_type: &gdtf::fixture_type::FixtureType,
) -> Option<ParameterMetadata> {
    let logical_channel = resolved.channel.logical_channels.first()?;
    let attribute = map_gdtf_attribute_to_nightfall(&logical_channel.attribute)?;
    let (resolution, dmx_slots) = resolved_channel_slots(resolved)?;

    let merge_type = match &attribute {
        Attribute::Intensity | Attribute::VirtualIntensity => MergeStrategy::HTP,
        _ => MergeStrategy::LTP,
    };
    let use_grandmaster = matches!(
        attribute,
        Attribute::Intensity | Attribute::VirtualIntensity
    );

    let mut metadata = ParameterMetadata {
        dmx_slots,
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        resolution,
        min: 0.0,
        max: nightfall_fixtures::wire_layout::dmx_max(resolution) as ParameterDmxValue,
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

/// Resolves a channel's byte resolution and footprint slots from its resolved offsets and break.
///
/// Channels without an `Offset` are virtual and occupy no slots. Returns
/// `None` for offsets that cannot be represented (more than four bytes, or
/// slots outside `1..=512`).
pub(super) fn resolved_channel_slots(
    resolved: &ResolvedChannel<'_>,
) -> Option<(DmxValueResolution, DmxSlots)> {
    let Some(offsets) = &resolved.offsets else {
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
    Some((
        resolution,
        DmxSlots::Explicit {
            dmx_break: resolved.dmx_break,
            offsets,
        },
    ))
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

/// Extracts beam physical properties from the first beam instance in the mode.
fn extract_physical_properties(resolved: &ResolvedMode<'_>) -> Option<FixturePhysical> {
    let beam = resolved
        .instances
        .iter()
        .find_map(|instance| match instance.geometry {
            Geometry::Beam(beam) => Some(beam),
            _ => None,
        })?;

    Some(FixturePhysical {
        beam_angle: beam.beam_angle as f32,
        field_angle: beam.field_angle as f32,
        lumens: (beam.luminous_flux > 0.0).then_some(beam.luminous_flux as f32),
        color_temperature: (beam.color_temperature > 0.0).then_some(beam.color_temperature as f32),
        beam_type: map_gdtf_beam_type(&beam.beam_type),
    })
}

/// Returns, for every instance, the element label controlling its emitted light.
///
/// A beam is controlled by the nearest ancestor-or-self instance that has an
/// emitter (dimmer or color) channel.
fn emitter_owners(resolved: &ResolvedMode<'_>) -> Vec<Option<String>> {
    let mut has_emitter = vec![false; resolved.instances.len()];
    for channel in &resolved.channels {
        if channel
            .channel
            .logical_channels
            .iter()
            .any(|logical| is_emitter_attribute(&logical.attribute.to_string()))
        {
            has_emitter[channel.instance] = true;
        }
    }

    let mut owners: Vec<Option<String>> = vec![None; resolved.instances.len()];
    for (index, instance) in resolved.instances.iter().enumerate() {
        // Instances are in depth-first order, so parents are resolved first.
        owners[index] = if has_emitter[index] {
            Some(instance.name.clone())
        } else {
            instance.parent.and_then(|parent| owners[parent].clone())
        };
    }
    owners
}

/// Builds the visualization geometry tree from resolved instances.
fn build_geometry_tree(
    resolved: &ResolvedMode<'_>,
    fixture_type: &gdtf::fixture_type::FixtureType,
    resources: &mut gdtf::ResourceMap,
    metadata: &GdtfMetadata,
) -> FixtureGeometry {
    let models: HashMap<&str, &gdtf::model::Model> = fixture_type
        .models
        .iter()
        .filter_map(|m| m.name.as_ref().map(|n| (n.as_ref(), m)))
        .collect();
    let owners = emitter_owners(resolved);
    let mut mesh_resources = HashMap::new();

    let nodes = resolved
        .instances
        .iter()
        .enumerate()
        .map(|(index, instance)| {
            let (geometry_type, axis) = geometry_kind(instance.geometry, &instance.name);
            let model = instance
                .model
                .and_then(|name| models.get(name))
                .map(|model| {
                    if let Some(file) = &model.file {
                        check_mesh_resource(file, resources, &mut mesh_resources);
                    }
                    GeometryModel {
                        name: instance.model.unwrap_or_default().to_string(),
                        primitive_type: convert_primitive_type(&model.primitive_type),
                        length: model.length as f32,
                        width: model.width as f32,
                        height: model.height as f32,
                        mesh_file: model.file.clone(),
                    }
                });
            GeometryNode {
                name: instance.name.clone(),
                geometry_type,
                transform: convert_gdtf_matrix(instance.placement),
                model,
                axis,
                parent_index: instance.parent.map_or(-1, |parent| parent as i32),
                children: instance
                    .children
                    .iter()
                    .map(|child| *child as u32)
                    .collect(),
                controlled_element: match geometry_type {
                    GeometryType::Beam => owners[index].clone(),
                    _ => None,
                },
            }
        })
        .collect();

    FixtureGeometry {
        nodes,
        roots: vec![0],
        mesh_resources,
        gdtf_path: Some(metadata.file_path.to_string_lossy().to_string()),
    }
}

/// Maps a GDTF geometry variant to a node type and, for axes, a name-inferred axis type.
fn geometry_kind(geometry: &Geometry, name: &str) -> (GeometryType, Option<AxisType>) {
    match geometry {
        Geometry::Axis(_) => {
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
        _ => (GeometryType::Generic, None),
    }
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
