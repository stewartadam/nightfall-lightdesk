// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  BoxGeometry,
  BufferGeometry,
  type EventDispatcher,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Texture,
} from "three";
import { disposeObjectResources } from "./three-dispose";

/** Counts the dispose events a three.js resource emits. */
function disposeCount(resource: EventDispatcher<{ dispose: object }>) {
  const counter = { count: 0 };
  resource.addEventListener("dispose", () => {
    counter.count += 1;
  });
  return counter;
}

/** Verifies a loaded model's textures are released along with its geometry and material. */
test("disposeObjectResources releases material textures", () => {
  const map = new Texture();
  const normalMap = new Texture();
  const material = new MeshStandardMaterial({ map, normalMap });
  const geometry = new BoxGeometry();
  const group = new Group();
  group.add(new Mesh(geometry, material));

  const counts = [map, normalMap, material, geometry].map(disposeCount);
  disposeObjectResources(group);

  assert.deepEqual(
    counts.map(({ count }) => count),
    [1, 1, 1, 1],
  );
});

/** Verifies line and point primitives from a model are released like meshes. */
test("disposeObjectResources releases lines and points", () => {
  const lineGeometry = new BufferGeometry();
  const pointsGeometry = new BufferGeometry();
  const pointsMaterial = new PointsMaterial();
  const group = new Group();
  group.add(new Line(lineGeometry, new LineBasicMaterial()));
  group.add(new Points(pointsGeometry, pointsMaterial));

  const counts = [lineGeometry, pointsGeometry, pointsMaterial].map(
    disposeCount,
  );
  disposeObjectResources(group);

  assert.deepEqual(
    counts.map(({ count }) => count),
    [1, 1, 1],
  );
});

/** Verifies kept (shared) materials and their textures survive, and a reused material is released once. */
test("disposeObjectResources skips kept materials and disposes shared ones once", () => {
  const sharedMap = new Texture();
  const shared = new MeshStandardMaterial({ map: sharedMap });
  const reused = new MeshStandardMaterial();
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(), shared));
  group.add(new Mesh(new BoxGeometry(), reused));
  group.add(new Mesh(new BoxGeometry(), [reused]));

  const sharedCount = disposeCount(shared);
  const sharedMapCount = disposeCount(sharedMap);
  const reusedCount = disposeCount(reused);
  disposeObjectResources(group, { keepMaterials: new Set([shared]) });

  assert.equal(sharedCount.count, 0);
  assert.equal(sharedMapCount.count, 0);
  assert.equal(reusedCount.count, 1);
});
