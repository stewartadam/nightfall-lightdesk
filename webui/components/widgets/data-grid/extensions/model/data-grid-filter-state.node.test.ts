// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";
import {
  type DataGridFilterColumn,
  EMPTY_TABLE_FILTERS,
  type TableFilterSettings,
} from "../../../../../lib/datagrid-filtering";
import { createDataGridFilterState } from "./data-grid-filter-state";

interface TestRow {
  id: number;
}

const rows: TestRow[] = [{ id: 1 }, { id: 2 }, { id: 3 }];

const columns: DataGridFilterColumn<TestRow>[] = [
  { id: "id", label: "ID", kind: "number", value: (row) => row.id },
];

/** Verifies callbacks can observe the previous filter state before an update is applied. */
test("createDataGridFilterState notifies before applying changed filters", () => {
  createRoot((dispose) => {
    let readFilters: (() => TableFilterSettings) | undefined;
    const filtersBeforeChanges: TableFilterSettings[] = [];
    const state = createDataGridFilterState({
      scope: "selection-clear-test",
      rows: () => rows,
      columns: () => columns,
      onFiltersChange: () => {
        const filters = readFilters?.();
        if (filters) {
          filtersBeforeChanges.push(filters);
        }
      },
    });
    readFilters = state.filters;

    state.setFilters({
      ...EMPTY_TABLE_FILTERS,
      rules: [{ columnId: "id", operator: "equals", value: "2" }],
    });

    assert.equal(filtersBeforeChanges.length, 1);
    assert.deepEqual(filtersBeforeChanges[0], EMPTY_TABLE_FILTERS);
    assert.deepEqual(state.filters().rules, [
      { columnId: "id", operator: "equals", value: "2" },
    ]);

    dispose();
  });
});
