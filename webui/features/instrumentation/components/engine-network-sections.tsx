// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Sparkline } from "../../../components/ui/sparkline";
import type {
  EngineMetrics,
  MetricsHistory,
  SmoothedEngineMetrics,
} from "../../../state/appStores";
import { formatNumber } from "../model/metrics";
import { CollapsibleSection, MetricRow } from "./metric-sections";

interface EngineStatsSectionProps {
  metrics: EngineMetrics | null;
}

/** Presents backend entity, layer, and universe counts. */
export function EngineStatsSection(props: EngineStatsSectionProps) {
  return (
    <CollapsibleSection title="Engine Stats">
      <div class="space-y-2 rounded-lg bg-gray-100 p-3 dark:bg-gray-800">
        <MetricRow
          label="Active Layers"
          value={props.metrics?.active_layers ?? "—"}
        />
        <MetricRow
          label="Active Universes"
          value={props.metrics?.active_universes ?? "—"}
        />
        <Show
          when={
            props.metrics?.entity_count !== undefined &&
            props.metrics?.entity_count !== null
          }
        >
          <MetricRow label="Entity Count" value={props.metrics?.entity_count} />
        </Show>
      </div>
    </CollapsibleSection>
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
    <CollapsibleSection
      title="Network"
      headerContent={
        <span class="ml-auto flex items-center gap-2">
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
      <div class="space-y-2 rounded-lg bg-gray-100 p-3 dark:bg-gray-800">
        <MetricRow
          label="Transport RTT (last heartbeat)"
          value={formatNumber(props.latencyMs, 2, " ms")}
        />
        <MetricRow
          label="Art-Net Send"
          value={
            <>
              {formatNumber(props.smoothedMetrics.artnetSendTimeMs, 2, " ms")}
              <Show when={(props.metrics?.artnet_universe_count ?? 0) > 0}>
                <span class="ml-1 text-gray-500 dark:text-gray-400">
                  ({props.metrics?.artnet_universe_count} univ)
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
              <Show when={(props.metrics?.sacn_universe_count ?? 0) > 0}>
                <span class="ml-1 text-gray-500 dark:text-gray-400">
                  ({props.metrics?.sacn_universe_count} univ)
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
    </CollapsibleSection>
  );
}
