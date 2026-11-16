// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import { Collapsible } from "../../../components/ui/collapsible";
import { Sparkline } from "../../../components/ui/sparkline";
import {
  type EngineMetrics,
  METRIC_PATHS,
  type MetricsHistory,
  type SmoothedEngineMetrics,
} from "../../../state/appStores";
import { formatNumber } from "../model/metrics";
import { MetricRow } from "./metric-sections";

/** Formats a smoothed backend count as a whole number, or a dash before the first value. */
function formatCount(value: number | undefined): string {
  return value === undefined ? "—" : String(Math.round(value));
}

/** Lists every backend diagnostic by path, so newly recorded values show without UI changes. */
export function AllDiagnosticsSection(props: {
  metrics: EngineMetrics | null;
}) {
  const entries = () =>
    Object.entries(props.metrics ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    );
  return (
    <Collapsible lazy title="All Diagnostics" contentClass="p-3">
      <div class="space-y-2 rounded-lg bg-neutral-800 p-3">
        <For each={entries()}>
          {([path, value]) => (
            <MetricRow label={path} value={formatNumber(value, 2)} />
          )}
        </For>
      </div>
    </Collapsible>
  );
}

interface EngineStatsSectionProps {
  metrics: EngineMetrics | null;
}

/** Presents backend entity, layer, and universe counts. */
export function EngineStatsSection(props: EngineStatsSectionProps) {
  return (
    <Collapsible lazy title="Engine Stats" contentClass="p-3">
      <div class="space-y-2 rounded-lg bg-neutral-800 p-3">
        <MetricRow
          label="Active Layers"
          value={formatCount(props.metrics?.[METRIC_PATHS.activeLayers])}
        />
        <MetricRow
          label="Active Universes"
          value={formatCount(props.metrics?.[METRIC_PATHS.activeUniverses])}
        />
        <Show when={props.metrics?.[METRIC_PATHS.entityCount] !== undefined}>
          <MetricRow
            label="Entity Count"
            value={formatCount(props.metrics?.[METRIC_PATHS.entityCount])}
          />
        </Show>
      </div>
    </Collapsible>
  );
}

interface NetworkMetricsSectionProps {
  history: MetricsHistory;
  latencyMs: number;
  metrics: EngineMetrics | null;
  smoothedMetrics: SmoothedEngineMetrics;
}

/** Presents websocket latency and network-output timing metrics. */
export function NetworkMetricsSection(props: NetworkMetricsSectionProps) {
  return (
    <Collapsible
      lazy
      title="Network"
      contentClass="p-3"
      actions={
        <span class="flex items-center gap-2">
          <Sparkline
            data={props.history.latency}
            width={80}
            height={20}
            color="#facc15"
          />
          <span class="font-mono text-xs">
            {formatNumber(props.latencyMs, 1, " ms")}
          </span>
        </span>
      }
    >
      <div class="space-y-2 rounded-lg bg-neutral-800 p-3">
        <MetricRow
          label="Transport RTT (last heartbeat)"
          value={formatNumber(props.latencyMs, 2, " ms")}
        />
        <MetricRow
          label="Art-Net Send"
          value={
            <>
              {formatNumber(props.smoothedMetrics.artnetSendTimeMs, 2, " ms")}
              <Show
                when={
                  (props.metrics?.[METRIC_PATHS.artnetUniverseCount] ?? 0) > 0
                }
              >
                <span class="ml-1 text-neutral-400">
                  {`(${formatCount(props.metrics?.[METRIC_PATHS.artnetUniverseCount])} univ)`}
                </span>
              </Show>
            </>
          }
        />
        <MetricRow
          label="sACN Send"
          value={
            <>
              {formatNumber(props.smoothedMetrics.sacnSendTimeMs, 2, " ms")}
              <Show
                when={
                  (props.metrics?.[METRIC_PATHS.sacnUniverseCount] ?? 0) > 0
                }
              >
                <span class="ml-1 text-neutral-400">
                  {`(${formatCount(props.metrics?.[METRIC_PATHS.sacnUniverseCount])} univ)`}
                </span>
              </Show>
            </>
          }
        />
        <MetricRow
          label="LayerStack Broadcast"
          value={formatNumber(
            props.smoothedMetrics.layerStackBroadcastMs,
            2,
            " ms",
          )}
        />
      </div>
    </Collapsible>
  );
}
