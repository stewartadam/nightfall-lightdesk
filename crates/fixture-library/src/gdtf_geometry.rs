// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Owned expanded geometry, independent of mesh loading and operator element grouping.

use std::collections::HashMap;

use gdtf::geometry::{BeamGeometry, BeamType, Geometry, LampType};
use gdtf::model::{Model, PrimitiveType};
use serde::Serialize;

use crate::gdtf_resolver::{JointBinding, ResolveError, ResolvedMode, matrix_rows};

/// Authored geometry category; unsupported visual behaviors retain their distinction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum GeometryKind {
    /// Unspecified physical part.
    Generic,
    /// Articulated part; actual control axes come from joint bindings.
    Axis,
    /// Beam filter.
    FilterBeam,
    /// Color filter.
    FilterColor,
    /// Gobo filter.
    FilterGobo,
    /// Beam shaper.
    FilterShaper,
    /// Light output.
    Beam,
    /// Media layer.
    MediaServerLayer,
    /// Media camera.
    MediaServerCamera,
    /// Media master.
    MediaServerMaster,
    /// Emitting display surface.
    Display,
    /// Laser output.
    Laser,
    /// Electrical wiring object.
    WiringObject,
    /// Inventory part.
    Inventory,
    /// Structural part.
    Structure,
    /// Support part.
    Support,
    /// Magnetic attachment.
    Magnet,
}

/// Per-instance optical declarations; no fixture-wide first-beam fallback.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeamProperties {
    /// Authored output type, including glow and no-output distinctions.
    pub beam_type: BeamType,
    /// Authored light source technology.
    pub lamp_type: LampType,
    /// Electrical power in watts.
    pub power_consumption: f64,
    /// Luminous output in lumens.
    pub luminous_flux: f64,
    /// White reference in kelvin.
    pub color_temperature: f64,
    /// Half-intensity beam angle in degrees.
    pub beam_angle: f64,
    /// Ten-percent-intensity field angle in degrees.
    pub field_angle: f64,
    /// Lens throw ratio.
    pub throw_ratio: f64,
    /// Width-to-height ratio for rectangular output.
    pub rectangle_ratio: f64,
    /// Physical aperture radius in metres.
    pub beam_radius: f64,
    /// Authored color rendering index.
    pub color_rendering_index: u8,
    /// Unresolved emitter-spectrum link, retained for optical-resource compilation.
    pub emitter_spectrum: Option<String>,
}

/// Shared model declaration, separate from archive resource discovery or decoding.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledModel {
    /// Exact model identity within this definition.
    pub name: String,
    /// Primitive fallback declared by the profile.
    pub primitive: PrimitiveType,
    /// Length, width and height in metres; no axis swapping at compilation.
    pub dimensions: [f64; 3],
    /// Authored resource stem; not a filesystem path or a resolved asset URL.
    pub file: Option<String>,
}

/// One instantiated part with its authored local placement.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledGeometryNode {
    /// Structural identity independent of display text.
    pub id: String,
    /// Reference instance label where applicable.
    pub name: String,
    /// Original template label.
    pub source_name: String,
    /// Physical part category, independent of joint control semantics.
    pub kind: GeometryKind,
    /// Parent index; absent only for the selected root.
    pub parent: Option<usize>,
    /// Child indices in authored order.
    pub children: Vec<usize>,
    /// Row-major numeric rest transform in GDTF coordinates and metres.
    /// Translation occupies the fourth column; renderer conversion belongs at its loading boundary.
    pub rest: [[f64; 4]; 4],
    /// Index of the effective model after reference overrides.
    pub model: Option<usize>,
    /// Optical declarations for this emitter only.
    pub beam: Option<BeamProperties>,
}

/// Immutable selected hierarchy sharing indices with compiled channel metadata.
#[derive(Debug, Serialize)]
pub struct CompiledGeometry {
    nodes: Vec<CompiledGeometryNode>,
    models: Vec<CompiledModel>,
    joints: Vec<JointBinding>,
}

/// Report malformed geometry declarations without guessing a renderer fallback.
fn error(code: &'static str, path: &str, message: &str) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Preserve finite per-beam values without imposing visual simulation approximations.
fn compile_beam(source: &BeamGeometry, id: &str) -> Result<BeamProperties, ResolveError> {
    if [
        source.power_consumption,
        source.luminous_flux,
        source.color_temperature,
        source.beam_angle,
        source.field_angle,
        source.throw_ratio,
        source.rectangle_ratio,
        source.beam_radius,
    ]
    .iter()
    .any(|value| !value.is_finite())
    {
        return Err(error(
            "invalid_beam_properties",
            id,
            "Beam properties must be finite",
        ));
    }
    Ok(BeamProperties {
        beam_type: source.beam_type,
        lamp_type: source.lamp_type,
        power_consumption: source.power_consumption,
        luminous_flux: source.luminous_flux,
        color_temperature: source.color_temperature,
        beam_angle: source.beam_angle,
        field_angle: source.field_angle,
        throw_ratio: source.throw_ratio,
        rectangle_ratio: source.rectangle_ratio,
        beam_radius: source.beam_radius,
        color_rendering_index: source.color_rendering_index,
        emitter_spectrum: source.emitter_spectrum.as_ref().map(ToString::to_string),
    })
}

/// Copy an expanded hierarchy and bind its effective model links without retaining source objects.
pub fn compile_geometry(
    mode: &ResolvedMode<'_>,
    sources: &[Model],
    model_limit: usize,
) -> Result<CompiledGeometry, ResolveError> {
    if sources.len() > model_limit {
        return Err(error(
            "model_limit",
            &mode.name,
            "Model declarations exceed the compilation budget",
        ));
    }
    let mut indices = HashMap::new();
    let mut models = Vec::with_capacity(sources.len());
    for source in sources {
        let name = source
            .name
            .as_ref()
            .map(ToString::to_string)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                error(
                    "missing_model_name",
                    &mode.name,
                    "Model requires an exact name",
                )
            })?;
        if indices.insert(name.clone(), models.len()).is_some() {
            return Err(error(
                "duplicate_model",
                &name,
                "Model names must be unique",
            ));
        }
        let dimensions = [source.length, source.width, source.height];
        if dimensions
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(error(
                "invalid_model_dimensions",
                &name,
                "Model dimensions must be finite and nonnegative",
            ));
        }
        models.push(CompiledModel {
            name,
            primitive: source.primitive_type,
            dimensions,
            file: source.file.clone(),
        });
    }
    let mut nodes = Vec::with_capacity(mode.geometries.len());
    for node in &mode.geometries {
        let kind = match node.source {
            Geometry::Generic(_) => GeometryKind::Generic,
            Geometry::Axis(_) => GeometryKind::Axis,
            Geometry::FilterBeam(_) => GeometryKind::FilterBeam,
            Geometry::FilterColor(_) => GeometryKind::FilterColor,
            Geometry::FilterGobo(_) => GeometryKind::FilterGobo,
            Geometry::FilterShaper(_) => GeometryKind::FilterShaper,
            Geometry::Beam(_) => GeometryKind::Beam,
            Geometry::MediaServerLayer(_) => GeometryKind::MediaServerLayer,
            Geometry::MediaServerCamera(_) => GeometryKind::MediaServerCamera,
            Geometry::MediaServerMaster(_) => GeometryKind::MediaServerMaster,
            Geometry::Display(_) => GeometryKind::Display,
            Geometry::Laser(_) => GeometryKind::Laser,
            Geometry::WiringObject(_) => GeometryKind::WiringObject,
            Geometry::Inventory(_) => GeometryKind::Inventory,
            Geometry::Structure(_) => GeometryKind::Structure,
            Geometry::Support(_) => GeometryKind::Support,
            Geometry::Magnet(_) => GeometryKind::Magnet,
            Geometry::Reference(_) => {
                return Err(error(
                    "unexpanded_reference",
                    &node.id,
                    "Resolve references before compiling geometry",
                ));
            }
        };
        let model = node
            .model
            .map(|name| {
                indices.get(name.as_ref()).copied().ok_or_else(|| {
                    error(
                        "missing_model",
                        &node.id,
                        "Effective geometry model is not declared",
                    )
                })
            })
            .transpose()?;
        let beam = match node.source {
            Geometry::Beam(source) => Some(compile_beam(source, &node.id)?),
            _ => None,
        };
        nodes.push(CompiledGeometryNode {
            id: node.id.clone(),
            name: node.name.clone(),
            source_name: node.source_name.clone(),
            kind,
            parent: node.parent,
            children: node.children.clone(),
            rest: matrix_rows(node.position, &node.id)?,
            model,
            beam,
        });
    }
    Ok(CompiledGeometry {
        nodes,
        models,
        joints: mode.joints.clone(),
    })
}

impl CompiledGeometry {
    /// Inspect parent-before-child instances without mutating definition indices.
    pub fn nodes(&self) -> &[CompiledGeometryNode] {
        &self.nodes
    }
    /// Inspect model declarations; resources must still be resolved from the indexed archive.
    pub fn models(&self) -> &[CompiledModel] {
        &self.models
    }
    /// Inspect explicit channel-to-joint links, including nested or independent axes of the same type.
    pub fn joints(&self) -> &[JointBinding] {
        &self.joints
    }
}
