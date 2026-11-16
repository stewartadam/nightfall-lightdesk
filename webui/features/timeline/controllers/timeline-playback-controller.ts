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

// Small transport delays adjust playback speed by at most 10%; larger changes seek.
const MAX_CLOCK_CORRECTION_RATE = 0.1;
const PLAYBACK_DISCONTINUITY_MS = 250;

interface TimelinePlaybackControllerOptions {
  isManualTriggerMode: Accessor<boolean>;
  loopRange: Accessor<types.TimelineLoopRange | undefined>;
  commands: InstanceCommandCallbacks;
}

/**
 * Converts a timecode position into timeline time: the time since the timeline's
 * `timecode_start`, held at 0 before the timeline starts.
 */
const timelinePositionAt = (timecodeMs: number, timecodeStartMs: number) =>
  Math.max(0, timecodeMs - timecodeStartMs);

interface TimelineTimecodeState {
  currentTime: types.Duration;
  isActive: boolean;
  triggerMode: types.TimelineTriggerMode;
}

/**
 * Owns local playback state, interpolation, loop handling, and backend commands.
 *
 * Every position it exposes or accepts is in timeline time, the coordinate space the engine
 * stores action, automation, marker and loop positions in. The linked timecode runs in
 * timecode time, offset by the timeline's `timecode_start`, so the conversion happens only
 * where timecode positions enter (`syncTimecodeState`) or leave (`seek`).
 */
export const createTimelinePlaybackController = (
  options: TimelinePlaybackControllerOptions,
) => {
  const workspaceActive = useWorkspaceActivity();
  const [timecodeStart, setTimecodeStart] = createSignal(0);
  const [end, setEnd] = createSignal(60 * 1000);
  const [position, setPosition] = createSignal(0);
  const [paused, setPaused] = createSignal(true);
  const [timecodePlaybackActive, setTimecodePlaybackActive] =
    createSignal(false);
  const [manualTimelinePlaybackActive, setManualTimelinePlaybackActive] =
    createSignal(false);
  const [playbackStartPending, setPlaybackStartPending] = createSignal(false);
  let playbackFrame: number | undefined;
  let anchorPositionMs = 0;
  let anchorTimeMs = 0;
  let lastFrameTimeMs = 0;
  let lastSnapshotPositionMs: number | undefined;
  let lastTimecodeMs: number | undefined;
  let lastTimecodeActive = false;

  /** Cancels the pending presentation update. */
  const clearPlaybackFrame = () => {
    if (playbackFrame !== undefined) {
      window.cancelAnimationFrame(playbackFrame);
      playbackFrame = undefined;
    }
  };

  /** Uses a monotonic clock for playback interpolation when available. */
  const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

  /** Anchors elapsed playback time to the instant this position was received or sought. */
  const anchorPosition = (nextPosition: number) => {
    anchorPositionMs = nextPosition;
    anchorTimeMs = monotonicNow();
    lastFrameTimeMs = anchorTimeMs;
    setPosition(nextPosition);
  };

  /**
   * Applies the timeline's `timecode_start` offset. A changed offset moves the playhead to
   * where the last known timecode position now falls on the timeline, since the timecode
   * itself did not move and may not report again until it does.
   */
  const updateTimecodeStart = (nextTimecodeStartMs: number) => {
    if (nextTimecodeStartMs === untrack(timecodeStart)) return;
    setTimecodeStart(nextTimecodeStartMs);
    if (lastTimecodeMs !== undefined) {
      lastSnapshotPositionMs = undefined;
      anchorPosition(timelinePositionAt(lastTimecodeMs, nextTimecodeStartMs));
      setTimecodePlaybackActive(
        lastTimecodeActive && lastTimecodeMs >= nextTimecodeStartMs,
      );
    }
  };

  /** Resets local playback state when the selected timeline disappears. */
  const reset = () => {
    setEnd(60 * 1000);
    setTimecodeStart(0);
    lastTimecodeMs = undefined;
    lastTimecodeActive = false;
    anchorPosition(0);
    lastSnapshotPositionMs = undefined;
    setPaused(true);
    setTimecodePlaybackActive(false);
    setManualTimelinePlaybackActive(false);
    setPlaybackStartPending(false);
    clearPlaybackFrame();
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

    lastTimecodeMs = durationToMs(state.currentTime);
    lastTimecodeActive = state.isActive;
    // Before the timeline starts (pre-roll), the engine holds playback at its start, so the
    // playhead waits there instead of advancing with the timecode.
    const snapshotPositionMs = timelinePositionAt(
      lastTimecodeMs,
      untrack(timecodeStart),
    );
    const advancing =
      state.isActive && lastTimecodeMs >= untrack(timecodeStart);
    const receivedAtMs = monotonicNow();
    const predictedPositionMs = anchorPositionMs + receivedAtMs - anchorTimeMs;
    if (
      !advancing ||
      snapshotPositionMs >= untrack(end) ||
      !untrack(timecodePlaybackActive) ||
      (lastSnapshotPositionMs !== undefined &&
        snapshotPositionMs < lastSnapshotPositionMs) ||
      Math.abs(snapshotPositionMs - predictedPositionMs) >
        PLAYBACK_DISCONTINUITY_MS
    ) {
      anchorPosition(snapshotPositionMs);
    } else {
      // Keep presentation continuous while converging on the latest clock sample.
      anchorPositionMs = snapshotPositionMs;
      anchorTimeMs = receivedAtMs;
    }
    lastSnapshotPositionMs = snapshotPositionMs;
    setTimecodePlaybackActive(advancing);
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
    clearPlaybackFrame();

    if (!workspaceActive() || !timecodePlaybackActive()) {
      log.debug(`playback paused at ${currentPosition}ms`);
      return;
    }

    log.debug(`playback resumed from ${currentPosition}ms`);
    /** Projects the latest authoritative position onto this browser presentation frame. */
    const animate = () => {
      const frameTimeMs = monotonicNow();
      const elapsedMs = frameTimeMs - lastFrameTimeMs;
      lastFrameTimeMs = frameTimeMs;
      const projectedPositionMs = untrack(position) + elapsedMs;
      const targetPositionMs = anchorPositionMs + frameTimeMs - anchorTimeMs;
      const maxCorrectionMs = elapsedMs * MAX_CLOCK_CORRECTION_RATE;
      const correctionMs = Math.max(
        -maxCorrectionMs,
        Math.min(maxCorrectionMs, targetPositionMs - projectedPositionMs),
      );
      const nextPosition = projectedPositionMs + correctionMs;
      if (nextPosition < untrack(end)) setPosition(nextPosition);
      playbackFrame = window.requestAnimationFrame(animate);
    };
    playbackFrame = window.requestAnimationFrame(animate);
  });

  onCleanup(clearPlaybackFrame);

  /**
   * Starts playback. The backend seeks to an enabled loop's start, so the local playhead
   * is anchored there to match.
   */
  const play = () => {
    const loop = options.loopRange();
    let playPosition = position();
    if (loop?.enabled) {
      const loopStart = durationToMs(loop.start);
      playPosition = loopStart;
      anchorPosition(loopStart);
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

  /**
   * Moves the playhead to a timeline position immediately and seeks the linked timecode to
   * the matching timecode position.
   */
  const seek = (nextPosition: number) => {
    log.debug(`seeking to ${nextPosition}ms`);
    anchorPosition(nextPosition);
    options.commands.onSeek(nextPosition + untrack(timecodeStart));
  };

  /** Stops playback, returns to the timeline start, and clears interpolation. */
  const stop = () => {
    log.debug(`stopping at ${position()}ms`);
    setPlaybackStartPending(false);
    setTimecodePlaybackActive(false);
    setManualTimelinePlaybackActive(false);
    setPaused(true);
    anchorPosition(0);
    clearPlaybackFrame();
    options.commands.onStop(position());
  };

  return {
    setTimecodeStart: updateTimecodeStart,
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
