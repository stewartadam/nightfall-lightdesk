// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AmbientLight, DirectionalLight, Scene } from "three/webgpu";
import { setSceneDarkness } from "./scene-environment";

/** Asserts a value lies within floating-point tolerance of the expected value. */
function near(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

/**
 * Darkness scales the environment's configured light intensities, so non-default
 * SceneEnvironmentOptions keep their relative balance instead of being reset to the defaults.
 */
test("scene darkness scales configured base light intensities", () => {
  const environment = {
    ambientLight: new AmbientLight(0xffffff, 0),
    directionalLight: new DirectionalLight(0xffffff, 0),
    fillLight: new DirectionalLight(0xffffff, 0),
    baseIntensities: { ambient: 1, directional: 2, fill: 0.5 },
  };
  const scene = new Scene();
  setSceneDarkness(scene, environment, 0);
  near(environment.ambientLight.intensity, 1.8, "ambient at no darkness");
  near(environment.directionalLight.intensity, 3.6, "key at no darkness");
  near(environment.fillLight.intensity, 0.9, "fill at no darkness");
  setSceneDarkness(scene, environment, 100);
  near(environment.ambientLight.intensity, 0.25, "ambient at full darkness");
  near(environment.directionalLight.intensity, 0.5, "key at full darkness");
  near(environment.fillLight.intensity, 0.125, "fill at full darkness");
});
