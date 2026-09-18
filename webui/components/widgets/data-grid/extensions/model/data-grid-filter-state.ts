// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createSignal } from "solid-js";
import {
  applyTableFilters,
  type DataGridFilterColumn,
  loadTableFilters,
  saveTableFilters,
  type TableFilterSettings,
} from "../../../../../lib/datagrid-filtering";

interface DataGridFilterStateParams<T> {
  scope: string;
  rows: () => readonly T[];
  columns: () => readonly DataGridFilterColumn<T>[];
  onFiltersChange?: () => void;
}

export function createDataGridFilterState<T>(
  params: DataGridFilterStateParams<T>,
) {
  const [filters, setFiltersSignal] = createSignal<TableFilterSettings>(
    loadTableFilters(params.scope),
  );

  const filteredRows = createMemo<T[]>(() => {
    const rows = params.rows();
    const columns = params.columns();
    if (columns.length === 0) return [...rows];
    return applyTableFilters(rows, columns, filters());
  });

  const setFilters = (nextFilters: TableFilterSettings) => {
    params.onFiltersChange?.();
    setFiltersSignal(nextFilters);
    saveTableFilters(params.scope, nextFilters);
  };

  return {
    filters,
    filteredRows,
    setFilters,
  };
}
