// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three/webgpu";
import { cloneFixtureMesh, disposeFixtureMesh } from "./mesh-ownership";

/** Copies isolate mutable materials, while shared geometry survives until its final owner is released. */
test("fixture mesh copies have independent materials and reference-counted geometry", () => {
  const geometry = new BoxGeometry();
  const material = new MeshStandardMaterial();
  const template = new Group();
  template.add(
    new Mesh(geometry, material),
    new Mesh(geometry, [material, material]),
  );
  const first = cloneFixtureMesh(template);
  const second = cloneFixtureMesh(template);
  const firstMesh = first.children[0] as Mesh<
    BoxGeometry,
    MeshStandardMaterial
  >;
  const secondMesh = second.children[0] as Mesh<
    BoxGeometry,
    MeshStandardMaterial
  >;
  assert.equal(firstMesh.geometry, secondMesh.geometry);
  assert.notEqual(firstMesh.material, secondMesh.material);
  assert.notEqual(firstMesh.material, material);
  firstMesh.material.opacity = 0.25;
  assert.equal(secondMesh.material.opacity, 1);
  assert.deepEqual((first.children[1] as Mesh).material, [
    firstMesh.material,
    firstMesh.material,
  ]);
  let geometryDisposals = 0;
  let materialDisposals = 0;
  geometry.addEventListener("dispose", () => {
    geometryDisposals++;
  });
  firstMesh.material.addEventListener("dispose", () => {
    materialDisposals++;
  });
  const fixture = new Group();
  fixture.add(first);
  disposeFixtureMesh(fixture);
  disposeFixtureMesh(fixture);
  assert.equal(materialDisposals, 1);
  assert.equal(geometryDisposals, 0);
  disposeFixtureMesh(template);
  assert.equal(geometryDisposals, 0);
  disposeFixtureMesh(second);
  assert.equal(geometryDisposals, 1);
});

/** Multiple model instances inside one fixture each release their own shared-geometry reference. */
test("nested model ownership releases every copy exactly once", () => {
  const template = new Group();
  const geometry = new BoxGeometry();
  template.add(new Mesh(geometry, new MeshStandardMaterial()));
  const fixture = new Group();
  fixture.add(cloneFixtureMesh(template), cloneFixtureMesh(template));
  const primitiveGeometry = new BoxGeometry();
  const primitiveMaterial = new MeshStandardMaterial();
  fixture.add(new Mesh(primitiveGeometry, primitiveMaterial));
  let sharedDisposals = 0;
  let primitiveDisposals = 0;
  geometry.addEventListener("dispose", () => {
    sharedDisposals++;
  });
  primitiveGeometry.addEventListener("dispose", () => {
    primitiveDisposals++;
  });
  disposeFixtureMesh(template);
  assert.equal(sharedDisposals, 0);
  disposeFixtureMesh(fixture);
  assert.equal(sharedDisposals, 1);
  assert.equal(primitiveDisposals, 1);
  disposeFixtureMesh(fixture);
  assert.equal(sharedDisposals, 1);
  assert.equal(primitiveDisposals, 1);
});
