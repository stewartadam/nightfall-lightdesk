// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useTimelineContext } from "../context/timeline-context";

type GhostPlayheadProps = {
  left: number;
};

/** Draws the playback cursor at subpixel precision as the timeline clock advances. */
export const Playhead = () => {
  const context = useTimelineContext();

  /** Calculate position directly from context values */
  const getPixelPosition = () => {
    return ((context.position() - context.start()) / 1000) * context.zoom();
  };

  return (
    <div
      data-timeline-playhead="true"
      class="absolute top-0 bottom-0 w-0.5 bg-red-600 z-5 h-full pointer-events-none"
      style={{ left: `${getPixelPosition()}px` }}
    >
      <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-red-600 relative -left-[5.2px] -top-1" />
    </div>
  );
};

/** Marks the prospective cursor location without changing playback. */
export const GhostPlayhead = (props: GhostPlayheadProps) => {
  return (
    <div
      class="absolute top-0 bottom-0 h-full pointer-events-none"
      style={{
        left: `${props.left}px`,
        "border-left": "1px dashed rgba(252, 165, 165, 0.9)",
        "z-index": 4,
      }}
    >
      <div class="w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[7px] border-t-red-300 relative -left-[4.6px] -top-1" />
    </div>
  );
};
