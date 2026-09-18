// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridRichCellExtension,
} from "../components/widgets/data-grid";
import {
  CompactSelection,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
} from "../lib/data-grid-types";
import { formatSMPTETime } from "../lib/time-format";
import { TimecodeRate } from "../types";

const sourceNames = [
  "Main show",
  "Backup clock",
  "Video playback",
  "House lights",
];
const states = ["Running", "Stopped", "Paused", "Waiting"];
const columns: GridColumn[] = [
  { id: "id", title: "ID", width: 64, sizing: "fixed" },
  { id: "name", title: "Source", width: 180, sizing: "fixed" },
  { id: "timecode", title: "Timecode", width: 140, sizing: "fixed" },
  { id: "rate", title: "Rate", width: 80, sizing: "fixed" },
  { id: "state", title: "Status", width: 120, sizing: "fixed" },
];
interface SourceRow {
  id: number;
  name: string;
  positionMs: number;
  state: string;
}

/** Seeds monitoring samples long enough to exercise scrolling and numeric sorting. */
function sampleSources(): SourceRow[] {
  return Array.from({ length: 24 }, (_, index) => ({
    id: index + 1,
    name: sourceNames[index] ?? `Timecode source ${index + 1}`,
    positionMs: index % 4 === 1 ? 0 : 725400 + index * 43100,
    state: states[index % states.length],
  }));
}

/** Supplies typed sortable values while preserving formatted monitoring text for copy. */
function sourceCell(row: SourceRow, column: GridColumn): GridCell {
  if (column.id === "state")
    return {
      kind: GridCellKind.Custom,
      data: { kind: "monitor-state", state: row.state },
      copyData: row.state,
    };
  if (column.id === "name")
    return {
      kind: GridCellKind.Text,
      data: row.name,
      allowOverlay: true,
      contentAlign: "left",
    };
  const value =
    column.id === "id" ? row.id : column.id === "rate" ? 30 : row.positionMs;
  const display =
    column.id === "id"
      ? String(row.id).padStart(2, "0")
      : column.id === "rate"
        ? "30 fps"
        : formatSMPTETime(row.positionMs, TimecodeRate.Fps30);
  return {
    kind: GridCellKind.Number,
    data: value,
    displayData: display,
    copyData: display,
    allowOverlay: true,
    contentAlign: "left",
  };
}

const statusExtension: DataGridRichCellExtension = {
  id: "monitor-state",
  matches: (cell) =>
    cell.kind === GridCellKind.Custom &&
    (cell.data as { kind?: string }).kind === "monitor-state",
  isEditable: () => false,
  measure: ({ measureText, cell }) => measureText(cell.copyData ?? "") + 20,
  render: ({ cell }) => (
    <span class="monitor-state" data-state={cell.copyData}>
      <i aria-hidden="true" />
      {cell.copyData}
    </span>
  ),
  renderEditor: () => null,
};

/** Demonstrates live read-only values using the production grid's sorting, resizing and selection. */
export function ReadOnlyTableDemo(props: {
  compact: boolean;
  columnGuides: boolean;
  active: boolean;
}) {
  const [sources, setSources] = createSignal(sampleSources());
  const [live, setLive] = createSignal(true);
  const [selection, setSelection] = createSignal<GridSelection>({
    rows: CompactSelection.empty(),
    columns: CompactSelection.empty(),
  });
  /** Resolves the selected source through the grid's source-coordinate callback contract. */
  const selectedSource = createMemo(() => {
    const current = selection().current;
    return current ? sources()[current.cell[1]]?.name : undefined;
  });
  /** Advances only running sample clocks while the monitoring tab is visible. */
  createEffect(() => {
    if (!props.active || !live()) return;
    const timer = window.setInterval(
      () =>
        setSources((rows) =>
          rows.map((row) =>
            row.state === "Running"
              ? { ...row, positionMs: row.positionMs + 1000 }
              : row,
          ),
        ),
      1000,
    );
    onCleanup(() => window.clearInterval(timer));
  });
  /** Exposes stable source IDs independently of sorting and live clock updates. */
  const provider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: sources(),
      columns,
      rowKey: (row) => row.id,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => sourceCell(row, column),
    }),
  );
  return (
    <div class="data-grid-demo lab-panel">
      <div class="panel-toolbar flex-wrap">
        <span class="toolbar-title">
          Timecode sources <span class="count">{sources().length} sources</span>
        </span>
        <ToggleSwitch
          label="Live updates"
          ariaLabel="Live updates"
          checked={live()}
          onChange={setLive}
        />
      </div>
      <div class="lab-data-grid">
        <DataGrid
          ariaLabel="Timecode source status"
          readOnly
          columns={columns}
          rows={sources().length}
          cellProvider={provider}
          sortableColumns={columns.map((column) => column.id!)}
          richCellExtensions={[statusExtension]}
          density={props.compact ? "compact" : "comfortable"}
          columnGuides={props.columnGuides}
          gridSelection={selection()}
          onGridSelectionChange={setSelection}
        />
      </div>
      <div class="panel-footnote">
        <span>Live sample · No output</span>
        <span>
          {selectedSource()
            ? `${selectedSource()} selected`
            : "Sort headers · Select and copy"}
        </span>
      </div>
    </div>
  );
}
