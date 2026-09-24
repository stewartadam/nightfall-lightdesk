// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  BindingConflictColumn,
  UniverseKey,
} from "../../../lib/binding-overlap";
import {
  alwaysVisibleColumnMeta,
  columnVisibilityMeta,
  type VisibilityGridColumn,
} from "../../../lib/datagrid-column-visibility";
import type { FilterableGridColumn } from "../../../lib/datagrid-filtering";
import type * as types from "../../../types";
import type { BindingRow } from "./bindings-model";
export type UniverseGroupRow = {
  rowKind: "universe";
  universe: UniverseKey;
  bindingCounts: { input: number; output: number; disabled: number };
  inputOverlap: boolean;
  outputOverlap: boolean;
  isExpanded: boolean;
};

export type UniverseBindingRow = {
  rowKind: "binding";
  universe: UniverseKey;
  binding: BindingRow;
  conflictColumns: Set<BindingConflictColumn>;
};

export type UniverseDisplayRow = UniverseGroupRow | UniverseBindingRow;

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
          ? row.bindingCounts.disabled > 0
            ? "Disabled"
            : ""
          : row.binding.kind,
    },
    ...columnVisibilityMeta("Binding", "Type"),
  },
  {
    title: "Source",
    id: "source",
    width: 280,
    filter: {
      value: (row) =>
        row.rowKind === "universe"
          ? `In ${row.bindingCounts.input}`
          : row.binding.source,
    },
    ...columnVisibilityMeta("Binding", "Source"),
  },
  {
    title: "Target",
    id: "target",
    width: 280,
    filter: {
      value: (row) =>
        row.rowKind === "universe"
          ? `DMX ${row.bindingCounts.output}`
          : row.binding.target,
    },
    ...columnVisibilityMeta("Binding", "Target"),
  },
  {
    title: "Priority",
    id: "priority",
    width: 90,
    filter: {
      kind: "number",
      value: (row) => (row.rowKind === "binding" ? row.binding.priority : null),
    },
    ...columnVisibilityMeta("Binding", "Priority"),
  },
  {
    title: "Clone",
    id: "clone",
    width: 70,
    filter: {
      kind: "boolean",
      value: (row) => row.rowKind === "binding" && row.binding.clone,
    },
    ...columnVisibilityMeta("Binding", "Clone"),
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
    case "Disabled":
      return [];
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

/** Returns whether a universe tab cell represents a patch conflict. */
export function universeDisplayCellHasConflict(
  row: UniverseDisplayRow,
  columnId: string | undefined,
): boolean {
  if (row.rowKind === "binding") {
    return (
      (columnId === "source" || columnId === "target") &&
      row.conflictColumns.has(columnId)
    );
  }

  return (
    (columnId === "source" && row.inputOverlap) ||
    (columnId === "target" && row.outputOverlap)
  );
}
