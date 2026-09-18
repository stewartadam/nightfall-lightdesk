// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import { getLogger } from "../../../lib/logger";
import { durationToMs } from "../../../lib/utils";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import * as types from "../../../types";
import type { InstanceCommandCallbacks } from "../context/timeline-context-contract";

const log = getLogger(import.meta.url);

interface TimelinePlaybackControllerOptions {
  isManualTriggerMode: Accessor<boolean>;
  loopRange: Accessor<types.TimelineLoopRange | undefined>;
  commands: InstanceCommandCallbacks;
}

interface TimelineTimecodeState {
  currentTime: types.Duration;
  isActive: boolean;
  triggerMode: types.TimelineTriggerMode;
}

/** Owns local playback state, interpolation, loop handling, and backend commands. */
export const createTimelinePlaybackController = (
  options: TimelinePlaybackControllerOptions,
) => {
  const workspaceActive = useWorkspaceActivity();
  const [start, setStart] = createSignal(0);
  const [end, setEnd] = createSignal(60 * 1000);
  const [position, setPosition] = createSignal(0);
  const [paused, setPaused] = createSignal(true);
  const [timecodePlaybackActive, setTimecodePlaybackActive] =
    createSignal(false);
  const [manualTimelinePlaybackActive, setManualTimelinePlaybackActive] =
    createSignal(false);
  const [playbackStartPending, setPlaybackStartPending] = createSignal(false);
  let playbackInterval: number | undefined;

  /** Stops local playhead interpolation and forgets the timer handle. */
  const clearPlaybackInterval = () => {
    if (playbackInterval !== undefined) {
      window.clearInterval(playbackInterval);
      playbackInterval = undefined;
    }
  };

  /** Uses a monotonic clock for playback interpolation when available. */
  const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

  /** Resets local playback state when the selected timeline disappears. */
  const reset = () => {
    setEnd(60 * 1000);
    setStart(0);
    setPosition(0);
    setPaused(true);
    setTimecodePlaybackActive(false);
    setManualTimelinePlaybackActive(false);
    setPlaybackStartPending(false);
    clearPlaybackInterval();
  };

  /** Stops local playback when upstream playback state is unavailable. */
  const stopLocalPlaybackState = () => {
    setPlaybackStartPending(false);
    setTimecodePlaybackActive(false);
    setManualTimelinePlaybackActive(false);
    setPaused(true);
  };

  /** Mirrors an upstream timecode update into the local playback state machine. */
  const syncTimecodeState = (state: TimelineTimecodeState) => {
    if (
      state.triggerMode === types.TimelineTriggerMode.Manual &&
      !manualTimelinePlaybackActive()
    ) {
      setTimecodePlaybackActive(false);
      if (!playbackStartPending()) setPaused(true);
      return;
    }

    setPosition(durationToMs(state.currentTime));
    setTimecodePlaybackActive(state.isActive);
    if (state.isActive) {
      setPlaybackStartPending(false);
      setPaused(false);
    } else if (!playbackStartPending()) {
      if (state.triggerMode === types.TimelineTriggerMode.Manual) {
        setManualTimelinePlaybackActive(false);
      }
      setPaused(true);
    }
  };

  /** Interpolates the playhead between authoritative timecode snapshots. */
  createEffect(() => {
    const currentPosition = untrack(position);
    clearPlaybackInterval();

    if (!workspaceActive() || !timecodePlaybackActive()) {
      log.debug(`playback paused at ${currentPosition}ms`);
      return;
    }

    log.debug(`playback resumed from ${currentPosition}ms`);
    let lastTickMs = monotonicNow();
    playbackInterval = window.setInterval(() => {
      const tickMs = monotonicNow();
      const elapsedMs = tickMs - lastTickMs;
      lastTickMs = tickMs;
      const newPosition = untrack(position) + elapsedMs;
      if (newPosition < untrack(end)) setPosition(newPosition);
    }, 16);
  });

  onCleanup(clearPlaybackInterval);

  /** Starts playback, seeking to an enabled loop's start when necessary. */
  const play = () => {
    const loop = options.loopRange();
    let playPosition = position();
    if (loop?.enabled) {
      const loopStart = durationToMs(loop.start);
      playPosition = loopStart;
      setPosition(loopStart);
      options.commands.onSeek(loopStart);
    }
    if (options.isManualTriggerMode()) setManualTimelinePlaybackActive(true);
    setPlaybackStartPending(true);
    setPaused(false);
    options.commands.onPlay(playPosition);
  };

  /** Pauses playback and forwards the pause position to the backend. */
  const pause = () => {
    setPlaybackStartPending(false);
    setTimecodePlaybackActive(false);
    if (options.isManualTriggerMode()) setManualTimelinePlaybackActive(false);
    setPaused(true);
    options.commands.onPause(position());
  };

  /** Moves the playhead immediately and notifies the backend. */
  const seek = (nextPosition: number) => {
    log.debug(`seeking to ${nextPosition}ms`);
    setPosition(nextPosition);
    options.commands.onSeek(nextPosition);
  };

  /** Stops playback, returns to the timeline start, and clears interpolation. */
  const stop = () => {
    log.debug(`stopping at ${position()}ms`);
    setPlaybackStartPending(false);
    setTimecodePlaybackActive(false);
    setManualTimelinePlaybackActive(false);
    setPaused(true);
    setPosition(start());
    clearPlaybackInterval();
    options.commands.onStop(position());
  };

  return {
    start,
    setStart,
    end,
    setEnd,
    position,
    paused,
    reset,
    stopLocalPlaybackState,
    syncTimecodeState,
    play,
    pause,
    seek,
    stop,
  };
};
