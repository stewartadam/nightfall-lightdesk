// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types/index";
import { computeRouteOverlapAnalysis } from "./route-overlap";

/** Builds an overlap entry touching `universes`, or every universe when `all` is set. */
function entry(
  universes: number[],
  all: boolean,
  target_conflict = false,
): types.RouteOverlapEntry {
  return {
    universes: { universes, all },
    source_conflict: false,
    target_conflict,
  };
}

/** Builds a routes snapshot carrying only an overlap report. */
function snapshot(overlap: types.RouteOverlapReport): types.RoutesSnapshot {
  return { input: [], output: [], disabled: [], overlap };
}

/** Verifies conflict cells are indexed by route row and only for rows that conflict. */
test("indexes conflicting cells by route row", () => {
  const analysis = computeRouteOverlapAnalysis(
    snapshot({
      input: [entry([4], false, true), entry([4], false)],
      output: [entry([4], false, true)],
      disabled: [],
      universes: [{ universe: 4, input_overlap: false, output_overlap: true }],
    }),
    [],
  );
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("input-0"),
    new Set(["target"]),
  );
  assert.equal(analysis.conflictColumnsByRoute.has("input-1"), false);
  assert.deepEqual(
    analysis.conflictColumnsByRoute.get("output-0"),
    new Set(["target"]),
  );
  assert.deepEqual(analysis.overlapByUniverse.get(4), {
    inputOverlap: false,
    outputOverlap: true,
  });
});

/** Verifies routes on every universe list under `*` and each known universe, which share `*` flags. */
test("lists every-universe routes under each known universe", () => {
  const analysis = computeRouteOverlapAnalysis(
    snapshot({
      input: [entry([], true, true), entry([2], false, true)],
      output: [],
      disabled: [],
      universes: [
        { universe: undefined, input_overlap: true, output_overlap: false },
        { universe: 2, input_overlap: true, output_overlap: false },
      ],
    }),
    [9],
  );
  assert.deepEqual(
    analysis.routeUniverses.get("input-0"),
    new Set(["*", 9, 2]),
  );
  assert.deepEqual(analysis.routeUniverses.get("input-1"), new Set([2]));
  assert.deepEqual(analysis.overlapByUniverse.get(9), {
    inputOverlap: true,
    outputOverlap: false,
  });
});
