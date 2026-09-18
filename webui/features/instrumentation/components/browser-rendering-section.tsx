// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Sparkline } from "../../../components/ui/sparkline";
import type {
  FrameStats,
  LongAnimationFrameStats,
  MetricsHistory,
} from "../../../state/appStores";
import { formatNumber, getFpsColor, UI_TARGET_FPS } from "../model/metrics";
import { CollapsibleSection, MetricCard } from "./metric-sections";

interface BrowserRenderingSectionProps {
  frameStats: FrameStats | null;
  history: MetricsHistory;
  longFrameStats: LongAnimationFrameStats | null;
}

/** Presents browser frame-rate, frame-time, and dropped-frame metrics. */
export function BrowserRenderingSection(props: BrowserRenderingSectionProps) {
  return (
    <CollapsibleSection
      title="Browser Rendering"
      headerContent={
        <span class="ml-auto flex items-center gap-2">
          <Sparkline
            data={props.history.uiFps}
            width={80}
            height={20}
            color="#22d3ee"
          />
          <span
            class={`font-mono text-xs ${getFpsColor(props.frameStats?.fps, UI_TARGET_FPS)}`}
          >
            {formatNumber(props.frameStats?.fps, 0)} fps
          </span>
        </span>
      }
    >
      <Show
        when={props.frameStats}
        fallback={
          <div class="rounded-lg bg-gray-100 p-3 text-sm text-gray-500 dark:bg-gray-800">
            Starting...
          </div>
        }
      >
        <div class="grid grid-cols-4 gap-3">
          <MetricCard
            label="FPS"
            value={formatNumber(props.frameStats?.fps, 0)}
            valueClass={`text-xl font-bold ${getFpsColor(props.frameStats?.fps, UI_TARGET_FPS)}`}
          />
          <MetricCard
            label="Frame Time"
            value={formatNumber(props.frameStats?.avgFrameTimeMs, 1, " ms")}
            valueClass="text-xl font-bold"
          />
          <MetricCard
            label="Dropped"
            value={props.frameStats?.droppedFrames ?? 0}
            valueClass={`text-xl font-bold ${(props.frameStats?.droppedFrames ?? 0) > 0 ? "text-yellow-500" : ""}`}
          />
          <MetricCard
            label="Long frames"
            value={formatNumber(props.longFrameStats?.totalFrames, 0)}
            valueClass="text-xl font-bold"
          />
        </div>
      </Show>
    </CollapsibleSection>
  );
}
