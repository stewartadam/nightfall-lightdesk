// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  CustomCell,
  CustomRenderer,
  GridColumn,
} from "../../../../lib/data-grid-types";
import { GridCellKind } from "../../../../lib/data-grid-types";
import { createKeyedDataGridCellProvider } from "./cell-provider";
import { sizeColumnsToContent } from "./column-sizing";
import type { DataGridRichCellExtension } from "./types";

/** Builds a deterministic canvas substitute that assigns ten pixels per character. */
function measurementContext(): CanvasRenderingContext2D {
  return {
    font: "",
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as CanvasRenderingContext2D;
}

/** Builds a provider whose text cells expose the selected object property. */
function textProvider(
  rows: readonly Record<string, string>[],
  columns: readonly GridColumn[],
) {
  return createKeyedDataGridCellProvider({
    rows,
    columns,
    rowKey: (_row, index) => index,
    columnKey: (column) => String(column.id),
    getCellContent: ({ row, column }) => ({
      kind: GridCellKind.Text,
      data: row[String(column.id)] ?? "",
    }),
  });
}

/** Verifies ordinary columns use the widest body value while fixed columns retain their width. */
test("sizeColumnsToContent measures all provider rows and preserves fixed columns", () => {
  const columns: GridColumn[] = [
    { id: "name", title: "Name", width: 240 },
    { id: "id", title: "ID", width: 75, sizing: "fixed" },
  ];
  const provider = textProvider(
    [
      { name: "Short", id: "1" },
      { name: "Longest value", id: "2" },
    ],
    columns,
  );

  const sized = sizeColumnsToContent({
    columns,
    provider,
    context: measurementContext(),
    nestedColumnGroups: false,
  });

  assert.equal(sized[0]?.width, 146);
  assert.equal(sized[1]?.width, 75);
});

/** Verifies measured widths obey per-column minimum and maximum constraints. */
test("sizeColumnsToContent clamps content widths", () => {
  const columns: GridColumn[] = [
    { id: "small", title: "", minWidth: 64 },
    { id: "large", title: "", maxWidth: 90 },
  ];
  const provider = textProvider(
    [
      {
        small: "x",
        large: "a value that is intentionally much too wide",
      },
    ],
    columns,
  );

  const sized = sizeColumnsToContent({
    columns,
    provider,
    context: measurementContext(),
    nestedColumnGroups: false,
  });

  assert.equal(sized[0]?.width, 64);
  assert.equal(sized[1]?.width, 90);
});

/** Verifies header groups can expand their content-sized child columns. */
test("sizeColumnsToContent fits grouped header labels", () => {
  const columns: GridColumn[] = [
    { id: "first", title: "", group: "A grouped heading" },
    { id: "second", title: "", group: "A grouped heading" },
  ];
  const provider = textProvider([], columns);

  const sized = sizeColumnsToContent({
    columns,
    provider,
    context: measurementContext(),
    nestedColumnGroups: false,
  });

  assert.ok((sized[0]?.width ?? 0) + (sized[1]?.width ?? 0) >= 186);
});

/** Verifies rich custom cells delegate intrinsic sizing to their renderer. */
test("sizeColumnsToContent uses custom renderer measurements", () => {
  const columns: GridColumn[] = [{ id: "rich", title: "Rich" }];
  const richCell: CustomCell<{ kind: "measured" }> = {
    kind: GridCellKind.Custom,
    data: { kind: "measured" },
  };
  const provider = createKeyedDataGridCellProvider({
    rows: [richCell],
    columns,
    rowKey: (_row, index) => index,
    columnKey: (column) => String(column.id),
    getCellContent: ({ row }) => row,
  });
  const renderer: CustomRenderer<typeof richCell> = {
    isMatch: (cell): cell is typeof richCell =>
      (cell.data as { kind?: string }).kind === "measured",
    draw: () => undefined,
    measure: () => 275,
  };

  const sized = sizeColumnsToContent({
    columns,
    provider,
    context: measurementContext(),
    customRenderers: [renderer],
    nestedColumnGroups: false,
  });

  assert.equal(sized[0]?.width, 275);
});

/** Verifies rich extensions measure the text and chrome they render instead of copy data. */
test("sizeColumnsToContent uses rich cell extension measurements", () => {
  const columns: GridColumn[] = [{ id: "rich", title: "Rich" }];
  const richCell: CustomCell<{ kind: "rich-extension" }> = {
    kind: GridCellKind.Custom,
    data: { kind: "rich-extension" },
    copyData: "short",
  };
  const provider = createKeyedDataGridCellProvider({
    rows: [richCell],
    columns,
    rowKey: (_row, index) => index,
    columnKey: (column) => String(column.id),
    getCellContent: ({ row }) => row,
  });
  const extension: DataGridRichCellExtension = {
    id: "test:rich-extension",
    matches: (cell) =>
      cell.kind === GridCellKind.Custom &&
      (cell.data as { kind?: string }).kind === "rich-extension",
    isEditable: () => true,
    measure: ({ measureText }) => measureText("rendered rich value") + 36,
    render: () => null as never,
    renderEditor: () => null as never,
  };

  const sized = sizeColumnsToContent({
    columns,
    provider,
    context: measurementContext(),
    richCellExtensions: [extension],
    nestedColumnGroups: false,
  });

  assert.equal(sized[0]?.width, 226);
});
