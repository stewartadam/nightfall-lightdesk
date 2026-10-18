// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, For, Show } from "solid-js";
import { Collapsible } from "../../../components/ui/collapsible";
import { Table, TableScroll } from "../../../components/ui/table";
import DataGrid, {
  createKeyedDataGridCellProvider,
} from "../../../components/widgets/data-grid";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
} from "../../../lib/data-grid-types";
import type {
  PerformanceMeasureStats,
  WsStats,
} from "../../../state/appStores";
import type { MessageTypeRow, MessageTypeStats } from "../model/message-table";
import { formatNumber, getDeliveryLagColor } from "../model/metrics";
import { MetricCard } from "./metric-sections";

interface WebSocketMetricsSectionProps {
  measures: Record<string, PerformanceMeasureStats>;
  rows: MessageTypeRow[];
  stats: WsStats | null;
}

const MESSAGE_COLUMNS: GridColumn[] = [
  { id: "type", title: "Type", width: 180, sizing: "fixed" },
  { id: "count", title: "Count", width: 88, sizing: "fixed", align: "right" },
  {
    id: "ratePerSec",
    title: "Rate/s",
    width: 88,
    sizing: "fixed",
    align: "right",
  },
  {
    id: "avgDecodeMs",
    title: "Decode (EMA)",
    width: 112,
    sizing: "fixed",
    align: "right",
  },
  {
    id: "avgProcessMs",
    title: "Processing (EMA)",
    width: 128,
    sizing: "fixed",
    align: "right",
  },
  {
    id: "dropped",
    title: "Drop (cum.)",
    width: 104,
    sizing: "fixed",
    align: "right",
  },
];

/** Shows the warning tone used for messages that were coalesced or discarded. */
const DROPPED_THEME = { textDark: "#eab308" };

/** Projects one message-type aggregate into a typed, sortable cell for a totals column. */
function messageCell(
  [type, stats]: MessageTypeRow,
  column: GridColumn,
): GridCell {
  if (column.id === "type")
    return { kind: GridCellKind.Text, data: type, contentAlign: "left" };
  const value = stats[column.id as keyof MessageTypeStats];
  const display =
    column.id === "ratePerSec"
      ? formatNumber(value, 1)
      : column.id === "avgDecodeMs" || column.id === "avgProcessMs"
        ? formatNumber(value, 2, " ms")
        : String(value);
  return {
    kind: GridCellKind.Number,
    data: value,
    displayData: display,
    copyData: display,
    contentAlign: "right",
    themeOverride:
      column.id === "dropped" && value > 0 ? DROPPED_THEME : undefined,
  };
}

/** Presents websocket delivery health, pull cadence, and sortable type totals. */
export function WebSocketMetricsSection(props: WebSocketMetricsSectionProps) {
  /** Keys aggregates by message type so a header sort follows each type as totals update. */
  const messageProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: props.rows,
      columns: MESSAGE_COLUMNS,
      rowKey: ([type]) => type,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => messageCell(row, column),
    }),
  );
  return (
    <Collapsible
      lazy
      title="WebSocket Messages"
      contentClass="p-3"
      actions={
        <Show when={props.stats}>
          <span class="flex items-center gap-2">
            <span
              class={`rounded px-1.5 py-0.5 text-xs ${
                props.stats?.main.backlogLagging
                  ? "bg-red-500/20 text-red-400"
                  : "bg-green-500/20 text-green-500"
              }`}
            >
              {props.stats?.main.backlogLagging ? "Lagging" : "Current"}
            </span>
            <span
              class={`font-mono text-xs ${getDeliveryLagColor(
                props.stats?.main.avgDeliveryLagMs,
              )}`}
            >
              {formatNumber(props.stats?.main.avgDeliveryLagMs, 1, " ms")}
            </span>
          </span>
        </Show>
      }
    >
      <Show
        when={props.rows.length > 0}
        fallback={
          <div class="rounded-lg bg-neutral-800 p-3 text-sm text-neutral-500">
            Waiting for messages...
          </div>
        }
      >
        <div class="space-y-3">
          <TableScroll
            aria-label="WebSocket timing stages scroll area"
            class="rounded-lg bg-neutral-800 p-3"
          >
            <Table aria-label="WebSocket timing stages">
              <thead>
                <tr>
                  <th scope="col" class="text-left">
                    Stage
                  </th>
                  <For each={["Samples", "Avg", "P95", "P99", "Max"]}>
                    {(label) => (
                      <th scope="col" class="text-right">
                        {label}
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For
                  each={[
                    {
                      label: "Transport RTT",
                      stats:
                        props.measures["nightfall:websocket.transport-rtt"],
                      description:
                        "Worker heartbeat send to response decode: includes both network directions and server response time. Not one-way server delivery; unavailable in embedded mode.",
                    },
                    {
                      label: "Worker processing",
                      stats: props.stats?.worker.processing,
                      description:
                        "Worker receive handler through decode and staging, including snapshots later replaced. Excludes network transit and waiting for the receive handler.",
                    },
                    {
                      label: "Worker → main delay",
                      stats:
                        props.measures["nightfall:websocket.worker-to-main"],
                      description:
                        "Decoded message staged in the worker until main-thread handling begins. Includes frame-pull wait, transfer and main-thread scheduling; excludes UI rendering. Delivered messages only.",
                    },
                  ]}
                >
                  {(stage) => (
                    <tr>
                      <th
                        scope="row"
                        class="text-left font-normal"
                        title={stage.description}
                      >
                        {stage.label}
                      </th>
                      <td class="text-right font-mono">
                        {stage.stats?.count ?? "—"}
                      </td>
                      <For
                        each={[
                          stage.stats?.avgMs,
                          stage.stats?.p95Ms,
                          stage.stats?.p99Ms,
                          stage.stats?.maxMs,
                        ]}
                      >
                        {(value) => (
                          <td class="whitespace-nowrap text-right font-mono">
                            {formatNumber(value, 2, " ms")}
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </Table>
          </TableScroll>
          <p class="text-xs text-neutral-400">
            Timings use the newest 6,000 samples per stage from the last 60
            seconds. Transport RTT measures a worker–server–worker heartbeat
            round trip, not one-way delivery. Worker processing covers decode
            and staging. Worker → main delay includes waiting for a frame pull
            and main-thread scheduling, before UI rendering.
          </p>
          <h3 class="text-sm font-medium">
            Worker queue and main-thread delivery
          </h3>
          <div class="grid grid-cols-3 gap-3">
            <MetricCard
              label="Main delivery EMA"
              value={formatNumber(props.stats?.main.avgDeliveryLagMs, 1, " ms")}
              valueClass={`text-xl font-bold ${getDeliveryLagColor(props.stats?.main.avgDeliveryLagMs)}`}
            />
            <MetricCard
              label="Main delivery max (session)"
              value={formatNumber(props.stats?.main.maxDeliveryLagMs, 1, " ms")}
            />
            <MetricCard
              label="Worker queue depth"
              value={props.stats?.worker.queueDepth ?? 0}
              valueClass={`text-xl font-bold ${
                (props.stats?.worker.queueDepth ?? 0) > 0
                  ? "text-yellow-500"
                  : ""
              }`}
            />
          </div>
          <div class="grid grid-cols-4 gap-3">
            <MetricCard
              label="Pulls/s"
              value={formatNumber(props.stats?.main.pull?.pullsPerSec, 1)}
            />
            <MetricCard
              label="Non-empty/s"
              value={formatNumber(
                props.stats?.main.pull?.nonEmptyResponsesPerSec,
                1,
              )}
            />
            <MetricCard
              label="ParameterState/s"
              value={formatNumber(
                props.stats?.main.pull?.parameterStatesPerSec,
                1,
              )}
            />
            <MetricCard
              label="Pull cadence"
              value={formatNumber(
                props.stats?.main.pull?.cadenceAvgMs,
                1,
                " ms",
              )}
            />
          </div>
          <div class="grid grid-cols-4 gap-3">
            <MetricCard
              label="Messages/s"
              value={formatNumber(props.stats?.main.pull?.messagesPerSec, 1)}
            />
            <MetricCard
              label="Last batch"
              value={props.stats?.main.pull?.lastBatchSize ?? "—"}
            />
            <MetricCard
              label="Delivery IDs"
              value={`${props.stats?.main.lastSeenDeliveryMessageId ?? "—"} / ${
                props.stats?.worker.lastStagedDeliveryMessageId ?? "—"
              }`}
              valueClass="text-sm"
            />
            <MetricCard
              label="Pull state"
              value={props.stats?.main.pull?.inFlight ? "in flight" : "idle"}
            />
          </div>
          <h3 class="text-sm font-medium">Parameter stream</h3>
          <div class="grid grid-cols-4 gap-3">
            <MetricCard
              label="Keyframes"
              value={props.stats?.worker.parameterStream?.keyframes ?? "—"}
            />
            <MetricCard
              label="Deltas"
              value={props.stats?.worker.parameterStream?.deltas ?? "—"}
            />
            <MetricCard
              label="Gaps"
              value={props.stats?.worker.parameterStream?.gaps ?? "—"}
              valueClass={`text-xl font-bold ${
                (props.stats?.worker.parameterStream?.gaps ?? 0) > 0
                  ? "text-yellow-500"
                  : ""
              }`}
            />
            <MetricCard
              label="Drifted keyframes"
              value={
                props.stats?.worker.parameterStream?.driftedKeyframes ?? "—"
              }
              valueClass={`text-xl font-bold ${
                (props.stats?.worker.parameterStream?.driftedKeyframes ?? 0) > 0
                  ? "text-red-500"
                  : ""
              }`}
            />
          </div>
          <p class="text-xs text-neutral-400">
            The worker applies every numbered ParameterState frame as it
            arrives. A gap means a frame was missed, so the worker stops
            delivering parameter state and asks the backend for a keyframe.
            Drifted keyframes disagreed with the state the worker rebuilt
            without a gap, and should always be zero.
          </p>
          <h3 class="text-sm font-medium">Worker message totals</h3>
          <p class="text-xs text-neutral-400">
            Decode and processing are worker-side exponential moving averages
            (EMA). Snapshot messages are coalesced: newer snapshots replace
            older ones before delivery, increasing Drop (cum.). This is expected
            when updates arrive faster than the main thread consumes them.
            Structural messages are queued separately and are not coalesced.
            ParameterState frames are counted as dropped when they belong to an
            outdated ParameterLayout, arrive after a gap, or arrive during a
            resynchronization. Delivery IDs show main-thread received / worker
            staged.
          </p>
          <div class="rounded-lg bg-neutral-800 p-3">
            <DataGrid
              ariaLabel="Worker message totals"
              readOnly
              columns={MESSAGE_COLUMNS}
              rows={props.rows.length}
              cellProvider={messageProvider}
              sortableColumns={MESSAGE_COLUMNS.map((column) => column.id!)}
              freezeColumns={1}
              height="content"
              class="max-h-[420px]"
            />
          </div>
        </div>
      </Show>
    </Collapsible>
  );
}
