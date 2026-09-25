// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { FixtureColorState } from "./fixture-color-state";
import { applyStrobeShutterIntensity } from "./visualizer-dmx";

/** Reusing records must not retain a previous frame's colors, optical controls, or removed geometry. */
test("fixture color reuse clears missing DMX without mutating input", () => {
  const state = new FixtureColorState();
  const first = {
    red: 1,
    green: 0.5,
    intensity: 0.8,
    Control: 1,
    "optical:Gobo": 1,
  };
  const colors = state.update(
    new Map<string, Record<string, number>>([
      ["Head", first],
      ["Base", { Control: 1 }],
    ]),
    undefined,
    0,
  );
  const head = colors.get("Head")!;
  assert.equal(head.Control, 1);
  assert.equal(head["optical:Gobo"], 1);
  const second = { blue: 1, intensity: 0.5 };
  assert.equal(state.update(new Map([["Head", second]]), undefined, 1), colors);
  assert.equal(colors.get("Head"), head);
  assert.equal(head.red, 0);
  assert.equal(head.green, 0);
  assert.equal(head.blue, 1);
  assert.equal(head.intensity, 0.5);
  assert.equal(head.Control, undefined);
  assert.equal(head["optical:Gobo"], undefined);
  assert.equal(colors.has("Base"), false);
  assert.deepEqual(first, {
    red: 1,
    green: 0.5,
    intensity: 0.8,
    Control: 1,
    "optical:Gobo": 1,
  });
  assert.deepEqual(second, { blue: 1, intensity: 0.5 });
});

/** Fixture-level shutter inheritance and element-local overrides continue to advance on reused colors. */
test("reused colors preserve independent strobe timing and local overrides", () => {
  const state = new FixtureColorState();
  const elements = new Map<string, Record<string, number>>([
    ["Inherited", { intensity: 1 }],
    ["Local", { intensity: 1, strobeShutter: 0 }],
  ]);
  for (const seconds of [0, 0.03, 0.06, 0.1]) {
    const colors = state.update(elements, 0.5, seconds);
    assert.equal(
      colors.get("Inherited")!.intensity,
      applyStrobeShutterIntensity(1, 0.5, seconds),
    );
    assert.equal(colors.get("Local")!.intensity, 1);
  }
});
