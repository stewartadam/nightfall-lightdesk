// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Geometry types for 3D visualization of fixtures.
//!
//! These types represent the GDTF geometry tree structure, including transforms,
//! model references, and mesh resources for rendering fixtures in the visualizer.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 4x4 transformation matrix stored as column-major array.
///
/// Compatible with Three.js Matrix4.fromArray() format.
/// Contains rotation, scale, and translation in a single matrix.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    /// Column-major 4x4 matrix elements (16 floats).
    /// Order: [col0_x, col0_y, col0_z, col0_w, col1_x, col1_y, col1_z, col1_w, ...]
    pub elements: [f32; 16],
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            elements: [
                1.0, 0.0, 0.0, 0.0, // column 0 (X axis)
                0.0, 1.0, 0.0, 0.0, // column 1 (Y axis)
                0.0, 0.0, 1.0, 0.0, // column 2 (Z axis)
                0.0, 0.0, 0.0, 1.0, // column 3 (translation)
            ],
        }
    }
}

/// Type of GDTF geometry node.
///
/// Determines how the geometry node behaves and what properties it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum GeometryType {
    /// Basic geometry without special behavior.
    Generic,
    /// Articulated geometry with a rotation axis (pan/tilt).
    Axis,
    /// Light output geometry (beam emitter).
    Beam,
    /// Reference to another geometry (instancing).
    Reference,
    /// Beam filter (barn doors, iris).
    FilterBeam,
    /// Color filter (color wheels, CMY).
    FilterColor,
    /// Gobo filter (gobo wheels).
    FilterGobo,
    /// Display surface for media.
    Display,
}

/// Axis type for articulated geometry nodes.
///
/// Determines which axis the geometry rotates around.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum AxisType {
    /// Rotation around the node's local GDTF Z axis.
    Pan,
    /// Rotation around the node's local GDTF X axis.
    Tilt,
    /// Rotation around the node's local GDTF Y axis.
    Roll,
}

/// GDTF PrimitiveType for fallback geometry generation.
///
/// When no mesh file is available, primitives define the basic shape
/// to generate using the model dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum PrimitiveType {
    /// Rectangular box.
    Cube,
    /// Cylindrical shape.
    Cylinder,
    /// Spherical shape.
    Sphere,
    /// Base/mounting plate of fixture.
    Base,
    /// U-shaped yoke for pan axis.
    Yoke,
    /// Head housing for tilt axis.
    Head,
    /// Scanner mirror assembly.
    Scanner,
    /// Conventional fixture body (PAR can, fresnel).
    Conventional,
    /// Cable/pigtail.
    Pigtail,
    /// Base variant 1.1.
    Base1_1,
    /// Scanner variant 1.1.
    Scanner1_1,
    /// Conventional variant 1.1.
    Conventional1_1,
    /// Undefined or unknown primitive.
    #[default]
    Undefined,
}

/// Model definition for a geometry node.
///
/// Contains the model name, primitive type for fallback rendering,
/// dimensions, and optional mesh file reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct GeometryModel {
    /// Model name from GDTF.
    pub name: String,
    /// Primitive type for fallback rendering when mesh is unavailable.
    pub primitive_type: PrimitiveType,
    /// Length (depth) of the model in meters.
    pub length: f32,
    /// Width of the model in meters.
    pub width: f32,
    /// Height of the model in meters.
    pub height: f32,
    /// Mesh file name (without extension) if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_file: Option<String>,
}

/// A node in the fixture's geometry tree.
///
/// Represents a single part of the fixture with its transform, model,
/// and relationships to other nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct GeometryNode {
    /// Unique name within the fixture (e.g., "Yoke", "Head", "Pixel_1").
    pub name: String,
    /// Type of geometry node.
    pub geometry_type: GeometryType,
    /// Local transform relative to parent (4x4 matrix).
    pub transform: Transform,
    /// Model definition if this node has visual geometry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<GeometryModel>,
    /// Rotations this node applies when its `controlled_element` moves, in
    /// application order: pan rotates about the local Z axis and tilt about
    /// the local X axis, on top of the node's authored transform. A node can
    /// carry both when one geometry holds pan and tilt channels.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub axes: Vec<AxisType>,
    /// Index of parent node in the nodes array (-1 for root).
    pub parent_index: i32,
    /// Indices of child nodes in the nodes array.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<u32>,
    /// Label of the element driving this node: the element whose color and
    /// intensity a beam emits, or whose pan/tilt parameter rotates an axis node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controlled_element: Option<String>,
}

/// Format of a mesh resource file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum MeshFormat {
    /// GLTF Binary format (.glb).
    Glb,
    /// 3D Studio Max format (.3ds).
    Max3ds,
}

/// Information about an available mesh resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct MeshResource {
    /// Format of the mesh file.
    pub format: MeshFormat,
    /// Relative path within GDTF archive (e.g., "models/gltf/Body.glb").
    pub path: String,
}

/// Complete geometry tree for a fixture.
///
/// Contains all geometry nodes in a flat array with parent/child indices,
/// plus available mesh resources and the source GDTF file path.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct FixtureGeometry {
    /// Flat array of nodes (parent indices reference into this array).
    pub nodes: Vec<GeometryNode>,
    /// Indices of root nodes (typically just one).
    pub roots: Vec<u32>,
    /// Available mesh resources keyed by model name.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub mesh_resources: HashMap<String, MeshResource>,
    /// Path to source GDTF file for mesh loading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gdtf_path: Option<String>,
}

/// Trait for providing geometry data for fixtures.
///
/// Implemented by fixture library to supply geometry at runtime.
/// The fixtures crate uses this to materialize fixtures with geometry
/// without directly depending on the fixture-library crate.
pub trait GeometryProvider: Send + Sync {
    /// Get geometry for a patched fixture from the library revision it was created from.
    ///
    /// Returns `None` if the fixture source doesn't have geometry (e.g., OFL),
    /// or if its revision is unavailable and no available revision has the
    /// same element structure.
    fn get_geometry(&self, fixture: &crate::fixture::Fixture) -> Option<FixtureGeometry>;
}

/// Resource wrapper for a geometry provider.
///
/// This is registered by the fixture-library crate to allow the fixtures crate
/// to access geometry without a direct dependency.
#[derive(bevy_ecs::prelude::Resource)]
pub struct GeometryProviderResource(pub Box<dyn GeometryProvider>);

impl GeometryProviderResource {
    /// Create a new geometry provider resource.
    pub fn new(provider: impl GeometryProvider + 'static) -> Self {
        Self(Box::new(provider))
    }

    /// Get geometry for a patched fixture.
    pub fn get_geometry(&self, fixture: &crate::fixture::Fixture) -> Option<FixtureGeometry> {
        self.0.get_geometry(fixture)
    }
}
