// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../types/index";
import { computeRouteOverlapAnalysis } from "./route-overlap";

/**
 * Builds a one-universe DMX range for route overlap tests.
 */
function singleUniverse(universe: number): types.DmxRange {
  return { start: universe, end: universe };
}

/**
 * Builds an input transport route with overridable source and target ranges.
 */
function makeInputTransportRoute(
  sourceTransport: types.RouteTransport,
  target: string,
  universe: number,
  address?: number,
): types.InputRoute {
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
 * Builds an input route that routes a transport source into a console target.
 */
function makeInputConsoleRoute(
  sourceTransport: types.RouteTransport,
  sourceUniverse: number,
  targetUniverse: number,
  targetAddress?: number,
): types.InputRoute {
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
 * Builds an input route that routes a transport source into a fixture target.
 */
function makeInputFixtureRoute(
  sourceTransport: types.RouteTransport,
  sourceUniverse: number,
  fixtureUid: string,
  param: string,
): types.InputRoute {
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
 * Builds an output transport route with overridable source and target ranges.
 */
function makeOutputTransportRoute(
  source: types.OutputSource,
  target: string,
  universe: number,
  address?: number,
): types.OutputRoute {
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

test("flags output overlap when input and output routes target same transport endpoint", () => {
  const snapshot: types.RoutesSnapshot = {
    input: [makeInputTransportRoute(types.RouteTransport.Sacn, "artnet", 4, 1)],
    output: [
      makeOutputTransportRoute(
        { type: "Fixture", data: { uids: ["fixture-215"] } },
        "artnet",
        4,
        1,
      ),
    ],
    disabled: [],
  };

  const analysis = computeRouteOverlapAnalysis(snapshot, [4]);
  const overlap = analysis.overlapByUniverse.get(4);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, false);
  assert.equal(overlap.outputOverlap, true);
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("input-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("output-0"),
    new Set(["target"]),
  );
});

test("does not flag overlap when transport addresses differ", () => {
  const snapshot: types.RoutesSnapshot = {
    input: [makeInputTransportRoute(types.RouteTransport.Sacn, "artnet", 4, 1)],
    output: [
      makeOutputTransportRoute(
        { type: "Fixture", data: { uids: ["fixture-215"] } },
        "artnet",
        4,
        2,
      ),
    ],
    disabled: [],
  };

  const analysis = computeRouteOverlapAnalysis(snapshot, [4]);
  const overlap = analysis.overlapByUniverse.get(4);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, false);
  assert.equal(overlap.outputOverlap, false);
  assert.equal(analysis.conflictColumnsByRoute.size, 0);
});

test("flags input overlap for duplicate input transport targets", () => {
  const snapshot: types.RoutesSnapshot = {
    input: [
      makeInputTransportRoute(types.RouteTransport.Sacn, "artnet", 4, 1),
      makeInputTransportRoute(types.RouteTransport.Sacn, "artnet", 4, 1),
    ],
    output: [],
    disabled: [],
  };

  const analysis = computeRouteOverlapAnalysis(snapshot, [4]);
  const overlap = analysis.overlapByUniverse.get(4);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, true);
  assert.equal(overlap.outputOverlap, false);
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("input-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("input-1"),
    new Set(["target"]),
  );
});

test("flags input overlap for duplicate input console targets", () => {
  const snapshot: types.RoutesSnapshot = {
    input: [
      makeInputConsoleRoute(types.RouteTransport.Sacn, 1, 50, 5),
      makeInputConsoleRoute(types.RouteTransport.ArtNet, 2, 50, 5),
    ],
    output: [],
    disabled: [],
  };

  const analysis = computeRouteOverlapAnalysis(snapshot, [50]);
  const overlap = analysis.overlapByUniverse.get(50);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, true);
  assert.equal(overlap.outputOverlap, false);
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("input-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("input-1"),
    new Set(["target"]),
  );
});

test("marks source values for duplicate fixture input targets", () => {
  const snapshot: types.RoutesSnapshot = {
    input: [
      makeInputFixtureRoute(
        types.RouteTransport.Sacn,
        1,
        "fixture-311",
        "Intensity",
      ),
      makeInputFixtureRoute(
        types.RouteTransport.Sacn,
        2,
        "fixture-311",
        "Intensity",
      ),
    ],
    output: [],
    disabled: [],
  };

  const analysis = computeRouteOverlapAnalysis(snapshot, [1, 2]);

  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("input-0"),
    new Set(["source"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("input-1"),
    new Set(["source"]),
  );
});

test("flags output overlap for duplicate fixture output transport endpoints", () => {
  const snapshot: types.RoutesSnapshot = {
    input: [],
    output: [
      makeOutputTransportRoute(
        { type: "Fixture", data: { uids: ["fixture-311"] } },
        "sacn",
        20,
        1,
      ),
      makeOutputTransportRoute(
        { type: "Fixture", data: { uids: ["fixture-312"] } },
        "sacn",
        20,
        1,
      ),
    ],
    disabled: [],
  };

  const analysis = computeRouteOverlapAnalysis(snapshot, [20]);
  const overlap = analysis.overlapByUniverse.get(20);

  assert.ok(overlap);
  assert.equal(overlap.inputOverlap, false);
  assert.equal(overlap.outputOverlap, true);
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("output-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("output-1"),
    new Set(["target"]),
  );
});

test("keeps console/fixture output transport exclusivity overlap behavior", () => {
  const snapshot: types.RoutesSnapshot = {
    input: [],
    output: [
      makeOutputTransportRoute(
        {
          type: "Console",
          data: { universe: singleUniverse(4), address: 1 },
        },
        "artnet",
        4,
        1,
      ),
      makeOutputTransportRoute(
        { type: "Fixture", data: { uids: ["fixture-216"] } },
        "artnet",
        4,
        50,
      ),
    ],
    disabled: [],
  };

  const analysis = computeRouteOverlapAnalysis(snapshot, [4]);
  const overlap = analysis.overlapByUniverse.get(4);

  assert.ok(overlap);
  assert.equal(overlap.outputOverlap, true);
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("output-0"),
    new Set(["target"]),
  );
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("output-1"),
    new Set(["target"]),
  );
});
