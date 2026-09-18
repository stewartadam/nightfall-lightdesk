// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { formatBpm, formatMs, formatPercent } from "../model/panel-model";
import type { TapPatternAnalysis } from "../model/tap-pattern-analysis";
import { MetricCell } from "./metric-cell";

interface TapPatternMetricsProps {
  analysis: TapPatternAnalysis;
  beatsPerLoop: number;
  elapsedLoopCount: number | null;
  loopBpm: number | null;
  tapCount: number;
}

/** Presents the detector's headline pulse, loop, cycle, and confidence metrics. */
export function TapPatternMetrics(props: TapPatternMetricsProps) {
  return (
    <div class="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
      <MetricCell
        label="Tap BPM"
        value={formatBpm(props.analysis.pulseBpm)}
        sublabel={formatMs(props.analysis.intervalStats.medianMs)}
      />
      <MetricCell
        label="Loop"
        value={formatMs(props.analysis.pattern?.loopLengthMs)}
        sublabel={
          props.analysis.pattern
            ? `${props.analysis.pattern.clusters.length} steps`
            : props.analysis.status
        }
      />
      <MetricCell
        label="Cycles"
        value={props.elapsedLoopCount?.toString() ?? "--"}
        sublabel="elapsed loops"
      />
      <MetricCell
        label="Loop BPM"
        value={formatBpm(props.loopBpm)}
        sublabel={`${props.beatsPerLoop} beats`}
      />
      <MetricCell
        label="Confidence"
        value={formatPercent(props.analysis.pattern?.confidence)}
        sublabel={`${props.tapCount} taps`}
      />
    </div>
  );
}
