// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { RouteConflictColumn } from "../../../lib/route-overlap";
import { normalizeFixtureUid } from "../../../lib/route-utils";
import type * as types from "../../../types";
import type { RouteRow } from "./routes-model";
export type FixtureGroupRow = {
  rowKind: "fixture";
  fixtureUid: string;
  fixtureLabel: string;
  disabled: boolean;
  routeCounts: { input: number; output: number; disabled: number };
  inputOverlap: boolean;
  outputOverlap: boolean;
  routeRows: RouteRow[];
  isExpanded: boolean;
};

export type FixtureRouteRow = {
  rowKind: "route";
  fixtureUid: string;
  route: RouteRow;
  conflictColumns: Set<RouteConflictColumn>;
};

export type FixtureDisplayRow = FixtureGroupRow | FixtureRouteRow;

export type ConflictTooltipState = {
  id: number;
  content: string;
  anchorRect: DOMRect;
};

export function stableUniverseKey(range?: types.DmxRange): string {
  if (!range) return "*";
  if (range.start === range.end) return `${range.start}`;
  return `${range.start}-${range.end}`;
}

export function stableOutputTargetKey(target: types.OutputTarget): string {
  switch (target.type) {
    case "Transport":
      return `transport:${target.data.target}:${stableUniverseKey(
        target.data.universe,
      )}:${target.data.address ?? "*"}`;
    case "Console":
      return `console:${stableUniverseKey(target.data.universe)}:${target.data.address ?? "*"}`;
  }
}

/**
 * Extracts normalized fixture UIDs from fixture-based input route sources.
 */
export function fixtureUidsFromInputSource(
  source: types.InputSource,
): Set<string> {
  if (source.type !== "Fixture") return new Set();
  return new Set(source.data.uids.map((uid) => normalizeFixtureUid(uid)));
}

/**
 * Extracts normalized fixture UIDs from fixture-based input route targets.
 */
export function fixtureUidsFromInputTarget(
  target: types.InputTarget,
): Set<string> {
  if (target.type !== "Fixture") return new Set();
  return new Set(target.data.uids.map((uid) => normalizeFixtureUid(uid)));
}

/**
 * Extracts normalized fixture UIDs from fixture-based output route sources,
 * including additional DMX break sources.
 */
export function fixtureUidsFromOutputSource(
  source: types.OutputSource,
): Set<string> {
  if (source.type !== "Fixture" && source.type !== "FixtureBreak") {
    return new Set();
  }
  return new Set(source.data.uids.map((uid) => normalizeFixtureUid(uid)));
}

export function inputRouteTouchesFixture(
  route: types.InputRoute,
  fixtureUid: string,
): boolean {
  const sourceUids = fixtureUidsFromInputSource(route.source);
  if (sourceUids.has(fixtureUid)) return true;
  const targetUids = fixtureUidsFromInputTarget(route.target);
  return targetUids.has(fixtureUid);
}

/**
 * Returns the stable key of the output location where a route sends a
 * fixture's DMX, or null when it does not output that fixture (another
 * source or another fixture).
 *
 * Primary (`Fixture`) and additional-break (`FixtureBreak`) sources both
 * occupy their target, so two breaks of one fixture patched to the same
 * address share a key and are reported as overlapping, while breaks patched
 * to different addresses do not.
 */
export function fixtureOutputOccupancyKey(
  route: types.OutputRoute,
  fixtureUid: string,
): string | null {
  if (!fixtureUidsFromOutputSource(route.source).has(fixtureUid)) {
    return null;
  }
  return stableOutputTargetKey(route.target);
}

export function outputRouteTouchesFixture(
  route: types.OutputRoute,
  fixtureUid: string,
): boolean {
  const sourceUids = fixtureUidsFromOutputSource(route.source);
  return sourceUids.has(fixtureUid);
}

/** Returns whether a disabled input rule filters input from the fixture. */
export function disabledRouteTouchesFixture(
  route: types.DisabledRoute,
  fixtureUid: string,
): boolean {
  return fixtureUidsFromInputSource(route.data.source).has(fixtureUid);
}

export function formatFixtureGroupLabel(fixture: types.Fixture): string {
  const label = fixture.identifiers.label;
  if (label) return `Fixture ${fixture.identifiers.id} (${label})`;
  return `Fixture ${fixture.identifiers.id}`;
}

export function formatGroupWithChevron(
  isExpanded: boolean,
  label: string,
): string {
  return `${isExpanded ? "▼" : "▶"} ${label}`;
}
