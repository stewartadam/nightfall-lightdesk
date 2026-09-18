// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mergeProps } from "solid-js";
import { formatSMPTETime as formatSMPTETimeValue } from "../../../lib/time-format";
import { TimecodeRate } from "../../../types";
import "./timeline-footer.css";
import { useTimelineContext } from "../context/timeline-context";

export { formatSMPTETime } from "../../../lib/time-format";

/** Connects the timecode readout to the active timeline position and frame rate. */
export const ConnectedSMPTEFrameDisplay = () => {
  const ctx = useTimelineContext();

  return <SMPTEFrameDisplay duration={ctx.position()} rate={ctx.frameRate()} />;
};

type SMPTEFrameProps = {
  duration?: number;
  rate?: TimecodeRate;
};

/** Renders the timeline position as a compact SMPTE timecode readout. */
const SMPTEFrameDisplay = (props: SMPTEFrameProps) => {
  const merged = mergeProps({ duration: 0, rate: TimecodeRate.Fps30 }, props);
  return (
    <div class="timeline-position-display">
      <div class="flex items-center gap-2">
        <span class="timeline-position-label">SMPTE</span>
        <span>{formatSMPTETimeValue(merged.duration, merged.rate)}</span>
      </div>
    </div>
  );
};
