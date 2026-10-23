// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Collapsible } from "../../../components/ui/collapsible";
import type { VisualizerStats } from "../../../state/appStores";
import { formatNumber, getFpsTone, UI_TARGET_FPS } from "../model/metrics";
import { MetricCard, MetricValue, PipelineStep } from "./metric-sections";

interface VisualizerMetricsSectionProps {
  stats: VisualizerStats | null;
}

/** Presents visualizer render-mode, stage timing, and frame-rate metrics. */
export function VisualizerMetricsSection(props: VisualizerMetricsSectionProps) {
  return (
    <Show when={props.stats}>
      <Collapsible
        lazy
        title="Visualizer"
        contentClass="p-3"
        actions={
          <span class="flex items-center gap-2">
            <span
              class={`rounded px-1.5 py-0.5 text-xs ${
                props.stats?.renderMode === "worker"
                  ? "bg-blue-500/20 text-blue-400"
                  : "bg-amber-500/20 text-amber-400"
              }`}
              title={
                props.stats?.renderMode === "worker"
                  ? "Rendering in worker thread (OffscreenCanvas)"
                  : "Rendering on main thread"
              }
            >
              {props.stats?.renderMode === "worker" ? "Worker" : "Main"}
            </span>
            <MetricValue
              tone={getFpsTone(props.stats?.fps, UI_TARGET_FPS)}
              class="text-xs"
            >
              {formatNumber(props.stats?.fps, 0)} fps
            </MetricValue>
          </span>
        }
      >
        <div class="space-y-3">
          <Show when={(props.stats?.reducedGoboEmitters ?? 0) > 0}>
            <p class="text-xs text-amber-400" role="status">
              Gobo mask limit reached on {props.stats?.reducedGoboEmitters}{" "}
              emitters: additional masks omitted.
            </p>
          </Show>
          <Show when={(props.stats?.reducedPrismEmitters ?? 0) > 0}>
            <p class="text-xs text-amber-400" role="status">
              Prism detail reduced on {props.stats?.reducedPrismEmitters}{" "}
              emitters to stay within the rendering budget.
            </p>
          </Show>
          <Show when={(props.stats?.omittedSurfaceLights ?? 0) > 0}>
            <p class="text-xs text-amber-400" role="status">
              Surface light limit reached: {props.stats?.omittedSurfaceLights}{" "}
              sources omitted.
            </p>
          </Show>
          <div class="grid grid-cols-4 gap-3">
            <MetricCard
              label="FPS"
              value={formatNumber(props.stats?.fps, 0)}
              size="lg"
              tone={getFpsTone(props.stats?.fps, UI_TARGET_FPS)}
            />
            <MetricCard
              label="Total"
              value={formatNumber(props.stats?.totalRenderMs, 2, " ms")}
              size="lg"
            />
            <MetricCard
              label="Update"
              value={formatNumber(props.stats?.updateFixturesMs, 2, " ms")}
            />
            <MetricCard
              label="Post"
              value={formatNumber(props.stats?.postProcessMs, 2, " ms")}
            />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <MetricCard
              label="Frame-to-Frame"
              value={formatNumber(props.stats?.frameToFrameMs, 2, " ms")}
            />
            <MetricCard
              label="GPU"
              value={formatNumber(props.stats?.gpuMs, 2, " ms")}
            />
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <PipelineStep label="Scene" value={props.stats?.scenePassMs} />
            <span class="text-gray-400">→</span>
            <PipelineStep
              label="Volumetric"
              value={props.stats?.volumetricPassMs}
            />
            <span class="text-gray-400">→</span>
            <PipelineStep
              label="Gaussian Blur"
              value={props.stats?.gaussianBlurMs}
            />
            <span class="text-gray-400">→</span>
            <PipelineStep label="Bloom" value={props.stats?.bloomMs} />
          </div>
        </div>
      </Collapsible>
    </Show>
  );
}
