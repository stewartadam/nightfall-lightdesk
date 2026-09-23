// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Geometry tree builder for GDTF fixtures.
 * Builds Three.js scene graphs from GDTF geometry definitions.
 *
 * Supports:
 * - Loading GLB meshes from GDTF archives
 * - Loading GLB models from bundled assets for standard primitive types
 * - Creating primitive shape fallbacks
 * - Rendering emitters at Beam geometry positions
 */

import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three/webgpu";
import { getLogger } from "../../../lib/logger";
import {
  AxisType,
  type FixtureGeometry,
  type GeometryModel,
  type GeometryNode,
  type PrimitiveType,
} from "../../../types";
import type { EmitterData, FixtureInstance } from "../model/types";
import { loadMesh } from "./mesh-loader";
import { cloneFixtureMesh, disposeFixtureMesh } from "./mesh-ownership";

const log = getLogger(import.meta.url);

/**
 * Asset paths for GDTF primitive type models.
 * These GLB files are bundled with the app and used when:
 * - The GDTF specifies a known primitive type (Base, Head, Yoke, etc.)
 * - No custom mesh file is provided in the GDTF
 */
const PRIMITIVE_ASSET_PATHS: Partial<Record<PrimitiveType, string>> = {
  base: "/assets/visualizer/models/Base.glb",
  base11: "/assets/visualizer/models/Base.glb",
  yoke: "/assets/visualizer/models/Yoke.glb",
  head: "/assets/visualizer/models/Head.glb",
  scanner: "/assets/visualizer/models/Scanner.glb",
  scanner11: "/assets/visualizer/models/Scanner.glb",
  conventional: "/assets/visualizer/models/Conventional.glb",
  conventional11: "/assets/visualizer/models/Conventional.glb",
};

/** Shared GLTF loader for asset models */
const gltfLoader = new GLTFLoader();

/** Cache for loaded asset models: primitiveType -> Promise<Group> */
const assetModelCache = new Map<string, Promise<Group>>();
const disposedInstances = new WeakSet<Group>();

/**
 * Loads and clones the GLB model for a primitive fixture type, returning null when no asset exists.
 */
async function loadAssetModel(
  primitiveType: PrimitiveType,
): Promise<Group | null> {
  const assetPath = PRIMITIVE_ASSET_PATHS[primitiveType];
  if (!assetPath) return null;

  // Check cache
  if (assetModelCache.has(primitiveType)) {
    try {
      const cached = await assetModelCache.get(primitiveType);
      return cached ? cloneFixtureMesh(cached) : null;
    } catch {
      assetModelCache.delete(primitiveType);
    }
  }

  // Load model
  const loadPromise = new Promise<Group>((resolve, reject) => {
    gltfLoader.load(
      assetPath,
      (gltf) => {
        // Apply standard fixture material
        gltf.scene.traverse((child) => {
          if ((child as Mesh).isMesh) {
            const mesh = child as Mesh;
            if (Array.isArray(mesh.material)) {
              for (const mat of mesh.material) {
                mat.dispose();
              }
            } else if (mesh.material) {
              mesh.material.dispose();
            }
            mesh.material = new MeshStandardMaterial({
              color: 0x3a3a3a,
              metalness: 0.6,
              roughness: 0.4,
            });
            mesh.castShadow = false;
            mesh.receiveShadow = false;
          }
        });
        resolve(gltf.scene);
      },
      undefined,
      (error) => {
        log.warn(`Failed to load asset model for ${primitiveType}:`, error);
        reject(error);
      },
    );
  });

  assetModelCache.set(primitiveType, loadPromise);

  try {
    const loaded = await loadPromise;
    return cloneFixtureMesh(loaded);
  } catch {
    assetModelCache.delete(primitiveType);
    return null;
  }
}

/**
 * Create a primitive mesh based on GDTF PrimitiveType.
 * Used as fallback when GLB/3DS mesh is not available and no asset model exists.
 */
function createPrimitiveMesh(model: GeometryModel): Mesh {
  const { primitiveType, length, width, height } = model;

  // GDTF primitive dimensions use Z-up coordinate system:
  // - Width: X axis (left/right)
  // - Length: Y axis (forward/back)
  // - Height: Z axis (up/down)
  //
  // Three.js primitives use Y-up:
  // - BoxGeometry(width, height, depth) = (X, Y, Z)
  // - CylinderGeometry creates cylinder along Y axis
  //
  // Since we apply coordinate conversion at the group level (-90° X rotation),
  // we need to create primitives in GDTF's Z-up space. This means:
  // - Box: (width=X, length=Y, height=Z) -> BoxGeometry(width, length, height)
  // - Cylinder: height along Z -> need to rotate the cylinder

  let geometry: BoxGeometry | CylinderGeometry | SphereGeometry;
  const mesh = new Mesh();

  switch (primitiveType) {
    case "cube":
      // Box in GDTF: width(X), length(Y), height(Z)
      geometry = new BoxGeometry(width, length, height);
      break;

    case "cylinder":
    case "pigtail":
      // Cylinder in GDTF has height along Z axis
      // Three.js CylinderGeometry has height along Y axis
      // So we create it and rotate 90° around X to align with Z
      geometry = new CylinderGeometry(width / 2, width / 2, height, 16);
      mesh.rotation.x = Math.PI / 2;
      break;

    case "sphere":
      // Sphere: radius (same in any orientation)
      geometry = new SphereGeometry(
        Math.max(width, height, length) / 2,
        16,
        16,
      );
      break;

    // These primitive types have bundled GLB models - use box as temporary fallback
    // The GLB will be loaded asynchronously and replace this
    case "base":
    case "base11":
    case "conventional":
    case "conventional11":
    case "yoke":
    case "head":
    case "scanner":
    case "scanner11":
      geometry = new BoxGeometry(width, length, height);
      break;

    default:
      // Default to small box for undefined types
      geometry = new BoxGeometry(0.1, 0.1, 0.1);
      break;
  }

  mesh.geometry = geometry;
  mesh.material = new MeshStandardMaterial({
    color: 0x4a4a4a, // Lighter gray for primitive fallbacks
    metalness: 0.5,
    roughness: 0.5,
  });

  return mesh;
}

/**
 * Create an emitter mesh for a Beam geometry node.
 * Uses the model dimensions and primitive type from GDTF to render a lit pixel/emitter.
 *
 * GDTF model dimensions are in meters. We convert to millimeters to match
 * the geometry tree coordinate system (which uses mm internally and scales
 * by 0.001 at the end to convert to meters).
 */
function createEmitterMesh(node: GeometryNode): Mesh {
  const model = node.model;

  // GDTF model dimensions are in meters - convert to mm for geometry tree
  // Default to 35mm diameter, 50mm depth if not specified
  const widthMm = (model?.width ?? 0.035) * 1000;
  const lengthMm = (model?.length ?? 0.035) * 1000;
  const heightMm = (model?.height ?? 0.05) * 1000;

  // Create geometry based on primitive type (matches mesh/transform units in geometry tree)
  // Default to cylinder for backwards compatibility with fixtures that don't specify a type
  const primitiveType = model?.primitiveType ?? "cylinder";
  let geometry: BoxGeometry | CylinderGeometry | SphereGeometry;

  const mesh = new Mesh();
  mesh.name = `${node.name}_emitter`;

  switch (primitiveType) {
    case "cube":
      // Box in GDTF: width(X), length(Y), height(Z)
      geometry = new BoxGeometry(widthMm, lengthMm, heightMm);
      break;

    case "sphere":
      // Sphere: use largest dimension as diameter
      geometry = new SphereGeometry(
        Math.max(widthMm, heightMm, lengthMm) / 2,
        16,
        16,
      );
      break;
    default: {
      // Cylinder in GDTF has height along Z axis
      // Three.js CylinderGeometry has height along Y axis
      // So we create it and rotate 90° around X to align with Z
      const radius = widthMm / 2;
      geometry = new CylinderGeometry(radius, radius, heightMm, 16);
      // Rotate to align cylinder with GDTF Z axis (height along Z)
      mesh.rotation.x = Math.PI / 2;
      break;
    }
  }

  // Create emissive material - color will be set by DMX
  const material = new MeshStandardMaterial({
    color: 0x000000,
    emissive: 0x000000,
    emissiveIntensity: 2.0,
  });

  mesh.geometry = geometry;
  mesh.material = material;

  return mesh;
}

/**
 * Replace a primitive mesh with a loaded mesh group.
 * Disposes the primitive geometry and material before replacement.
 */
function replacePrimitiveWithMesh(
  parent: Object3D,
  nodeName: string,
  meshGroup: Group,
): void {
  const primitive = parent.getObjectByName(`${nodeName}_primitive`);
  if (primitive) {
    parent.remove(primitive);
    if (primitive instanceof Mesh) {
      primitive.geometry?.dispose();
      (primitive.material as MeshStandardMaterial)?.dispose();
    }
  }
  meshGroup.name = `${nodeName}_mesh`;
  parent.add(meshGroup);
}

/**
 * Build a Three.js scene graph from a GDTF geometry definition.
 * Creates the geometry tree synchronously with primitive fallbacks,
 * then asynchronously loads and replaces with GLB/3DS meshes.
 *
 * Per GDTF spec, model dimensions and transforms are in millimeters.
 * The entire group is scaled to meters at the end.
 *
 * @param fixtureUid - Unique identifier for this fixture instance
 * @param geometry - GDTF geometry definition
 * @returns FixtureInstance with the built scene graph
 */
export function buildGeometryTree(
  fixtureUid: string,
  geometry: FixtureGeometry,
): FixtureInstance {
  const group = new Group();
  group.name = `Fixture_${fixtureUid}`;

  const nodeObjects = new Map<string, Object3D>();
  const emitters = new Map<string, EmitterData>();

  // Create Object3D for each geometry node
  for (const node of geometry.nodes) {
    const obj = new Group();
    obj.name = node.name;

    // Apply transform matrix from GDTF
    // GDTF position matrices use METERS for translation.
    // However, 3DS mesh files use MILLIMETERS.
    // We convert transforms to millimeters here so they match the mesh units,
    // then scale the entire group by 0.001 at the end to convert to meters.
    const matrix = new Matrix4();
    matrix.fromArray(node.transform.elements);

    // Decompose the matrix to get position, rotation, scale
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    matrix.decompose(position, quaternion, scale);

    // Convert position from meters to millimeters to match mesh units
    position.multiplyScalar(1000);

    // Apply transforms
    obj.position.copy(position);
    obj.quaternion.copy(quaternion);
    obj.scale.copy(scale);

    // When converting from Z-up to Y-up, rotations around the X axis appear
    // inverted. Negate the X rotation to correct this.
    obj.rotation.x = -obj.rotation.x;

    nodeObjects.set(node.name, obj);

    // Handle Beam geometry nodes - these are light emitters (pixels)
    // Only create emitter meshes for beams that have a controlled element, which
    // indicates they're controlled by the current DMX mode. Beams without
    // controlled elements are not active in this mode and should not be rendered.
    if (node.geometryType === "beam" && node.controlledElement) {
      // Create emitter mesh for this beam (rendered as a light source)
      // Add to the geometry node so it inherits the proper transform chain
      const emitterMesh = createEmitterMesh(node);
      obj.add(emitterMesh);

      emitters.set(node.name, {
        mesh: emitterMesh,
        controlledElement: node.controlledElement,
        nodeGroup: obj,
      });
    }
    // Handle other geometry nodes with models (non-beam nodes)
    else if (node.model) {
      const primitiveMesh = createPrimitiveMesh(node.model);
      primitiveMesh.name = `${node.name}_primitive`;
      obj.add(primitiveMesh);

      // Determine which mesh to load:
      // 1. If GDTF provides a mesh file, load from GDTF archive
      // 2. Otherwise, try to load bundled asset model for the primitive type
      const meshFileName = node.model.meshFile;
      const primitiveType = node.model.primitiveType;

      if (meshFileName && geometry.gdtf) {
        // Load mesh from GDTF archive
        loadMesh(geometry.gdtf, meshFileName).then((meshGroup) => {
          if (meshGroup) {
            if (disposedInstances.has(group)) {
              disposeFixtureMesh(meshGroup);
              return;
            }
            replacePrimitiveWithMesh(obj, node.name, meshGroup);
          }
        });
      } else if (PRIMITIVE_ASSET_PATHS[primitiveType]) {
        // Load bundled asset model for this primitive type
        loadAssetModel(primitiveType).then((meshGroup) => {
          if (meshGroup) {
            if (disposedInstances.has(group)) {
              disposeFixtureMesh(meshGroup);
              return;
            }
            // Scale the asset model to match GDTF model dimensions
            // Asset models are normalized, we need to scale them to match
            // the GDTF-specified dimensions
            const model = node.model!;
            // Compute a uniform scale based on the model dimensions
            // We use the largest dimension to avoid distortion
            const maxDim = Math.max(model.width, model.length, model.height);
            if (maxDim > 0) {
              meshGroup.scale.setScalar(maxDim);
            }
            replacePrimitiveWithMesh(obj, node.name, meshGroup);
          }
        });
      }
    }
  }

  // Establish parent-child relationships
  for (const node of geometry.nodes) {
    const obj = nodeObjects.get(node.name);
    if (!obj) continue;

    if (node.parentIndex >= 0 && node.parentIndex < geometry.nodes.length) {
      const parentNode = geometry.nodes[node.parentIndex];
      const parentObj = nodeObjects.get(parentNode.name);
      if (parentObj) {
        parentObj.add(obj);
      }
    }
  }

  // Add root nodes to main group
  for (const rootIndex of geometry.roots) {
    if (rootIndex < geometry.nodes.length) {
      const rootNode = geometry.nodes[rootIndex];
      const rootObj = nodeObjects.get(rootNode.name);
      if (rootObj) {
        group.add(rootObj);
      }
    }
  }

  // Note: Coordinate system conversion from GDTF (Z-up) to Three.js (Y-up)
  // is handled in SceneManager.applyPlacement(), which combines the base
  // -90° X rotation with any user-specified placement rotation.

  // Scale from millimeters to meters.
  // Both meshes (from 3DS files) and transforms (converted above) are in mm.
  group.scale.setScalar(0.001);

  return {
    uid: fixtureUid,
    group,
    nodeObjects,
    emitters,
  };
}

/**
 * RGB color values normalized to 0-1 range, with optional pan/tilt/zoom/frost.
 */
export interface EmitterColor {
  red: number;
  green: number;
  blue: number;
  intensity: number;
  /** White emitter level normalized to 0-1 when the element exposes a white channel. */
  white?: number;
  /** Pan position normalized against the attribute max, with 0 as neutral */
  pan?: number;
  /** Tilt position normalized against the attribute max, with 0 as neutral */
  tilt?: number;
  /** Zoom position (0-1, 0 = wide/unfocused, 1 = narrow/focused) */
  zoom?: number;
  /** Frost amount (0-1, 0 = clear, 1 = full frost) */
  frost?: number;
}

/**
 * Update emitter colors for a fixture instance.
 * Maps element names to color values and updates corresponding emitter meshes.
 *
 * @param instance - The fixture instance containing emitters
 * @param elementColors - Map of element name to color values
 */
export function updateEmitterColors(
  instance: FixtureInstance,
  elementColors: Map<string, EmitterColor>,
): void {
  for (const [_nodeName, emitter] of instance.emitters) {
    const color = elementColors.get(emitter.controlledElement);
    if (!color) continue;

    const material = emitter.mesh.material as MeshStandardMaterial;
    // Apply color with intensity, clamped to valid RGB range [0, 1]
    const r = Math.min(1, color.red * color.intensity);
    const g = Math.min(1, color.green * color.intensity);
    const b = Math.min(1, color.blue * color.intensity);
    // Update both color and emissive for MeshStandardMaterial
    // Use emissiveIntensity for brightness boost instead of exceeding RGB range
    material.color.setRGB(r, g, b);
    material.emissive.setRGB(r, g, b);
    material.emissiveIntensity = 2.0;
  }
}

/**
 * Dispose the all resources in a fixture instance.
 */
export function disposeFixtureInstance(instance: FixtureInstance): void {
  if (disposedInstances.has(instance.group)) return;
  disposedInstances.add(instance.group);
  disposeFixtureMesh(instance.group);
}

/** Default pan/tilt range in degrees for GDTF fixtures without specified ranges */
const DEFAULT_PAN_RANGE_DEG = 540;
const DEFAULT_TILT_RANGE_DEG = 270;
const DEFAULT_PAN_SPEED_DEG_PER_SEC = 180;
const DEFAULT_TILT_SPEED_DEG_PER_SEC = 180;

type PanTiltSmoothingState = {
  currentPan: number;
  currentTilt: number;
  lastUpdateTime: number;
  panSpeedDegPerSec: number;
  tiltSpeedDegPerSec: number;
};

type FixtureInstanceWithPanTilt = FixtureInstance & {
  panTiltState?: PanTiltSmoothingState;
};

function getPanTiltState(
  instance: FixtureInstanceWithPanTilt,
): PanTiltSmoothingState {
  if (!instance.panTiltState) {
    instance.panTiltState = {
      currentPan: 0,
      currentTilt: 0,
      lastUpdateTime: 0,
      panSpeedDegPerSec: DEFAULT_PAN_SPEED_DEG_PER_SEC,
      tiltSpeedDegPerSec: DEFAULT_TILT_SPEED_DEG_PER_SEC,
    };
  }

  return instance.panTiltState;
}

/**
 * Update pan/tilt rotations for GDTF fixture geometry nodes.
 *
 * Finds nodes with axis properties (pan/tilt) in the geometry tree and applies
 * the corresponding rotations based on DMX values.
 *
 * @param instance - The fixture instance to update
 * @param geometry - The GDTF geometry definition containing axis information
 * @param pan - Pan value normalized against the attribute max
 * @param tilt - Tilt value normalized against the attribute max
 */
export function updateGdtfPanTilt(
  instance: FixtureInstance,
  geometry: FixtureGeometry,
  pan: number,
  tilt: number,
): void {
  const panTiltInstance = instance as FixtureInstanceWithPanTilt;
  const state = getPanTiltState(panTiltInstance);

  const now = performance.now();
  const deltaMs = state.lastUpdateTime === 0 ? 0 : now - state.lastUpdateTime;
  const deltaSeconds = deltaMs / 1000;
  state.lastUpdateTime = now;

  // Pan/tilt values are normalized against the attribute max, so zero is the
  // hanging straight-down pose and signed values move away from that pose.
  const panDegrees = pan * DEFAULT_PAN_RANGE_DEG;
  const targetPan = (panDegrees * Math.PI) / 180;

  const tiltDegrees = tilt * DEFAULT_TILT_RANGE_DEG;
  const targetTilt = (tiltDegrees * Math.PI) / 180;

  if (deltaSeconds > 0) {
    const maxPanStep = MathUtils.degToRad(
      state.panSpeedDegPerSec * deltaSeconds,
    );
    const panDelta = targetPan - state.currentPan;
    state.currentPan += MathUtils.clamp(panDelta, -maxPanStep, maxPanStep);

    const maxTiltStep = MathUtils.degToRad(
      state.tiltSpeedDegPerSec * deltaSeconds,
    );
    const tiltDelta = targetTilt - state.currentTilt;
    state.currentTilt += MathUtils.clamp(tiltDelta, -maxTiltStep, maxTiltStep);
  } else {
    state.currentPan = targetPan;
    state.currentTilt = targetTilt;
  }

  // Find and update nodes with axis properties
  for (const node of geometry.nodes) {
    if (!node.axis) continue;

    const obj = instance.nodeObjects.get(node.name);
    if (!obj) continue;

    switch (node.axis) {
      case AxisType.Pan:
        obj.rotation.y = state.currentPan;
        break;
      case AxisType.Tilt:
        obj.rotation.x = state.currentTilt;
        break;
      case AxisType.Roll:
        // Roll not currently supported via DMX
        break;
    }
  }
}
