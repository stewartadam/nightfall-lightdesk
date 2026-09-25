// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  AmbientLight,
  type DataTexture,
  DirectionalLight,
  PerspectiveCamera,
  PointLight,
} from "three/webgpu";
import { resolveQualityProfile } from "../quality-profile";
import {
  FULL_CLUSTER_PRIORITY_LIGHTS,
  OpticalClusteredLightsNode,
  OpticalSurfaceLight,
  OpticalSurfaceLighting,
} from "./optical-surface-lighting";

/** Lower presets must not pay for a mask atlas or shadow maps they never sample. */
test("surface lighting allocates masks and shadow maps only for profiles that use them", () => {
  for (const preset of ["low", "medium"] as const) {
    const lighting = new OpticalSurfaceLighting(resolveQualityProfile(preset));
    assert.equal(lighting.goboAtlas, undefined, preset);
    assert.equal(lighting.shadows, undefined, preset);
    lighting.dispose();
  }
  const high = new OpticalSurfaceLighting(resolveQualityProfile("high"));
  assert.ok(high.goboAtlas);
  assert.ok(high.shadows);
  high.dispose();
});

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

/** Creates a positioned point source with current world matrices. */
function pointSource(intensity: number, z = -5): PointLight {
  const light = new PointLight(0xffffff, intensity, 2);
  light.position.set(0, 0, z);
  light.updateMatrixWorld();
  return light;
}

/** Prepares a cluster node with allocated textures and a camera facing the sources. */
function clusterNode(maxLights: number, maxPerCluster: number) {
  const node = new OpticalClusteredLightsNode(maxLights, maxPerCluster);
  node.setSize(64, 64);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.updateMatrixWorld();
  return { node, camera };
}

/** Reads the depth-sorted order the addon uses to index cluster lights. */
function sortOrder(node: OpticalClusteredLightsNode): number[] {
  return (node as unknown as { _lightSortOrder: number[] })._lightSortOrder;
}

/** Exposes the node's private optical buffers for inspection. */
function internals(node: OpticalClusteredLightsNode) {
  return node as unknown as {
    apertureTexture: DataTexture;
    apertureData: Float32Array;
    priorityData: Float32Array;
    priorityTexture: DataTexture;
  };
}

/** Surfaces bound before the first aperture write must reference real texture storage, not a placeholder. */
test("optical textures own GPU storage before any material binds them", () => {
  const { node } = clusterNode(8, 4);
  // Version 0 would bind Three's placeholder, which render objects that miss the first
  // upload keep sampling while change-only uploads never bump the version again.
  assert.ok(internals(node).apertureTexture.version > 0);
  assert.ok(internals(node).priorityTexture.version > 0);
  node.disposeApertures();
});

/** Unchanged optical parameters must not re-upload the aperture texture every frame. */
test("aperture texture uploads only when optical data changes", () => {
  const { node, camera } = clusterNode(8, 4);
  const optical = new OpticalSurfaceLight({
    shape: "round",
    radius: 0.02,
    slopeX: 0.1,
    slopeY: 0.1,
    halfPowerRatio: 0.5,
    distributionPower: 2,
    lumens: 1000,
  });
  optical.shadowKey = 3;
  optical.position.set(0, 0, -4);
  optical.updateMatrixWorld();
  const plain = pointSource(1);
  node.setLights([optical, plain]);
  const texture = internals(node).apertureTexture;
  node.updateLightsTexture(camera);
  const uploaded = texture.version;
  assert.ok(uploaded > 0);
  node.updateLightsTexture(camera);
  assert.equal(texture.version, uploaded, "unchanged data re-uploaded");
  optical.frost = 0.5;
  node.updateLightsTexture(camera);
  assert.equal(texture.version, uploaded + 1);
  const data = internals(node).apertureData;
  const stride = 8 * 4;
  /** Reads a light's shadow-key profile channel from its sorted texel. */
  const profileKey = (light: PointLight) =>
    data[
      stride * 3 +
        sortOrder(node).indexOf(node.clusteredLights.indexOf(light)) * 4 +
        3
    ];
  assert.equal(profileKey(optical), 3);
  assert.equal(profileKey(plain), -1);
  node.disposeApertures();
});

/** Overflowing clusters evaluate a bounded list of the strongest sources rather than every light. */
test("full-cluster fallback lists at most the brightest bounded sources", () => {
  const { node, camera } = clusterNode(256, 4);
  const lights = Array.from({ length: 100 }, (_, i) => pointSource(i + 1));
  node.setLights(lights);
  node.updateLightsTexture(camera);
  const priority = internals(node).priorityData;
  const listed = Array.from(
    { length: priority.length / 4 },
    (_, i) => priority[i * 4],
  );
  assert.equal(listed.length, FULL_CLUSTER_PRIORITY_LIGHTS);
  assert.ok(listed.every((index) => index > 0));
  const intensities = listed
    .map((index) => node.clusteredLights[sortOrder(node)[index - 1]].intensity)
    .sort((a, b) => a - b);
  assert.deepEqual(
    intensities,
    Array.from(
      { length: FULL_CLUSTER_PRIORITY_LIGHTS },
      (_, i) => lights.length - FULL_CLUSTER_PRIORITY_LIGHTS + i + 1,
    ),
  );
  // Equally important sources favor late depth order, which full cluster lists drop first.
  const fresh = clusterNode(256, 4);
  const equal = Array.from({ length: 100 }, () => pointSource(1));
  fresh.node.setLights(equal);
  fresh.node.updateLightsTexture(fresh.camera);
  const tied = Array.from(
    { length: FULL_CLUSTER_PRIORITY_LIGHTS },
    (_, i) => internals(fresh.node).priorityData[i * 4],
  ).sort((a, b) => a - b);
  assert.equal(tied[0], equal.length - FULL_CLUSTER_PRIORITY_LIGHTS + 1);
  fresh.node.disposeApertures();
  node.setLights(lights.slice(0, 3));
  node.updateLightsTexture(camera);
  assert.ok(
    Array.from(internals(node).priorityData).every((value) => value === 0),
    "lists that cannot overflow need no fallback",
  );
  node.disposeApertures();
});
