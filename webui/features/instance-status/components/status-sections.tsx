// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PauseIcon } from "@squidlab/phosphor-solid/pause";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { QueueIcon } from "@squidlab/phosphor-solid/queue";
import { SparkleIcon } from "@squidlab/phosphor-solid/sparkle";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { createMemo, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AppIcon } from "../../../components/ui/icon";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridRichCellExtension,
} from "../../../components/widgets/data-grid";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
} from "../../../lib/data-grid-types";
import { durationToMs, formatSMPTETime } from "../../../lib/time-format";
import {
  InstanceKind,
  type InstanceKind as InstanceKindType,
  type Timecode,
  TimecodeRate,
  type TimecodeState,
} from "../../../types";
import {
  type TimecodeStatusTone,
  timecodeRateLabel,
  timecodeSourceLabel,
  timecodeStatus,
  timecodeStatusPillClass,
} from "../../timecode";
import {
  compactId,
  formatInstanceNext,
  formatInstancePosition,
  formatPercent,
  instanceKindClass,
  instanceKindLabel,
  instanceStateClass,
  instanceStateLabel,
  instanceStateTitle,
  type StatusInstanceInfo,
} from "../model/instance-status-model";

type StatusIconButtonProps = {
  label: string;
  icon: AppIcon;
  disabled?: boolean;
  onClick: () => void;
  variant?: "neutral" | "danger";
};

export type ActiveInstancesSectionProps = {
  rows: StatusInstanceInfo[];
  clipLabel: (clipId: number | null | undefined) => string;
  ownerLabels: (instance: StatusInstanceInfo) => string;
  onStop: (instanceId: StatusInstanceInfo["instance_id"]) => void;
  onStopAll: () => void;
  onStopKind: (kind: InstanceKindType) => void;
};

export type TimecodeRow = {
  timecode: Timecode;
  state: TimecodeState;
};

export type TimecodeSectionProps = {
  rows: TimecodeRow[];
  runningCount: number;
  onCommand: (
    command: "StartTimecode" | "PauseTimecode" | "StopTimecode",
    id: number,
  ) => void;
};

/** Renders a compact icon-only action used by status table controls. */
function StatusIconButton(props: StatusIconButtonProps) {
  return (
    <ToolbarButton
      label={props.label}
      variant={props.variant}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Dynamic component={props.icon} class="size-4" aria-hidden />
    </ToolbarButton>
  );
}

const INSTANCE_ROW_HEIGHT = 44;
const INSTANCE_COLUMNS: GridColumn[] = [
  { id: "kind", title: "Kind", width: 112, sizing: "fixed" },
  { id: "instance", title: "Instance", width: 192, sizing: "fixed" },
  { id: "state", title: "State", width: 128, sizing: "fixed" },
  { id: "clip", title: "Clip", width: 144, sizing: "fixed" },
  { id: "owners", title: "Owners", width: 144, sizing: "fixed" },
  { id: "priority", title: "Priority", width: 96, sizing: "fixed" },
  { id: "position", title: "Position", width: 200, sizing: "fixed" },
  { id: "intensity", title: "Int", width: 80, sizing: "fixed" },
  { id: "speed", title: "Speed", width: 80, sizing: "fixed" },
  { id: "tags", title: "Tags", width: 120, sizing: "fixed" },
  { id: "stop", title: "Stop", width: 56, sizing: "fixed" },
];
const SORTABLE_INSTANCE_COLUMNS = INSTANCE_COLUMNS.flatMap((column) =>
  column.id === "stop" ? [] : [column.id!],
);

type InstanceCellData =
  | {
      kind: "instance-pill";
      className: string;
      /** Tooltip explaining the pill, such as the slot holding a Swop. */
      title?: string;
      /** Held-button effect the pill reports, exposed for tests. */
      heldButton?: string;
    }
  | { kind: "instance-lines"; secondary: string; mono: boolean }
  | { kind: "instance-stop"; instanceId: StatusInstanceInfo["instance_id"] };

/** Builds a rich instance cell whose copy and sort value is its primary text. */
function instanceCell(data: InstanceCellData, copyData: string): GridCell {
  return { kind: GridCellKind.Custom, data, copyData };
}

/** Builds a plain text instance cell, optionally in the monospace value style. */
function instanceTextCell(value: string, mono = false): GridCell {
  return mono
    ? instanceCell({ kind: "instance-lines", secondary: "", mono }, value)
    : { kind: GridCellKind.Text, data: value, contentAlign: "left" };
}

/** Builds a numeric instance cell that sorts by value while showing formatted text; missing values show a dash. */
function instanceNumberCell(
  value: number | undefined,
  display: string,
): GridCell {
  if (value === undefined) return instanceTextCell("-", true);
  return {
    kind: GridCellKind.Number,
    data: value,
    displayData: display,
    copyData: display,
    contentAlign: "left",
  };
}

/** Projects one instance snapshot into the cell for a status column. */
function activeInstanceCell(
  instance: StatusInstanceInfo,
  column: GridColumn,
  labels: Pick<ActiveInstancesSectionProps, "clipLabel" | "ownerLabels">,
): GridCell {
  switch (column.id) {
    case "kind":
      return instanceCell(
        {
          kind: "instance-pill",
          className: instanceKindClass(instance.display_kind),
        },
        instanceKindLabel(instance.display_kind),
      );
    case "instance":
      return instanceCell(
        {
          kind: "instance-lines",
          secondary: compactId(instance.instance_id),
          mono: false,
        },
        instance.name ?? "Instance",
      );
    case "state":
      return instanceCell(
        {
          kind: "instance-pill",
          className: instanceStateClass(instance),
          title: instanceStateTitle(instance),
          heldButton: instanceStateTitle(instance)
            ? instance.held_button?.type
            : undefined,
        },
        instanceStateLabel(instance),
      );
    case "clip":
      return instanceTextCell(labels.clipLabel(instance.bound_clip_id));
    case "owners":
      return instanceTextCell(labels.ownerLabels(instance));
    case "priority":
      return instanceNumberCell(
        instance.priority,
        String(instance.priority ?? "-"),
      );
    case "position":
      return instanceCell(
        {
          kind: "instance-lines",
          secondary: formatInstanceNext(instance),
          mono: true,
        },
        formatInstancePosition(instance),
      );
    case "intensity":
      return instanceNumberCell(
        instance.intensity_scale,
        formatPercent(instance.intensity_scale),
      );
    case "speed":
      return instanceNumberCell(
        instance.effective_speed,
        `${instance.effective_speed.toFixed(2)}x`,
      );
    case "tags":
      return instanceTextCell(
        instance.tags.length > 0 ? instance.tags.join(", ") : "-",
      );
    default:
      return instanceCell(
        { kind: "instance-stop", instanceId: instance.instance_id },
        "",
      );
  }
}

/** Renders the instance table's pills, two-line values and per-row stop action. */
function activeInstanceExtension(
  onStop: (instanceId: StatusInstanceInfo["instance_id"]) => void,
): DataGridRichCellExtension {
  return {
    id: "active-instance",
    matches: (cell) =>
      cell.kind === GridCellKind.Custom &&
      String((cell.data as { kind?: string }).kind).startsWith("instance-"),
    isEditable: () => false,
    render: ({ cell }) => {
      if (cell.kind !== GridCellKind.Custom) return null;
      const data = cell.data as InstanceCellData;
      if (data.kind === "instance-pill")
        return (
          <span
            class={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ring-1 ${data.className}`}
            data-held-button={data.heldButton}
            title={data.title}
          >
            {cell.copyData}
          </span>
        );
      if (data.kind === "instance-stop")
        return (
          <StatusIconButton
            label="Stop instance"
            icon={StopIcon}
            onClick={() => onStop(data.instanceId)}
            variant="danger"
          />
        );
      return (
        <div class="min-w-0">
          <div
            class={`truncate text-neutral-100 ${data.mono ? "font-mono" : ""}`}
          >
            {cell.copyData}
          </div>
          <Show when={data.secondary}>
            <div
              class={`truncate text-[11px] text-neutral-500 ${data.mono ? "" : "font-mono"}`}
            >
              {data.secondary}
            </div>
          </Show>
        </div>
      );
    },
    renderEditor: () => null,
  };
}

/** Presents active instance status and stop controls without owning app state. */
export function ActiveInstancesSection(props: ActiveInstancesSectionProps) {
  /** Keys cells by playback ID so selection and sorting follow instances across snapshots. */
  const provider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: props.rows,
      columns: INSTANCE_COLUMNS,
      rowKey: (row) => row.instance_id,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) =>
        activeInstanceCell(row, column, props),
    }),
  );
  const extensions = [activeInstanceExtension((id) => props.onStop(id))];

  return (
    <section class="min-h-0 shrink-0">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xs font-semibold uppercase text-neutral-400">
            Active Instances
          </h2>
          <span class="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300">
            {props.rows.length} running
          </span>
        </div>
        <div class="flex items-center gap-1">
          <StatusIconButton
            label="Stop sequences"
            icon={QueueIcon}
            disabled={props.rows.length === 0}
            onClick={() => props.onStopKind(InstanceKind.Sequence)}
          />
          <StatusIconButton
            label="Stop FX"
            icon={SparkleIcon}
            disabled={props.rows.length === 0}
            onClick={() => props.onStopKind(InstanceKind.Fx)}
          />
          <StatusIconButton
            label="Stop all instances"
            icon={StopIcon}
            disabled={props.rows.length === 0}
            onClick={props.onStopAll}
            variant="danger"
          />
        </div>
      </div>

      <div class="border border-neutral-800">
        <DataGrid
          ariaLabel="Active instances"
          readOnly
          columns={INSTANCE_COLUMNS}
          rows={props.rows.length}
          cellProvider={provider}
          richCellExtensions={extensions}
          sortableColumns={SORTABLE_INSTANCE_COLUMNS}
          freezeColumns={2}
          rowHeight={INSTANCE_ROW_HEIGHT}
          height="content"
          class="max-h-[60vh]"
          emptyState="No active instances"
        />
      </div>
    </section>
  );
}

const TIMECODE_ROW_HEIGHT = 40;
const TIMECODE_COLUMNS: GridColumn[] = [
  { id: "id", title: "ID", width: 64, sizing: "fixed" },
  { id: "label", title: "Label", width: 192, sizing: "fixed" },
  { id: "position", title: "Position", width: 160, sizing: "fixed" },
  { id: "rate", title: "Rate", width: 96, sizing: "fixed" },
  { id: "source", title: "Source", width: 96, sizing: "fixed" },
  { id: "state", title: "State", width: 96, sizing: "fixed" },
  { id: "controls", title: "Controls", width: 120, sizing: "fixed" },
];
const SORTABLE_TIMECODE_COLUMNS = TIMECODE_COLUMNS.flatMap((column) =>
  column.id === "controls" ? [] : [column.id!],
);

type TimecodeCellData =
  | { kind: "timecode-state"; tone: TimecodeStatusTone }
  | { kind: "timecode-controls"; id: number };

/** Projects one timecode and its live state into the cell for a status column. */
function timecodeStatusCell(row: TimecodeRow, column: GridColumn): GridCell {
  const id = row.timecode.identifiers.id;
  switch (column.id) {
    case "id":
      return {
        kind: GridCellKind.Number,
        data: id,
        displayData: String(id),
        contentAlign: "left",
      };
    case "label":
      return instanceTextCell(row.timecode.identifiers.label);
    case "position":
      return instanceTextCell(
        formatSMPTETime(
          durationToMs(row.state.current_time),
          row.timecode.rate ?? TimecodeRate.Fps30,
        ),
        true,
      );
    case "rate":
      return instanceTextCell(timecodeRateLabel(row.timecode.rate));
    case "source":
      return instanceTextCell(timecodeSourceLabel(row.timecode, row.state));
    case "state": {
      const status = timecodeStatus(row.state);
      return {
        kind: GridCellKind.Custom,
        data: { kind: "timecode-state", tone: status.tone },
        copyData: status.label,
      };
    }
    default:
      return {
        kind: GridCellKind.Custom,
        data: { kind: "timecode-controls", id },
        copyData: "",
      };
  }
}

/** Renders the timecode table's run-state pill and per-row transport buttons. */
function timecodeStatusExtension(
  onCommand: TimecodeSectionProps["onCommand"],
): DataGridRichCellExtension {
  return {
    id: "timecode-status",
    matches: (cell) =>
      cell.kind === GridCellKind.Custom &&
      String((cell.data as { kind?: string }).kind).startsWith("timecode-"),
    isEditable: () => false,
    render: ({ cell }) => {
      if (cell.kind !== GridCellKind.Custom) return null;
      const data = cell.data as TimecodeCellData;
      if (data.kind === "timecode-state")
        return (
          <span
            class={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ring-1 ${timecodeStatusPillClass(
              data.tone,
            )}`}
          >
            {cell.copyData}
          </span>
        );
      return (
        <div class="flex gap-1">
          <StatusIconButton
            label="Start timecode"
            icon={PlayIcon}
            onClick={() => onCommand("StartTimecode", data.id)}
          />
          <StatusIconButton
            label="Pause timecode"
            icon={PauseIcon}
            onClick={() => onCommand("PauseTimecode", data.id)}
          />
          <StatusIconButton
            label="Stop timecode"
            icon={StopIcon}
            onClick={() => onCommand("StopTimecode", data.id)}
            variant="danger"
          />
        </div>
      );
    },
    renderEditor: () => null,
  };
}

/** Presents timecode status and transport controls without owning app state. */
export function TimecodesSection(props: TimecodeSectionProps) {
  /** Keys cells by timecode UID so sorting and selection follow each clock across snapshots. */
  const provider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: props.rows,
      columns: TIMECODE_COLUMNS,
      rowKey: (row) => String(row.timecode.identifiers.uid),
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => timecodeStatusCell(row, column),
    }),
  );
  const extensions = [
    timecodeStatusExtension((...args) => props.onCommand(...args)),
  ];

  return (
    <section class="shrink-0">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xs font-semibold uppercase text-neutral-400">
            Timecodes
          </h2>
          <span class="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300">
            {props.runningCount} running
          </span>
          <span class="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300">
            {Math.max(props.rows.length - props.runningCount, 0)} idle
          </span>
        </div>
      </div>

      <div class="border border-neutral-800">
        <DataGrid
          ariaLabel="Timecode controls"
          readOnly
          selectionMode="row"
          columns={TIMECODE_COLUMNS}
          rows={props.rows.length}
          cellProvider={provider}
          richCellExtensions={extensions}
          sortableColumns={SORTABLE_TIMECODE_COLUMNS}
          freezeColumns={2}
          rowHeight={TIMECODE_ROW_HEIGHT}
          height="content"
          class="max-h-[40vh]"
          emptyState="No timecodes"
        />
      </div>
    </section>
  );
}
