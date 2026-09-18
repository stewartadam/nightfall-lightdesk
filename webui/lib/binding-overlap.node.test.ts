// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../types/index";
import { computeBindingOverlapAnalysis } from "./binding-overlap";

/**
 * Builds a one-universe DMX range for binding overlap tests.
 */
function singleUniverse(universe: number): types.DmxRange {
  return { start: universe, end: universe };
}

/**
 * Builds an input transport binding with overridable source and target ranges.
 */
function makeInputTransportBinding(
  sourceTransport: types.BindingTransport,
  target: string,
  universe: number,
  address?: number,
): types.InputBinding {
  return {
    source: {
      type: "Transport",
      data: {
        transport: sourceTransport,
        universe: singleUniverse(universe),
        address,
      },
    },
    target: {
      type: "Transport",
      data: {
        target,
        universe: singleUniverse(universe),
        address,
      },
    },
    priority: 0,
    clone: false,
  };
}

/**
 * Builds an input binding that routes a transport source into a console target.
 */
function makeInputConsoleBinding(
  sourceTransport: types.BindingTransport,
  sourceUniverse: number,
  targetUniverse: number,
  targetAddress?: number,
): types.InputBinding {
  return {
    source: {
      type: "Transport",
      data: {
        transport: sourceTransport,
        universe: singleUniverse(sourceUniverse),
        address: 1,
      },
    },
    target: {
      type: "Console",
      data: {
        universe: singleUniverse(targetUniverse),
        address: targetAddress,
      },
    },
    priority: 0,
    clone: false,
  };
}

/**
 * Builds an input binding that routes a transport source into a fixture target.
 */
function makeInputFixtureBinding(
  sourceTransport: types.BindingTransport,
  sourceUniverse: number,
  fixtureUid: string,
  param: string,
): types.InputBinding {
  return {
    source: {
      type: "Transport",
      data: {
        transport: sourceTransport,
        universe: singleUniverse(sourceUniverse),
      },
    },
    target: {
      type: "Fixture",
      data: {
        uids: [fixtureUid],
        param,
      },
    },
    priority: 0,
    clone: false,
  };
}

/**
 * Builds an output transport binding with overridable source and target ranges.
 */
function makeOutputTransportBinding(
  source: types.OutputSource,
  target: string,
  universe: number,
  address?: number,
): types.OutputBinding {
  return {
    source,
    target: {
      type: "Transport",
      data: {
        target,
        universe: singleUniverse(universe),
        address,
      },
    },
    priority: 0,
    clone: false,
  };
}

test("flags output overlap when input and output bindings target same transport endpoint", () => {
  const snapshot: types.BindingsSnapshot = {
    input: [
      makeInputTransportBinding(types.BindingTransport.Sacn, "artnet", 4, 1),
    ],
    output: [
      makeOutputTransportBinding(
        { type: "Fixture", data: { uids: ["fixture-215"] } },
        "artnet",
        4,
        1,
      ),
    ],
    disabled: [],
  };

  const analysis = computeBindingOverlapAnalysis(snapshot, [4]);
  const overlap = analysis.overlapByUniverse.get(4);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, false);
  assert.equal(overlap.outputOverlap, true);
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("input-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("output-0"),
    new Set(["target"]),
  );
});

test("does not flag overlap when transport addresses differ", () => {
  const snapshot: types.BindingsSnapshot = {
    input: [
      makeInputTransportBinding(types.BindingTransport.Sacn, "artnet", 4, 1),
    ],
    output: [
      makeOutputTransportBinding(
        { type: "Fixture", data: { uids: ["fixture-215"] } },
        "artnet",
        4,
        2,
      ),
    ],
    disabled: [],
  };

  const analysis = computeBindingOverlapAnalysis(snapshot, [4]);
  const overlap = analysis.overlapByUniverse.get(4);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, false);
  assert.equal(overlap.outputOverlap, false);
  assert.equal(analysis.conflictColumnsByBinding.size, 0);
});

test("flags input overlap for duplicate input transport targets", () => {
  const snapshot: types.BindingsSnapshot = {
    input: [
      makeInputTransportBinding(types.BindingTransport.Sacn, "artnet", 4, 1),
      makeInputTransportBinding(types.BindingTransport.Sacn, "artnet", 4, 1),
    ],
    output: [],
    disabled: [],
  };

  const analysis = computeBindingOverlapAnalysis(snapshot, [4]);
  const overlap = analysis.overlapByUniverse.get(4);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, true);
  assert.equal(overlap.outputOverlap, false);
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("input-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("input-1"),
    new Set(["target"]),
  );
});

test("flags input overlap for duplicate input console targets", () => {
  const snapshot: types.BindingsSnapshot = {
    input: [
      makeInputConsoleBinding(types.BindingTransport.Sacn, 1, 50, 5),
      makeInputConsoleBinding(types.BindingTransport.ArtNet, 2, 50, 5),
    ],
    output: [],
    disabled: [],
  };

  const analysis = computeBindingOverlapAnalysis(snapshot, [50]);
  const overlap = analysis.overlapByUniverse.get(50);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, true);
  assert.equal(overlap.outputOverlap, false);
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("input-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("input-1"),
    new Set(["target"]),
  );
});

test("marks source values for duplicate fixture input targets", () => {
  const snapshot: types.BindingsSnapshot = {
    input: [
      makeInputFixtureBinding(
        types.BindingTransport.Sacn,
        1,
        "fixture-311",
        "Intensity",
      ),
      makeInputFixtureBinding(
        types.BindingTransport.Sacn,
        2,
        "fixture-311",
        "Intensity",
      ),
    ],
    output: [],
    disabled: [],
  };

  const analysis = computeBindingOverlapAnalysis(snapshot, [1, 2]);

  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("input-0"),
    new Set(["source"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("input-1"),
    new Set(["source"]),
  );
});

test("flags output overlap for duplicate fixture output transport endpoints", () => {
  const snapshot: types.BindingsSnapshot = {
    input: [],
    output: [
      makeOutputTransportBinding(
        { type: "Fixture", data: { uids: ["fixture-311"] } },
        "sacn",
        20,
        1,
      ),
      makeOutputTransportBinding(
        { type: "Fixture", data: { uids: ["fixture-312"] } },
        "sacn",
        20,
        1,
      ),
    ],
    disabled: [],
  };

  const analysis = computeBindingOverlapAnalysis(snapshot, [20]);
  const overlap = analysis.overlapByUniverse.get(20);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, false);
  assert.equal(overlap.outputOverlap, true);
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("output-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("output-1"),
    new Set(["target"]),
  );
});

test("keeps console/fixture output transport exclusivity overlap behavior", () => {
  const snapshot: types.BindingsSnapshot = {
    input: [],
    output: [
      makeOutputTransportBinding(
        {
          type: "Console",
          data: { universe: singleUniverse(4), address: 1 },
        },
        "artnet",
        4,
        1,
      ),
      makeOutputTransportBinding(
        { type: "Fixture", data: { uids: ["fixture-216"] } },
        "artnet",
        4,
        50,
      ),
    ],
    disabled: [],
  };

  const analysis = computeBindingOverlapAnalysis(snapshot, [4]);
  const overlap = analysis.overlapByUniverse.get(4);

  assert.ok(overlap);
  assert.equal(overlap.outputOverlap, true);
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("output-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByBinding.get("output-1"),
    new Set(["target"]),
  );
});
