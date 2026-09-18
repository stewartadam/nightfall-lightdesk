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
import { createMemo, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AppIcon } from "../../../components/ui/icon";
import {
  Table,
  TableEmptyRow,
  TableScroll,
} from "../../../components/ui/table";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import { Button } from "../../../components/ui/visual-language/button";
import { durationToMs, formatSMPTETime } from "../../../lib/time-format";
import {
  InstanceKind,
  type InstanceKind as InstanceKindType,
  type Timecode,
  TimecodeRate,
  type TimecodeState,
} from "../../../types";
import {
  compactId,
  formatInstanceNext,
  formatInstancePosition,
  formatPercent,
  type InstanceSortColumn,
  instanceKindClass,
  instanceKindLabel,
  instanceStateClass,
  instanceStateLabel,
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
  sortIndicator: (column: InstanceSortColumn) => string;
  onSort: (column: InstanceSortColumn) => void;
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

/** Renders one sortable instance table heading. */
function InstanceSortHeading(props: {
  column: InstanceSortColumn;
  label: string;
  class?: string;
  indicator: string;
  onSort: (column: InstanceSortColumn) => void;
}) {
  return (
    <th scope="col" class={props.class}>
      <Button
        size="compact"
        variant="subtle"
        type="button"
        onClick={() => props.onSort(props.column)}
      >
        <span>{props.label}</span>
        <span class="w-2 text-right text-[10px]">{props.indicator}</span>
      </Button>
    </th>
  );
}

/** Presents active instance status and stop controls without owning app state. */
export function ActiveInstancesSection(props: ActiveInstancesSectionProps) {
  /** Keeps row identity tied to playback IDs while snapshots update cell values. */
  const instancesById = createMemo(
    () =>
      new Map(props.rows.map((instance) => [instance.instance_id, instance])),
  );

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

      <TableScroll
        aria-label="Active instances scroll area"
        class="border border-neutral-800"
      >
        <Table
          aria-label="Active instances"
          class="min-w-[1180px] table-fixed text-left"
        >
          <thead>
            <tr>
              <InstanceSortHeading
                class="w-28"
                column="kind"
                label="Kind"
                indicator={props.sortIndicator("kind")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                class="w-48"
                column="instance"
                label="Instance"
                indicator={props.sortIndicator("instance")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                class="w-32"
                column="state"
                label="State"
                indicator={props.sortIndicator("state")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                class="w-36"
                column="clip"
                label="Clip"
                indicator={props.sortIndicator("clip")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                class="w-36"
                column="owners"
                label="Owners"
                indicator={props.sortIndicator("owners")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                class="w-24"
                column="priority"
                label="Priority"
                indicator={props.sortIndicator("priority")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                class="w-60"
                column="position"
                label="Position"
                indicator={props.sortIndicator("position")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                class="w-20"
                column="intensity"
                label="Int"
                indicator={props.sortIndicator("intensity")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                class="w-20"
                column="rate"
                label="Rate"
                indicator={props.sortIndicator("rate")}
                onSort={props.onSort}
              />
              <InstanceSortHeading
                column="tags"
                label="Tags"
                indicator={props.sortIndicator("tags")}
                onSort={props.onSort}
              />
              <th
                scope="col"
                class="w-12 text-center"
                aria-label="Stop instance"
                title="Stop instance"
              >
                <StopIcon class="mx-auto size-3" aria-hidden />
              </th>
            </tr>
          </thead>
          <tbody>
            <Show
              when={props.rows.length > 0}
              fallback={
                <TableEmptyRow colSpan={11}>No active instances</TableEmptyRow>
              }
            >
              <For each={[...instancesById().keys()]}>
                {(instanceId) => (
                  <Show when={instancesById().get(instanceId)}>
                    {(instance) => (
                      <tr>
                        <td>
                          <span
                            class={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ring-1 ${instanceKindClass(instance().display_kind)}`}
                          >
                            {instanceKindLabel(instance().display_kind)}
                          </span>
                        </td>
                        <td>
                          <div class="truncate text-neutral-100">
                            {instance().name ?? "Instance"}
                          </div>
                          <div class="truncate font-mono text-[11px] text-neutral-500">
                            {compactId(instance().instance_id)}
                          </div>
                        </td>
                        <td class="truncate">
                          <span
                            class={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ring-1 ${instanceStateClass(instance())}`}
                          >
                            {instanceStateLabel(instance())}
                          </span>
                        </td>
                        <td class="truncate">
                          {props.clipLabel(instance().bound_clip_id)}
                        </td>
                        <td class="truncate">
                          {props.ownerLabels(instance())}
                        </td>
                        <td class="font-mono">{instance().priority ?? "-"}</td>
                        <td>
                          <div class="truncate font-mono text-neutral-100">
                            {formatInstancePosition(instance())}
                          </div>
                          <Show when={formatInstanceNext(instance())}>
                            <div class="truncate text-[11px] text-neutral-500">
                              {formatInstanceNext(instance())}
                            </div>
                          </Show>
                        </td>
                        <td class="font-mono">
                          {formatPercent(instance().intensity_scale)}
                        </td>
                        <td class="font-mono">
                          {instance().effective_rate.toFixed(2)}x
                        </td>
                        <td class="truncate">
                          {instance().tags.length > 0
                            ? instance().tags.join(", ")
                            : "-"}
                        </td>
                        <td class="text-center">
                          <StatusIconButton
                            label="Stop instance"
                            icon={StopIcon}
                            onClick={() => props.onStop(instance().instance_id)}
                            variant="danger"
                          />
                        </td>
                      </tr>
                    )}
                  </Show>
                )}
              </For>
            </Show>
          </tbody>
        </Table>
      </TableScroll>
    </section>
  );
}

/** Presents timecode status and transport controls without owning app state. */
export function TimecodesSection(props: TimecodeSectionProps) {
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

      <TableScroll
        aria-label="Timecode controls scroll area"
        class="border border-neutral-800"
      >
        <Table
          aria-label="Timecode controls"
          class="min-w-[760px] table-fixed text-left"
        >
          <thead>
            <tr>
              <th scope="col" class="w-16">
                ID
              </th>
              <th scope="col" class="w-48">
                Label
              </th>
              <th scope="col" class="w-40">
                Position
              </th>
              <th scope="col" class="w-24">
                Rate
              </th>
              <th scope="col" class="w-24">
                Source
              </th>
              <th scope="col" class="w-24">
                State
              </th>
              <th scope="col" class="w-28">
                Controls
              </th>
            </tr>
          </thead>
          <tbody>
            <Show
              when={props.rows.length > 0}
              fallback={<TableEmptyRow colSpan={7}>No timecodes</TableEmptyRow>}
            >
              <For each={props.rows}>
                {(row) => (
                  <tr>
                    <td class="font-mono">{row.timecode.identifiers.id}</td>
                    <td class="truncate">{row.timecode.identifiers.label}</td>
                    <td class="font-mono">
                      {formatSMPTETime(
                        durationToMs(row.state.current_time),
                        row.timecode.rate ?? TimecodeRate.Fps30,
                      )}
                    </td>
                    <td>{row.timecode.rate}</td>
                    <td>{row.timecode.source}</td>
                    <td>
                      <span
                        class={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ring-1 ${
                          row.state.is_active
                            ? "bg-emerald-500/20 text-emerald-200 ring-emerald-400/30"
                            : "bg-neutral-700/40 text-neutral-300 ring-neutral-600"
                        }`}
                      >
                        {row.state.is_active ? "Running" : "Idle"}
                      </span>
                    </td>
                    <td>
                      <div class="flex gap-1">
                        <StatusIconButton
                          label="Start timecode"
                          icon={PlayIcon}
                          onClick={() =>
                            props.onCommand(
                              "StartTimecode",
                              row.timecode.identifiers.id,
                            )
                          }
                        />
                        <StatusIconButton
                          label="Pause timecode"
                          icon={PauseIcon}
                          onClick={() =>
                            props.onCommand(
                              "PauseTimecode",
                              row.timecode.identifiers.id,
                            )
                          }
                        />
                        <StatusIconButton
                          label="Stop timecode"
                          icon={StopIcon}
                          onClick={() =>
                            props.onCommand(
                              "StopTimecode",
                              row.timecode.identifiers.id,
                            )
                          }
                          variant="danger"
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </Show>
          </tbody>
        </Table>
      </TableScroll>
    </section>
  );
}
