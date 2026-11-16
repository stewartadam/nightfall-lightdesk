// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, untrack } from "solid-js";
import { resyncComplete } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { resolveTimelineAudioUrl } from "../../../lib/timeline-audio";
import {
  useConditionalShallowStore,
  useShallowStore,
} from "../../../lib/use-shallow-store";
import { durationToMs } from "../../../lib/utils";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import {
  timecodes,
  timelineRecordingPreviews,
  timelineRecordingStates,
  timelineStopEvent,
  timelines,
} from "../../../state/appStores";
import * as types from "../../../types";
import type { InstanceCommandCallbacks } from "../context/timeline-context-contract";
import { ScrollMode } from "../model/types";
import type { TimelineEdits } from "./timeline-edits";
import { createTimelinePlaybackController } from "./timeline-playback-controller";
import type { createTimelineSelectionController } from "./timeline-selection-controller";
import type { TimelineState } from "./timeline-state-controller";

const log = getLogger(import.meta.url);

type TimelineSelectionController = ReturnType<
  typeof createTimelineSelectionController
>;

interface TimelineHydrationControllerOptions {
  timelineUid: string;
  state: TimelineState;
  edits: TimelineEdits;
  selection: TimelineSelectionController;
  playbackCommands: InstanceCommandCallbacks;
}

/** Synchronizes one timeline editor's local state with backend store snapshots. */
export function createTimelineHydrationController(
  options: TimelineHydrationControllerOptions,
) {
  const workspaceActive = useWorkspaceActivity();
  const $timecodes = useConditionalShallowStore(timecodes, workspaceActive);
  const $timelines = useShallowStore(timelines);
  const $timelineRecordingPreviews = useStore(timelineRecordingPreviews);
  const $timelineRecordingStates = useStore(timelineRecordingStates);
  const $timelineStopEvent = useStore(timelineStopEvent);
  let handledTimelineStopRevision = untrack(
    () => $timelineStopEvent()?.revision ?? 0,
  );
  const playback = createTimelinePlaybackController({
    isManualTriggerMode: () =>
      $timelines()?.[options.timelineUid]?.trigger_mode === "Manual",
    loopRange: options.state.loopRange,
    commands: options.playbackCommands,
  });

  /** Clears local editing state when the selected timeline is unavailable. */
  const resetTimelineState = () => {
    const state = options.state;
    state.setAudioPath("");
    state.setScrollModeSignal(ScrollMode.FREE);
    state.setUseBeatgridSignal(false);
    state.setBeatsPerBarSignal(4);
    state.setBpmSignal(120);
    state.setBeatgrid(undefined);
    playback.reset();
    state.setTracks([]);
    state.setMarkers([]);
    state.setEditingMarkerLabelUid(undefined);
    state.setMarkerLabelDrafts({});
    state.setRegions([]);
    state.setLoopRange(undefined);
    options.selection.clear();
    state.setRecordingEnabledSignal(false);
    state.setRecordTargetTrackIdSignal(undefined);
    state.setTimelineHydrated(false);
  };

  /** Copies the timeline, with unconfirmed edits applied, into the local editing signals. */
  const syncFromTimeline = (
    timeline: types.Timeline | undefined,
    reason: string,
  ) => {
    if (!timeline) {
      log.warn(
        `Could not find timeline ${options.timelineUid} during ${reason}; clearing local timeline state`,
      );
      resetTimelineState();
      return;
    }
    const state = options.state;
    state.setAudioPath(resolveTimelineAudioUrl(timeline.audio_path ?? ""));
    state.setScrollModeSignal(
      (timeline.scroll_mode ?? types.TimelineScrollMode.Free) as ScrollMode,
    );
    state.setUseBeatgridSignal(timeline.use_beat_grid ?? false);
    state.setBeatsPerBarSignal(timeline.beats_per_bar);
    state.setBpmSignal(timeline.bpm);
    state.setBeatgrid(timeline.beatgrid);
    const trackContentEnd = Math.max(
      0,
      ...timeline.tracks.flatMap((track) =>
        track.actions.map(
          (action) =>
            durationToMs(action.position) + durationToMs(action.duration),
        ),
      ),
    );
    playback.setEnd(
      timeline.end_time
        ? durationToMs(timeline.end_time)
        : Math.max(untrack(playback.end), trackContentEnd, 60 * 1000),
    );
    playback.setTimecodeStart(
      timeline.timecode_start ? durationToMs(timeline.timecode_start) : 0,
    );
    state.setTracks(timeline.tracks);
    state.setTimelineHydrated(true);
  };

  /**
   * The timeline's markers, regions and loop range. Each memo changes only when its own value
   * is replaced, so adding or settling a track or settings edit doesn't copy them again over
   * this panel's own unconfirmed marker, region or loop changes.
   */
  const markers = createMemo(() => options.edits.timeline()?.markers);
  const regions = createMemo(() => options.edits.timeline()?.regions);
  const loopRange = createMemo(() => options.edits.timeline()?.loop_range);

  /** Copies the markers, regions and loop range into the local editing signals. */
  const syncAnnotations = () => {
    if (!untrack(options.edits.timeline)) return;
    const state = options.state;
    state.setMarkers(untrack(markers) ?? []);
    state.setRegions(untrack(regions) ?? []);
    state.setLoopRange(untrack(loopRange));
  };

  /** Projects staged recording actions into the visible track list. */
  const displayTracks = createMemo<types.Track[]>(() => {
    const baseTracks = options.state.tracks();
    const timeline = $timelines()?.[options.timelineUid];
    if (!timeline) return baseTracks;
    const preview =
      $timelineRecordingPreviews()[String(timeline.identifiers.id)];
    if (!preview || preview.actions.length === 0) return baseTracks;
    const previewTrackIndex = baseTracks.findIndex(
      (track) => track.id === preview.target_track_id,
    );
    if (previewTrackIndex === -1) {
      return [
        ...baseTracks,
        {
          id: preview.target_track_id,
          label: "Recorded Actions",
          muted: false,
          solo: false,
          actions: preview.actions,
          automation_lanes: [],
        },
      ];
    }
    return baseTracks.map((track, index) => {
      if (index !== previewTrackIndex) return track;
      const existingActionIds = new Set(
        track.actions.map((action) => action.id),
      );
      const stagedActions = preview.actions.filter(
        (action: types.Action) => !existingActionIds.has(action.id),
      );
      return stagedActions.length === 0
        ? track
        : { ...track, actions: [...track.actions, ...stagedActions] };
    });
  });

  /** Keeps playhead and pause state aligned with the active timecode. */
  createEffect(() => {
    const currentTimecodes = $timecodes();
    const timeline = untrack($timelines)?.[options.timelineUid];
    if (!timeline) {
      playback.stopLocalPlaybackState();
      return;
    }
    const timecodeState = currentTimecodes?.[timeline.timecode_uid]?.[1];
    if (!timecodeState) {
      playback.stopLocalPlaybackState();
      return;
    }
    playback.syncTimecodeState({
      currentTime: timecodeState.current_time,
      isActive: timecodeState.is_active,
      triggerMode:
        timeline.trigger_mode ?? types.TimelineTriggerMode.FollowTimecode,
    });
  });

  /** Stops local playback when the backend broadcasts a newer stop event. */
  createEffect(() => {
    const stopEvent = $timelineStopEvent();
    if (!stopEvent || stopEvent.revision <= handledTimelineStopRevision) return;
    handledTimelineStopRevision = stopEvent.revision;
    const timeline = $timelines()?.[options.timelineUid];
    if (timeline?.identifiers.id === stopEvent.timelineId) {
      playback.stopLocalPlaybackState();
    }
  });

  /**
   * Mirrors the timeline into the local editing signals whenever the engine's copy or this
   * panel's unconfirmed edits change, so an edit stays shown until the engine confirms it.
   */
  createEffect(() => {
    syncFromTimeline(options.edits.timeline(), "timeline update");
  });

  /** Mirrors the markers whenever they are replaced. */
  createEffect(() => {
    const next = markers();
    if (untrack(options.edits.timeline)) options.state.setMarkers(next ?? []);
  });

  /** Mirrors the regions whenever they are replaced. */
  createEffect(() => {
    const next = regions();
    if (untrack(options.edits.timeline)) options.state.setRegions(next ?? []);
  });

  /** Mirrors the loop range whenever it is replaced. */
  createEffect(() => {
    const next = loopRange();
    if (untrack(options.edits.timeline)) options.state.setLoopRange(next);
  });

  /** Mirrors backend recording state into the selected timeline controls. */
  createEffect(() => {
    const timeline = $timelines()?.[options.timelineUid];
    if (!timeline) {
      options.state.setRecordingEnabledSignal(false);
      options.state.setRecordTargetTrackIdSignal(undefined);
      return;
    }
    const recordingState =
      $timelineRecordingStates()[String(timeline.identifiers.id)];
    options.state.setRecordingEnabledSignal(recordingState?.enabled ?? false);
    options.state.setRecordTargetTrackIdSignal(recordingState?.target_track_id);
  });

  /** Reloads local state after a websocket resynchronization completes. */
  createEffect(() => {
    if (resyncComplete()) {
      syncFromTimeline(untrack(options.edits.timeline), "resync complete");
      syncAnnotations();
    }
  });

  return { playback, displayTracks };
}
