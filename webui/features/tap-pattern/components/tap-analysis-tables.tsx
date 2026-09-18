// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { For, Show } from "solid-js";
import { Table, TableEmptyRow } from "../../../components/ui/table";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import {
  clusterColor,
  formatMs,
  gapFromPreviousCluster,
} from "../model/panel-model";
import type {
  TapEvent,
  TapPatternAnalysis,
  TapPatternCluster,
} from "../model/tap-pattern-analysis";

interface TapAnalysisTablesProps {
  analysis: TapPatternAnalysis;
  clusterRows: TapPatternCluster[];
  highlightedClusterId: number | null;
  onCopyTapTimings: (includeStoredState: boolean) => void;
  onSetHighlightedClusterId: (clusterId: number | null) => void;
  taps: TapEvent[];
}

/** Presents detected pattern steps and captured tap details from projected data. */
export function TapAnalysisTables(props: TapAnalysisTablesProps) {
  return (
    <section
      aria-label="Tap analysis"
      class="grid min-h-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(22rem,0.9fr)_minmax(28rem,1.1fr)]"
    >
      <div class="min-h-0 border border-neutral-800">
        <div class="border-b border-neutral-800 px-3 py-2 text-xs font-semibold uppercase text-neutral-400">
          Pattern Steps
        </div>
        <Table aria-label="Pattern steps" class="table-fixed text-left">
          <thead>
            <tr>
              <th scope="col" class="w-14">
                Step
              </th>
              <th scope="col">Phase</th>
              <th scope="col">Gap</th>
              <th scope="col" class="w-16">
                Hits
              </th>
              <th scope="col" class="w-20">
                Jitter
              </th>
            </tr>
          </thead>
          <tbody>
            <Show
              when={props.analysis.pattern}
              fallback={
                <TableEmptyRow colSpan={5}>No repeated pattern</TableEmptyRow>
              }
            >
              {(pattern) => (
                <For each={props.clusterRows}>
                  {(cluster, index) => (
                    <tr
                      data-tap-pattern-step={cluster.id + 1}
                      onMouseEnter={() =>
                        props.onSetHighlightedClusterId(cluster.id)
                      }
                      onMouseLeave={() => props.onSetHighlightedClusterId(null)}
                    >
                      <td>
                        <span
                          class={`inline-flex size-5 items-center justify-center rounded-full font-mono text-neutral-950 ${clusterColor(
                            cluster.id,
                          )} ${
                            props.highlightedClusterId === cluster.id
                              ? "outline outline-1 outline-offset-2 outline-red-500"
                              : ""
                          }`}
                          data-highlighted-step={
                            props.highlightedClusterId === cluster.id
                              ? "true"
                              : "false"
                          }
                          data-tap-pattern-step-badge="true"
                        >
                          {cluster.id + 1}
                        </span>
                      </td>
                      <td class="font-mono">{formatMs(cluster.phaseMs)}</td>
                      <td class="font-mono">
                        {formatMs(
                          gapFromPreviousCluster(
                            cluster,
                            index(),
                            props.clusterRows,
                            pattern().loopLengthMs,
                          ),
                        )}
                      </td>
                      <td class="font-mono">{cluster.tapIds.length}</td>
                      <td class="font-mono">
                        {formatMs(cluster.averageErrorMs)}
                      </td>
                    </tr>
                  )}
                </For>
              )}
            </Show>
          </tbody>
        </Table>
      </div>

      <div class="min-h-0 border border-neutral-800">
        <div class="flex items-center gap-2 border-b border-neutral-800 px-3 py-2 text-xs font-semibold uppercase text-neutral-400">
          <span>Captured Taps</span>
          <ToolbarButton
            label="Copy captured tap timings"
            data-tap-control="true"
            disabled={props.analysis.relativeTapsMs.length === 0}
            tooltip="Copy captured tap timings. Shift-click copies full tap state."
            type="button"
            onClick={(event) => props.onCopyTapTimings(event.shiftKey)}
          >
            <CopyIcon class="size-4" aria-hidden />
          </ToolbarButton>
        </div>
        <Table aria-label="Captured taps" class="table-fixed text-left">
          <thead>
            <tr>
              <th scope="col" class="w-16">
                #
              </th>
              <th scope="col" class="w-20">
                Key
              </th>
              <th scope="col">Time</th>
              <th scope="col">Interval</th>
              <th scope="col">Step</th>
            </tr>
          </thead>
          <tbody>
            <Show
              when={props.analysis.relativeTapsMs.length > 0}
              fallback={<TableEmptyRow colSpan={5}>No taps</TableEmptyRow>}
            >
              <For each={props.analysis.relativeTapsMs}>
                {(timeMs, index) => {
                  const tap = () => props.taps[index()];
                  const assignment = () =>
                    props.analysis.pattern?.assignments.find(
                      (candidate) => candidate.tapId === tap().id,
                    );
                  const intervalMs = () =>
                    index() === 0
                      ? null
                      : timeMs - props.analysis.relativeTapsMs[index() - 1];
                  const assignedClusterId = () => assignment()?.clusterId;
                  return (
                    <tr
                      data-tap-captured-row="true"
                      onMouseEnter={() => {
                        const clusterId = assignedClusterId();
                        if (clusterId != null) {
                          props.onSetHighlightedClusterId(clusterId);
                        }
                      }}
                      onMouseLeave={() => props.onSetHighlightedClusterId(null)}
                    >
                      <td class="font-mono">{index() + 1}</td>
                      <td class="font-mono">{tap().key ?? "--"}</td>
                      <td class="font-mono">{formatMs(timeMs)}</td>
                      <td class="font-mono">{formatMs(intervalMs())}</td>
                      <td>
                        <Show
                          when={assignment()}
                          fallback={<span class="text-neutral-600">--</span>}
                        >
                          {(matched) => {
                            const isHighlighted = () =>
                              matched().clusterId ===
                              props.highlightedClusterId;
                            return (
                              <span
                                class={`inline-flex rounded px-2 py-0.5 font-mono text-neutral-950 ${clusterColor(
                                  matched().clusterId,
                                )} ${
                                  isHighlighted()
                                    ? "outline outline-1 outline-offset-2 outline-red-500"
                                    : ""
                                }`}
                                data-highlighted-step={
                                  isHighlighted() ? "true" : "false"
                                }
                                data-tap-captured-step="true"
                                onMouseEnter={() =>
                                  props.onSetHighlightedClusterId(
                                    matched().clusterId,
                                  )
                                }
                                onMouseLeave={() =>
                                  props.onSetHighlightedClusterId(null)
                                }
                              >
                                {matched().clusterId + 1}
                              </span>
                            );
                          }}
                        </Show>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </Show>
          </tbody>
        </Table>
      </div>
    </section>
  );
}
