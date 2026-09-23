// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Pure source-resolution pass for the GDTF mode compiler.
//!
//! Instances borrow the parsed description, retaining complete source semantics
//! for subsequent control/wire compilation. This is not the persisted definition
//! or the browser transport contract. IDs are deterministic within a pinned mode;
//! source names are labels and link targets, never instance identities.

use std::collections::HashMap;

use gdtf::dmx_mode::{DmxChannel, DmxMode};
use gdtf::fixture_type::FixtureType;
use gdtf::geometry::{AnyGeometry, Geometry, ReferenceGeometry};
use gdtf::values::{Matrix, Name};
use nightfall_fixtures::geometry::AxisType;
use serde::Serialize;

/// Bound source traversal, reference expansion, and instantiated controls independently.
#[derive(Debug, Clone, Copy)]
pub struct ResolveLimits {
    /// Maximum hierarchy/reference depth, including template expansion edges.
    pub depth: usize,
    /// Maximum expanded geometry instances per mode.
    pub geometries: usize,
    /// Maximum instantiated physical or virtual channels per mode.
    pub channels: usize,
}

impl Default for ResolveLimits {
    /// Allow large pixel fixtures while bounding recursive expansion and allocations.
    fn default() -> Self {
        Self {
            depth: 128,
            geometries: 100_000,
            channels: 500_000,
        }
    }
}

/// A source fault or bounded-work failure with a stable machine-readable category.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{code} at {path}: {message}")]
pub struct ResolveError {
    /// Category independent of vendor labels and display text.
    pub code: &'static str,
    /// Mode or geometry instance path at which resolution failed.
    pub path: String,
    /// Actionable detail retained in corpus reports.
    pub message: String,
}

/// One instantiated part; a reference replaces its template root's placement/model.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryInstance<'a> {
    /// Deterministic structural path, independent of geometry display names.
    pub id: String,
    /// Human-readable instance label (the reference name where instantiated).
    pub name: String,
    /// Name of the authored template/source node.
    pub source_name: String,
    /// Parent instance index; only the selected mode root has no parent.
    pub parent: Option<usize>,
    /// Child instance indices in authored order.
    pub children: Vec<usize>,
    /// Effective local rest transform in unchanged GDTF coordinates and metres.
    pub position: Matrix,
    /// Effective model after the reference root's optional override.
    pub model: Option<&'a Name>,
    /// Authored node including emitter properties and other type-specific information.
    #[serde(skip)]
    pub source: &'a Geometry,
    /// Reference roots replaced by this instance, retaining channel link targets.
    #[serde(skip)]
    pub aliases: Vec<&'a Geometry>,
    /// Outer-to-inner reference scope used by subsequent DMX break resolution.
    #[serde(skip)]
    pub references: Vec<&'a ReferenceGeometry>,
}

/// One physical/virtual channel bound to a particular geometry instance.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInstance<'a> {
    /// Definition-local identity including source channel and geometry instance.
    pub id: String,
    /// Index into the selected mode's authored channel list.
    pub source_index: usize,
    /// Index into the resolved geometry array.
    pub geometry: usize,
    /// Original functions, ranges, offsets, defaults, and selectors remain intact.
    #[serde(skip)]
    pub source: &'a DmxChannel,
}

/// A position attribute attached to its physical joint, independent of labels/node type.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JointBinding {
    /// Index into the instantiated channel array.
    pub channel: usize,
    /// Logical channel carrying this position attribute.
    pub logical_channel: usize,
    /// Geometry instance rotated by this control.
    pub geometry: usize,
    /// Position axis from the GDTF attribute semantics.
    pub axis: AxisType,
}

/// Selected hierarchy and instance bindings, before wire/function compilation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMode<'a> {
    /// Exact authored mode name, including whitespace.
    pub name: String,
    /// Flattened scene graph with parent-before-child order.
    pub geometries: Vec<GeometryInstance<'a>>,
    /// Authored channel order, then instance order for repeated channels.
    pub channels: Vec<ChannelInstance<'a>>,
    /// Explicit position links; nested or sibling joints retain independent controls.
    pub joints: Vec<JointBinding>,
    /// Complete selected mode retains relationships and vendor macros for later passes.
    #[serde(skip)]
    pub source: &'a DmxMode,
}

impl<'a> ResolvedMode<'a> {
    /// Return enclosing references; a control on a reference belongs outside its template.
    pub fn channel_scope(&self, channel: &ChannelInstance<'_>) -> &[&'a ReferenceGeometry] {
        let references = &self.geometries[channel.geometry].references;
        let end = references
            .iter()
            .position(|reference| reference.name.as_ref() == Some(&channel.source.geometry))
            .unwrap_or(references.len());
        &references[..end]
    }
}

/// Create a contextual failure without throwing away the location or category.
fn failure(code: &'static str, path: &str, message: impl Into<String>) -> ResolveError {
    ResolveError {
        code,
        path: path.to_owned(),
        message: message.into(),
    }
}

/// Resolve only the selected root and reachable templates, then instantiate channel targets.
pub fn resolve_mode<'a>(
    fixture: &'a FixtureType,
    mode_name: &str,
    limits: ResolveLimits,
) -> Result<ResolvedMode<'a>, ResolveError> {
    let mut modes = fixture
        .dmx_modes
        .iter()
        .filter(|m| m.name.as_ref().map(Name::as_ref) == Some(mode_name));
    let mode = modes
        .next()
        .ok_or_else(|| failure("missing_mode", mode_name, "No exact mode match"))?;
    if modes.next().is_some() {
        return Err(failure(
            "ambiguous_mode",
            mode_name,
            "Multiple modes have this name",
        ));
    }
    let root_name = mode
        .geometry
        .as_ref()
        .ok_or_else(|| failure("missing_root", mode_name, "Mode has no geometry link"))?;
    let root = unique_root(fixture, root_name, mode_name)?;
    let mut resolver = Resolver {
        fixture,
        limits,
        nodes: Vec::new(),
        active: Vec::new(),
    };
    resolver.visit(root, "g/0".into(), None, &[], None, 0)?;

    let mut by_name: HashMap<&str, (&Geometry, Vec<usize>)> = HashMap::new();
    for (index, node) in resolver.nodes.iter().enumerate() {
        for source in node
            .aliases
            .iter()
            .copied()
            .chain(std::iter::once(node.source))
        {
            let Some(name) = source.name() else { continue };
            let entry = by_name
                .entry(name.as_ref())
                .or_insert_with(|| (source, Vec::new()));
            if !std::ptr::eq(entry.0, source) {
                return Err(failure(
                    "ambiguous_geometry",
                    &node.id,
                    format!("Distinct source geometries share name {name}"),
                ));
            }
            entry.1.push(index);
        }
    }
    let mut channels = Vec::new();
    let mut joints = Vec::new();
    for (source_index, source) in mode.dmx_channels.iter().enumerate() {
        let (_, instances) = by_name.get(source.geometry.as_ref()).ok_or_else(|| {
            failure(
                "unreachable_channel",
                mode_name,
                format!(
                    "Channel {source_index} targets unreachable geometry {}",
                    source.geometry
                ),
            )
        })?;
        for &geometry in instances {
            if channels.len() >= limits.channels {
                return Err(failure(
                    "channel_limit",
                    mode_name,
                    "Instantiated channel limit exceeded",
                ));
            }
            for (logical_channel, logical) in source.logical_channels.iter().enumerate() {
                let axis = match logical.attribute.to_string().as_str() {
                    "Pan" => AxisType::Pan,
                    "Tilt" => AxisType::Tilt,
                    _ => continue,
                };
                joints.push(JointBinding {
                    channel: channels.len(),
                    logical_channel,
                    geometry,
                    axis,
                });
            }
            channels.push(ChannelInstance {
                id: format!("c/{source_index}/{}", resolver.nodes[geometry].id),
                source_index,
                geometry,
                source,
            });
        }
    }
    Ok(ResolvedMode {
        name: mode_name.into(),
        geometries: resolver.nodes,
        channels,
        joints,
        source: mode,
    })
}

/// Require one root target instead of choosing whichever duplicate happens to occur first.
fn unique_root<'a>(
    fixture: &'a FixtureType,
    name: &Name,
    path: &str,
) -> Result<&'a Geometry, ResolveError> {
    let mut matches = fixture.geometries.iter().filter(|g| g.name() == Some(name));
    let root = matches.next().ok_or_else(|| {
        failure(
            "missing_reference",
            path,
            format!("Root geometry {name} does not exist"),
        )
    })?;
    if matches.next().is_some() {
        return Err(failure(
            "ambiguous_reference",
            path,
            format!("Root geometry {name} is not unique"),
        ));
    }
    Ok(root)
}

/// Expansion state shared by all recursive branches of a single mode.
struct Resolver<'a> {
    fixture: &'a FixtureType,
    limits: ResolveLimits,
    nodes: Vec<GeometryInstance<'a>>,
    active: Vec<&'a Geometry>,
}

/// Effective overrides across a chain of reference roots; descendants start a fresh placement.
struct Placement<'a> {
    position: Matrix,
    model: Option<&'a Name>,
    name: Option<&'a Name>,
    aliases: Vec<&'a Geometry>,
}

impl<'a> Resolver<'a> {
    /// Expand one part with path-local cycle checks; siblings may reuse the same template.
    fn visit(
        &mut self,
        source: &'a Geometry,
        id: String,
        parent: Option<usize>,
        references: &[&'a ReferenceGeometry],
        placement: Option<Placement<'a>>,
        depth: usize,
    ) -> Result<usize, ResolveError> {
        if depth >= self.limits.depth {
            return Err(failure(
                "depth_limit",
                &id,
                "Geometry/reference depth limit exceeded",
            ));
        }
        if self.active.iter().any(|g| std::ptr::eq(*g, source)) {
            return Err(failure(
                "reference_cycle",
                &id,
                "Geometry references an active ancestor",
            ));
        }
        self.active.push(source);
        if let Geometry::Reference(reference) = source {
            let target_name = reference
                .geometry
                .as_ref()
                .ok_or_else(|| failure("missing_reference", &id, "Reference has no target"))?;
            let target = unique_root(self.fixture, target_name, &id)?;
            let mut scope = references.to_vec();
            scope.push(reference);
            let mut placement = placement.unwrap_or_else(|| Placement {
                position: reference.position,
                model: None,
                name: reference.name.as_ref(),
                aliases: Vec::new(),
            });
            placement.model = placement.model.or(reference.model.as_ref());
            placement.aliases.push(source);
            let index = self.visit(target, id, parent, &scope, Some(placement), depth + 1)?;
            self.active.pop();
            return Ok(index);
        }
        if self.nodes.len() >= self.limits.geometries {
            return Err(failure(
                "geometry_limit",
                &id,
                "Expanded geometry limit exceeded",
            ));
        }
        let index = self.nodes.len();
        let source_name = source.name().map(ToString::to_string).unwrap_or_default();
        let position = placement
            .as_ref()
            .map_or_else(|| geometry_position(source), |p| p.position);
        validate_position(position, &id)?;
        self.nodes.push(GeometryInstance {
            name: placement
                .as_ref()
                .and_then(|p| p.name)
                .map(ToString::to_string)
                .unwrap_or_else(|| source_name.clone()),
            source_name,
            id: id.clone(),
            parent,
            children: Vec::new(),
            position,
            model: placement
                .as_ref()
                .and_then(|p| p.model)
                .or_else(|| source.model_name()),
            source,
            aliases: placement.map(|p| p.aliases).unwrap_or_default(),
            references: references.to_vec(),
        });
        for (child_index, child) in source.children().iter().enumerate() {
            let child = self.visit(
                child,
                format!("{id}/{child_index}"),
                Some(index),
                references,
                None,
                depth + 1,
            )?;
            self.nodes[index].children.push(child);
        }
        self.active.pop();
        Ok(index)
    }
}

/// Reject non-finite rest transforms before they can poison scene bounds or world matrices.
fn validate_position(position: Matrix, path: &str) -> Result<(), ResolveError> {
    matrix_rows(position, path).map(|_| ())
}

/// Read finite numeric rows through the parser's sole public matrix representation.
pub(crate) fn matrix_rows(position: Matrix, path: &str) -> Result<[[f64; 4]; 4], ResolveError> {
    // The parser exposes matrix components only through its string serializer.
    let serialized = serde_json::to_value(position)
        .map_err(|error| failure("invalid_transform", path, error.to_string()))?;
    let invalid = || {
        failure(
            "invalid_transform",
            path,
            "Rest transform must contain sixteen finite components",
        )
    };
    let value = serialized.as_str().ok_or_else(invalid)?;
    let mut values = value.split(['{', '}', ',']).filter(|v| !v.is_empty());
    let mut rows = [[0.0; 4]; 4];
    for row in &mut rows {
        for component in row {
            *component = values
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite())
                .ok_or_else(invalid)?;
        }
    }
    if values.next().is_some() {
        return Err(invalid());
    }
    Ok(rows)
}

/// Read the common authored matrix without assigning meaning based on geometry names.
pub fn geometry_position(geometry: &Geometry) -> Matrix {
    match geometry {
        Geometry::Generic(g) => g.position,
        Geometry::Axis(g) => g.position,
        Geometry::Beam(g) => g.position,
        Geometry::FilterBeam(g) => g.position,
        Geometry::FilterColor(g) => g.position,
        Geometry::FilterGobo(g) => g.position,
        Geometry::FilterShaper(g) => g.position,
        Geometry::Display(g) => g.position,
        Geometry::Reference(g) => g.position,
        Geometry::MediaServerLayer(g) => g.position,
        Geometry::MediaServerCamera(g) => g.position,
        Geometry::MediaServerMaster(g) => g.position,
        Geometry::Laser(g) => g.position,
        Geometry::WiringObject(g) => g.position,
        Geometry::Inventory(g) => g.position,
        Geometry::Structure(g) => g.position,
        Geometry::Support(g) => g.position,
        Geometry::Magnet(g) => g.position,
    }
}
