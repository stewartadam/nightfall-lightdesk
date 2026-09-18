// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Sparkline } from "../../../components/ui/sparkline";
import type {
  MetricsHistory,
  SmoothedEngineMetrics,
} from "../../../state/appStores";
import { formatNumber, getFpsColor } from "../model/metrics";
import { CollapsibleSection, MetricCard } from "./metric-sections";

interface BackendMetricsSectionProps {
  history: MetricsHistory;
  metrics: SmoothedEngineMetrics;
}

/** Presents backend frame pacing and state-build timings from projected metrics. */
export function BackendMetricsSection(props: BackendMetricsSectionProps) {
  return (
    <CollapsibleSection
      title="Backend"
      headerContent={
        <span class="ml-auto flex items-center gap-2">
          <Sparkline
            data={props.history.fps}
            width={80}
            height={20}
            color="#4ade80"
          />
          <span class={`font-mono text-xs ${getFpsColor(props.metrics.fps)}`}>
            {formatNumber(props.metrics.fps, 1)} fps
          </span>
        </span>
      }
    >
      <div class="grid grid-cols-2 gap-3">
        <MetricCard
          label="FPS"
          value={formatNumber(props.metrics.fps, 1)}
          valueClass={`text-2xl font-bold ${getFpsColor(props.metrics.fps)}`}
        />
        <MetricCard
          label={
            <span class="flex items-center gap-2">
              Frame Time (incl. sleep)
              <Sparkline
                data={props.history.frameTime}
                width={60}
                height={16}
                color="#60a5fa"
              />
            </span>
          }
          value={formatNumber(props.metrics.frameTimeMs, 2, " ms")}
          valueClass="text-2xl font-bold"
        />
        <MetricCard
          label="Frame generation"
          value={formatNumber(props.metrics.framepaceTimeMs, 2, " ms")}
        />
        <MetricCard
          label="Oversleep"
          value={formatNumber(props.metrics.framepaceOversleepMs, 2, " ms")}
        />
        <MetricCard
          label="ParameterState Build"
          value={formatNumber(props.metrics.parameterStateBuildMs, 2, " ms")}
        />
        <MetricCard
          label="ParameterState Broadcast"
          value={formatNumber(
            props.metrics.parameterStateBroadcastMs,
            2,
            " ms",
          )}
        />
        <MetricCard
          label="LayerStack Build"
          value={formatNumber(props.metrics.layerStackBuildMs, 2, " ms")}
        />
        <MetricCard
          label="Layer Transition Build"
          value={formatNumber(
            props.metrics.layerStackTransitionBuildMs,
            2,
            " ms",
          )}
        />
      </div>
    </CollapsibleSection>
  );
}
