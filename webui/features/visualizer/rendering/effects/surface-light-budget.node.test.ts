// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Color, PerspectiveCamera, PointLight } from "three/webgpu";
import { SurfaceLightBudget } from "./surface-light-budget";

/** Creates a source with current world matrices, as supplied by the renderer's lighting traversal. */
function source(intensity: number, x = 0, z = -5): PointLight {
  const light = new PointLight(0xffffff, intensity, 1);
  light.position.set(x, 0, z);
  light.updateMatrixWorld();
  return light;
}

/** Late bright sources beat earlier weak/far sources, while off-screen bounds cannot consume their slots. */
test("surface budget ranks the full candidate list using current camera relevance", () => {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.updateMatrixWorld();
  const budget = new SurfaceLightBudget(2);
  const far = source(10, 0, -50);
  const near = source(1);
  const bright = source(10);
  const offscreen = source(1e6, 100);
  const selected: PointLight[] = [];
  budget.select([far, near, offscreen, bright], camera, selected);
  assert.deepEqual(new Set(selected), new Set([near, bright]));
  camera.position.x = 100;
  camera.updateMatrixWorld();
  budget.select([far, near, offscreen, bright], camera, selected);
  assert.ok(selected.includes(offscreen));
  assert.equal(selected.length, 2);
  budget.select([far], camera, selected);
  assert.deepEqual(selected, [far]);
});

/** Small intensity changes retain the incumbent; a materially stronger source replaces it. */
test("surface budget is stable across traversal reorder and uses bounded hysteresis", () => {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.updateMatrixWorld();
  const first = source(1);
  const second = source(1);
  const budget = new SurfaceLightBudget(1);
  const selected: PointLight[] = [];
  budget.select([second, first], camera, selected);
  assert.equal(selected[0], first);
  second.intensity = 1.05;
  budget.select([first, second], camera, selected);
  assert.equal(selected[0], first);
  second.intensity = 1.2;
  budget.select([first, second], camera, selected);
  assert.equal(selected[0], second);
  second.intensity = 0;
  budget.select([second, first], camera, selected);
  assert.equal(selected[0], first);
});

/** Split-color optical sources remain important when only the secondary side emits light. */
test("surface budget includes secondary transmission and tolerates invalid intensity", () => {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.updateMatrixWorld();
  const split = Object.assign(source(10), {
    splitColor: true,
    secondaryColor: new Color(0, 0, 1),
  });
  split.color.setRGB(0, 0, 0);
  const invalid = source(NaN);
  const normal = source(1);
  const budget = new SurfaceLightBudget(1);
  const selected: PointLight[] = [];
  budget.select([normal, invalid, split], camera, selected);
  assert.equal(selected[0], split);
});
