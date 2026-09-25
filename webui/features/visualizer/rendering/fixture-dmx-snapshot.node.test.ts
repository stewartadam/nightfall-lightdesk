// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DmxValueResolution,
  type FixtureElement,
  MergeStrategy,
  ParameterValuePolarity,
} from "../../../types";
import { FixtureColorState } from "./fixture-color-state";
import { FixtureDmxSnapshot } from "./fixture-dmx-snapshot";
import { extractElementDmxData, resetDmxPool } from "./visualizer-dmx";

/** Provides independently controllable red and shutter channels with normalized physical ranges. */
function element(label = "Cell"): FixtureElement {
  return {
    label,
    parameters: (["Red", "StrobeShutter"] as const).map((type) => ({
      attribute: { type },
      is_inverted: false,
      is_snap: false,
      max: 1,
      min: 0,
      merge_type: MergeStrategy.LTP,
      offset: { type: "Absolute", data: { value: 0 } },
      resolution: DmxValueResolution.Coarse,
      use_grandmaster: false,
      value_polarity: ParameterValuePolarity.Unsigned,
    })),
  };
}

/** Cached records own their values even when another consumer resets and reuses the extraction pool. */
test("unchanged DMX snapshots retain owned records and refresh on new output", () => {
  const cache = new FixtureDmxSnapshot();
  const fixtures = { bar: { elements: [element()] } };
  const outputs = new Map([["bar", [{ Red: 0.8 }]]]);
  const first = cache.read(outputs, fixtures).get("bar")!;
  const cell = first.get("Cell")!;
  resetDmxPool();
  extractElementDmxData({ Red: 0.1 }, fixtures.bar.elements[0]);
  assert.equal(cache.read(outputs, fixtures).get("bar"), first);
  assert.equal(cell.red, 0.8);
  const next = cache.read(new Map([["bar", [{ Red: 0.2 }]]]), fixtures);
  assert.equal(next.get("bar")!.get("Cell")!.red, 0.2);
  assert.equal(cell.red, 0.8);
});

/** Definition replacements and missing fixtures/outputs cannot preserve obsolete cache entries. */
test("DMX snapshots invalidate on definition replacement and removed output", () => {
  const cache = new FixtureDmxSnapshot();
  const outputs = new Map([["bar", [{ Red: 0.8 }]]]);
  cache.read(outputs, { bar: { elements: [element()] } });
  const renamed = { bar: { elements: [element("Renamed")] } };
  assert.deepEqual(
    [...cache.read(outputs, renamed).get("bar")!.keys()],
    ["Renamed"],
  );
  assert.equal(cache.read(new Map(), renamed).size, 0);
  assert.equal(cache.read(outputs, {}).size, 0);
});

/** Reusing normalized input must still allow the frame-time shutter simulation to change output. */
test("cached DMX permits strobes to advance between engine messages", () => {
  const cache = new FixtureDmxSnapshot();
  const colors = new FixtureColorState();
  const fixtures = { bar: { elements: [element()] } };
  const outputs = new Map([["bar", [{ Red: 1, StrobeShutter: 0.5 }]]]);
  const first = cache.read(outputs, fixtures).get("bar")!;
  assert.equal(colors.update(first, undefined, 0).get("Cell")!.intensity, 1);
  const next = cache.read(outputs, fixtures).get("bar")!;
  assert.equal(next, first);
  assert.equal(colors.update(next, undefined, 0.06).get("Cell")!.intensity, 0);
});
