// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import { Table, TableScroll } from "../../../components/ui/table";
import { Button } from "../../../components/ui/visual-language/button";
import type {
  PerformanceMeasureStats,
  WsStats,
} from "../../../state/appStores";
import type { MessageSortColumn, MessageTypeRow } from "../model/message-table";
import { formatNumber, getDeliveryLagColor } from "../model/metrics";
import { CollapsibleSection, MetricCard } from "./metric-sections";

interface WebSocketMetricsSectionProps {
  measures: Record<string, PerformanceMeasureStats>;
  getSortIndicator: (column: MessageSortColumn) => string;
  rows: MessageTypeRow[];
  stats: WsStats | null;
  toggleSort: (column: MessageSortColumn) => void;
}

const MESSAGE_COLUMNS: {
  column: MessageSortColumn;
  label: string;
  leftAligned?: boolean;
}[] = [
  { column: "type", label: "Type", leftAligned: true },
  { column: "count", label: "Count" },
  { column: "ratePerSec", label: "Rate/s" },
  { column: "avgDecodeMs", label: "Decode (EMA)" },
  { column: "avgProcessMs", label: "Processing (EMA)" },
  { column: "dropped", label: "Drop (cum.)" },
];

/** Presents websocket delivery health, pull cadence, and sortable type totals. */
export function WebSocketMetricsSection(props: WebSocketMetricsSectionProps) {
  return (
    <CollapsibleSection
      title="WebSocket Messages"
      headerContent={
        <Show when={props.stats}>
          <span class="ml-auto flex items-center gap-2">
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
          <div class="rounded-lg bg-gray-100 p-3 text-sm text-gray-500 dark:bg-gray-800">
            Waiting for messages...
          </div>
        }
      >
        <div class="space-y-3">
          <TableScroll
            aria-label="WebSocket timing stages scroll area"
            class="rounded-lg bg-gray-100 p-3 dark:bg-gray-800"
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
          <p class="text-xs text-gray-500 dark:text-gray-400">
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
          <h3 class="text-sm font-medium">Worker message totals</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            Decode and processing are worker-side exponential moving averages
            (EMA). ParameterState snapshots are coalesced: newer snapshots
            replace older ones before delivery, increasing Drop (cum.). This is
            expected when updates arrive faster than the main thread consumes
            them. Structural messages are queued separately and are not
            coalesced. Queue overflow or resynchronization can also cause drops;
            the counter is not exclusively snapshot replacement. Delivery IDs
            show main-thread received / worker staged.
          </p>
          <TableScroll
            aria-label="Worker message totals scroll area"
            class="rounded-lg bg-gray-100 p-3 dark:bg-gray-800"
          >
            <Table aria-label="Worker message totals">
              <thead>
                <tr>
                  <For each={MESSAGE_COLUMNS}>
                    {({ column, label, leftAligned }) => (
                      <th
                        scope="col"
                        class={leftAligned ? "text-left" : "text-right"}
                      >
                        <Button
                          size="compact"
                          variant="subtle"
                          type="button"
                          class="w-full"
                          style={{
                            "justify-content": leftAligned
                              ? "flex-start"
                              : "flex-end",
                          }}
                          onClick={() => props.toggleSort(column)}
                        >
                          <span>{label}</span>
                          <span class="w-2 text-right text-[10px]">
                            {props.getSortIndicator(column)}
                          </span>
                        </Button>
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={props.rows}>
                  {([type, stats]) => (
                    <tr>
                      <td class="max-w-[120px] truncate font-mono" title={type}>
                        {type}
                      </td>
                      <td class="text-right font-mono">{stats.count}</td>
                      <td class="text-right font-mono">
                        {formatNumber(stats.ratePerSec, 1)}
                      </td>
                      <td class="text-right font-mono">
                        {formatNumber(stats.avgDecodeMs, 2, " ms")}
                      </td>
                      <td class="text-right font-mono">
                        {formatNumber(stats.avgProcessMs, 2, " ms")}
                      </td>
                      <td
                        class={`text-right font-mono ${
                          stats.dropped > 0 ? "text-yellow-500" : ""
                        }`}
                      >
                        {stats.dropped}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </Table>
          </TableScroll>
        </div>
      </Show>
    </CollapsibleSection>
  );
}
