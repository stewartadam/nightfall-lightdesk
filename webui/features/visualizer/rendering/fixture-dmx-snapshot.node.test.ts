// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  DmxValueResolution,
  type FixtureElement,
  MergeStrategy,
  ParameterValuePolarity,
} from "../../../types";
import {
  isFixtureEvaluationLoaded,
  loadFixtureEvaluation,
} from "./channel-evaluation";
import { FixtureColorState } from "./fixture-color-state";
import { FixtureDmxSnapshot } from "./fixture-dmx-snapshot";
import { extractFixtureDmxData, resetDmxPool } from "./visualizer-dmx";

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

// Module evaluation is synchronous, so the fixture model cannot have finished
// loading yet: this snapshot is taken exactly as a renderer's first frame would.
const staticLookFixtures = { bar: { elements: [element()] } };
const staticLookOutputs = new Map([["bar", [{ Red: 0.8 }]]]);
const staticLookSnapshot = new FixtureDmxSnapshot();
const evaluationLoadedBeforeFirstRead = isFixtureEvaluationLoaded();
// The red channel is the element's only color, so it sets its brightness.
const intensityBeforeEvaluation = staticLookSnapshot
  .read(staticLookOutputs, staticLookFixtures)
  .get("bar")
  ?.get("Cell")?.intensity;
const revisionBeforeEvaluation = staticLookSnapshot.revision;

before(() => loadFixtureEvaluation());

/** A static look converted before the fixture model loaded is re-evaluated once it has, without new engine output. */
test("DMX snapshots taken before the fixture model loads refresh once it is ready", () => {
  assert.equal(evaluationLoadedBeforeFirstRead, false);
  assert.equal(intensityBeforeEvaluation, 0);
  assert.ok(isFixtureEvaluationLoaded());
  const cell = staticLookSnapshot
    .read(staticLookOutputs, staticLookFixtures)
    .get("bar")!
    .get("Cell")!;
  assert.notEqual(staticLookSnapshot.revision, revisionBeforeEvaluation);
  assert.ok(Math.abs(cell.intensity - 0.8) < 1e-6);
  const revision = staticLookSnapshot.revision;
  staticLookSnapshot.read(staticLookOutputs, staticLookFixtures);
  assert.equal(staticLookSnapshot.revision, revision);
});

/** Readiness participates in the cache key, so a flip in either direction rebuilds identical inputs. */
test("DMX snapshot revision follows fixture model readiness", () => {
  let ready = false;
  const cache = new FixtureDmxSnapshot(() => ready);
  const fixtures = { bar: { elements: [element()] } };
  const outputs = new Map([["bar", [{ Red: 0.8 }]]]);
  cache.read(outputs, fixtures);
  const unloaded = cache.revision;
  cache.read(outputs, fixtures);
  assert.equal(cache.revision, unloaded);
  ready = true;
  cache.read(outputs, fixtures);
  assert.notEqual(cache.revision, unloaded);
});

/** Cached records own their values even when another consumer resets and reuses the extraction pool. */
test("unchanged DMX snapshots retain owned records and refresh on new output", () => {
  const cache = new FixtureDmxSnapshot();
  const fixtures = { bar: { elements: [element()] } };
  const outputs = new Map([["bar", [{ Red: 0.8 }]]]);
  const first = cache.read(outputs, fixtures).get("bar")!;
  const cell = first.get("Cell")!;
  resetDmxPool();
  extractFixtureDmxData(fixtures.bar.elements, [{ Red: 0.1 }]);
  assert.equal(cache.read(outputs, fixtures).get("bar"), first);
  assert.ok(Math.abs(cell.intensity - 0.8) < 1e-6);
  const next = cache.read(new Map([["bar", [{ Red: 0.2 }]]]), fixtures);
  assert.ok(Math.abs(next.get("bar")!.get("Cell")!.intensity - 0.2) < 1e-6);
  assert.ok(Math.abs(cell.intensity - 0.8) < 1e-6);
});

/** Optical controls travel once under their output key, without a duplicated prefixed alias. */
test("element DMX carries optical controls once under their output key", () => {
  const gobo = element().parameters[0];
  const [[, dmx]] = extractFixtureDmxData(
    [
      {
        label: "Head",
        parameters: [{ ...gobo, attribute: { type: "Gobo" }, max: 255 }],
      },
    ],
    [{ Gobo: 128 }],
  );
  assert.ok(Math.abs(dmx.Gobo - 128 / 255) < 1e-9);
  assert.deepEqual(
    Object.keys(dmx).filter((key) => key.includes(":")),
    [],
  );
});

/** The revision advances only on rebuilds, letting the worker proxy skip posting unchanged snapshots. */
test("DMX snapshot revision changes only when output or definitions change", () => {
  const cache = new FixtureDmxSnapshot();
  const fixtures = { bar: { elements: [element()] } };
  const outputs = new Map([["bar", [{ Red: 0.8 }]]]);
  const initial = cache.revision;
  const first = cache.read(outputs, fixtures);
  const afterFirst = cache.revision;
  assert.notEqual(afterFirst, initial);
  assert.equal(cache.read(outputs, fixtures), first);
  assert.equal(cache.revision, afterFirst);
  cache.read(new Map([["bar", [{ Red: 0.2 }]]]), fixtures);
  assert.notEqual(cache.revision, afterFirst);
  const afterOutput = cache.revision;
  cache.read(new Map([["bar", [{ Red: 0.2 }]]]), {
    bar: { elements: [element()] },
  });
  assert.notEqual(cache.revision, afterOutput);
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
  const intensities = [0.02, 0.04, 0.06, 0.08, 0.1].map(
    (seconds) => colors.update(next, undefined, seconds).get("Cell")!.intensity,
  );
  assert.ok(intensities.includes(0));
});

/**
 * A new engine snapshot that keeps a fixture's output array keeps that fixture's records, while a
 * fixture with a replaced output array or definition is converted again.
 */
test("DMX snapshots reconvert only fixtures whose output or definition changed", () => {
  const cache = new FixtureDmxSnapshot();
  const fixtures = {
    a: { elements: [element()] },
    b: { elements: [element()] },
  };
  const aOutputs = [{ Red: 0.2 }];
  const first = new Map(
    cache.read(
      new Map([
        ["a", aOutputs],
        ["b", [{ Red: 0.4 }]],
      ]),
      fixtures,
    ),
  );

  const second = cache.read(
    new Map([
      ["a", aOutputs],
      ["b", [{ Red: 0.6 }]],
    ]),
    fixtures,
  );
  assert.equal(second.get("a"), first.get("a"));
  assert.notEqual(second.get("b"), first.get("b"));
  const intensity = second.get("b")?.get("Cell")?.intensity ?? 0;
  assert.ok(Math.abs(intensity - 0.6) < 1e-6, `intensity ${intensity}`);

  const redefined = { ...fixtures, a: { elements: [element("Renamed")] } };
  const third = cache.read(new Map([["a", aOutputs]]), redefined);
  assert.deepEqual([...third.get("a")!.keys()], ["Renamed"]);
  assert.equal(third.has("b"), false);
});
