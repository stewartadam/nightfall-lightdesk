// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  Line,
  type Material,
  Mesh,
  type Object3D,
  Points,
  Texture,
} from "three";

/** Options for {@link disposeObjectResources}. */
export interface DisposeObjectResourcesOptions {
  /** Materials owned elsewhere (shared constants) that must survive disposal, with their textures. */
  keepMaterials?: ReadonlySet<Material>;
}

/**
 * Releases the GPU resources of a material: every texture it references (color, normal,
 * roughness and other maps loaded with a glTF model), then the material itself.
 */
export function disposeMaterialResources(material: Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}

/**
 * Releases the geometry, materials and textures of every mesh, line and point cloud under
 * `object`, so removing a
 * loaded model from the scene doesn't leave its buffers and textures on the GPU. Materials in
 * `keepMaterials` are skipped, and a material shared by several meshes is disposed once.
 */
export function disposeObjectResources(
  object: Object3D,
  options: DisposeObjectResourcesOptions = {},
): void {
  const disposed = new Set<Material>();
  object.traverse((child) => {
    // glTF primitives load as meshes, lines or points; all three own their geometry.
    if (
      !(
        child instanceof Mesh ||
        child instanceof Line ||
        child instanceof Points
      )
    ) {
      return;
    }
    child.geometry?.dispose();
    const materials: Material[] = Array.isArray(child.material)
      ? child.material
      : child.material
        ? [child.material]
        : [];
    for (const material of materials) {
      if (options.keepMaterials?.has(material) || disposed.has(material)) {
        continue;
      }
      disposed.add(material);
      disposeMaterialResources(material);
    }
  });
}
