// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type InstancedMesh, Object3D, Scene, Vector3 } from "three/webgpu";
import { emitterDistributionArea } from "./emitter-optics";
import { EmitterVolumeBatch } from "./emitter-volume-batch";
import { compilePrismFacet, PrismStack } from "./prism-optics";

/** Budget reduction samples the full combination range and still applies later optical stages. */
test("oversized prism stacks retain bounded contributions from every stage", () => {
  const facets = Array.from({ length: 4 }, (_, x) => ({
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    x,
    y: 0,
    determinant: 1,
    red: 1,
    green: 1,
    blue: 1,
  }));
  const stages = [
    { facets, rotation: 0 },
    {
      facets: facets.map((facet) => ({ ...facet, x: 0, y: facet.x })),
      rotation: Math.PI / 2,
    },
  ];
  const stack = new PrismStack(3, [3], true);
  const result = stack.compose(stages)!;
  assert.equal(result.length, 3);
  assert.ok(
    result.every(
      (facet) => Number.isFinite(facet.x) && Number.isFinite(facet.y),
    ),
  );
  assert.ok(result.some((facet) => Math.abs(facet.x) > 0.5));
  assert.ok(result.some((facet) => Math.abs(facet.y) > 0.5));
  assert.equal(stack.compose(stages), result);
  stages[1].rotation = 0;
  const straight = stack.compose(stages)!;
  assert.ok(straight.every((facet) => facet.x >= 0 && facet.y >= 0));
  assert.ok(straight.some((facet) => facet.x >= 2 && facet.y >= 2));
});

/** Stacked prisms multiply beam count, apply transforms in optical order, and multiply transmission. */
test("prism stack composes affine stages into reusable facet records", () => {
  const first = [-1, 1].map((x) => ({
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    x,
    y: 0,
    determinant: 1,
    red: 0.5,
    green: 1,
    blue: 1,
  }));
  const second = [-2, 0, 2].map((y) => ({
    a: 2,
    b: 0,
    c: 0,
    d: 1,
    x: 0,
    y,
    determinant: 2,
    red: 1,
    green: 0.25,
    blue: 1,
  }));
  const stack = new PrismStack(6, [2, 3, 6]);
  const stages = [
    { facets: first, rotation: 0 },
    { facets: second, rotation: Math.PI / 2 },
  ];
  const output = stack.compose(stages)!;
  assert.equal(output.length, 6);
  assert.ok(Math.abs(output[0].x - 2) < 1e-12);
  assert.ok(Math.abs(output[0].y + 2) < 1e-12);
  assert.ok(Math.abs(output[5].x + 2) < 1e-12);
  assert.ok(Math.abs(output[5].y - 2) < 1e-12);
  assert.equal(output[0].determinant, 2);
  assert.equal(output[0].red, 0.5);
  assert.equal(output[0].green, 0.25);
  const facet = output[0];
  stages[1].rotation = 0;
  assert.equal(stack.compose(stages), output);
  assert.equal(output[0], facet);
  assert.equal(output[0].x, -2);
  assert.equal(output[0].y, -2);
  const single = stack.compose([stages[0]])!;
  assert.equal(single.length, 2);
  assert.equal(output.length, 6);
  assert.equal(stack.compose([stages[0]]), single);
  assert.equal(stack.compose([]), undefined);
  assert.equal(stack.compose(stages), output);
  assert.throws(() => stack.compose([...stages, stages[0]]), /capacity/);
  assert.equal(output[0].x, -2);
});

/** Frost spreads conserved flux without mutating source zoom data or calibrated focus. */
test("frost broadens the shared distribution while retaining flux and focus", () => {
  const scene = new Scene();
  const batch = new EmitterVolumeBatch(scene);
  const optics = {
    shape: "round" as const,
    radius: 0.02,
    slopeX: 0.1,
    slopeY: 0.2,
    halfPowerRatio: 0.5,
    distributionPower: 8,
    lumens: 1000,
  };
  const color = { red: 1, green: 1, blue: 1, intensity: 1, frost: 1 };
  batch.update(
    "fixture:beam",
    new Object3D(),
    optics,
    color,
    30,
    2,
    0,
    0,
    undefined,
    0,
    10,
  );
  const geometry = (scene.children[0] as InstancedMesh).geometry;
  const distribution = geometry.getAttribute("volumeOptics");
  const pattern = geometry.getAttribute("volumePattern");
  const radiance = geometry.getAttribute("volumeRadiance");
  assert.ok(Math.abs(distribution.getX(0) - 0.3) < 1e-6);
  assert.ok(Math.abs(distribution.getY(0) - 0.6) < 1e-6);
  assert.ok(
    Math.abs(radiance.getX(0) * emitterDistributionArea("round", 2) - 1) < 1e-6,
  );
  assert.equal(distribution.getW(0), 2);
  assert.equal(pattern.getZ(0), 10);
  assert.equal(pattern.getW(0), 1);
  color.frost = 0;
  batch.update(
    "fixture:beam",
    new Object3D(),
    optics,
    color,
    30,
    2,
    0,
    0,
    undefined,
    0,
    10,
  );
  assert.equal(distribution.getW(0), 8);
  assert.ok(Math.abs(distribution.getX(0) - 0.2) < 1e-6);
  assert.ok(Math.abs(distribution.getY(0) - 0.4) < 1e-6);
  assert.ok(
    Math.abs(radiance.getX(0) * emitterDistributionArea("round", 8) - 1) < 1e-6,
  );
  assert.equal(optics.slopeX, 0.1);
  assert.equal(optics.slopeY, 0.2);
  assert.equal(pattern.getW(0), 0);
  assert.equal(pattern.getZ(0), 10);
  batch.dispose();
});

/** First activation of a preloaded split reuses buffers and traverses its parent hierarchy once. */
test("prepared prism capacity avoids playback buffer growth and repeated world updates", () => {
  const scene = new Scene();
  const batch = new EmitterVolumeBatch(scene);
  batch.reserve("fixture:beam", 300);
  const mesh = scene.children[0] as InstancedMesh;
  const instanceBuffer = mesh.instanceMatrix;
  assert.equal(mesh.count, 0);
  let poseUpdates = 0;
  class TrackedParent extends Object3D {
    /** Counts actual hierarchy traversals without replacing Three.js pose computation. */
    override updateWorldMatrix(parents: boolean, children: boolean): void {
      poseUpdates++;
      super.updateWorldMatrix(parents, children);
    }
  }
  const parent = new TrackedParent();
  const facet = compilePrismFacet({
    transform: [1, 0, 0, 0, 1, 0, 2, 0, 1],
    colorCie: [0.3127, 0.329, 100],
  })!;
  const optics = {
    shape: "round" as const,
    radius: 0.02,
    slopeX: 0.1,
    slopeY: 0.1,
    halfPowerRatio: 0.5,
    distributionPower: 4,
    lumens: 1000,
  };
  const color = { red: 1, green: 1, blue: 1, intensity: 1 };
  batch.update(
    "fixture:beam",
    parent,
    optics,
    color,
    30,
    1,
    0,
    0,
    Array(300).fill(facet),
  );
  assert.equal(scene.children[0], mesh);
  assert.equal(mesh.instanceMatrix, instanceBuffer);
  assert.equal(mesh.count, 300);
  assert.equal(poseUpdates, 1);
  batch.update("fixture:beam", parent, optics, color);
  assert.equal(mesh.count, 1);
  assert.equal(poseUpdates, 2);
  batch.sync(new Map());
  assert.equal(mesh.count, 0);
  batch.dispose();
});

/** Affine facet coordinates recover the original gobo point after projection and indexed rotation. */
test("prism projection preserves the source coordinates through shear, scale and rotation", () => {
  const facet = compilePrismFacet({
    transform: [2, 0.5, 0, 0.25, 1, 0, 3, -2, 1],
    colorCie: [0.3127, 0.329, 100],
  })!;
  assert.ok(facet);
  const scene = new Scene();
  const batch = new EmitterVolumeBatch(scene);
  const optics = {
    shape: "round" as const,
    radius: 0.02,
    slopeX: 0.1,
    slopeY: 0.1,
    halfPowerRatio: 0.5,
    distributionPower: 4,
    lumens: 1000,
  };
  batch.update(
    "fixture:beam",
    new Object3D(),
    optics,
    { red: 1, green: 1, blue: 1, intensity: 1 },
    30,
    1,
    0,
    0,
    [facet],
    Math.PI / 2,
  );
  const mesh = scene.children[0] as InstancedMesh;
  const geometry = mesh.geometry;
  const origin = new Vector3().fromBufferAttribute(
    geometry.getAttribute("volumeOrigin"),
    0,
  );
  const right = new Vector3().fromBufferAttribute(
    geometry.getAttribute("volumeRight"),
    0,
  );
  const up = new Vector3().fromBufferAttribute(
    geometry.getAttribute("volumeUp"),
    0,
  );
  const z = 10,
    width = optics.radius + z * optics.slopeX;
  const sourceX = 0.2 * width,
    sourceY = -0.4 * width;
  const projectedX =
    facet.a * sourceX +
    facet.b * sourceY +
    facet.x * optics.halfPowerRatio * width;
  const projectedY =
    facet.c * sourceX +
    facet.d * sourceY +
    facet.y * optics.halfPowerRatio * width;
  const point = new Vector3(-projectedY, projectedX, -z).sub(origin);
  assert.ok(Math.abs(point.dot(right) - sourceX) < 1e-6);
  assert.ok(Math.abs(point.dot(up) - sourceY) < 1e-6);
  batch.update(
    "fixture:beam",
    new Object3D(),
    optics,
    { red: 1, green: 1, blue: 1, intensity: 1 },
    30,
    1,
    0,
    0,
    [facet, facet, facet],
  );
  assert.equal(mesh.count, 3);
  batch.update("fixture:beam", new Object3D(), optics, {
    red: 1,
    green: 1,
    blue: 1,
    intensity: 1,
  });
  assert.equal(mesh.count, 1);
  batch.remove("fixture:beam");
  assert.equal(mesh.count, 0);
  batch.dispose();
});

/** Invalid projective or collapsed matrices never enter the atmospheric draw. */
test("prism compilation rejects singular and non-affine transforms", () => {
  assert.equal(
    compilePrismFacet({
      transform: [0, 0, 0, 0, 0, 0, 0, 0, 1],
      colorCie: [0.3127, 0.329, 100],
    }),
    undefined,
  );
  assert.equal(
    compilePrismFacet({
      transform: [1, 0, 1, 0, 1, 0, 0, 0, 1],
      colorCie: [0.3127, 0.329, 100],
    }),
    undefined,
  );
});
