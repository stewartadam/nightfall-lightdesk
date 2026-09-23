// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  BufferGeometry,
  Group,
  Material,
  Mesh,
  Object3D,
} from "three/webgpu";

const geometryOwners = new WeakMap<BufferGeometry, number>();
const retainedTrees = new WeakSet<Object3D>();
const disposedTrees = new WeakSet<Object3D>();

/** Collect each mesh resource once, including resources reused by multiple parts of a model. */
function resources(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]) {
      materials.add(material);
    }
  });
  return { geometries, materials };
}

/** Retain one ownership reference per geometry in a cached template or cloned instance. */
function retainTree(root: Object3D): void {
  if (retainedTrees.has(root)) return;
  retainedTrees.add(root);
  for (const geometry of resources(root).geometries) {
    geometryOwners.set(geometry, (geometryOwners.get(geometry) ?? 0) + 1);
  }
}

/** Share immutable geometry while cloning mutable fixture materials independently for each instance. */
export function cloneFixtureMesh(template: Group): Group {
  retainTree(template);
  const copy = template.clone();
  const materials = new Map<Material, Material>();
  /** Preserve intentional material reuse within one copy without sharing it with another fixture. */
  const cloneMaterial = (source: Material): Material => {
    let material = materials.get(source);
    if (!material) {
      material = source.clone();
      materials.set(source, material);
    }
    return material;
  };
  copy.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(cloneMaterial)
      : cloneMaterial(mesh.material);
  });
  retainTree(copy);
  return copy;
}

/** Release one model's materials and geometry ownership; cached or other live owners keep geometry alive. */
export function disposeFixtureMesh(root: Object3D): void {
  if (disposedTrees.has(root)) return;
  disposedTrees.add(root);
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  /** Release nested retained models separately so each ownership reference is decremented exactly once. */
  const collect = (object: Object3D): void => {
    if (object !== root && retainedTrees.has(object)) {
      disposeFixtureMesh(object);
      return;
    }
    const mesh = object as Mesh;
    if (mesh.isMesh) {
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]) {
        materials.add(material);
      }
    }
    for (const child of object.children) collect(child);
  };
  collect(root);
  for (const material of materials) material.dispose();
  for (const geometry of geometries) {
    const owners = geometryOwners.get(geometry);
    if (owners !== undefined && owners > 1) {
      geometryOwners.set(geometry, owners - 1);
    } else {
      geometryOwners.delete(geometry);
      geometry.dispose();
    }
  }
}
