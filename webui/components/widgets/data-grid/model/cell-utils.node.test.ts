// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type GridCell, GridCellKind } from "../../../../lib/data-grid-types";
import {
  isRichTimeCell,
  makeTimeCell,
} from "../../../../lib/datagrid-rich-cells";
import {
  canUseCellEditor,
  makeDeletedCell,
  makeEditedCell,
  makePastedCell,
} from "./cell-utils";
import type { DataGridRichCellExtension } from "./types";

/** Read-only cells remain immutable even when a provider advertises edit overlays or a rich editor. */
test("readonly overrides built-in and rich-cell edit capabilities", () => {
  const extension: DataGridRichCellExtension = {
    id: "editable-sample",
    matches: (cell) => cell.kind === GridCellKind.Custom,
    isEditable: () => true,
    render: () => "display",
    renderEditor: () => "editor",
    makeDeletedCell: (cell) => ({ ...cell, copyData: "deleted" }),
    makePastedCell: (cell) => ({ ...cell, copyData: "pasted" }),
  };
  const cells: GridCell[] = [
    { kind: GridCellKind.Text, data: "Text", allowOverlay: true },
    { kind: GridCellKind.Number, data: 42, allowOverlay: true },
    { kind: GridCellKind.Boolean, data: true },
    {
      kind: GridCellKind.Custom,
      data: {},
      copyData: "Rich",
      allowOverlay: true,
    },
  ];
  for (const source of cells) {
    assert.equal(canUseCellEditor(source, [extension]), true);
    const cell = { ...source, readonly: true };
    assert.equal(canUseCellEditor(cell, [extension]), false);
    assert.equal(makeDeletedCell(cell, [extension]), undefined);
    assert.equal(makePastedCell(cell, "Replacement", [extension]), undefined);
  }
});

/** Verifies Delete turns editable numeric cells into the shared numeric empty value. */
test("makeDeletedCell clears editable numbers to zero", () => {
  const deleted = makeDeletedCell({
    kind: GridCellKind.Number,
    data: 42,
    displayData: "42",
    allowOverlay: true,
  });

  assert.deepEqual(deleted, {
    kind: GridCellKind.Number,
    data: 0,
    displayData: "0",
    allowOverlay: true,
  });
});

/** Verifies Delete turns editable text cells into an empty string value. */
test("makeDeletedCell clears editable text to an empty string", () => {
  const deleted = makeDeletedCell({
    kind: GridCellKind.Text,
    data: "Label",
    displayData: "Label",
    allowOverlay: true,
  });

  assert.deepEqual(deleted, {
    kind: GridCellKind.Text,
    data: "",
    displayData: "",
    allowOverlay: true,
  });
});

/** Verifies Delete uses rich time cell clear state when the cell allows clearing. */
test("makeDeletedCell marks clearable time cells as cleared", () => {
  const original: GridCell = makeTimeCell({
    value: { secs: 3, nanos: 0 },
    clearable: true,
  });

  const deleted = makeDeletedCell(original);

  if (
    !deleted ||
    deleted.kind !== GridCellKind.Custom ||
    !isRichTimeCell(deleted)
  ) {
    assert.fail("Expected Delete to create a rich time cell");
  }
  assert.equal(deleted.data.cleared, true);
  assert.equal(deleted.copyData, "");
});

/** Verifies zero reciprocal unit edits keep explicit zero timings intact. */
test("makeEditedCell preserves clearable zero bpm and hertz time cells", () => {
  const bpmOriginal: GridCell = makeTimeCell({
    value: { secs: 0, nanos: 0 },
    clearable: true,
    displayUnit: "bpm",
  });
  const hzOriginal: GridCell = makeTimeCell({
    value: { secs: 0, nanos: 0 },
    clearable: true,
    displayUnit: "hertz",
  });

  const bpmEdited = makeEditedCell(bpmOriginal, "0bpm");
  const hzEdited = makeEditedCell(hzOriginal, "0hz");

  if (
    bpmEdited.kind !== GridCellKind.Custom ||
    hzEdited.kind !== GridCellKind.Custom ||
    !isRichTimeCell(bpmEdited) ||
    !isRichTimeCell(hzEdited)
  ) {
    assert.fail("Expected edited cells to remain rich time cells");
  }
  assert.equal(bpmEdited.data.cleared, false);
  assert.equal(bpmEdited.data.value.secs, 0);
  assert.equal(bpmEdited.copyData, "0bpm");
  assert.equal(hzEdited.data.cleared, false);
  assert.equal(hzEdited.data.value.secs, 0);
  assert.equal(hzEdited.copyData, "0hz");
});

/** Verifies invalid non-empty timing edits do not clear existing timing cells. */
test("makeEditedCell ignores invalid clearable time text", () => {
  const original: GridCell = makeTimeCell({
    value: { secs: 3, nanos: 0 },
    clearable: true,
  });

  assert.equal(makeEditedCell(original, "not-a-duration"), original);
});

/** Verifies blank timing edits still clear cells that allow clearing. */
test("makeEditedCell clears blank clearable time text", () => {
  const original: GridCell = makeTimeCell({
    value: { secs: 3, nanos: 0 },
    clearable: true,
  });

  const edited = makeEditedCell(original, "   ");

  if (edited.kind !== GridCellKind.Custom || !isRichTimeCell(edited)) {
    assert.fail("Expected edited cell to remain a rich time cell");
  }
  assert.equal(edited.data.cleared, true);
  assert.equal(edited.copyData, "");
});

/** Verifies Delete leaves readonly cells untouched. */
test("makeDeletedCell ignores readonly editable-looking cells", () => {
  const deleted = makeDeletedCell({
    kind: GridCellKind.Text,
    data: "Locked",
    displayData: "Locked",
    allowOverlay: true,
    readonly: true,
  });

  assert.equal(deleted, undefined);
});
