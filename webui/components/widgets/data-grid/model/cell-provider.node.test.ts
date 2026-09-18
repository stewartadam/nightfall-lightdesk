// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { GridCell } from "../../../../lib/data-grid-types";
import { GridCellKind } from "../../../../lib/data-grid-types";
import {
  createKeyedDataGridCellProvider,
  keyedDataGridCellContent,
  keyedDataGridCellContentFn,
} from "./cell-provider";

interface TestRow {
  id: string;
}

interface TestColumn {
  id: string;
}

/** Creates a text cell for keyed provider tests. */
function textCell(value: string): GridCell {
  return {
    kind: GridCellKind.Text,
    data: value,
    displayData: value,
    allowOverlay: true,
  };
}

test("keyedDataGridCellContent maps viewport indices to stable row and column keys", () => {
  const rows: TestRow[] = [{ id: "row-a" }, { id: "row-b" }];
  const columns: TestColumn[] = [{ id: "intensity" }, { id: "color" }];
  const values = new Map([
    ["row-a:intensity", "A intensity"],
    ["row-b:color", "B color"],
  ]);
  const provider = createKeyedDataGridCellProvider({
    rows,
    columns,
    rowKey: (row) => row.id,
    columnKey: (column) => column.id,
    getCellContent: ({ row, column, rowKey, columnKey }) => {
      assert.equal(row.id, rowKey);
      assert.equal(column.id, columnKey);
      return textCell(values.get(`${rowKey}:${columnKey}`) ?? "missing");
    },
  });

  assert.deepEqual(
    keyedDataGridCellContent(provider, [0, 0]),
    textCell("A intensity"),
  );
  assert.deepEqual(
    keyedDataGridCellContent(provider, [1, 1]),
    textCell("B color"),
  );
});

test("keyedDataGridCellContentFn uses fallback content for uncovered coordinates", () => {
  const provider = createKeyedDataGridCellProvider({
    rows: [{ id: 1 }],
    columns: [{ id: "name" }],
    rowKey: (row) => row.id,
    columnKey: (column) => column.id,
    getCellContent: ({ rowKey, columnKey }) =>
      textCell(`${rowKey}:${columnKey}`),
  });
  const getCellContent = keyedDataGridCellContentFn(provider, () =>
    textCell("fallback"),
  );

  assert.deepEqual(getCellContent([0, 0]), textCell("1:name"));
  assert.deepEqual(getCellContent([1, 0]), textCell("fallback"));
  assert.deepEqual(getCellContent([0, 1]), textCell("fallback"));
});

/** Verifies providers expose an owner-defined intrinsic sizing revision. */
test("createKeyedDataGridCellProvider preserves the content sizing key", () => {
  const contentSizingKey = {};
  const provider = createKeyedDataGridCellProvider({
    rows: [{ id: 1 }],
    columns: [{ id: "name" }],
    contentSizingKey,
    rowKey: (row) => row.id,
    columnKey: (column) => column.id,
    getCellContent: () => textCell("Fixture"),
  });

  assert.equal(provider.contentSizingKey, contentSizingKey);
});
