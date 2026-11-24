// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Tests for the fixture library preview's rendering profile and beam pipeline. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  Box3,
  BoxGeometry,
  Group,
  type InstancedMesh,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
} from "three/webgpu";
import { BeamManager } from "./effects";
import {
  EMITTER_RADIANCE,
  UNBLOOMED_EMITTER_RADIANCE,
} from "./emitter-radiance";
import {
  PREVIEW_QUALITY,
  type PreviewFraming,
  previewFraming,
} from "./preview-renderer";

/**
 * The preview has no bloom pass, so its luminous faces must use the unbloomed exposure that
 * keeps mixed colors from clipping toward white, as the Low and Medium presets do.
 */
test("preview exposes emitters for its unbloomed output", () => {
  assert.equal(PREVIEW_QUALITY.bloom, false);
  assert.equal(
    EMITTER_RADIANCE * PREVIEW_QUALITY.emitterDisplayGain,
    UNBLOOMED_EMITTER_RADIANCE,
  );
});

/**
 * The preview renders its scene directly, so its beams must be a cone style drawn in that scene
 * rather than volumetric haze that only an atmospheric pass would composite.
 */
test("preview beams draw in the preview scene without an atmospheric pass", () => {
  assert.notEqual(PREVIEW_QUALITY.beamStyle.kind, "volumetric");
  const scene = new Scene();
  const manager = new BeamManager(scene, PREVIEW_QUALITY);
  const draw = scene.children.find(
    (child): child is InstancedMesh => child.name === "EmitterBeams",
  );
  assert.ok(draw, "beam draw is added to the preview scene");
  assert.equal(manager.reducedGoboEmitters, 0);
  manager.dispose();
  assert.equal(draw.parent, null);
});

/**
 * Projects the corners of `mesh`'s bounding box through `camera` once it takes `framing`'s
 * view, returning the largest absolute normalized device coordinate on either axis.
 */
function widestCornerAfterFraming(
  mesh: Mesh,
  camera: PerspectiveCamera,
  framing: PreviewFraming,
): number {
  camera.position.copy(framing.position);
  camera.lookAt(framing.target);
  camera.updateMatrixWorld();
  const box = new Box3().setFromObject(mesh);
  let widest = 0;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const ndc = new Vector3(x, y, z).project(camera);
        widest = Math.max(widest, Math.abs(ndc.x), Math.abs(ndc.y));
      }
    }
  }
  return widest;
}

/**
 * A tall, narrow preview (such as the patch wizard's on a phone-shaped screen) and a wide one
 * both keep the whole fixture in view, and the fixture still fills a fair share of the frame.
 */
test("preview framing fits the fixture at any canvas shape", () => {
  const mesh = new Mesh(new BoxGeometry(0.4, 0.3, 0.45));
  mesh.position.set(0.2, -0.1, -0.2);
  for (const aspect of [0.4, 1, 2.5]) {
    const camera = new PerspectiveCamera(45, aspect, 0.01, 100);
    const framing = previewFraming(mesh, camera);
    assert.ok(framing, `aspect ${aspect} frames the fixture`);
    const widest = widestCornerAfterFraming(mesh, camera, framing);
    assert.ok(widest <= 1, `aspect ${aspect} keeps every corner in view`);
    assert.ok(
      widest >= 0.4,
      `aspect ${aspect} doesn't shrink the fixture away`,
    );
  }
});

/** An empty draft has no size, so the preview leaves the camera alone. */
test("preview framing skips a fixture with no size", () => {
  const camera = new PerspectiveCamera(45, 1, 0.01, 100);
  assert.equal(previewFraming(new Group(), camera), null);
});
