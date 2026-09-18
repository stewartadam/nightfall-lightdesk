// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ContextMenuEntry } from "../../../components/providers/context-menu";
import type {
  GridColumn,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import type { RichTimeDisplayUnit } from "../../../lib/datagrid-rich-cell-helpers";
import {
  TIME_DISPLAY_UNIT_LABELS,
  TIME_DISPLAY_UNITS,
} from "../../../lib/time-display-units";

/** Returns the column indexes covered by a selected range. */
function rangeColumnIndexes(range: { x: number; width: number }): number[] {
  const indexes: number[] = [];
  for (let index = range.x; index < range.x + range.width; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

/** Returns whether a cell coordinate is inside the given range. */
function rangeContainsCell(
  range: { x: number; y: number; width: number; height: number },
  [col, row]: Item,
): boolean {
  return (
    col >= range.x &&
    col < range.x + range.width &&
    row >= range.y &&
    row < range.y + range.height
  );
}

/** Resolves the time-display columns affected by a unit context-menu action. */
export function selectedTimeDisplayColumnIds(options: {
  columns: readonly GridColumn[];
  clickedCell: Item;
  selection: GridSelection | undefined;
  isTimeDisplayColumnId: (columnId: string | undefined) => boolean;
}): string[] {
  const [clickedCol] = options.clickedCell;
  const clickedColumnId = options.columns[clickedCol]?.id;
  if (
    typeof clickedColumnId !== "string" ||
    !options.isTimeDisplayColumnId(clickedColumnId)
  ) {
    return [];
  }

  const selection = options.selection;
  const candidateIndexes = new Set<number>();
  const selectedColumns = selection?.columns.toArray() ?? [];
  const ranges = selection?.current
    ? [selection.current.range, ...selection.current.rangeStack]
    : [];
  const clickedInSelection =
    selectedColumns.includes(clickedCol) ||
    ranges.some((range) => rangeContainsCell(range, options.clickedCell));

  if (clickedInSelection) {
    for (const index of selectedColumns) {
      candidateIndexes.add(index);
    }
    for (const range of ranges) {
      for (const index of rangeColumnIndexes(range)) {
        candidateIndexes.add(index);
      }
    }
  }

  if (candidateIndexes.size === 0) {
    candidateIndexes.add(clickedCol);
  }

  const selectedIds = [...candidateIndexes]
    .sort((left, right) => left - right)
    .map((index) => options.columns[index]?.id)
    .filter(
      (columnId): columnId is string =>
        typeof columnId === "string" && options.isTimeDisplayColumnId(columnId),
    );
  return selectedIds.includes(clickedColumnId)
    ? selectedIds
    : [clickedColumnId];
}

/** Builds the shared context-menu entries for time display unit selection. */
export function timeUnitContextMenuEntries(options: {
  currentUnit: RichTimeDisplayUnit;
  onSelect: (unit: RichTimeDisplayUnit) => void;
}): ContextMenuEntry[] {
  return [
    {
      type: "heading",
      id: "units-heading",
      label: "Units",
    },
    {
      type: "submenu",
      id: "units-time",
      label: "Time",
      items: TIME_DISPLAY_UNITS.map((unit) => ({
        id: `units-time-${unit}`,
        label: TIME_DISPLAY_UNIT_LABELS[unit],
        checked: options.currentUnit === unit,
        onSelect: () => options.onSelect(unit),
      })),
    },
  ];
}
