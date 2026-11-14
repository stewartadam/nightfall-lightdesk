// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { untrack } from "solid-js";
import type * as types from "../../../types";
import type { ScrollMode } from "../model/types";
import type { TimelineEdits } from "./timeline-edits";

/**
 * Sends the timeline settings the timeline panel edits (beat grid and scroll mode) as granular
 * setting edits, so they never overwrite the timeline's tracks or markers.
 */
export function createTimelineSettingsController(edits: TimelineEdits) {
  /** Sends one setting when it differs from the shown value, showing it until confirmed. */
  const updateSetting = (
    setting: types.TimelineSetting,
    unchanged: (timeline: types.Timeline) => boolean,
    apply: (timeline: types.Timeline) => types.Timeline,
  ) => {
    const timeline = untrack(edits.timeline);
    if (!timeline || unchanged(timeline)) return;
    edits.edit(
      [{ type: "UpdateSettings", data: { settings: [setting] } }],
      apply,
    );
  };

  /** Changes how the timeline view scrolls during playback. */
  const setScrollMode = (mode: ScrollMode) => {
    const scrollMode = mode as types.TimelineScrollMode;
    updateSetting(
      { type: "ScrollMode", data: scrollMode },
      (timeline) => (timeline.scroll_mode ?? "free") === scrollMode,
      (timeline) => ({ ...timeline, scroll_mode: scrollMode }),
    );
  };

  /** Turns the beat grid on or off. */
  const setUseBeatgrid = (useBeatgrid: boolean) => {
    updateSetting(
      { type: "UseBeatGrid", data: useBeatgrid },
      (timeline) => (timeline.use_beat_grid ?? false) === useBeatgrid,
      (timeline) => ({ ...timeline, use_beat_grid: useBeatgrid }),
    );
  };

  /** Changes the beat grid's tempo. */
  const setBpm = (bpm: number) => {
    updateSetting(
      { type: "Bpm", data: bpm },
      (timeline) => timeline.bpm === bpm,
      (timeline) => ({ ...timeline, bpm }),
    );
  };

  /** Changes how many beats make one bar of the beat grid. */
  const setBeatsPerBar = (beatsPerBar: number) => {
    updateSetting(
      { type: "BeatsPerBar", data: beatsPerBar },
      (timeline) => timeline.beats_per_bar === beatsPerBar,
      (timeline) => ({ ...timeline, beats_per_bar: beatsPerBar }),
    );
  };

  return { setScrollMode, setUseBeatgrid, setBpm, setBeatsPerBar };
}
