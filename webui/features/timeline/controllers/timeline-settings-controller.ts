// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";
import type { ScrollMode } from "../model/types";
import type { TimelineEdits } from "./timeline-edits";

/**
 * Sends the timeline settings the timeline panel edits (beat grid and scroll mode) as granular
 * setting edits, so they never overwrite the timeline's tracks or markers.
 */
export function createTimelineSettingsController(edits: TimelineEdits) {
  /** Changes how the timeline view scrolls during playback. */
  const setScrollMode = (mode: ScrollMode) => {
    void edits.editSettings({ scroll_mode: mode as types.TimelineScrollMode });
  };

  /** Turns the beat grid on or off. */
  const setUseBeatgrid = (useBeatgrid: boolean) => {
    void edits.editSettings({ use_beat_grid: useBeatgrid });
  };

  /** Changes the beat grid's tempo. */
  const setBpm = (bpm: number) => {
    void edits.editSettings({ bpm });
  };

  /** Changes how many beats make one bar of the beat grid. */
  const setBeatsPerBar = (beatsPerBar: number) => {
    void edits.editSettings({ beats_per_bar: beatsPerBar });
  };

  return { setScrollMode, setUseBeatgrid, setBpm, setBeatsPerBar };
}
