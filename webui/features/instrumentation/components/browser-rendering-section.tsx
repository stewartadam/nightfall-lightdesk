// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Collapsible } from "../../../components/ui/collapsible";
import { Sparkline } from "../../../components/ui/sparkline";
import type {
  FrameStats,
  LongAnimationFrameStats,
  MetricsHistory,
} from "../../../state/appStores";
import { formatNumber, getFpsTone, UI_TARGET_FPS } from "../model/metrics";
import { MetricCard, MetricValue } from "./metric-sections";

interface BrowserRenderingSectionProps {
  frameStats: FrameStats | null;
  history: MetricsHistory;
  longFrameStats: LongAnimationFrameStats | null;
}

/** Presents browser frame-rate, frame-time, and dropped-frame metrics. */
export function BrowserRenderingSection(props: BrowserRenderingSectionProps) {
  return (
    <Collapsible
      lazy
      title="Browser Rendering"
      contentClass="p-3"
      actions={
        <span class="flex items-center gap-2">
          <Sparkline
            data={props.history.uiFps}
            width={80}
            height={20}
            color="#22d3ee"
          />
          <MetricValue
            tone={getFpsTone(props.frameStats?.fps, UI_TARGET_FPS)}
            class="text-xs"
          >
            {formatNumber(props.frameStats?.fps, 0)} fps
          </MetricValue>
        </span>
      }
    >
      <Show
        when={props.frameStats}
        fallback={
          <div class="rounded-lg bg-neutral-800 p-3 text-sm text-neutral-500">
            Starting...
          </div>
        }
      >
        <div class="grid grid-cols-4 gap-3">
          <MetricCard
            label="FPS"
            value={formatNumber(props.frameStats?.fps, 0)}
            size="lg"
            tone={getFpsTone(props.frameStats?.fps, UI_TARGET_FPS)}
          />
          <MetricCard
            label="Frame Time"
            value={formatNumber(props.frameStats?.avgFrameTimeMs, 1, " ms")}
            size="lg"
          />
          <MetricCard
            label="Dropped"
            value={props.frameStats?.droppedFrames ?? 0}
            size="lg"
            tone={
              (props.frameStats?.droppedFrames ?? 0) > 0 ? "warning" : "default"
            }
          />
          <MetricCard
            label="Long frames"
            value={formatNumber(props.longFrameStats?.totalFrames, 0)}
            size="lg"
          />
        </div>
      </Show>
    </Collapsible>
  );
}
