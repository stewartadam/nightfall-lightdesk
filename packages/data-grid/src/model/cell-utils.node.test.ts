// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type GridCell, GridCellKind } from "../data-grid-types.ts";
import {
  canUseCellEditor,
  makeDeletedCell,
  makeEditedCell,
  makePastedCell,
} from "./cell-utils.ts";
import {
  secondsEditors as editors,
  secondsCell,
  secondsCellValue,
  secondsRenderer,
} from "./seconds-cell.test-fixture.ts";
import type {
  DataGridCellEditors,
  DataGridRichCellExtension,
} from "./types.ts";

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
    assert.equal(
      canUseCellEditor(source, { richCellExtensions: [extension] }),
      true,
    );
    const cell = { ...source, readonly: true };
    assert.equal(
      canUseCellEditor(cell, { richCellExtensions: [extension] }),
      false,
    );
    assert.equal(
      makeDeletedCell(cell, { richCellExtensions: [extension] }),
      undefined,
    );
    assert.equal(
      makePastedCell(cell, "Replacement", {
        richCellExtensions: [extension],
      }),
      undefined,
    );
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

/** Verifies custom cells edit through the text editor their renderer provides. */
test("makeEditedCell parses text through the matching renderer's text editor", () => {
  const original = secondsCell(3);

  const edited = makeEditedCell(original, "5s", editors);

  assert.notEqual(edited, original);
  assert.equal(secondsCellValue(edited), 5);
  assert.equal(edited.copyData, "5s");
});

/** Verifies text a custom text editor cannot parse leaves the cell unchanged. */
test("makeEditedCell keeps custom cells whose text does not parse", () => {
  const original = secondsCell(3);

  assert.equal(makeEditedCell(original, "soon", editors), original);
});

/** Verifies custom cells only become text-editable when a renderer provides a text editor. */
test("custom cells without a text editor do not open the inline editor", () => {
  const original = secondsCell(3);

  assert.equal(canUseCellEditor(original), false);
  assert.equal(canUseCellEditor(original, editors), true);
  assert.equal(
    canUseCellEditor({ ...original, readonly: true }, editors),
    false,
  );
  assert.equal(makeEditedCell(original, "5s"), original);
});

/** Verifies Delete and paste on custom cells go through the renderer's text editor. */
test("makeDeletedCell and makePastedCell use the custom text editor", () => {
  const deleted = makeDeletedCell(secondsCell(3), editors);
  assert.equal(secondsCellValue(deleted), undefined);

  const pasted = makePastedCell(secondsCell(3), "7s", editors);
  assert.equal(secondsCellValue(pasted), 7);

  const withoutDelete: DataGridCellEditors = {
    customRenderers: [
      { ...secondsRenderer, textEditor: { makeEditedCell: (cell) => cell } },
    ],
  };
  assert.equal(makeDeletedCell(secondsCell(3), withoutDelete), undefined);
});

/** Verifies an editable rich-cell extension wins over a renderer's text editor for every edit path. */
test("rich-cell extensions take precedence over custom text editors", () => {
  const extension: DataGridRichCellExtension = {
    id: "seconds-picker",
    matches: (cell) => cell.kind === GridCellKind.Custom,
    isEditable: () => true,
    render: () => "display",
    renderEditor: () => "editor",
    makeDeletedCell: (cell) => ({ ...cell, copyData: "rich-deleted" }),
    makePastedCell: (cell) => ({ ...cell, copyData: "rich-pasted" }),
  };
  const both: DataGridCellEditors = {
    ...editors,
    richCellExtensions: [extension],
  };

  assert.equal(makeDeletedCell(secondsCell(3), both)?.copyData, "rich-deleted");
  assert.equal(
    makePastedCell(secondsCell(3), "7s", both)?.copyData,
    "rich-pasted",
  );
  assert.equal(makeEditedCell(secondsCell(3), "7s", both).copyData, "3s");
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
