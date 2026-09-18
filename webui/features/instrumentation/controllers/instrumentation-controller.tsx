// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createSignal } from "solid-js";
import { clearPerformanceMeasures } from "../../../lib/performance-measure-collector";
import { useConditionalShallowStore } from "../../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import {
  engineMetrics,
  frameStats,
  longAnimationFrameStats,
  metricsHistory,
  performanceMeasureStats,
  smoothedEngineMetrics,
  visualizerStats,
  wsLatency,
  wsStats,
} from "../../../state/appStores";
import { BackendMetricsSection } from "../components/backend-metrics-section";
import { BrowserRenderingSection } from "../components/browser-rendering-section";
import {
  EngineStatsSection,
  NetworkMetricsSection,
} from "../components/engine-network-sections";
import { PerformanceMeasuresSection } from "../components/performance-measures-section";
import { VisualizerMetricsSection } from "../components/visualizer-metrics-section";
import { WebSocketMetricsSection } from "../components/websocket-metrics-section";
import {
  compareMessageTypeRows,
  type MessageSort,
  type MessageSortColumn,
  type MessageTypeRow,
  messageSortIndicator,
  nextMessageSort,
} from "../model/message-table";
import { downloadJson } from "../services/download-json";

/** Coordinates instrumentation stores, local table sorting, and diagnostic actions. */
export function InstrumentationController() {
  const $metrics = useConditionalShallowStore(
    engineMetrics,
    useWorkspaceActivity(),
  );
  const $smoothedMetrics = useConditionalShallowStore(
    smoothedEngineMetrics,
    useWorkspaceActivity(),
  );
  const $wsLatency = useConditionalShallowStore(
    wsLatency,
    useWorkspaceActivity(),
  );
  const $wsStats = useConditionalShallowStore(wsStats, useWorkspaceActivity());
  const $frameStats = useConditionalShallowStore(
    frameStats,
    useWorkspaceActivity(),
  );
  const $longAnimationFrameStats = useConditionalShallowStore(
    longAnimationFrameStats,
    useWorkspaceActivity(),
  );
  const $visualizerStats = useConditionalShallowStore(
    visualizerStats,
    useWorkspaceActivity(),
  );
  const $metricsHistory = useConditionalShallowStore(
    metricsHistory,
    useWorkspaceActivity(),
  );
  const $performanceMeasureStats = useConditionalShallowStore(
    performanceMeasureStats,
    useWorkspaceActivity(),
  );
  const [messageSort, setMessageSort] = createSignal<MessageSort>({
    column: "ratePerSec",
    direction: "desc",
  });

  /** Sorts websocket message aggregates for the active table column. */
  const sortedMessageTypes = createMemo(() => {
    const stats = $wsStats();
    if (!stats?.byType) return [];
    const { column, direction } = messageSort();
    return (Object.entries(stats.byType) as MessageTypeRow[]).sort(
      (left, right) => compareMessageTypeRows(left, right, column, direction),
    );
  });

  /** Returns User Timing aggregates sorted by measured scope name. */
  const sortedPerformanceMeasures = createMemo(() =>
    Object.values($performanceMeasureStats()).sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  );

  /** Updates the websocket message table sort from a column header. */
  const toggleMessageSort = (column: MessageSortColumn) => {
    setMessageSort((current) => nextMessageSort(current, column));
  };

  /** Returns the active sort marker for a websocket table column. */
  const getSortIndicator = (column: MessageSortColumn) =>
    messageSortIndicator(messageSort(), column);

  /** Downloads the current instrumentation snapshot for baseline revisioning. */
  const downloadPerformanceBaseline = () => {
    const timestamp = new Date().toISOString();
    downloadJson(`nightfall-performance-baseline-${timestamp}.json`, {
      schemaVersion: 1,
      capturedAt: timestamp,
      rollingWindowMs: 60_000,
      backend: { raw: $metrics(), smoothed: $smoothedMetrics() },
      browser: {
        frameStats: $frameStats(),
        longAnimationFrameStats: $longAnimationFrameStats(),
        visualizerStats: $visualizerStats(),
      },
      websocket: { latencyMs: $wsLatency(), stats: $wsStats() },
      performanceMeasures: sortedPerformanceMeasures(),
    });
  };

  return (
    <div class="h-full w-full overflow-auto p-4 dark:text-white">
      <div class="space-y-4">
        <BackendMetricsSection
          history={$metricsHistory()}
          metrics={$smoothedMetrics()}
        />
        <BrowserRenderingSection
          frameStats={$frameStats()}
          history={$metricsHistory()}
          longFrameStats={$longAnimationFrameStats()}
        />
        <PerformanceMeasuresSection
          measures={sortedPerformanceMeasures()}
          onClear={clearPerformanceMeasures}
          onDownload={downloadPerformanceBaseline}
        />
        <VisualizerMetricsSection stats={$visualizerStats()} />
        <EngineStatsSection metrics={$metrics()} />
        <NetworkMetricsSection
          history={$metricsHistory()}
          latencyMs={$wsLatency()}
          metrics={$metrics()}
          smoothedMetrics={$smoothedMetrics()}
        />
        <WebSocketMetricsSection
          measures={$performanceMeasureStats()}
          getSortIndicator={getSortIndicator}
          rows={sortedMessageTypes()}
          stats={$wsStats()}
          toggleSort={toggleMessageSort}
        />
      </div>
    </div>
  );
}
