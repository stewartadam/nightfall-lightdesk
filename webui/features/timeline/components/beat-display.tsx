// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// BeatDisplay component - shows current beat/bar position
import { createMemo } from "solid-js";
import { useStore } from "../../../lib/use-nanostore";
import { durationToMs } from "../../../lib/utils";
import { timelineBeatgridPreview } from "../../../state/appStores";
import "./timeline-footer.css";
import { useTimelineContext } from "../context/timeline-context";
import { beatsElapsed, getBeatInfo, msPerBeat } from "../model/grid-utils";

export type BeatDisplayProps = {
  showWhenDisabled?: boolean; // Whether to show when beatgrid is disabled
};

/** Displays the current bar and beat using the active beat grid. */
export const BeatDisplay = (props: BeatDisplayProps) => {
  const context = useTimelineContext();
  const $timelineBeatgridPreview = useStore(timelineBeatgridPreview);

  /** Formats the bar and beat readout for the playback position and beat-grid settings. */
  const beatDisplay = createMemo(() => {
    const previewMarkers =
      $timelineBeatgridPreview()[context.timelineUid]?.markers ?? [];
    // Only calculate beat info if beatgrid is enabled or we're explicitly told to show
    if (
      context.useBeatgrid() ||
      props.showWhenDisabled ||
      previewMarkers.length > 0
    ) {
      const position = context.position();
      const bpm = context.bpm();
      const beatsPerBar = context.beatsPerBar();
      const beatgrid = context.beatgrid();
      const activeMarkers =
        previewMarkers.length > 0 ? previewMarkers : (beatgrid?.markers ?? []);

      if (activeMarkers.length > 0) {
        const beatDuration = msPerBeat(bpm);
        const markers = activeMarkers;
        let anchorBeat = markers[0].beat_index;
        let anchorMs = durationToMs(markers[0].time);

        for (const marker of markers) {
          const markerMs = durationToMs(marker.time);
          if (markerMs > position) {
            break;
          }
          anchorBeat = marker.beat_index;
          anchorMs = markerMs;
        }

        const beatFromAnchor = beatsElapsed(position - anchorMs, beatDuration);
        const totalBeat = Math.max(0, anchorBeat + beatFromAnchor);
        const bar = Math.floor(totalBeat / beatsPerBar) + 1;
        const beatInBar = (totalBeat % beatsPerBar) + 1;
        return `${bar}:${beatInBar}`;
      }

      // Get beat and bar information
      const beatInfo = getBeatInfo(position, bpm, beatsPerBar);

      // Create display string: "Bar:Beat"
      const beatInBar = beatInfo.beatInBar + 1; // Convert to 1-based for display
      return `${beatInfo.bar}:${beatInBar}`;
    }
    return "--";
  });

  return (
    <div class="timeline-position-display">
      <div class="flex items-center gap-2">
        <span class="timeline-position-label">Beat</span>
        <span>{beatDisplay()}</span>
      </div>
    </div>
  );
};
