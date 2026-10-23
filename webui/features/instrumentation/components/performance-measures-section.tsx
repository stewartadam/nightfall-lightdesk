// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, Show } from "solid-js";
import { Collapsible } from "../../../components/ui/collapsible";
import { Button } from "../../../components/ui/visual-language/button";
import DataGrid, {
  createKeyedDataGridCellProvider,
} from "../../../components/widgets/data-grid";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
} from "../../../lib/data-grid-types";
import type { PerformanceMeasureStats } from "../../../state/appStores";
import { formatMeasureName } from "../model/message-table";
import { formatMeasureValue } from "../model/metrics";

interface PerformanceMeasuresSectionProps {
  measures: PerformanceMeasureStats[];
  onClear: () => void;
  onDownload: () => void;
}

type MeasureValueKey =
  | "avgMs"
  | "p90Ms"
  | "p95Ms"
  | "p99Ms"
  | "maxMs"
  | "lastMs";

/** Builds a fixed-width, right-aligned numeric column for one timing statistic. */
function measureColumn(
  id: MeasureValueKey | "count",
  title: string,
): GridColumn {
  return { id, title, width: 88, sizing: "fixed", align: "right" };
}

const MEASURE_COLUMNS: GridColumn[] = [
  { id: "scope", title: "Scope", width: 260, sizing: "fixed" },
  measureColumn("count", "Count"),
  measureColumn("avgMs", "Avg"),
  measureColumn("p90Ms", "P90"),
  measureColumn("p95Ms", "P95"),
  measureColumn("p99Ms", "P99"),
  measureColumn("maxMs", "Max"),
  measureColumn("lastMs", "Last"),
];

/**
 * Projects one User Timing aggregate into a sortable cell: the scope shows its
 * short name and copies the full measure name, and statistics sort by raw value
 * while displaying in the measure's own unit.
 */
function measureCell(
  stats: PerformanceMeasureStats,
  column: GridColumn,
): GridCell {
  if (column.id === "scope") {
    return {
      kind: GridCellKind.Text,
      data: formatMeasureName(stats.name),
      copyData: stats.name,
      contentAlign: "left",
    };
  }
  if (column.id === "count") {
    return {
      kind: GridCellKind.Number,
      data: stats.count,
      displayData: String(stats.count),
      contentAlign: "right",
    };
  }
  const value = stats[column.id as MeasureValueKey];
  const display = formatMeasureValue(value, stats.unit);
  return {
    kind: GridCellKind.Number,
    data: value,
    displayData: display,
    copyData: display,
    contentAlign: "right",
  };
}

/** Presents sortable User Timing aggregates and their diagnostic actions. */
export function PerformanceMeasuresSection(
  props: PerformanceMeasuresSectionProps,
) {
  /** Keys aggregates by measure name so a header sort follows each scope as samples update. */
  const measureProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: props.measures,
      columns: MEASURE_COLUMNS,
      rowKey: (stats) => stats.name,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => measureCell(row, column),
    }),
  );
  return (
    <Collapsible
      lazy
      title="Performance Metrics"
      contentClass="p-3"
      actions={
        <span class="font-mono text-xs">
          {props.measures.length} scopes / 60s
        </span>
      }
    >
      <Show
        when={props.measures.length > 0}
        fallback={
          <div class="rounded-lg bg-neutral-800 p-3 text-sm text-neutral-500">
            Waiting for frontend measures...
          </div>
        }
      >
        <div class="rounded-lg bg-neutral-800 p-3">
          <p class="mb-2 text-xs text-neutral-400">
            Newest 6,000 samples per scope within 60 seconds.
          </p>
          <div class="mb-2 flex justify-end gap-2">
            <Button size="compact" type="button" onClick={props.onDownload}>
              Download JSON
            </Button>
            <Button size="compact" type="button" onClick={props.onClear}>
              Clear
            </Button>
          </div>
          <DataGrid
            ariaLabel="Performance metrics"
            readOnly
            columns={MEASURE_COLUMNS}
            rows={props.measures.length}
            cellProvider={measureProvider}
            sortableColumns={MEASURE_COLUMNS.map((column) => column.id!)}
            freezeColumns={1}
            height="content"
            class="max-h-[420px]"
          />
        </div>
      </Show>
    </Collapsible>
  );
}
