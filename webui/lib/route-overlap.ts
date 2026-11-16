// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Route overlap highlighting for the patch views. The engine finds which routes
 * overlap and sends the result with every routes snapshot; this module only
 * reshapes it into per-row and per-universe lookups for the grids.
 */

import type * as types from "../types";

export type UniverseKey = number | "*";

type UniverseOverlapFlags = { inputOverlap: boolean; outputOverlap: boolean };

export type RouteConflictColumn = "source" | "target";

export type RouteOverlapAnalysis = {
  /** Every universe a route names or the engine reports as active. */
  universeIds: Set<number>;
  /** Overlap flags by universe, including `"*"` for routes on every universe. */
  overlapByUniverse: Map<UniverseKey, UniverseOverlapFlags>;
  /** Universes each route row is listed under, by row ID. */
  routeUniverses: Map<string, Set<UniverseKey>>;
  /** The cells of each route row that overlap another route, by row ID. */
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>;
};

/** Returns the overlapping cells of one route row, or undefined when it has none. */
function conflictColumns(
  entry: types.RouteOverlapEntry,
): Set<RouteConflictColumn> | undefined {
  const columns = new Set<RouteConflictColumn>();
  if (entry.source_conflict) columns.add("source");
  if (entry.target_conflict) columns.add("target");
  return columns.size > 0 ? columns : undefined;
}

/**
 * Indexes the engine's route overlap report by route row and universe. Routes
 * that apply to every universe are listed under `"*"` and under each known
 * universe; a universe no route names explicitly shares the `"*"` flags.
 */
export function computeRouteOverlapAnalysis(
  snapshot: types.RoutesSnapshot,
  activeUniverses: number[],
): RouteOverlapAnalysis {
  const report = snapshot.overlap;
  const universeIds = new Set<number>(activeUniverses);
  for (const entry of [...report.input, ...report.output, ...report.disabled]) {
    for (const universe of entry.universes.universes) universeIds.add(universe);
  }

  const overlapByUniverse = new Map<UniverseKey, UniverseOverlapFlags>();
  for (const entry of report.universes) {
    overlapByUniverse.set(entry.universe ?? "*", {
      inputOverlap: entry.input_overlap,
      outputOverlap: entry.output_overlap,
    });
  }
  const wildcardFlags = overlapByUniverse.get("*");
  if (wildcardFlags) {
    for (const universe of universeIds) {
      if (!overlapByUniverse.has(universe)) {
        overlapByUniverse.set(universe, { ...wildcardFlags });
      }
    }
  }

  const routeUniverses = new Map<string, Set<UniverseKey>>();
  const conflictColumnsByRoute = new Map<string, Set<RouteConflictColumn>>();
  const addEntries = (prefix: string, entries: types.RouteOverlapEntry[]) => {
    entries.forEach((entry, index) => {
      const rowId = `${prefix}-${index}`;
      const universes = entry.universes.all
        ? new Set<UniverseKey>(["*", ...universeIds])
        : new Set<UniverseKey>(entry.universes.universes);
      routeUniverses.set(rowId, universes);
      const columns = conflictColumns(entry);
      if (columns) conflictColumnsByRoute.set(rowId, columns);
    });
  };
  addEntries("input", report.input);
  addEntries("output", report.output);
  addEntries("disabled", report.disabled);

  return {
    universeIds,
    overlapByUniverse,
    routeUniverses,
    conflictColumnsByRoute,
  };
}
