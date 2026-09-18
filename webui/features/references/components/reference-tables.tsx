// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo } from "solid-js";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridRichCellExtension,
} from "../../../components/widgets/data-grid";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
} from "../../../lib/data-grid-types";
import {
  type ReferenceEntry,
  type ReferenceIssue,
  referenceDomainLabel,
  referenceIssueReasonLabel,
} from "../../../lib/reference-audit";
import {
  REFERENCE_COLUMNS,
  REFERENCE_ROW_HEIGHT,
} from "../model/reference-panel-model";

const referenceColumns: GridColumn[] = REFERENCE_COLUMNS.map((column) => ({
  id: column.id,
  title: column.label,
  width: column.defaultWidth,
  minWidth: column.minWidth,
  sizing: "fixed",
}));
const healthColumns: GridColumn[] = [
  { id: "issue", title: "Issue", width: 200, minWidth: 144, sizing: "fixed" },
  { id: "source", title: "Source", width: 128, minWidth: 104, sizing: "fixed" },
  { id: "object", title: "Object", width: 220, minWidth: 128, sizing: "fixed" },
  { id: "target", title: "Target", width: 200, minWidth: 112, sizing: "fixed" },
  { id: "action", title: "Action", width: 96, minWidth: 80, sizing: "fixed" },
  { id: "path", title: "Path", width: 360, minWidth: 160, sizing: "fixed" },
];

/** Exposes copyable audit text with optional domain-specific badge or path presentation. */
function auditCell(
  row: ReferenceEntry | ReferenceIssue,
  column: GridColumn,
): GridCell {
  let value: string;
  switch (column.id) {
    case "target":
      value = row.targetLabel;
      break;
    case "source":
      value = referenceDomainLabel(row.source.domain);
      break;
    case "object":
      value = `${row.source.id}: ${row.source.label}`;
      break;
    case "path":
      value = row.path;
      break;
    case "status":
      value = "status" in row && row.status === "ok" ? "OK" : "Missing";
      break;
    case "issue":
      value = "reason" in row ? referenceIssueReasonLabel(row.reason) : "";
      break;
    case "action":
      value = "prunable" in row && row.prunable ? "Prune" : "Manual";
      break;
    default:
      value = "";
  }
  if (
    column.id === "status" ||
    column.id === "action" ||
    column.id === "path"
  ) {
    return {
      kind: GridCellKind.Custom,
      data: { kind: "reference-detail", column: column.id },
      copyData: value,
    };
  }
  return {
    kind: GridCellKind.Text,
    data: value,
    contentAlign: "left",
    readonly: true,
  };
}

const referenceDetailExtension: DataGridRichCellExtension = {
  id: "reference-detail",
  matches: (cell) =>
    cell.kind === GridCellKind.Custom &&
    (cell.data as { kind?: string }).kind === "reference-detail",
  isEditable: () => false,
  measure: ({ cell, measureText }) => measureText(cell.copyData ?? "") + 16,
  render: ({ cell }) => {
    if (cell.kind !== GridCellKind.Custom) return null;
    const column = (cell.data as { column: string }).column;
    if (column === "status")
      return (
        <ReferenceStatusPill
          status={cell.copyData === "OK" ? "ok" : "missing"}
        />
      );
    if (column === "action")
      return (
        <span
          class={
            cell.copyData === "Prune"
              ? "rounded bg-amber-950 px-2 py-1 text-xs text-amber-200"
              : "rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400"
          }
        >
          {cell.copyData}
        </span>
      );
    return <span class="truncate font-mono">{cell.copyData}</span>;
  },
  renderEditor: () => null,
};

/** Renders one compact reference-audit summary metric. */
export function ReferenceSummaryCell(props: { label: string; value: number }) {
  return (
    <div class="rounded border border-neutral-800 bg-neutral-900 px-3 py-2">
      <div class="text-xs uppercase text-neutral-500">{props.label}</div>
      <div class="text-lg font-semibold text-neutral-100">{props.value}</div>
    </div>
  );
}

/** Presents reverse references through the shared grid's keyed rows, resizing and virtualization. */
export function ReferencesTable(props: { references: ReferenceEntry[] }) {
  /** Keeps reference identity stable across filtering and audit refreshes. */
  const provider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: props.references,
      columns: referenceColumns,
      rowKey: (row) => row.id,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => auditCell(row, column),
    }),
  );
  return (
    <div
      class="h-full min-w-0"
      data-component="ReferencesTable"
      data-reference-count={props.references.length}
    >
      <DataGrid
        ariaLabel="References"
        readOnly
        columns={referenceColumns}
        rows={props.references.length}
        cellProvider={provider}
        richCellExtensions={[referenceDetailExtension]}
        rowHeight={REFERENCE_ROW_HEIGHT}
        sortableColumns={referenceColumns.map((column) => column.id!)}
        emptyState="No references"
      />
    </div>
  );
}

/** Shares the same grid structure for missing-reference health details and repair status. */
export function ReferenceHealthTable(props: { issues: ReferenceIssue[] }) {
  /** Retains issue identity while domain and text filters change the visible projection. */
  const provider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: props.issues,
      columns: healthColumns,
      rowKey: (row) => row.id,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => auditCell(row, column),
    }),
  );
  return (
    <DataGrid
      ariaLabel="Reference health"
      readOnly
      columns={healthColumns}
      rows={props.issues.length}
      cellProvider={provider}
      richCellExtensions={[referenceDetailExtension]}
      rowHeight={REFERENCE_ROW_HEIGHT}
      sortableColumns={healthColumns.map((column) => column.id!)}
      emptyState="No missing references"
    />
  );
}

/** Renders the status badge for a reverse-reference row. */
export function ReferenceStatusPill(props: {
  status: ReferenceEntry["status"];
}) {
  return (
    <span
      class={
        props.status === "ok"
          ? "rounded bg-emerald-950 px-2 py-1 text-xs text-emerald-200"
          : "rounded bg-red-950 px-2 py-1 text-xs text-red-200"
      }
    >
      {props.status === "ok" ? "OK" : "Missing"}
    </span>
  );
}
