// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Mesh loading utilities for GDTF fixtures.
 * Handles loading GLB/3DS meshes from the backend with caching.
 */

import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { TDSLoader } from "three/examples/jsm/loaders/TDSLoader.js";
import {
  Box3,
  DoubleSide,
  Group,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
} from "three/webgpu";
import { getBackendUrl } from "../../../lib/api";
import { getLogger } from "../../../lib/logger";

const log = getLogger(import.meta.url);

// Shared loaders
const gltfLoader = new GLTFLoader();
const tdsLoader = new TDSLoader();

// Mesh cache: gdtfPath:modelName -> Promise<Group>
const meshCache = new Map<string, Promise<Group>>();

/** Declared size of a GDTF model in metres, used to detect the unit a mesh was authored in. */
export interface ModelDimensions {
  length: number;
  width: number;
  height: number;
}

/** Scale converting spec-conforming glTF metres into the geometry tree's millimetres. */
const METRES_TO_MILLIMETRES = 1000;

/**
 * Returns the scale that brings a glTF scene into the geometry tree's millimetres.
 *
 * GDTF requires glTF meshes in metres, but some archives ship meshes authored
 * in millimetres. The scene's largest bounding-box extent is compared with the
 * largest dimension the GDTF model declares: a metre mesh measures about the
 * declared size and a millimetre mesh about 1000 times it. The boundary is
 * their geometric mean, so either unit is chosen within a factor of ~31. Missing,
 * zero or non-finite dimensions and empty scenes keep the metre scale.
 */
export function gltfUnitScale(
  scene: Object3D,
  dimensions?: ModelDimensions,
): number {
  const declared = dimensions
    ? Math.max(dimensions.length, dimensions.width, dimensions.height)
    : 0;
  if (!Number.isFinite(declared) || declared <= 0) {
    return METRES_TO_MILLIMETRES;
  }
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(scene);
  if (box.isEmpty()) return METRES_TO_MILLIMETRES;
  const size = box.getSize(new Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  const ratio = extent / declared;
  return ratio > Math.sqrt(METRES_TO_MILLIMETRES) ? 1 : METRES_TO_MILLIMETRES;
}

/**
 * Converts a glTF scene from a GDTF archive into the geometry tree's space.
 *
 * glTF is Y-up and in metres, while the GDTF geometry tree is Z-up and built
 * in millimetres (3DS meshes already are). The scene is wrapped in a group
 * that rotates Y-up back to Z-up and scales it to millimetres; scenes authored
 * in millimetres are detected from the model's declared dimensions and left
 * unscaled (see {@link gltfUnitScale}). Cameras and lights exported alongside
 * the model are removed so they cannot affect the visualizer scene.
 */
export function normalizeGdtfGltfScene(
  scene: Group,
  dimensions?: ModelDimensions,
  label = "glTF mesh",
): Group {
  const strays: Object3D[] = [];
  scene.traverse((object) => {
    const flags = object as Object3D & {
      isCamera?: boolean;
      isLight?: boolean;
    };
    if (flags.isCamera || flags.isLight) strays.push(object);
  });
  for (const object of strays) object.removeFromParent();

  const scale = gltfUnitScale(scene, dimensions);
  if (scale !== METRES_TO_MILLIMETRES) {
    log.warn(
      `${label} is authored in millimetres rather than metres; loading it unscaled to match its declared model size`,
    );
  }

  const wrapper = new Group();
  wrapper.rotation.x = Math.PI / 2;
  wrapper.scale.setScalar(scale);
  wrapper.add(scene);
  return wrapper;
}

/**
 * Create a MeshStandardMaterial that preserves transparency from the original material.
 */
function createFixtureMaterial(original: Material): MeshStandardMaterial {
  const isTransparent =
    ("transparent" in original && original.transparent) ||
    ("opacity" in original && (original.opacity as number) < 1);
  const opacity = "opacity" in original ? (original.opacity as number) : 1;

  const mat = new MeshStandardMaterial({
    color: 0x3a3a3a,
    metalness: 0.6,
    roughness: 0.4,
  });

  if (isTransparent) {
    mat.transparent = true;
    mat.opacity = opacity;
    mat.side = DoubleSide;
  }

  return mat;
}

/**
 * Replace all mesh materials with standard fixture materials.
 * Preserves transparency from the original materials.
 */
function applyFixtureMaterial(group: Group): void {
  group.traverse((child) => {
    if ("isMesh" in child && (child as Mesh).isMesh) {
      const mesh = child as Mesh;
      if (Array.isArray(mesh.material)) {
        const newMaterials = mesh.material.map((mat) => {
          const newMat = createFixtureMaterial(mat);
          mat.dispose();
          return newMat;
        });
        mesh.material = newMaterials;
      } else if (mesh.material) {
        const oldMat = mesh.material as Material;
        mesh.material = createFixtureMaterial(oldMat);
        oldMat.dispose();
      }
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
  });
}

/**
 * Encode a file path to base64url format for safe URL usage.
 */
function encodeGdtfPath(path: string): string {
  const base64 = btoa(path);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns a query string versioning archive resource URLs by content revision. */
function revisionQuery(revision?: string): string {
  return revision ? `?v=${encodeURIComponent(revision)}` : "";
}

/** Returns the backend URL serving a wheel slot image (e.g. a gobo) from a GDTF archive revision. */
export function gdtfWheelMediaUrl(
  gdtfPath: string,
  mediaName: string,
  revision?: string,
): string {
  return `${getBackendUrl()}/api/gdtf-wheel/${encodeGdtfPath(gdtfPath)}/${encodeURIComponent(mediaName)}${revisionQuery(revision)}`;
}

/**
 * Load a fixture mesh from the backend GDTF archive.
 * Tries GLB first, then falls back to 3DS if available.
 *
 * @param gdtfPath - Path to the GDTF file on the server
 * @param modelName - Name of the model/mesh to load (without extension)
 * @param revision - Library revision of the archive; versions the request URL
 *   and cache key so a replaced archive is not served from a stale cache
 * @param dimensions - Declared model size in metres, used to detect glTF
 *   meshes authored in millimetres; part of the cache key because models of
 *   different sizes may share one mesh file
 * @returns A cloned Group containing the mesh, or null if loading failed
 */
export async function loadMesh(
  gdtfPath: string,
  modelName: string,
  revision?: string,
  dimensions?: ModelDimensions,
): Promise<Group | null> {
  const dimensionKey = dimensions
    ? `${dimensions.length}x${dimensions.width}x${dimensions.height}`
    : "";
  const cacheKey = `${gdtfPath}:${revision ?? ""}:${modelName}:${dimensionKey}`;

  if (meshCache.has(cacheKey)) {
    try {
      const cached = await meshCache.get(cacheKey);
      return cached?.clone() ?? null;
    } catch {
      // Cache entry failed, will retry below
      meshCache.delete(cacheKey);
    }
  }

  const encodedPath = encodeGdtfPath(gdtfPath);
  const url = `${getBackendUrl()}/api/mesh/${encodedPath}/${encodeURIComponent(modelName)}${revisionQuery(revision)}`;

  const loadPromise = new Promise<Group>((resolve, reject) => {
    // Try loading as GLB/GLTF first
    gltfLoader.load(
      url,
      (gltf) => {
        applyFixtureMaterial(gltf.scene);
        resolve(
          normalizeGdtfGltfScene(
            gltf.scene,
            dimensions,
            `Mesh ${modelName} from ${gdtfPath}`,
          ),
        );
      },
      undefined,
      () => {
        // GLB failed, try 3DS as fallback
        tdsLoader.load(
          url,
          (object: Group) => {
            // 3DS files in GDTF are authored in Z-up coordinate system.
            // TDSLoader loads the raw vertex data without coordinate conversion,
            // so the mesh is already in Z-up space (matching GDTF transforms).
            // The final group rotation (-90° X) converts everything to Y-up.
            applyFixtureMaterial(object);
            resolve(object);
          },
          undefined,
          () => {
            log.warn(`Failed to load mesh ${modelName} from ${gdtfPath}`);
            reject(new Error("Failed to load mesh"));
          },
        );
      },
    );
  });

  meshCache.set(cacheKey, loadPromise);

  try {
    const loaded = await loadPromise;
    return loaded.clone();
  } catch {
    meshCache.delete(cacheKey);
    return null;
  }
}
