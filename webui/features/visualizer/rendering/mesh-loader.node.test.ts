// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Unit detection tests for GDTF glTF meshes: spec-conforming meshes are in
 * metres, but some archives ship millimetre meshes that must not be scaled.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Box3, BoxGeometry, Group, Mesh, Vector3 } from "three/webgpu";
import {
  gltfUnitScale,
  type ModelDimensions,
  normalizeGdtfGltfScene,
} from "./mesh-loader";

/** Declared size of a 0.374 x 0.307 x 0.11 m fixture base (the MagicPanel FX base). */
const BASE: ModelDimensions = { length: 0.374, width: 0.307, height: 0.11 };

/** Builds a glTF-like scene holding one box mesh of the given size in scene units. */
function boxScene(x: number, y: number, z: number): Group {
  const scene = new Group();
  scene.add(new Mesh(new BoxGeometry(x, y, z)));
  return scene;
}

/** Returns the size of an object's world-space bounding box. */
function worldSize(object: Group): Vector3 {
  object.updateMatrixWorld(true);
  return new Box3().setFromObject(object).getSize(new Vector3());
}

/** Verifies a mesh authored in metres is scaled to millimetres. */
test("metre meshes scale by 1000", () => {
  assert.equal(gltfUnitScale(boxScene(0.374, 0.11, 0.307), BASE), 1000);
});

/** Verifies a mesh authored in millimetres is left at its native scale. */
test("millimetre meshes keep their scale", () => {
  assert.equal(gltfUnitScale(boxScene(374, 110, 307), BASE), 1);
});

/** Verifies meshes loosely matching their declared size still pick the nearer unit. */
test("unit detection tolerates meshes that differ from the declared size", () => {
  assert.equal(gltfUnitScale(boxScene(3, 0.1, 0.1), BASE), 1000);
  assert.equal(gltfUnitScale(boxScene(40, 10, 10), BASE), 1);
});

/** Verifies missing, zero or non-finite dimensions and empty scenes fall back to metres. */
test("unit detection falls back to metres without usable dimensions", () => {
  const millimetres = boxScene(374, 110, 307);
  assert.equal(gltfUnitScale(millimetres), 1000);
  assert.equal(
    gltfUnitScale(millimetres, { length: 0, width: 0, height: 0 }),
    1000,
  );
  assert.equal(
    gltfUnitScale(millimetres, { length: Number.NaN, width: 0, height: 0 }),
    1000,
  );
  assert.equal(gltfUnitScale(new Group(), BASE), 1000);
});

/** Verifies both units normalize to the same millimetre-sized, Z-up object. */
test("metre and millimetre meshes normalize to the same size", () => {
  const metres = worldSize(
    normalizeGdtfGltfScene(boxScene(0.374, 0.11, 0.307), BASE),
  );
  const millimetres = worldSize(
    normalizeGdtfGltfScene(boxScene(374, 110, 307), BASE),
  );
  for (const size of [metres, millimetres]) {
    assert.ok(Math.abs(size.x - 374) < 1e-3, `x ${size.x}`);
    assert.ok(Math.abs(size.y - 307) < 1e-3, `y ${size.y}`);
    assert.ok(Math.abs(size.z - 110) < 1e-3, `z ${size.z}`);
  }
});
