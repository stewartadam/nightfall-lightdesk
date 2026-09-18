// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, untrack } from "solid-js";
import type {
  BeatgridSettingsEvent,
  ScrollModeEvent,
} from "../context/timeline-context-contract";
import type { ScrollMode } from "../model/types";
import type { TimelineState } from "./timeline-state-controller";

/** Coordinates editable timeline settings with the events persisted by the listener. */
export function createTimelineSettingsController(state: TimelineState) {
  const [scrollModeEvent, setScrollModeEvent] = createSignal<ScrollModeEvent>();
  const [beatgridSettingsEvent, setBeatgridSettingsEvent] =
    createSignal<BeatgridSettingsEvent>();

  /** Stores a user-requested scroll mode change and emits a persistence event. */
  const setScrollMode = (mode: ScrollMode) => {
    state.setScrollModeSignal(mode);
    setScrollModeEvent({ type: "set-scroll-mode", scrollMode: mode });
  };

  /** Stores a user-requested beatgrid enabled-state change and emits a persistence event. */
  const setUseBeatgrid = (useBeatgrid: boolean) => {
    state.setUseBeatgridSignal(useBeatgrid);
    setBeatgridSettingsEvent({
      type: "set-beatgrid-settings",
      useBeatgrid,
      bpm: untrack(state.bpm),
      beatsPerBar: untrack(state.beatsPerBar),
    });
  };

  /** Stores a user-requested BPM change and emits a persistence event. */
  const setBpm = (bpm: number) => {
    state.setBpmSignal(bpm);
    setBeatgridSettingsEvent({
      type: "set-beatgrid-settings",
      useBeatgrid: untrack(state.useBeatgrid),
      bpm,
      beatsPerBar: untrack(state.beatsPerBar),
    });
  };

  /** Stores a user-requested beats-per-bar change and emits a persistence event. */
  const setBeatsPerBar = (beatsPerBar: number) => {
    state.setBeatsPerBarSignal(beatsPerBar);
    setBeatgridSettingsEvent({
      type: "set-beatgrid-settings",
      useBeatgrid: untrack(state.useBeatgrid),
      bpm: untrack(state.bpm),
      beatsPerBar,
    });
  };

  return {
    setScrollMode,
    scrollModeEvent,
    setUseBeatgrid,
    setBpm,
    setBeatsPerBar,
    beatgridSettingsEvent,
  };
}
