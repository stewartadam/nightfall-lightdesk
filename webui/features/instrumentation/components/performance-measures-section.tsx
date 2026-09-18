// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import { Table, TableScroll } from "../../../components/ui/table";
import { Button } from "../../../components/ui/visual-language/button";
import type { PerformanceMeasureStats } from "../../../state/appStores";
import { formatMeasureName } from "../model/message-table";
import { formatMeasureValue } from "../model/metrics";
import { CollapsibleSection } from "./metric-sections";

interface PerformanceMeasuresSectionProps {
  measures: PerformanceMeasureStats[];
  onClear: () => void;
  onDownload: () => void;
}

/** Presents sortable-name User Timing aggregates and their diagnostic actions. */
export function PerformanceMeasuresSection(
  props: PerformanceMeasuresSectionProps,
) {
  return (
    <CollapsibleSection
      title="Performance Metrics"
      headerContent={
        <span class="ml-auto font-mono text-xs">
          {props.measures.length} scopes / 60s
        </span>
      }
    >
      <Show
        when={props.measures.length > 0}
        fallback={
          <div class="rounded-lg bg-gray-100 p-3 text-sm text-gray-500 dark:bg-gray-800">
            Waiting for frontend measures...
          </div>
        }
      >
        <TableScroll
          aria-label="Performance metrics scroll area"
          class="rounded-lg bg-gray-100 p-3 dark:bg-gray-800"
        >
          <p class="mb-2 text-xs text-gray-500 dark:text-gray-400">
            Newest 6,000 samples per scope within 60 seconds.
          </p>
          <div class="mb-2 flex justify-end gap-2">
            <Button size="compact" type="button" onClick={props.onDownload}>
              Download JSON
            </Button>
            <Button size="compact" type="button" onClick={props.onClear}>
              Clear
            </Button>
          </div>
          <Table aria-label="Performance metrics">
            <thead>
              <tr>
                <th scope="col" class="text-left">
                  Scope
                </th>
                <th scope="col" class="text-right">
                  Count
                </th>
                <th scope="col" class="text-right">
                  Avg
                </th>
                <th scope="col" class="text-right">
                  P90
                </th>
                <th scope="col" class="text-right">
                  P95
                </th>
                <th scope="col" class="text-right">
                  P99
                </th>
                <th scope="col" class="text-right">
                  Max
                </th>
                <th scope="col" class="text-right">
                  Last
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.measures}>
                {(stats) => (
                  <tr>
                    <td
                      class="max-w-[260px] truncate font-mono"
                      title={stats.name}
                    >
                      {formatMeasureName(stats.name)}
                    </td>
                    <td class="text-right font-mono">{stats.count}</td>
                    <td class="text-right font-mono">
                      {formatMeasureValue(stats.avgMs, stats.unit)}
                    </td>
                    <td class="text-right font-mono">
                      {formatMeasureValue(stats.p90Ms, stats.unit)}
                    </td>
                    <td class="text-right font-mono">
                      {formatMeasureValue(stats.p95Ms, stats.unit)}
                    </td>
                    <td class="text-right font-mono">
                      {formatMeasureValue(stats.p99Ms, stats.unit)}
                    </td>
                    <td class="text-right font-mono">
                      {formatMeasureValue(stats.maxMs, stats.unit)}
                    </td>
                    <td class="text-right font-mono">
                      {formatMeasureValue(stats.lastMs, stats.unit)}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </Table>
        </TableScroll>
      </Show>
    </CollapsibleSection>
  );
}
