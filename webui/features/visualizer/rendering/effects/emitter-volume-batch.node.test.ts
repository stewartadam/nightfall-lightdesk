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
  ConeGeometry,
  type InstancedMesh,
  Object3D,
  Scene,
  Vector3,
} from "three/webgpu";
import { resolveQualityProfile } from "../quality-profile";
import { apertureId } from "./aperture-id";
import {
  emitterDistributionArea,
  type ResolvedEmitterOptics,
} from "./emitter-optics";
import { EmitterVolumeBatch } from "./emitter-volume-batch";
import { MAX_GOBO_STAGES } from "./gobo-stack-table";
import { createOpticalRenderContext } from "./optical-render-context";
import { OpticalShadowPool } from "./optical-shadow-pool";
import { OpticalSurfaceLight } from "./optical-surface-lighting";
import { compilePrismFacet } from "./prism-optics";

const WHITE = { red: 1, green: 1, blue: 1, intensity: 1 };

/** Builds a round aperture with the given spread and falloff. */
function roundOptics(
  slopeX = 0.1,
  slopeY = slopeX,
  distributionPower = 4,
): ResolvedEmitterOptics {
  return {
    shape: "round",
    radius: 0.02,
    slopeX,
    slopeY,
    halfPowerRatio: 0.5,
    distributionPower,
    lumens: 1000,
  };
}

/** Returns the batch's single instanced draw from the scene it renders into. */
function draw(scene: Scene): InstancedMesh {
  return scene.children[0] as InstancedMesh;
}

/** Lists the optical surface lights the batch has added to a scene. */
function surfaceLights(scene: Scene): OpticalSurfaceLight[] {
  return scene.children.filter(
    (child): child is OpticalSurfaceLight =>
      child instanceof OpticalSurfaceLight,
  );
}

/** Frost spreads conserved flux without mutating source zoom data or calibrated focus. */
test("frost broadens the shared distribution while retaining flux and focus", () => {
  const scene = new Scene();
  const batch = new EmitterVolumeBatch(scene);
  const optics = roundOptics(0.1, 0.2, 8);
  const color = { ...WHITE, frost: 1 };
  const update = () =>
    batch.update("fixture:beam", new Object3D(), {
      optics,
      color,
      zoomScale: 2,
      focusDistance: 10,
    });
  update();
  const geometry = draw(scene).geometry;
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
  update();
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

/** A reserved split activates in the existing draw, and unsplit or removed apertures release their facets. */
test("prepared prism capacity draws every facet from a single shared draw", () => {
  const scene = new Scene();
  const batch = new EmitterVolumeBatch(scene);
  batch.reserve("fixture:beam", 300);
  assert.equal(scene.children.length, 1);
  assert.equal(draw(scene).count, 0);
  const facet = compilePrismFacet({
    transform: [1, 0, 0, 0, 1, 0, 2, 0, 1],
    colorCie: [0.3127, 0.329, 100],
  })!;
  const parent = new Object3D();
  const optics = roundOptics();
  batch.update("fixture:beam", parent, {
    optics,
    color: WHITE,
    facets: Array(300).fill(facet),
  });
  assert.equal(scene.children.length, 1);
  assert.equal(draw(scene).count, 300);
  batch.update("fixture:beam", parent, { optics, color: WHITE });
  assert.equal(draw(scene).count, 1);
  batch.sync(new Map());
  assert.equal(draw(scene).count, 0);
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
  const optics = roundOptics();
  batch.update("fixture:beam", new Object3D(), {
    optics,
    color: WHITE,
    facets: [facet],
    prismRotation: Math.PI / 2,
  });
  const mesh = draw(scene);
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
  batch.update("fixture:beam", new Object3D(), {
    optics,
    color: WHITE,
    facets: [facet, facet, facet],
  });
  assert.equal(mesh.count, 3);
  batch.update("fixture:beam", new Object3D(), { optics, color: WHITE });
  assert.equal(mesh.count, 1);
  batch.remove("fixture:beam");
  assert.equal(mesh.count, 0);
  batch.dispose();
});

/** Cluster spheres must retain wide, sheared and translated prism fields through the full throw. */
test("surface bounds contain transformed prism field corners", () => {
  const scene = new Scene();
  createOpticalRenderContext(scene, float(-100), { surfaceLighting: true });
  const batch = new EmitterVolumeBatch(scene);
  const optics: ResolvedEmitterOptics = {
    shape: "rectangle",
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
  batch.update("prism", new Object3D(), {
    optics,
    color: WHITE,
    facets: [facet],
  });
  const [light] = surfaceLights(scene);
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
  const optics = roundOptics(0.1, 0.2, 8);
  const color = { red: 1, green: 0.5, blue: 0, intensity: 1 };
  batch.update("fixture:aperture", aperture, {
    optics,
    color,
    zoomScale: 2,
  });
  const [light] = surfaceLights(scene);
  assert.ok(light);
  assert.deepEqual(light.position.toArray(), [1, 2, 3]);
  assert.equal(light.optics.slopeX, 0.2);
  assert.equal(light.optics.slopeY, 0.4);
  assert.equal(light.optics.distributionPower, 8);
  batch.remove("fixture:aperture");
  assert.equal(light.visible, false);
  batch.update("fixture:aperture", aperture, {
    optics,
    color: { ...color, frost: 1 },
  });
  assert.equal(light.visible, true);
  assert.equal(light.optics.distributionPower, 2);
  assert.equal(surfaceLights(scene).length, 1);
  batch.dispose();
  assert.equal(scene.children.length, 0);
});

/** Shader-visible shadow keys come from the pool, never from scene object IDs, which can be 0 or exceed float precision. */
test("atmospheric instances carry the pool's small shadow key", () => {
  const scene = new Scene();
  const pool = new OpticalShadowPool();
  const context = createOpticalRenderContext(scene, float(-100), {
    surfaceLighting: true,
    shadows: pool,
  });
  const batch = new EmitterVolumeBatch(scene);
  const optics = roundOptics(0.1, 0.1, 2);
  batch.update("a:1", new Object3D(), { optics, color: WHITE });
  batch.update("b:1", new Object3D(), { optics, color: WHITE });
  assert.deepEqual(
    surfaceLights(scene).map((light) => light.shadowKey),
    [1, 2],
  );
  const shape = draw(context.scene).geometry.getAttribute("volumeShape");
  assert.deepEqual([shape.getZ(0), shape.getZ(1)], [1, 2]);
  batch.dispose();
  pool.dispose();
});

/** Fixture removal releases every facet light of the removed aperture while leaving the others in place. */
test("sync releases a removed aperture's facet lights and keeps live ones", () => {
  const scene = new Scene();
  createOpticalRenderContext(scene, float(-100), { surfaceLighting: true });
  const batch = new EmitterVolumeBatch(scene);
  const facet = compilePrismFacet({
    transform: [1, 0, 0, 0, 1, 0, 2, 0, 1],
    colorCie: [0.3127, 0.329, 100],
  })!;
  const optics = roundOptics();
  // Emitter names may contain the separator; only the first one splits the identifier.
  const kept = apertureId("kept", "Head:Lens");
  const removed = apertureId("removed", "Lens");
  batch.update(kept, new Object3D(), { optics, color: WHITE });
  batch.update(removed, new Object3D(), {
    optics,
    color: WHITE,
    facets: [facet, facet, facet],
  });
  assert.equal(surfaceLights(scene).length, 4);
  batch.sync(
    new Map([["kept", { emitters: new Map([["Head:Lens", { optics }]]) }]]),
  );
  const [light] = surfaceLights(scene);
  assert.equal(surfaceLights(scene).length, 1);
  assert.equal(light.name, `OpticalSurface:${kept}`);
  batch.dispose();
});

/** Render lifecycle transitions clear active approximation without losing prepared masks on reactivation. */
test("batch gobo diagnostics clear on blackout, fixture removal and disposal", () => {
  const batch = new EmitterVolumeBatch(new Scene());
  const masks = Array.from({ length: MAX_GOBO_STAGES + 1 }, () => ({
    slot: 1,
    rotation: 0,
  }));
  /** Activates the same prepared optical emitter to exercise reusable batch state. */
  const activate = () =>
    batch.update("fixture:head", new Object3D(), {
      optics: roundOptics(),
      color: WHITE,
      gobos: masks,
    });
  const stacks = batch.goboAtlas!.stacks;
  activate();
  assert.equal(stacks.reducedStacks, 1);
  batch.remove("fixture:head");
  assert.equal(stacks.reducedStacks, 0);
  activate();
  assert.equal(stacks.reducedStacks, 1);
  batch.sync(new Map());
  assert.equal(stacks.reducedStacks, 0);
  activate();
  batch.clear();
  assert.equal(stacks.reducedStacks, 0);
  activate();
  batch.dispose();
  assert.equal(stacks.reducedStacks, 0);
});

/** Cone presets follow their pipeline's profile: no mask atlas, and cones with the profile's segment count. */
test("cone profiles draw faceted cones without allocating a mask atlas", () => {
  for (const preset of ["low", "medium"] as const) {
    const profile = resolveQualityProfile(preset);
    const { beamStyle } = profile;
    if (beamStyle.kind === "volumetric")
      assert.fail(`${preset} must draw cones`);
    const scene = new Scene();
    const context = createOpticalRenderContext(scene, float(-100), {
      profile,
    });
    const batch = new EmitterVolumeBatch(scene);
    assert.equal(batch.goboAtlas, undefined, preset);
    const expected = new ConeGeometry(0.25, 1, beamStyle.segments, 1, true);
    assert.equal(
      draw(context.scene).geometry.getAttribute("position").count,
      expected.getAttribute("position").count,
      preset,
    );
    expected.dispose();
    batch.dispose();
  }
});
