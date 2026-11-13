// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Turning the model files of MVR scene objects into GLB models the visualizer loads.
//!
//! MVR stores geometry as `.3ds` files (Z up, millimetres, the form Capture and older
//! Vectorworks exports use) and `.glb` or `.gltf` files (glTF's own Y up, metres). Both are
//! read into one triangle soup in MVR space (Z up, millimetres), placed by the matrices of
//! the geometry nodes, and written out as a single untextured GLB in Nightfall space (Y up,
//! metres, +Z towards the audience).

use std::collections::HashMap;

use nightfall_mvr::prelude::*;

/// Deepest nesting of symbol definitions followed, so a symbol that contains itself ends.
const MAX_SYMBOL_DEPTH: usize = 8;

/// Most triangles one model may hold; larger geometry is left out with a warning.
const MAX_TRIANGLES: usize = 4_000_000;

/// How deep 3DS chunks or glTF nodes may nest before a model counts as broken.
const MAX_NESTING: usize = 64;

/// Triangles in MVR space: Z up, millimetres.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    /// Vertex positions.
    pub positions: Vec<[f32; 3]>,
    /// Vertex indices, three per triangle.
    pub indices: Vec<u32>,
}

impl Mesh {
    /// Whether the mesh has no triangles.
    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    /// Number of triangles.
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Adds `other` with every vertex mapped through `transform`.
    pub fn append(&mut self, other: &Mesh, transform: &Transform) {
        let base = self.positions.len() as u32;
        self.positions.extend(other.positions.iter().map(|point| {
            transform
                .apply_point(point.map(f64::from))
                .map(|value| value as f32)
        }));
        self.indices
            .extend(other.indices.iter().map(|index| index + base));
    }

    /// Writes the mesh as a binary glTF file in Nightfall space: `x = X`, `y = Z`, `z = -Y`,
    /// in metres. The single material is a light grey drawn from both sides, because
    /// mirrored placements flip triangle winding.
    pub fn to_glb(&self) -> Vec<u8> {
        let positions: Vec<[f32; 3]> = self
            .positions
            .iter()
            .map(|[x, y, z]| [x / 1000.0, z / 1000.0, -y / 1000.0])
            .collect();
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for point in &positions {
            for axis in 0..3 {
                min[axis] = min[axis].min(point[axis]);
                max[axis] = max[axis].max(point[axis]);
            }
        }
        if positions.is_empty() {
            (min, max) = ([0.0; 3], [0.0; 3]);
        }

        let mut binary = Vec::with_capacity(positions.len() * 12 + self.indices.len() * 4);
        for point in &positions {
            for value in point {
                binary.extend_from_slice(&value.to_le_bytes());
            }
        }
        let positions_length = binary.len();
        for index in &self.indices {
            binary.extend_from_slice(&index.to_le_bytes());
        }
        let indices_length = binary.len() - positions_length;

        let json = format!(
            concat!(
                r#"{{"asset":{{"version":"2.0","generator":"Nightfall MVR import"}},"#,
                r#""scene":0,"scenes":[{{"nodes":[0]}}],"nodes":[{{"mesh":0}}],"#,
                r#""meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1,"material":0}}]}}],"#,
                r#""materials":[{{"pbrMetallicRoughness":{{"baseColorFactor":[0.62,0.62,0.64,1],"metallicFactor":0.1,"roughnessFactor":0.8}},"doubleSided":true}}],"#,
                r#""buffers":[{{"byteLength":{total}}}],"#,
                r#""bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":{positions_length},"target":34962}},"#,
                r#"{{"buffer":0,"byteOffset":{positions_length},"byteLength":{indices_length},"target":34963}}],"#,
                r#""accessors":[{{"bufferView":0,"componentType":5126,"count":{vertices},"type":"VEC3","min":[{min}],"max":[{max}]}},"#,
                r#"{{"bufferView":1,"componentType":5125,"count":{indices},"type":"SCALAR"}}]}}"#
            ),
            total = binary.len(),
            positions_length = positions_length,
            indices_length = indices_length,
            vertices = positions.len(),
            indices = self.indices.len(),
            min = json_numbers(&min),
            max = json_numbers(&max),
        );
        glb_container(json.into_bytes(), binary)
    }
}

/// Writes three numbers as a JSON list body.
fn json_numbers(values: &[f32; 3]) -> String {
    values
        .iter()
        .map(|value| format!("{value:?}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Wraps glTF JSON and its binary buffer in the GLB container, padding each chunk to four
/// bytes as the format requires.
fn glb_container(mut json: Vec<u8>, mut binary: Vec<u8>) -> Vec<u8> {
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    while !binary.len().is_multiple_of(4) {
        binary.push(0);
    }
    let total = 12 + 8 + json.len() + 8 + binary.len();
    let mut glb = Vec::with_capacity(total);
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2u32.to_le_bytes());
    glb.extend_from_slice(&(total as u32).to_le_bytes());
    glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&json);
    glb.extend_from_slice(&(binary.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"BIN\0");
    glb.extend_from_slice(&binary);
    glb
}

/// Reads the triangles of a `.3ds` file. Coordinates are kept as written, which MVR
/// defines as Z up in millimetres.
///
/// Only the parts a model needs are read: each object's vertex list and face list. Unknown
/// chunks are skipped by their length.
pub fn read_3ds(bytes: &[u8]) -> Result<Mesh, String> {
    let mut mesh = Mesh::default();
    walk_3ds(bytes, 0, bytes.len(), &mut mesh, &mut Vec::new(), 0)?;
    if mesh.is_empty() {
        return Err("the 3DS file has no triangles".to_string());
    }
    Ok(mesh)
}

/// Reads the chunks between `start` and `end`, descending into the containers that lead to
/// meshes. `vertices` holds the vertex list of the mesh being read, and `depth` how deep the
/// chunks nest, which is capped so a crafted file cannot exhaust the stack.
fn walk_3ds(
    bytes: &[u8],
    start: usize,
    end: usize,
    mesh: &mut Mesh,
    vertices: &mut Vec<[f32; 3]>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_NESTING {
        return Err("3DS chunks nest too deeply".to_string());
    }
    const MAIN: u16 = 0x4D4D;
    const EDITOR: u16 = 0x3D3D;
    const OBJECT: u16 = 0x4000;
    const TRIANGLES: u16 = 0x4100;
    const VERTICES: u16 = 0x4110;
    const FACES: u16 = 0x4120;

    let mut offset = start;
    while offset + 6 <= end {
        let id = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
        let length = read_u32(bytes, offset + 2)? as usize;
        let chunk_end = offset
            .checked_add(length)
            .filter(|chunk_end| length >= 6 && *chunk_end <= end)
            .ok_or_else(|| format!("broken 3DS chunk {id:#06x} at byte {offset}"))?;
        let body = offset + 6;
        match id {
            MAIN | EDITOR => walk_3ds(bytes, body, chunk_end, mesh, vertices, depth + 1)?,
            OBJECT => {
                let name_end = bytes[body..chunk_end]
                    .iter()
                    .position(|byte| *byte == 0)
                    .map(|position| body + position + 1)
                    .ok_or("unterminated 3DS object name")?;
                walk_3ds(bytes, name_end, chunk_end, mesh, vertices, depth + 1)?;
            }
            TRIANGLES => {
                vertices.clear();
                walk_3ds(bytes, body, chunk_end, mesh, vertices, depth + 1)?;
            }
            VERTICES => {
                let count = read_u16(bytes, body)? as usize;
                if body + 2 + count * 12 > chunk_end {
                    return Err("3DS vertex list runs past its chunk".to_string());
                }
                vertices.clear();
                vertices.extend((0..count).map(|index| {
                    let at = body + 2 + index * 12;
                    std::array::from_fn(|axis| {
                        f32::from_le_bytes(
                            bytes[at + axis * 4..at + axis * 4 + 4]
                                .try_into()
                                .expect("four bytes"),
                        )
                    })
                }));
            }
            FACES => {
                let count = read_u16(bytes, body)? as usize;
                if body + 2 + count * 8 > chunk_end {
                    return Err("3DS face list runs past its chunk".to_string());
                }
                let base = mesh.positions.len() as u32;
                mesh.positions.extend_from_slice(vertices);
                for face in 0..count {
                    let at = body + 2 + face * 8;
                    let corners = [
                        read_u16(bytes, at)?,
                        read_u16(bytes, at + 2)?,
                        read_u16(bytes, at + 4)?,
                    ];
                    if corners
                        .iter()
                        .any(|corner| usize::from(*corner) >= vertices.len())
                    {
                        return Err("3DS face uses a vertex that does not exist".to_string());
                    }
                    mesh.indices
                        .extend(corners.map(|corner| base + u32::from(corner)));
                }
            }
            _ => {}
        }
        offset = chunk_end;
    }
    Ok(())
}

/// Reads a little-endian `u16` at `at`.
fn read_u16(bytes: &[u8], at: usize) -> Result<u16, String> {
    bytes
        .get(at..at + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
        .ok_or_else(|| "3DS file ends early".to_string())
}

/// Reads a little-endian `u32` at `at`.
fn read_u32(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
        .ok_or_else(|| "3DS file ends early".to_string())
}

/// Reads the triangles of a binary or embedded glTF file into MVR space, applying the
/// transforms of the nodes of its default scene. glTF is Y up in metres, so a point
/// `(x, y, z)` becomes `(x, -z, y)` millimetres.
pub fn read_gltf(bytes: &[u8]) -> Result<Mesh, String> {
    let gltf = gltf::Gltf::from_slice(bytes).map_err(|error| error.to_string())?;
    let blob = gltf.blob.as_deref();
    let scene = gltf
        .default_scene()
        .or_else(|| gltf.scenes().next())
        .ok_or("the glTF file has no scene")?;
    let mut mesh = Mesh::default();
    for node in scene.nodes() {
        read_gltf_node(&node, IDENTITY_4, blob, &mut mesh, 0)?;
    }
    if mesh.is_empty() {
        return Err("the glTF file has no triangles".to_string());
    }
    Ok(mesh)
}

/// The 4x4 identity matrix in glTF's column-major layout.
const IDENTITY_4: [[f32; 4]; 4] = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
];

/// Adds the triangle primitives of `node` and its children, placed by `parent` composed
/// with each node's own transform. `depth` caps the nesting, which also stops a node
/// hierarchy that loops back on itself.
fn read_gltf_node(
    node: &gltf::Node<'_>,
    parent: [[f32; 4]; 4],
    blob: Option<&[u8]>,
    mesh: &mut Mesh,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_NESTING {
        return Err("glTF nodes nest too deeply".to_string());
    }
    let world = multiply_4(parent, node.transform().matrix());
    if let Some(node_mesh) = node.mesh() {
        for primitive in node_mesh.primitives() {
            if primitive.mode() != gltf::mesh::Mode::Triangles {
                continue;
            }
            let reader = primitive.reader(|buffer| match buffer.source() {
                gltf::buffer::Source::Bin => blob,
                gltf::buffer::Source::Uri(_) => None,
            });
            let Some(positions) = reader.read_positions() else {
                continue;
            };
            let base = mesh.positions.len() as u32;
            let mut count = 0u32;
            for [x, y, z] in positions {
                let [wx, wy, wz] = transform_point_4(&world, [x, y, z]);
                mesh.positions
                    .push([wx * 1000.0, -wz * 1000.0, wy * 1000.0]);
                count += 1;
            }
            match reader.read_indices() {
                Some(indices) => {
                    let start = mesh.indices.len();
                    for index in indices.into_u32() {
                        if index >= count {
                            return Err("glTF index uses a vertex that does not exist".into());
                        }
                        mesh.indices.push(base + index);
                    }
                    // A stray index would shift every later triangle of the merged mesh.
                    let extra = (mesh.indices.len() - start) % 3;
                    mesh.indices.truncate(mesh.indices.len() - extra);
                }
                None => mesh
                    .indices
                    .extend((0..count - count % 3).map(|i| base + i)),
            }
        }
    }
    for child in node.children() {
        read_gltf_node(&child, world, blob, mesh, depth + 1)?;
    }
    Ok(())
}

/// Adds a warning unless the same one is already there, so a model built from many
/// references to one broken file reports it once.
fn push_once(warnings: &mut Vec<String>, warning: String) {
    if !warnings.contains(&warning) {
        warnings.push(warning);
    }
}

/// Multiplies two column-major 4x4 matrices.
fn multiply_4(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    std::array::from_fn(|column| {
        std::array::from_fn(|row| (0..4).map(|k| a[k][row] * b[column][k]).sum())
    })
}

/// Maps a point through a column-major 4x4 matrix.
fn transform_point_4(matrix: &[[f32; 4]; 4], point: [f32; 3]) -> [f32; 3] {
    std::array::from_fn(|row| {
        matrix[0][row] * point[0]
            + matrix[1][row] * point[1]
            + matrix[2][row] * point[2]
            + matrix[3][row]
    })
}

/// Reads the model files of a rig once each and assembles object geometry from them.
pub struct GeometryCache<'a, R> {
    /// The archive the model files come from.
    archive: &'a mut MvrArchive<R>,
    /// Symbol definitions by UUID.
    symdefs: HashMap<uuid::Uuid, &'a Symdef>,
    /// Model files read so far, or why they could not be read.
    files: HashMap<String, Result<Mesh, String>>,
}

impl<'a, R: std::io::Read + std::io::Seek> GeometryCache<'a, R> {
    /// Prepares to read geometry from `archive`, resolving symbols through `scene`.
    pub fn new(archive: &'a mut MvrArchive<R>, symdefs: HashMap<uuid::Uuid, &'a Symdef>) -> Self {
        Self {
            archive,
            symdefs,
            files: HashMap::new(),
        }
    }

    /// Adds the geometry `geometries` describe to `mesh`, each piece placed by its own
    /// matrix and then by `transform`. Pieces that cannot be read are reported in
    /// `warnings` and left out.
    pub fn add(
        &mut self,
        geometries: &Geometries,
        transform: &Transform,
        mesh: &mut Mesh,
        warnings: &mut Vec<String>,
    ) {
        self.add_nested(geometries, transform, mesh, warnings, 0);
    }

    /// Adds geometry, following symbols at most [`MAX_SYMBOL_DEPTH`] deep.
    fn add_nested(
        &mut self,
        geometries: &Geometries,
        transform: &Transform,
        mesh: &mut Mesh,
        warnings: &mut Vec<String>,
        depth: usize,
    ) {
        for node in &geometries.nodes {
            match node {
                GeometryNode::Geometry3D(geometry) => {
                    let placed = transform.then(&geometry.matrix.unwrap_or_default());
                    match self.file(&geometry.file_name) {
                        Ok(piece) => {
                            if mesh.triangle_count() + piece.triangle_count() > MAX_TRIANGLES {
                                push_once(
                                    warnings,
                                    format!(
                                        "Left out pieces past {MAX_TRIANGLES} triangles to keep the model drawable"
                                    ),
                                );
                                continue;
                            }
                            mesh.append(piece, &placed);
                        }
                        Err(error) => push_once(
                            warnings,
                            format!("Left out model {}: {error}", geometry.file_name),
                        ),
                    }
                }
                GeometryNode::Symbol(symbol) => {
                    let Some(symdef) = self.symdefs.get(&symbol.symdef).copied() else {
                        warnings.push(format!("Symbol {} has no definition", symbol.symdef));
                        continue;
                    };
                    if depth >= MAX_SYMBOL_DEPTH {
                        warnings.push(format!("Symbol {} nests too deeply", symdef.name));
                        continue;
                    }
                    let placed = transform.then(&symbol.matrix.unwrap_or_default());
                    self.add_nested(&symdef.geometries, &placed, mesh, warnings, depth + 1);
                }
                GeometryNode::Other => {}
            }
        }
    }

    /// Returns the triangles of a model file in the archive, reading it the first time.
    fn file(&mut self, name: &str) -> Result<&Mesh, String> {
        if !self.files.contains_key(name) {
            let read = self.read_file(name);
            self.files.insert(name.to_string(), read);
        }
        self.files[name].as_ref().map_err(Clone::clone)
    }

    /// Reads and parses one model file, choosing the format by its extension. MVR treats
    /// a file without an extension as 3DS.
    fn read_file(&mut self, name: &str) -> Result<Mesh, String> {
        let bytes = self
            .archive
            .read_file(name)
            .map_err(|error| error.to_string())?;
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".glb") || lower.ends_with(".gltf") {
            read_gltf(&bytes)
        } else {
            read_3ds(&bytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a 3DS file holding one triangle.
    fn triangle_3ds() -> Vec<u8> {
        let mut vertices = vec![];
        vertices.extend_from_slice(&3u16.to_le_bytes());
        for point in [[0.0f32, 0.0, 0.0], [1000.0, 0.0, 0.0], [0.0, 0.0, 2000.0]] {
            for value in point {
                vertices.extend_from_slice(&value.to_le_bytes());
            }
        }
        let mut faces = vec![];
        faces.extend_from_slice(&1u16.to_le_bytes());
        for value in [0u16, 1, 2, 0] {
            faces.extend_from_slice(&value.to_le_bytes());
        }
        let chunk = |id: u16, body: &[u8]| {
            let mut out = id.to_le_bytes().to_vec();
            out.extend_from_slice(&((body.len() + 6) as u32).to_le_bytes());
            out.extend_from_slice(body);
            out
        };
        let mut triangles = chunk(0x4110, &vertices);
        triangles.extend(chunk(0x4120, &faces));
        let mut object = b"Box\0".to_vec();
        object.extend(chunk(0x4100, &triangles));
        chunk(0x4D4D, &chunk(0x3D3D, &chunk(0x4000, &object)))
    }

    /// A 3DS triangle is read in millimetres and written out Y up in metres.
    #[test]
    fn reads_3ds_and_writes_glb() {
        let mesh = read_3ds(&triangle_3ds()).unwrap();
        assert_eq!(mesh.positions[2], [0.0, 0.0, 2000.0]);
        assert_eq!(mesh.indices, [0, 1, 2]);

        let glb = mesh.to_glb();
        let back = read_gltf(&glb).unwrap();
        // Written as Y up metres and read back into MVR space: the same points.
        assert_eq!(back.positions, mesh.positions);
        assert_eq!(back.indices, mesh.indices);
    }

    /// Placing a piece applies its matrix to every vertex.
    #[test]
    fn append_places_vertices() {
        let piece = read_3ds(&triangle_3ds()).unwrap();
        let mut mesh = Mesh::default();
        let shifted = Transform {
            origin: [0.0, 0.0, 500.0],
            ..Transform::IDENTITY
        };
        mesh.append(&piece, &shifted);
        mesh.append(&piece, &Transform::IDENTITY);
        assert_eq!(mesh.positions[2], [0.0, 0.0, 2500.0]);
        assert_eq!(mesh.indices, [0, 1, 2, 3, 4, 5]);
    }

    /// A broken chunk length is an error, not a panic.
    #[test]
    fn rejects_truncated_3ds() {
        let mut bytes = triangle_3ds();
        bytes.truncate(bytes.len() - 4);
        assert!(read_3ds(&bytes).is_err());
    }

    /// Chunks nested thousands deep are refused instead of overflowing the stack.
    #[test]
    fn rejects_deeply_nested_3ds() {
        let levels = 10_000usize;
        let mut bytes = Vec::with_capacity(levels * 6);
        for level in 0..levels {
            bytes.extend_from_slice(&0x4D4Du16.to_le_bytes());
            bytes.extend_from_slice(&(((levels - level) * 6) as u32).to_le_bytes());
        }
        let error = read_3ds(&bytes).unwrap_err();
        assert!(error.contains("nest"), "{error}");
    }
}
