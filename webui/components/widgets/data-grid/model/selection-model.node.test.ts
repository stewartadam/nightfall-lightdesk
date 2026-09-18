// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CompactSelection } from "../../../../lib/data-grid-types";
import {
  deleteSelectionFromState,
  editCommitSelectionFromState,
  effectiveSelectedColumns,
  effectiveSelectedRows,
  initialDataGridSelectionState,
  reduceDataGridSelection,
  selectionFromState,
  selectionIncludesCell,
} from "./selection-model";

/**
 * Creates an empty selection state so selection-model tests start from a known baseline.
 */
function freshState() {
  return { ...initialDataGridSelectionState };
}

test("selectCell tracks active cell, anchor, and extended ranges", () => {
  let state = freshState();

  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [1, 1],
    extend: false,
  });
  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [3, 2],
    extend: true,
  });

  assert.deepEqual(state.activeCell, [3, 2]);
  assert.deepEqual(state.current?.cell, [3, 2]);
  assert.deepEqual(state.current?.range, { x: 1, y: 1, width: 3, height: 2 });
  assert.equal(selectionIncludesCell(state.current!, [2, 2]), true);
});

test("selectCell appends and removes ranges through one reducer path", () => {
  let state = freshState();

  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [0, 0],
    extend: false,
  });
  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [2, 2],
    append: true,
    extend: false,
  });

  assert.equal(selectionIncludesCell(state.current!, [0, 0]), true);
  assert.equal(selectionIncludesCell(state.current!, [2, 2]), true);

  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [0, 0],
    append: true,
    extend: false,
  });

  assert.equal(selectionIncludesCell(state.current!, [0, 0]), false);
  assert.equal(selectionIncludesCell(state.current!, [2, 2]), true);
});

test("drag actions add and subtract cell ranges", () => {
  let state = reduceDataGridSelection(freshState(), {
    type: "selectCell",
    target: [0, 0],
    extend: false,
  });

  state = reduceDataGridSelection(state, {
    type: "beginDrag",
    target: [1, 1],
    append: true,
  });
  state = reduceDataGridSelection(state, {
    type: "dragTo",
    target: [2, 2],
  });

  assert.equal(selectionIncludesCell(state.current!, [0, 0]), true);
  assert.equal(selectionIncludesCell(state.current!, [2, 2]), true);

  state = reduceDataGridSelection(state, {
    type: "beginDrag",
    target: [1, 1],
    append: true,
  });
  state = reduceDataGridSelection(state, {
    type: "dragTo",
    target: [2, 2],
  });

  assert.equal(selectionIncludesCell(state.current!, [0, 0]), true);
  assert.equal(selectionIncludesCell(state.current!, [1, 1]), false);
  assert.equal(selectionIncludesCell(state.current!, [2, 2]), false);
});

test("row actions preserve active cell while extending row ranges", () => {
  let state = reduceDataGridSelection(freshState(), {
    type: "selectCell",
    target: [1, 2],
    extend: false,
  });

  state = reduceDataGridSelection(state, { type: "selectActiveRow" });
  assert.deepEqual(state.activeCell, [1, 2]);
  assert.deepEqual(state.selectedRows, [2]);

  state = reduceDataGridSelection(state, {
    type: "extendRowSelection",
    direction: 1,
    rowCount: 10,
  });
  assert.deepEqual(state.selectedRows, [2, 3]);

  state = reduceDataGridSelection(state, {
    type: "extendRowSelection",
    direction: -1,
    rowCount: 10,
  });
  assert.deepEqual(state.selectedRows, [2]);
});

test("selectCell preserves row selection when activating a selected row cell", () => {
  let state = reduceDataGridSelection(freshState(), {
    type: "toggleRow",
    row: 1,
    extend: false,
  });
  state = reduceDataGridSelection(state, {
    type: "toggleRow",
    row: 2,
    extend: false,
  });

  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [3, 1],
    extend: false,
  });

  assert.deepEqual(state.activeCell, [3, 1]);
  assert.deepEqual(state.selectedRows, [1, 2]);
});

test("selectCell can clear selected rows for keyboard navigation", () => {
  let state = reduceDataGridSelection(freshState(), {
    type: "toggleRow",
    row: 1,
    extend: false,
  });

  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [3, 1],
    extend: false,
    preserveSelectedRows: false,
  });

  assert.deepEqual(state.activeCell, [3, 1]);
  assert.deepEqual(state.selectedRows, []);
});

test("selectCell clears row selection when activating an unselected row cell", () => {
  let state = reduceDataGridSelection(freshState(), {
    type: "toggleRow",
    row: 1,
    extend: false,
  });

  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [3, 2],
    extend: false,
  });

  assert.deepEqual(state.selectedRows, []);
});

test("toggleRow removes selected cells from unchecked rows", () => {
  let state = reduceDataGridSelection(freshState(), {
    type: "selectCell",
    target: [1, 1],
    extend: false,
  });
  state = reduceDataGridSelection(state, {
    type: "selectCell",
    target: [3, 3],
    extend: true,
  });

  state = reduceDataGridSelection(state, {
    type: "toggleRow",
    row: 2,
    extend: false,
  });

  assert.equal(selectionIncludesCell(state.current!, [1, 1]), true);
  assert.equal(selectionIncludesCell(state.current!, [2, 2]), false);
  assert.equal(selectionIncludesCell(state.current!, [3, 3]), true);
  assert.deepEqual(state.selectedRows, []);
});

test("toggleRow clears active cell selection for unchecked active rows", () => {
  let state = reduceDataGridSelection(freshState(), {
    type: "selectCell",
    target: [3, 2],
    extend: false,
  });

  state = reduceDataGridSelection(state, {
    type: "toggleRow",
    row: 2,
    extend: false,
  });

  assert.equal(state.current, undefined);
  assert.equal(state.activeCell, undefined);
  assert.deepEqual(state.selectedRows, []);
});

test("controlled selection syncs through state and merges effective sets", () => {
  const state = reduceDataGridSelection(
    reduceDataGridSelection(freshState(), {
      type: "toggleRow",
      row: 1,
      extend: false,
    }),
    {
      type: "syncExternalSelection",
      selection: {
        rows: CompactSelection.fromArray([3]),
        columns: CompactSelection.fromArray([2]),
        current: {
          cell: [2, 3],
          range: { x: 2, y: 3, width: 1, height: 1 },
          rangeStack: [],
        },
      },
    },
  );

  assert.deepEqual(state.activeCell, [2, 3]);
  assert.deepEqual(effectiveSelectedRows(state), [3]);
  assert.deepEqual(effectiveSelectedColumns(state), [2]);
});

test("deleteSelection stores returned rows and columns for publication", () => {
  const state = reduceDataGridSelection(freshState(), {
    type: "deleteSelection",
    selection: {
      rows: CompactSelection.fromArray([4]),
      columns: CompactSelection.fromArray([2, 5]),
    },
  });

  assert.deepEqual(selectionFromState(state).rows.toArray(), [4]);
  assert.deepEqual(selectionFromState(state).columns.toArray(), [2, 5]);
  assert.deepEqual(deleteSelectionFromState(state).rows.toArray(), [4]);
});

test("editCommitSelectionFromState preserves selected columns for inline edits", () => {
  const state = reduceDataGridSelection(freshState(), {
    type: "selectColumnRange",
    start: 2,
    endExclusive: 4,
    activeRow: 5,
  });

  const selection = editCommitSelectionFromState(state);

  assert.deepEqual(state.activeCell, [2, 5]);
  assert.deepEqual(selection.rows.toArray(), []);
  assert.deepEqual(selection.columns.toArray(), [2, 3]);
  assert.equal(selection.current, undefined);
});

test("extendColumnSelection expands header-selected columns from the active cell", () => {
  let state = reduceDataGridSelection(freshState(), {
    type: "selectColumnRange",
    start: 2,
    endExclusive: 3,
    activeRow: 4,
  });

  state = reduceDataGridSelection(state, {
    type: "extendColumnSelection",
    direction: 1,
    columnCount: 6,
  });

  assert.deepEqual(state.activeCell, [3, 4]);
  assert.deepEqual(selectionFromState(state).columns.toArray(), [2, 3]);

  state = reduceDataGridSelection(state, {
    type: "extendColumnSelection",
    direction: -1,
    columnCount: 6,
  });

  assert.deepEqual(state.activeCell, [2, 4]);
  assert.deepEqual(selectionFromState(state).columns.toArray(), [2]);
});
