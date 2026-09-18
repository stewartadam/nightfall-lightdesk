// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GridSelection, Item } from "../../../../lib/data-grid-types";
import { isSelectedCell } from "./selection-model";

interface SelectionOutlineInput {
  current: GridSelection["current"] | undefined;
  active: Item | undefined;
  rows: ReadonlySet<number>;
  columns: ReadonlySet<number>;
  rowCount: number;
  columnCount: number;
}

/** Finds exposed and shared edges in the union of ranges, rows, columns, and the active cell. */
export function selectionOutline(
  selection: SelectionOutlineInput,
  col: number,
  row: number,
) {
  /** Tests logical membership independently of which cells are currently mounted by virtualization. */
  const includes = (x: number, y: number): boolean =>
    x >= 0 &&
    y >= 0 &&
    x < selection.columnCount &&
    y < selection.rowCount &&
    ((selection.active?.[0] === x && selection.active?.[1] === y) ||
      selection.rows.has(y) ||
      selection.columns.has(x) ||
      isSelectedCell(selection.current, x, y));
  const selected = includes(col, row);
  return {
    selected,
    top: selected && !includes(col, row - 1),
    right: selected && !includes(col + 1, row),
    bottom: selected && !includes(col, row + 1),
    left: selected && !includes(col - 1, row),
    sharedRight: selected && includes(col + 1, row),
    sharedBottom: selected && includes(col, row + 1),
  };
}
