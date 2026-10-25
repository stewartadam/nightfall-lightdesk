// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  GridCell,
  GridSelection,
  Item,
} from "../../../../lib/data-grid-types";
import {
  CompactSelection,
  GridCellKind,
} from "../../../../lib/data-grid-types";
import {
  isRichTimeCell,
  makeTimeCell,
} from "../../../../lib/datagrid-rich-cells";
import {
  clipboardEditsForPaste,
  clipboardTextForSelection,
  discreteEditEditsForSelection,
  inlineEditEditsForSelection,
  parseClipboardText,
  selectedClipboardCells,
} from "./clipboard";

/** Builds an empty public grid selection for clipboard tests. */
function emptySelection(): GridSelection {
  return {
    rows: CompactSelection.empty(),
    columns: CompactSelection.empty(),
  };
}

/** Builds a text cell used by clipboard serialization tests. */
function textCell(value: string): GridCell {
  return {
    kind: GridCellKind.Text,
    data: value,
    displayData: value,
    allowOverlay: true,
  };
}

/** Builds a number cell used by clipboard paste tests. */
function numberCell(value: number): GridCell {
  return {
    kind: GridCellKind.Number,
    data: value,
    displayData: String(value),
    allowOverlay: true,
  };
}

/** Reads numeric test cell data after asserting the returned cell kind. */
function numberCellData(cell: GridCell): number {
  assert.equal(cell.kind, GridCellKind.Number);
  return cell.data;
}

/** Builds a clearable timing cell used by inline edit tests. */
function timeCell(seconds: number): GridCell {
  return makeTimeCell({
    value: { secs: seconds, nanos: 0 },
    clearable: true,
  });
}

test("selectedClipboardCells expands rectangular ranges in row-major order", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [2, 2],
      range: { x: 1, y: 1, width: 2, height: 2 },
      rangeStack: [],
    },
  };

  assert.deepEqual(selectedClipboardCells(selection, 10, 10), [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ]);
});

test("clipboardTextForSelection preserves tabular shape", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [1, 1],
      range: { x: 0, y: 0, width: 2, height: 2 },
      rangeStack: [],
    },
  };

  /** Returns deterministic cell text matching the requested coordinate. */
  const getCellContent = ([col, row]: Item) => textCell(`${row},${col}`);

  assert.equal(
    clipboardTextForSelection(selection, 5, 5, getCellContent),
    "0,0\t0,1\n1,0\t1,1",
  );
});

test("clipboardTextForSelection preserves copy data over display data", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [0, 0],
      range: { x: 0, y: 0, width: 1, height: 1 },
      rangeStack: [],
    },
  };

  /** Returns a cell with a display-only relative marker and plain copy text. */
  const getCellContent = (): GridCell => ({
    kind: GridCellKind.Text,
    data: "0.5",
    displayData: "~ 50%",
    copyData: "50%",
    allowOverlay: true,
  });

  assert.equal(
    clipboardTextForSelection(selection, 1, 1, getCellContent),
    "50%",
  );
});

test("parseClipboardText treats pasted text as rows and tab-separated columns", () => {
  assert.deepEqual(parseClipboardText("a\tb\r\nc\td\n"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("clipboardEditsForPaste anchors tabular data at the selection bounds", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [2, 3],
      range: { x: 2, y: 3, width: 1, height: 1 },
      rangeStack: [],
    },
  };

  const edits = clipboardEditsForPaste({
    selection,
    rowCount: 10,
    columnCount: 10,
    text: "10\t11\n20\t21",
    getCellContent: () => numberCell(0),
  });

  assert.deepEqual(
    edits.map((edit) => [
      edit.cell,
      edit.newValue.kind,
      numberCellData(edit.newValue),
    ]),
    [
      [[2, 3], GridCellKind.Number, 10],
      [[3, 3], GridCellKind.Number, 11],
      [[2, 4], GridCellKind.Number, 20],
      [[3, 4], GridCellKind.Number, 21],
    ],
  );
});

test("clipboardEditsForPaste fills selected cells with a single pasted value", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [0, 0],
      range: { x: 0, y: 0, width: 1, height: 3 },
      rangeStack: [],
    },
  };

  const edits = clipboardEditsForPaste({
    selection,
    rowCount: 5,
    columnCount: 5,
    text: "42",
    getCellContent: () => numberCell(0),
  });

  assert.deepEqual(
    edits.map((edit) => [edit.cell, numberCellData(edit.newValue)]),
    [
      [[0, 0], 42],
      [[0, 1], 42],
      [[0, 2], 42],
    ],
  );
});

/** Verifies pasted invalid timing text does not commit the existing time value. */
test("clipboardEditsForPaste ignores invalid time text", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [0, 0],
      range: { x: 0, y: 0, width: 1, height: 1 },
      rangeStack: [],
    },
  };

  const edits = clipboardEditsForPaste({
    selection,
    rowCount: 1,
    columnCount: 1,
    text: "not-a-duration",
    getCellContent: () => timeCell(3),
  });

  assert.equal(edits.length, 0);
});

/** Verifies typed inline edits fill every cell in a multi-column range selection. */
test("inlineEditEditsForSelection fills multi-column selected cells", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [1, 1],
      range: { x: 1, y: 1, width: 2, height: 2 },
      rangeStack: [],
    },
  };

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [1, 1],
    rowCount: 5,
    columnCount: 5,
    value: "7",
    dirty: true,
    getCellContent: () => numberCell(0),
  });

  assert.deepEqual(
    edits.map((edit) => [edit.cell, numberCellData(edit.newValue)]),
    [
      [[1, 1], 7],
      [[2, 1], 7],
      [[1, 2], 7],
      [[2, 2], 7],
    ],
  );
});

/** Verifies typed inline edits fill every cell in a single-column range selection. */
test("inlineEditEditsForSelection fills single-column selected cells", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [1, 1],
      range: { x: 1, y: 1, width: 1, height: 3 },
      rangeStack: [],
    },
  };

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [1, 1],
    rowCount: 5,
    columnCount: 5,
    value: "9",
    dirty: true,
    getCellContent: () => numberCell(0),
  });

  assert.deepEqual(
    edits.map((edit) => [edit.cell, numberCellData(edit.newValue)]),
    [
      [[1, 1], 9],
      [[1, 2], 9],
      [[1, 3], 9],
    ],
  );
});

/** Verifies discrete editors fill every cell in the active range selection. */
test("discreteEditEditsForSelection fills selected range cells", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [1, 1],
      range: { x: 1, y: 1, width: 1, height: 3 },
      rangeStack: [],
    },
  };

  const edits = discreteEditEditsForSelection({
    selection,
    editCell: [1, 1],
    rowCount: 5,
    columnCount: 5,
    getCellContent: () => textCell("Manual"),
    makeEditedCell: (original) =>
      original.kind === GridCellKind.Text
        ? { ...original, data: "Follow" }
        : undefined,
  });

  assert.deepEqual(
    edits.map((edit) => [edit.cell, edit.newValue.kind]),
    [
      [[1, 1], GridCellKind.Text],
      [[1, 2], GridCellKind.Text],
      [[1, 3], GridCellKind.Text],
    ],
  );
  assert.deepEqual(
    edits.map((edit) =>
      edit.newValue.kind === GridCellKind.Text ? edit.newValue.data : "",
    ),
    ["Follow", "Follow", "Follow"],
  );
});

/** Verifies row-marker selections remain panel-defined for discrete editors. */
test("discreteEditEditsForSelection leaves row-marker selection expansion to panels", () => {
  const selection: GridSelection = {
    rows: CompactSelection.fromArray([1, 2]),
    columns: CompactSelection.empty(),
  };

  const edits = discreteEditEditsForSelection({
    selection,
    editCell: [3, 1],
    rowCount: 5,
    columnCount: 5,
    getCellContent: () => textCell("Manual"),
    makeEditedCell: (original) =>
      original.kind === GridCellKind.Text
        ? { ...original, data: "Follow" }
        : undefined,
  });

  assert.deepEqual(
    edits.map((edit) => edit.cell),
    [[3, 1]],
  );
});

/** Verifies typed inline edits fill cells under selected column headers. */
test("inlineEditEditsForSelection fills selected column cells", () => {
  const selection: GridSelection = {
    rows: CompactSelection.empty(),
    columns: CompactSelection.fromArray([2]),
  };

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [2, 0],
    rowCount: 3,
    columnCount: 5,
    value: "11",
    dirty: true,
    getCellContent: () => numberCell(0),
  });

  assert.deepEqual(
    edits.map((edit) => [edit.cell, numberCellData(edit.newValue)]),
    [
      [[2, 0], 11],
      [[2, 1], 11],
      [[2, 2], 11],
    ],
  );
});

/** Verifies clean commits do not copy an unchanged anchor across selected columns. */
test("inlineEditEditsForSelection skips selected column fan-out when clean", () => {
  const selection: GridSelection = {
    rows: CompactSelection.empty(),
    columns: CompactSelection.fromArray([2]),
  };

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [2, 0],
    rowCount: 3,
    columnCount: 5,
    value: "2",
    dirty: false,
    getCellContent: ([, row]) => numberCell(row === 0 ? 2 : 0),
  });

  assert.deepEqual(edits, []);
});

/** Verifies typed input fans out even when the anchor already has that value. */
test("inlineEditEditsForSelection fans out dirty same-value anchor edits", () => {
  const selection: GridSelection = {
    rows: CompactSelection.empty(),
    columns: CompactSelection.fromArray([2]),
  };

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [2, 0],
    rowCount: 3,
    columnCount: 5,
    value: "2",
    dirty: true,
    getCellContent: ([, row]) => numberCell(row === 0 ? 2 : 0),
  });

  assert.deepEqual(
    edits.map((edit) => [edit.cell, numberCellData(edit.newValue)]),
    [
      [[2, 1], 2],
      [[2, 2], 2],
    ],
  );
});

/** Verifies row-marker selections do not fan typed edits across every row cell. */
test("inlineEditEditsForSelection leaves row-marker selection expansion to panels", () => {
  const selection: GridSelection = {
    rows: CompactSelection.fromArray([1, 2]),
    columns: CompactSelection.empty(),
  };

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [3, 1],
    rowCount: 5,
    columnCount: 5,
    value: "12",
    dirty: true,
    getCellContent: () => numberCell(0),
  });

  assert.deepEqual(
    edits.map((edit) => edit.cell),
    [[3, 1]],
  );
  assert.equal(numberCellData(edits[0]!.newValue), 12);
});

/** Verifies unchanged inline text commits do not rewrite cells with richer display data. */
test("inlineEditEditsForSelection skips unchanged display text", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [0, 0],
      range: { x: 0, y: 0, width: 1, height: 1 },
      rangeStack: [],
    },
  };
  const blockedCell: GridCell = {
    kind: GridCellKind.Text,
    data: "0",
    displayData: "B 0",
    copyData: "B 0",
    allowOverlay: true,
  };

  const unchangedEdits = inlineEditEditsForSelection({
    selection,
    editCell: [0, 0],
    rowCount: 1,
    columnCount: 1,
    value: "B 0",
    dirty: false,
    getCellContent: () => blockedCell,
  });
  const changedEdits = inlineEditEditsForSelection({
    selection,
    editCell: [0, 0],
    rowCount: 1,
    columnCount: 1,
    value: "0",
    dirty: true,
    getCellContent: () => blockedCell,
  });

  assert.deepEqual(unchangedEdits, []);
  assert.equal(changedEdits.length, 1);
  assert.deepEqual(changedEdits[0]?.cell, [0, 0]);
});

/** Verifies invalid timing text does not fan out a destructive clear edit. */
test("inlineEditEditsForSelection ignores invalid time text", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [0, 0],
      range: { x: 0, y: 0, width: 1, height: 1 },
      rangeStack: [],
    },
  };

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [0, 0],
    rowCount: 1,
    columnCount: 1,
    value: "not-a-duration",
    dirty: true,
    getCellContent: () => timeCell(3),
  });

  assert.equal(edits.length, 0);
});

/** Verifies panels can opt in to raw unparsed timing text for custom syntax. */
test("inlineEditEditsForSelection preserves opted-in unparsed time text", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [0, 0],
      range: { x: 0, y: 0, width: 1, height: 1 },
      rangeStack: [],
    },
  };
  const original = timeCell(3);

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [0, 0],
    rowCount: 1,
    columnCount: 1,
    value: "0>5s",
    dirty: true,
    shouldCommitUnparsedTimeInput: (value) => value.includes(">"),
    getCellContent: () => original,
  });

  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.newValue, original);
  assert.equal(edits[0]!.inputValue, "0>5s");
});

/** Verifies blank timing text still creates a clear edit. */
test("inlineEditEditsForSelection clears blank time text", () => {
  const selection: GridSelection = {
    ...emptySelection(),
    current: {
      cell: [0, 0],
      range: { x: 0, y: 0, width: 1, height: 1 },
      rangeStack: [],
    },
  };

  const edits = inlineEditEditsForSelection({
    selection,
    editCell: [0, 0],
    rowCount: 1,
    columnCount: 1,
    value: "",
    dirty: true,
    getCellContent: () => timeCell(3),
  });

  assert.equal(edits.length, 1);
  const edited = edits[0]!.newValue;
  if (edited.kind !== GridCellKind.Custom || !isRichTimeCell(edited)) {
    assert.fail("Expected blank timing edit to produce a rich time cell");
  }
  assert.equal(edited.data.cleared, true);
});
