// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PauseIcon } from "@squidlab/phosphor-solid/pause";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useRevealObjectCapability } from "../../components/providers/panel-capabilities/context-core";
import PanelToolbar from "../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../components/ui/toolbar-button";
import { CRUD_CARD_CLASS } from "../../components/widgets/crud/crud-panel-styles";
import CrudScrollArea from "../../components/widgets/crud/crud-scroll-area";
import CrudViewModeToggle, {
  type CrudViewMode,
} from "../../components/widgets/crud/crud-view-mode-toggle";
import DataGrid, {
  activeGridSelectionRow,
  createKeyedDataGridCellProvider,
  type DataGridScrollRequest,
  singleRowGridSelection,
} from "../../components/widgets/data-grid";
import {
  changeCrudPanelViewMode,
  loadCrudPanelViewMode,
} from "../../lib/crud-panel-view-mode";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
} from "../../lib/data-grid-types";
import { commandClient } from "../../lib/engine-commands";
import type { BasePanelComponentProps } from "../../lib/panel-registry";
import { durationToMs, formatSMPTETime } from "../../lib/time-format";
import { useConditionalShallowStore } from "../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../lib/workspace-activity";
import { timecodes } from "../../state/appStores";
import type { TimecodeCommand } from "../../types";

interface TimecodePanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

interface TimecodeRow {
  id: number;
  uid: string;
  label: string;
  rate: string;
  source: string;
  running: boolean;
  currentFrame: string;
}

type TimecodeTransportCommand = TimecodeCommand["type"] &
  ("StartTimecode" | "PauseTimecode" | "StopTimecode");

const VIEW_MODE_KEY = "timecodes";

const TIMECODE_COLUMNS: GridColumn[] = [
  { id: "id", title: "ID", width: 72, sizing: "fixed" },
  { id: "label", title: "Label", width: 180, minWidth: 96, maxWidth: 320 },
  { id: "currentFrame", title: "Timecode", width: 120, sizing: "fixed" },
  { id: "rate", title: "Rate", width: 88, sizing: "fixed" },
  { id: "source", title: "Source", width: 112, minWidth: 80 },
  { id: "running", title: "Status", width: 96, sizing: "fixed" },
];

/** Projects one timecode into a sortable, left-aligned cell for the list view. */
function timecodeCell(row: TimecodeRow, column: GridColumn): GridCell {
  if (column.id === "id") {
    return {
      kind: GridCellKind.Number,
      data: row.id,
      displayData: String(row.id),
      contentAlign: "left",
    };
  }
  const text =
    column.id === "label"
      ? row.label
      : column.id === "currentFrame"
        ? row.currentFrame
        : column.id === "rate"
          ? row.rate
          : column.id === "source"
            ? row.source
            : runStateLabel(row.running);
  return { kind: GridCellKind.Text, data: text, contentAlign: "left" };
}

/** Names a timecode's run state the same way Status Display does. */
function runStateLabel(running: boolean): string {
  return running ? "Running" : "Idle";
}

/** Normalizes object UIDs for stable lookup and DOM keys. */
function normalizeUid(uid: unknown): string {
  return String(uid).replace(/-/g, "").toLowerCase();
}

/** Sends one transport command for a timecode to the engine. */
function sendTimecodeCommand(command: TimecodeTransportCommand, id: number) {
  const payload: TimecodeCommand = { type: command, data: id };
  commandClient.emit("TimecodeCommand", payload);
}

/**
 * Lists the show's timecodes as cards or a sortable table, with a toolbar that
 * starts, pauses and stops the selected timecode.
 */
export default function TimecodePanel(props: TimecodePanelProps) {
  const $timecodes = useConditionalShallowStore(
    timecodes,
    useWorkspaceActivity(),
  );
  let panelRoot: HTMLDivElement | undefined;
  const [selectedUid, setSelectedUid] = createSignal<string | null>(null);
  const [reportedSelection, setReportedSelection] =
    createSignal<GridSelection>();
  const [scrollRequest, setScrollRequest] = createSignal<
    DataGridScrollRequest | undefined
  >();
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode(VIEW_MODE_KEY, "list"),
  );

  /** Projects timecode objects and live state into rows ordered by ID. */
  const rows = createMemo<TimecodeRow[]>(() =>
    Object.values($timecodes())
      .map(([tc, tcState]) => ({
        id: tc.identifiers.id,
        uid: normalizeUid(tc.identifiers.uid),
        label: tc.identifiers.label,
        rate: String(tc.rate),
        source: String(tc.source),
        running: tcState.is_active,
        currentFrame: tcState.current_time
          ? formatSMPTETime(durationToMs(tcState.current_time), tc.rate)
          : "00:00:00:00",
      }))
      .sort((a, b) => a.id - b.id),
  );

  /** Resolves the selected timecode row, if it still exists. */
  const selectedRow = createMemo(() =>
    rows().find((row) => row.uid === selectedUid()),
  );

  /** Persists the chosen card or table layout for this panel. */
  const setViewMode = (mode: CrudViewMode) =>
    changeCrudPanelViewMode(VIEW_MODE_KEY, viewMode(), mode, setViewModeSignal);

  /** Selects and reveals a timecode requested by the showfile object palette. */
  useRevealObjectCapability(
    props.initialPanelId ?? props.id,
    (request) => {
      const uid = normalizeUid(request.uid);
      const row = rows().findIndex((candidate) => candidate.uid === uid);
      if (row < 0) return;
      setSelectedUid(uid);
      if (viewMode() === "list") {
        setScrollRequest((previous) => ({
          cell: [0, row],
          requestId: (previous?.requestId ?? 0) + 1,
        }));
      } else {
        setTimeout(() => {
          panelRoot
            ?.querySelector(`[data-timecode-uid="${uid}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }, 0);
      }
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

  /** Sends a transport command to the selected timecode. */
  const runSelected = (command: TimecodeTransportCommand) => {
    const row = selectedRow();
    if (row) sendTimecodeCommand(command, row.id);
  };

  return (
    <div ref={panelRoot} class="flex h-full min-h-0 flex-col text-white">
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              type="button"
              label="Start timecode"
              tooltip="Start"
              disabled={!selectedRow()}
              onClick={() => runSelected("StartTimecode")}
            >
              <PlayIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              type="button"
              label="Pause timecode"
              tooltip="Pause"
              disabled={!selectedRow()}
              onClick={() => runSelected("PauseTimecode")}
            >
              <PauseIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              type="button"
              label="Stop timecode"
              tooltip="Stop"
              variant="danger"
              disabled={!selectedRow()}
              onClick={() => runSelected("StopTimecode")}
            >
              <StopIcon class="size-4" aria-hidden />
            </ToolbarButton>
          </>
        }
        right={
          <CrudViewModeToggle
            viewMode={viewMode()}
            onViewModeChange={setViewMode}
          />
        }
      />
      <CrudScrollArea
        viewMode={viewMode()}
        aria-label="Timecodes scroll area"
        classList={{ "p-4": viewMode() === "grid" }}
      >
        <Show
          when={viewMode() === "grid"}
          fallback={
            <div class="h-full min-h-0">
              <DataGrid
                ariaLabel="Timecodes"
                readOnly
                selectionMode="row"
                columns={TIMECODE_COLUMNS}
                rows={rows().length}
                cellProvider={provider}
                sortableColumns={TIMECODE_COLUMNS.map((column) => column.id!)}
                freezeColumns={2}
                emptyState="No timecodes"
                gridSelection={selection()}
                onGridSelectionChange={(next) => {
                  setReportedSelection(next);
                  const row = activeGridSelectionRow(next);
                  setSelectedUid(
                    row === undefined ? null : (rows()[row]?.uid ?? null),
                  );
                }}
                scrollRequest={scrollRequest()}
              />
            </div>
          }
        >
          <Show
            when={rows().length > 0}
            fallback={
              <p class="py-8 text-center text-neutral-500">No timecodes</p>
            }
          >
            <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              <For each={rows()}>
                {(row) => (
                  <button
                    type="button"
                    data-timecode-uid={row.uid}
                    aria-pressed={selectedUid() === row.uid}
                    class={CRUD_CARD_CLASS}
                    data-selectable-surface
                    data-selected={selectedUid() === row.uid}
                    onClick={() => setSelectedUid(row.uid)}
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-bold text-neutral-200">{row.id}</span>
                      <span
                        class={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ${
                          row.running
                            ? "bg-emerald-500/20 text-emerald-200 ring-emerald-400/30"
                            : "bg-neutral-700/40 text-neutral-300 ring-neutral-600"
                        }`}
                      >
                        {runStateLabel(row.running)}
                      </span>
                    </div>
                    <div class="truncate text-sm text-neutral-400">
                      {row.label}
                    </div>
                    <div class="mt-1 font-mono text-sm text-neutral-200">
                      {row.currentFrame}
                    </div>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </CrudScrollArea>
    </div>
  );
}
