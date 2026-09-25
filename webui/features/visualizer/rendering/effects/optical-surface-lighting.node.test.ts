// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { float } from "three/tsl";
import {
  AmbientLight,
  DirectionalLight,
  Object3D,
  PointLight,
  Scene,
  Vector3,
} from "three/webgpu";
import { EmitterVolumeBatch } from "./emitter-volume-batch";
import { createOpticalRenderContext } from "./optical-render-context";
import {
  OpticalClusteredLightsNode,
  OpticalSurfaceLight,
} from "./optical-surface-lighting";

/** Excess point sources must not overflow GPU storage or expand the material's analytic light loop. */
test("cluster capacity preserves non-point lighting and resets overflow on removal", () => {
  const node = new OpticalClusteredLightsNode(2, 2);
  const ambient = new AmbientLight();
  const directional = new DirectionalLight();
  const points = [new PointLight(), new PointLight(), new PointLight()];
  const lights = [points[0], ambient, points[1], points[2], directional];
  node.setLights(lights);
  assert.deepEqual(node.clusteredLights, points.slice(0, 2));
  assert.deepEqual(node.materialLights, [ambient, directional]);
  assert.equal(node.omittedPointLights, 1);
  assert.deepEqual(node.getLights(), lights);
  node.setLights([points[2], ambient]);
  assert.deepEqual(node.clusteredLights, [points[2]]);
  assert.equal(node.omittedPointLights, 0);
  node.disposeApertures();
});

/** Cluster spheres must retain wide, sheared and translated prism fields through the full throw. */
test("surface bounds contain transformed prism field corners", () => {
  const scene = new Scene();
  createOpticalRenderContext(scene, float(-100), true);
  const batch = new EmitterVolumeBatch(scene);
  const aperture = new Object3D();
  const optics = {
    shape: "rectangle" as const,
    radius: 0.2,
    slopeX: 0.3,
    slopeY: 0.15,
    halfPowerRatio: 0.5,
    distributionPower: 2,
    lumens: 1000,
  };
  const facet = {
    a: 3,
    b: 1.5,
    c: -0.75,
    d: 2,
    x: 8,
    y: -6,
    determinant: 7.125,
    red: 1,
    green: 1,
    blue: 1,
  };
  batch.update(
    "prism",
    aperture,
    optics,
    { red: 1, green: 1, blue: 1, intensity: 1 },
    30,
    1,
    0,
    0,
    [facet],
  );
  const light = scene.children.find(
    (child) => child instanceof OpticalSurfaceLight,
  ) as OpticalSurfaceLight;
  assert.ok(light);
  for (const z of [0, 15, 30]) {
    const width = optics.radius + z * optics.slopeX;
    const height = optics.radius + z * optics.slopeY;
    for (const u of [-2, 2]) {
      for (const v of [-2, 2]) {
        const corner = new Vector3(
          facet.a * u * width + facet.b * v * height + facet.x * 0.5 * width,
          facet.c * u * width + facet.d * v * height + facet.y * 0.5 * height,
          -z,
        );
        assert.ok(
          corner.distanceTo(light.position) <= light.distance,
          `field corner at ${z}m escaped the cluster sphere`,
        );
      }
    }
  }
  batch.dispose();
});

/** Surface sources share emitter pose and live optics, survive blackout for reuse, and release with the batch. */
test("atmospheric emitters own matching reusable surface lights", () => {
  const scene = new Scene();
  createOpticalRenderContext(scene, float(-100), true);
  const batch = new EmitterVolumeBatch(scene);
  const aperture = new Object3D();
  aperture.position.set(1, 2, 3);
  const optics = {
    shape: "round" as const,
    radius: 0.02,
    slopeX: 0.1,
    slopeY: 0.2,
    halfPowerRatio: 0.5,
    distributionPower: 8,
    lumens: 1000,
  };
  const color = { red: 1, green: 0.5, blue: 0, intensity: 1 };
  batch.update("fixture:aperture", aperture, optics, color, 30, 2);
  const light = scene.children.find(
    (child) => child instanceof OpticalSurfaceLight,
  )! as OpticalSurfaceLight;
  assert.ok(light);
  assert.deepEqual(light.position.toArray(), [1, 2, 3]);
  assert.equal(light.optics.slopeX, 0.2);
  assert.equal(light.optics.slopeY, 0.4);
  assert.equal(light.optics.distributionPower, 8);
  batch.remove("fixture:aperture");
  assert.equal(light.visible, false);
  batch.update("fixture:aperture", aperture, optics, { ...color, frost: 1 });
  assert.equal(light.visible, true);
  assert.equal(light.optics.distributionPower, 2);
  assert.equal(
    scene.children.filter((child) => child instanceof OpticalSurfaceLight)
      .length,
    1,
  );
  batch.dispose();
  assert.equal(scene.children.length, 0);
});
