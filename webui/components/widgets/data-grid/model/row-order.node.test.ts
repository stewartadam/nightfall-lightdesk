// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CompactSelection } from "../../../../lib/data-grid-types";
import { createDataGridRowMapping } from "./row-order";

/** Sorting must not expand a selected range to include rows that were never selected. */
test("row mapping preserves fragmented ranges and the active row after sorting", () => {
  const mapping = createDataGridRowMapping(
    ["a", "b", "c", "d"],
    ["b", "d", "a", "c"],
  );
  const selection = mapping.selection({
    columns: CompactSelection.empty(),
    rows: CompactSelection.fromArray([0, 2]),
    current: {
      cell: [1, 0],
      range: { x: 1, y: 0, width: 2, height: 2 },
      rangeStack: [],
    },
  });
  assert.deepEqual(selection.rows.toArray(), [2, 3]);
  assert.deepEqual(selection.current, {
    cell: [1, 2],
    range: { x: 1, y: 2, width: 2, height: 1 },
    rangeStack: [{ x: 1, y: 0, width: 2, height: 1 }],
  });
});

/** Removing a selected anchor chooses a surviving selected cell and excludes inserted rows. */
test("row mapping handles removed anchors and newly inserted rows", () => {
  const mapping = createDataGridRowMapping(["a", "b", "c"], ["new", "c", "b"]);
  const selection = mapping.selection({
    columns: CompactSelection.fromArray([2]),
    rows: CompactSelection.fromArray([0, 1]),
    current: {
      cell: [1, 0],
      range: { x: 1, y: 0, width: 1, height: 2 },
      rangeStack: [],
    },
  });
  assert.deepEqual(selection.rows.toArray(), [2]);
  assert.deepEqual(selection.columns.toArray(), [2]);
  assert.deepEqual(selection.current, {
    cell: [1, 2],
    range: { x: 1, y: 2, width: 1, height: 1 },
    rangeStack: [],
  });
  assert.equal(mapping.cell([0, 0]), undefined);
  assert.deepEqual(mapping.cell([0, 2]), [0, 1]);
});
