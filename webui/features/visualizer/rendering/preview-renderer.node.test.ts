// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Tests for the fixture library preview's rendering profile and beam pipeline. */

import assert from "node:assert/strict";
import test from "node:test";
import { type InstancedMesh, Scene } from "three/webgpu";
import { BeamManager } from "./effects";
import {
  EMITTER_RADIANCE,
  UNBLOOMED_EMITTER_RADIANCE,
} from "./emitter-radiance";
import { PREVIEW_QUALITY } from "./preview-renderer";

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
