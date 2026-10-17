// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createMemo, createSignal } from "solid-js";
import { useRevealObjectCapability } from "../../components/providers/panel-capabilities/context-core";
import DataGrid, {
  activeGridSelectionRow,
  createKeyedDataGridCellProvider,
  type DataGridScrollRequest,
  singleRowGridSelection,
} from "../../components/widgets/data-grid";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
} from "../../lib/data-grid-types";
import type { BasePanelComponentProps } from "../../lib/panel-registry";
import { durationToMs, formatSMPTETime } from "../../lib/time-format";
import { useConditionalShallowStore } from "../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../lib/workspace-activity";
import { timecodes } from "../../state/appStores";

interface TimecodePanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

interface TimecodeRow {
  id: number;
  uid: string;
  running: boolean;
  currentFrame: string;
}

const TIMECODE_COLUMNS: GridColumn[] = [
  { id: "id", title: "ID", width: 80, sizing: "fixed" },
  { id: "currentFrame", title: "Timecode", width: 140, sizing: "fixed" },
  { id: "running", title: "Status", width: 120, sizing: "fixed" },
];

/** Projects one timecode into a sortable cell: numeric ID, monospaced frame and run state. */
function timecodeCell(row: TimecodeRow, column: GridColumn): GridCell {
  switch (column.id) {
    case "id":
      return {
        kind: GridCellKind.Number,
        data: row.id,
        displayData: String(row.id),
        contentAlign: "left",
      };
    case "currentFrame":
      return {
        kind: GridCellKind.Text,
        data: row.currentFrame,
        contentAlign: "left",
      };
    default:
      return {
        kind: GridCellKind.Text,
        data: row.running ? "Running" : "Stopped",
        contentAlign: "left",
      };
  }
}

/** Normalizes object UIDs for stable lookup and DOM keys. */
function normalizeUid(uid: unknown): string {
  return String(uid).replace(/-/g, "").toLowerCase();
}

export default function TimecodePanel(props: TimecodePanelProps) {
  const $timecodes = useConditionalShallowStore(
    timecodes,
    useWorkspaceActivity(),
  );
  const [rows, setRows] = createSignal<TimecodeRow[]>([]);
  const [selectedUid, setSelectedUid] = createSignal<string | null>(null);

  const [reportedSelection, setReportedSelection] =
    createSignal<GridSelection>();
  const [scrollRequest, setScrollRequest] = createSignal<
    DataGridScrollRequest | undefined
  >();

  // Update rows when timecodes change
  createEffect(() => {
    const timecodeList = Object.values($timecodes());
    const newRows = timecodeList
      .map(([tc, tcState]) => ({
        id: tc.identifiers.id,
        uid: normalizeUid(tc.identifiers.uid),
        running: tcState.is_active,
        currentFrame: tcState.current_time
          ? formatSMPTETime(durationToMs(tcState.current_time), tc.rate)
          : "00:00:00:00",
      }))
      .sort((a, b) => a.id - b.id);
    setRows(newRows);
  });

  /** Selects and reveals a timecode requested by the showfile object palette. */
  useRevealObjectCapability(
    props.initialPanelId ?? props.id,
    (request) => {
      const uid = normalizeUid(request.uid);
      const row = rows().findIndex((candidate) => candidate.uid === uid);
      if (row < 0) return;
      setSelectedUid(uid);
      setScrollRequest((previous) => ({
        cell: [0, row],
        requestId: (previous?.requestId ?? 0) + 1,
      }));
    },
    { accepts: (payload) => payload.type === "timecode" },
  );

  /** Highlights the selected timecode at its current source row as live updates arrive. */
  const selection = createMemo(() =>
    singleRowGridSelection(
      rows().findIndex((row) => row.uid === selectedUid()),
      reportedSelection(),
    ),
  );

  /** Keys timecode rows by UID so selection and header sorts survive live frame updates. */
  const provider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: rows(),
      columns: TIMECODE_COLUMNS,
      rowKey: (row) => row.uid,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => timecodeCell(row, column),
    }),
  );

  return (
    <div class="h-full w-full p-4 dark:text-white">
      <DataGrid
        ariaLabel="Timecodes"
        readOnly
        columns={TIMECODE_COLUMNS}
        rows={rows().length}
        cellProvider={provider}
        sortableColumns={TIMECODE_COLUMNS.map((column) => column.id!)}
        freezeColumns={1}
        height="content"
        class="max-h-full"
        emptyState="No timecodes"
        gridSelection={selection()}
        onGridSelectionChange={(next) => {
          setReportedSelection(next);
          const row = activeGridSelectionRow(next);
          setSelectedUid(row === undefined ? null : (rows()[row]?.uid ?? null));
        }}
        scrollRequest={scrollRequest()}
      />
    </div>
  );
}
