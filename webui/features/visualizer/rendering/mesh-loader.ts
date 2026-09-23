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
  DoubleSide,
  type Group,
  type Material,
  type Mesh,
  MeshStandardMaterial,
} from "three/webgpu";
import { getBackendUrl } from "../../../lib/api";
import { getLogger } from "../../../lib/logger";
import type { GdtfGeometrySource } from "../../../types/index";
import { meshResourceKey, meshResourcePath } from "./mesh-resource";

const log = getLogger(import.meta.url);

// Shared loaders
const gltfLoader = new GLTFLoader();
const tdsLoader = new TDSLoader();

// Mesh cache: archive revision and model name -> Promise<Group>
const meshCache = new Map<string, Promise<Group>>();

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
 * Load a fixture mesh from the backend GDTF archive.
 * Tries GLB first, then falls back to 3DS if available.
 *
 * @param source - Indexed archive path and the exact revision used to build this geometry
 * @param modelName - Name of the model/mesh to load (without extension)
 * @returns A cloned Group containing the mesh, or null if loading failed
 */
export async function loadMesh(
  source: GdtfGeometrySource,
  modelName: string,
): Promise<Group | null> {
  const cacheKey = meshResourceKey(source, modelName);

  if (meshCache.has(cacheKey)) {
    try {
      const cached = await meshCache.get(cacheKey);
      return cached?.clone() ?? null;
    } catch {
      // Cache entry failed, will retry below
      meshCache.delete(cacheKey);
    }
  }

  const url = `${getBackendUrl()}${meshResourcePath(source, modelName)}`;

  const loadPromise = new Promise<Group>((resolve, reject) => {
    // Try loading as GLB/GLTF first
    gltfLoader.load(
      url,
      (gltf) => {
        applyFixtureMaterial(gltf.scene);
        resolve(gltf.scene);
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
            log.warn(
              `Failed to load mesh ${modelName} from ${source.path} at revision ${source.archiveSha256}`,
            );
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
