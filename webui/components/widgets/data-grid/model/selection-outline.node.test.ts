// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { selectionOutline } from "./selection-outline";

/** Creates an empty bounded grid for selection perimeter examples. */
function emptySelection(): Parameters<typeof selectionOutline>[0] {
  return {
    current: undefined,
    active: undefined,
    rows: new Set(),
    columns: new Set(),
    rowCount: 8,
    columnCount: 6,
  };
}

/** Verifies that rectangular selections have one perimeter and no interior outlines. */
test("selection outlines merge adjacent cells and ignore the active cell inside a range", () => {
  const selection = emptySelection();
  selection.active = [2, 2];
  selection.current = {
    cell: [2, 2],
    range: { x: 1, y: 1, width: 3, height: 3 },
    rangeStack: [],
  };
  assert.deepEqual(selectionOutline(selection, 2, 2), {
    selected: true,
    top: false,
    right: false,
    bottom: false,
    left: false,
    sharedRight: true,
    sharedBottom: true,
  });
  const corner = selectionOutline(selection, 1, 1);
  assert.equal(corner.top, true);
  assert.equal(corner.left, true);
  assert.equal(corner.right, false);
  assert.equal(corner.bottom, false);
  assert.equal(selectionOutline(selection, 0, 0).selected, false);
});

/** Keeps perimeter edges at grid bounds for whole rows and columns, even when virtualized. */
test("adjacent whole rows and columns share edges within grid bounds", () => {
  const selection = emptySelection();
  selection.rows = new Set([0, 1]);
  assert.equal(selectionOutline(selection, 0, 0).left, true);
  assert.equal(selectionOutline(selection, 0, 0).top, true);
  assert.equal(selectionOutline(selection, 0, 0).bottom, false);
  assert.equal(selectionOutline(selection, 5, 1).right, true);
  assert.equal(selectionOutline(selection, 5, 1).bottom, true);
  selection.rows = new Set();
  selection.columns = new Set([4, 5]);
  assert.equal(selectionOutline(selection, 4, 7).right, false);
  assert.equal(selectionOutline(selection, 4, 7).bottom, true);
  assert.equal(selectionOutline(selection, 5, 7).right, true);
});

/** Merges touching ranges while preserving concave boundaries and disconnected selections. */
test("stacked ranges preserve gaps and outline only the union boundary", () => {
  const selection = emptySelection();
  selection.current = {
    cell: [1, 1],
    range: { x: 1, y: 1, width: 2, height: 2 },
    rangeStack: [
      { x: 3, y: 1, width: 2, height: 1 },
      { x: 1, y: 5, width: 1, height: 1 },
    ],
  };
  assert.equal(selectionOutline(selection, 2, 1).right, false);
  assert.equal(selectionOutline(selection, 3, 1).left, false);
  assert.equal(selectionOutline(selection, 3, 1).bottom, true);
  assert.equal(selectionOutline(selection, 2, 2).right, true);
  assert.equal(selectionOutline(selection, 1, 4).selected, false);
  assert.deepEqual(selectionOutline(selection, 1, 5), {
    selected: true,
    top: true,
    right: true,
    bottom: true,
    left: true,
    sharedRight: false,
    sharedBottom: false,
  });
});
