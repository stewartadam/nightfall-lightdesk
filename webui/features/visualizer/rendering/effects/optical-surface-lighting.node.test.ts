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
  type DataTexture,
  DirectionalLight,
  Object3D,
  PerspectiveCamera,
  PointLight,
  Scene,
  Vector3,
} from "three/webgpu";
import { resolveQualityProfile } from "../quality-profile";
import { EmitterVolumeBatch } from "./emitter-volume-batch";
import { createOpticalRenderContext } from "./optical-render-context";
import { OpticalShadowPool } from "./optical-shadow-pool";
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

/** Cluster spheres must retain wide, sheared and translated prism fields through the full throw. */
test("surface bounds contain transformed prism field corners", () => {
  const scene = new Scene();
  createOpticalRenderContext(scene, float(-100), { surfaceLighting: true });
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
  createOpticalRenderContext(scene, float(-100), { surfaceLighting: true });
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

/** Shader-visible shadow keys come from the pool, never from scene object IDs, which can be 0 or exceed float precision. */
test("atmospheric instances carry the pool's small shadow key", () => {
  const scene = new Scene();
  const pool = new OpticalShadowPool();
  createOpticalRenderContext(scene, float(-100), {
    surfaceLighting: true,
    shadows: pool,
  });
  const batch = new EmitterVolumeBatch(scene);
  const optics = {
    shape: "round" as const,
    radius: 0.02,
    slopeX: 0.1,
    slopeY: 0.1,
    halfPowerRatio: 0.5,
    distributionPower: 2,
    lumens: 1000,
  };
  const color = { red: 1, green: 1, blue: 1, intensity: 1 };
  batch.update("a:1", new Object3D(), optics, color, 30, 1);
  batch.update("b:1", new Object3D(), optics, color, 30, 1);
  const lights = scene.children.filter(
    (child) => child instanceof OpticalSurfaceLight,
  ) as OpticalSurfaceLight[];
  assert.deepEqual(
    lights.map((light) => light.shadowKey),
    [1, 2],
  );
  const shape = (
    batch as unknown as {
      attributes: Record<string, { getZ(index: number): number }>;
    }
  ).attributes.volumeShape;
  assert.deepEqual([shape.getZ(0), shape.getZ(1)], [1, 2]);
  batch.dispose();
  pool.dispose();
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
