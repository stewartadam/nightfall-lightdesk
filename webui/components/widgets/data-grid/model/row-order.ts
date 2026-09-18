// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  CompactSelection,
  type GridSelection,
  type Item,
  type Rectangle,
} from "../../../../lib/data-grid-types";
import type { DataGridCellKey } from "./cell-provider";
import type { DataGridSelectionState } from "./selection-model";

/** Maps positions between row orders using the provider's stable row identities. */
export function createDataGridRowMapping(
  previous: readonly DataGridCellKey[],
  next: readonly DataGridCellKey[],
) {
  const nextIndexes = new Map(next.map((key, index) => [key, index]));

  /** Resolves a surviving row in the destination order. */
  const row = (index: number | undefined): number | undefined =>
    index === undefined ? undefined : nextIndexes.get(previous[index]);

  /** Preserves a cell's column while following its row identity. */
  const cell = (value: Item | undefined): Item | undefined => {
    if (!value) return undefined;
    const index = row(value[1]);
    return index === undefined ? undefined : [value[0], index];
  };

  /** Splits a rectangle into contiguous destination runs without selecting intervening rows. */
  const ranges = (value: Rectangle): Rectangle[] => {
    const indexes: number[] = [];
    for (let index = value.y; index < value.y + value.height; index += 1) {
      const mapped = row(index);
      if (mapped !== undefined) indexes.push(mapped);
    }
    indexes.sort((a, b) => a - b);
    const result: Rectangle[] = [];
    for (const index of indexes) {
      const last = result[result.length - 1];
      if (last && last.y + last.height === index) last.height += 1;
      else result.push({ x: value.x, y: index, width: value.width, height: 1 });
    }
    return result;
  };

  /** Preserves selected row identities and cell ranges across sorting, insertion and removal. */
  const selection = (value: GridSelection): GridSelection => {
    const mappedRanges = value.current
      ? [value.current.range, ...value.current.rangeStack].flatMap(ranges)
      : [];
    const anchor = cell(value.current?.cell);
    const anchorRangeIndex = anchor
      ? mappedRanges.findIndex(
          (range) =>
            anchor[0] >= range.x &&
            anchor[0] < range.x + range.width &&
            anchor[1] >= range.y &&
            anchor[1] < range.y + range.height,
        )
      : -1;
    const [range] = mappedRanges.splice(Math.max(0, anchorRangeIndex), 1);
    return {
      columns: value.columns,
      rows: CompactSelection.fromArray(
        value.rows.toArray().flatMap((index) => {
          const mapped = row(index);
          return mapped === undefined ? [] : [mapped];
        }),
      ),
      current: range
        ? {
            cell: anchor ?? [range.x, range.y],
            range,
            rangeStack: mappedRanges,
          }
        : undefined,
    };
  };

  /** Carries keyboard anchors and controlled selection with rows, ending any interrupted drag. */
  const state = (value: DataGridSelectionState): DataGridSelectionState => ({
    ...value,
    activeCell: cell(value.activeCell),
    selectionAnchor: cell(value.selectionAnchor),
    selectedRows: value.selectedRows.flatMap((index) => {
      const mapped = row(index);
      return mapped === undefined ? [] : [mapped];
    }),
    rowSelectionAnchor: row(value.rowSelectionAnchor),
    rowSelectionExtent: row(value.rowSelectionExtent),
    current: selection({
      current: value.current,
      rows: CompactSelection.empty(),
      columns: CompactSelection.empty(),
    }).current,
    externalSelection: value.externalSelection
      ? selection(value.externalSelection)
      : undefined,
    drag: undefined,
  });

  return { row, cell, selection, state };
}
