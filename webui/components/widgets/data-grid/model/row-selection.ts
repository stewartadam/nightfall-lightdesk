// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  CompactSelection,
  type GridSelection,
} from "../../../../lib/data-grid-types";

/**
 * Builds a controlled grid selection whose active cell sits in the first column
 * of one source row, or an empty selection when no row is chosen. Read-only
 * tables that track a single selected record derive their `gridSelection` from
 * it, so the highlight follows the record rather than a stale row index.
 * When `previous` (the grid's last reported selection) is already active on
 * that row, it is returned unchanged so the user's active cell and ranges
 * survive live data updates and remain copyable.
 */
export function singleRowGridSelection(
  row: number | undefined,
  previous?: GridSelection,
): GridSelection {
  if (
    previous &&
    row !== undefined &&
    row >= 0 &&
    activeGridSelectionRow(previous) === row
  ) {
    return previous;
  }
  const empty = {
    rows: CompactSelection.empty(),
    columns: CompactSelection.empty(),
  };
  if (row === undefined || row < 0) return empty;
  return {
    ...empty,
    current: {
      cell: [0, row],
      range: { x: 0, y: row, width: 1, height: 1 },
      rangeStack: [],
    },
  };
}

/** Returns the source row of a selection's active cell, if one is active. */
export function activeGridSelectionRow(
  selection: GridSelection,
): number | undefined {
  return selection.current?.cell[1];
}
