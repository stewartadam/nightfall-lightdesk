// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  alwaysVisibleColumnMeta,
  columnVisibilityMeta,
  type VisibilityGridColumn,
} from "../../../lib/datagrid-column-visibility";
import type { FilterableGridColumn } from "../../../lib/datagrid-filtering";
import type {
  RouteConflictColumn,
  UniverseKey,
} from "../../../lib/route-overlap";
import type * as types from "../../../types";
import type { RouteRow } from "./routes-model";
export type UniverseGroupRow = {
  rowKind: "universe";
  universe: UniverseKey;
  routeCounts: { input: number; output: number; disabled: number };
  inputOverlap: boolean;
  outputOverlap: boolean;
  isExpanded: boolean;
};

export type UniverseRouteRow = {
  rowKind: "route";
  universe: UniverseKey;
  route: RouteRow;
  conflictColumns: Set<RouteConflictColumn>;
};

export type UniverseDisplayRow = UniverseGroupRow | UniverseRouteRow;

export type ConflictTooltipState = {
  id: number;
  content: string;
  anchorRect: DOMRect;
};

export const DEFAULT_COLUMNS: FilterableGridColumn<
  UniverseDisplayRow,
  VisibilityGridColumn
>[] = [
  {
    title: "Universe",
    id: "universe",
    width: 120,
    filter: { value: (row) => formatUniverseLabel(row.universe) },
    ...alwaysVisibleColumnMeta("Identity", "Universe"),
  },
  {
    title: "Type",
    id: "type",
    width: 140,
    filter: {
      value: (row) =>
        row.rowKind === "universe"
          ? row.routeCounts.disabled > 0
            ? "Disabled"
            : ""
          : row.route.kind,
    },
    ...columnVisibilityMeta("Route", "Type"),
  },
  {
    title: "Source",
    id: "source",
    width: 280,
    filter: {
      value: (row) =>
        row.rowKind === "universe"
          ? `In ${row.routeCounts.input}`
          : row.route.source,
    },
    ...columnVisibilityMeta("Route", "Source"),
  },
  {
    title: "Target",
    id: "target",
    width: 280,
    filter: {
      value: (row) =>
        row.rowKind === "universe"
          ? `DMX ${row.routeCounts.output}`
          : row.route.target,
    },
    ...columnVisibilityMeta("Route", "Target"),
  },
  {
    title: "Priority",
    id: "priority",
    width: 90,
    filter: {
      kind: "number",
      value: (row) => (row.rowKind === "route" ? row.route.priority : null),
    },
    ...columnVisibilityMeta("Route", "Priority"),
  },
  {
    title: "Clone",
    id: "clone",
    width: 70,
    filter: {
      kind: "boolean",
      value: (row) => row.rowKind === "route" && row.route.clone,
    },
    ...columnVisibilityMeta("Route", "Clone"),
  },
];

export const MAX_UNIVERSE_RANGE_EXPANSION = 64;

export function expandUniverseRange(
  range?: types.DmxRange,
): UniverseKey[] | "wildcard" | null {
  if (!range) return "wildcard";
  if (range.end < range.start) return null;

  const size = range.end - range.start + 1;
  if (size > MAX_UNIVERSE_RANGE_EXPANSION) return "wildcard";

  const universes: UniverseKey[] = [];
  for (let u = range.start; u <= range.end; u++) {
    universes.push(u);
  }
  return universes;
}

export function collectUniversesFromInputSource(
  source: types.InputSource,
): UniverseKey[] {
  switch (source.type) {
    case "Transport":
    case "Console": {
      const expanded = expandUniverseRange(source.data.universe);
      if (expanded === "wildcard") return ["*"];
      return expanded ?? [];
    }
    case "Fixture":
      return [];
  }
}

export function collectUniversesFromInputTarget(
  target: types.InputTarget,
): UniverseKey[] {
  switch (target.type) {
    case "Transport":
    case "Console": {
      const expanded = expandUniverseRange(target.data.universe);
      if (expanded === "wildcard") return ["*"];
      return expanded ?? [];
    }
    case "Fixture":
    case "Disabled":
      return [];
  }
}

export function collectUniversesFromOutputSource(
  source: types.OutputSource,
): UniverseKey[] {
  switch (source.type) {
    case "Console": {
      const expanded = expandUniverseRange(source.data.universe);
      if (expanded === "wildcard") return ["*"];
      return expanded ?? [];
    }
    case "Fixture":
    case "FixtureBreak":
      return [];
  }
}

export function collectUniversesFromOutputTarget(
  target: types.OutputTarget,
): UniverseKey[] {
  switch (target.type) {
    case "Transport":
    case "Console": {
      const expanded = expandUniverseRange(target.data.universe);
      if (expanded === "wildcard") return ["*"];
      return expanded ?? [];
    }
  }
}

export function formatUniverseLabel(key: UniverseKey): string {
  return key === "*" ? "Universe * (any)" : `Universe ${key}`;
}

export function formatGroupWithChevron(
  isExpanded: boolean,
  label: string,
): string {
  return `${isExpanded ? "▼" : "▶"} ${label}`;
}
