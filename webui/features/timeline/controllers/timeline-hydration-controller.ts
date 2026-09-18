// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, onCleanup, untrack } from "solid-js";
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

  /** Copies one backend snapshot into the local editing signals. */
  const syncFromTimelineSnapshot = (
    snapshot: Record<string, types.Timeline> | undefined,
    reason: string,
  ) => {
    const timeline = snapshot?.[options.timelineUid];
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
    playback.setStart(
      timeline.timecode_start ? durationToMs(timeline.timecode_start) : 0,
    );
    state.setTracks(timeline.tracks);
    state.setMarkers(timeline.markers ?? []);
    state.setRegions(timeline.regions ?? []);
    state.setLoopRange(timeline.loop_range);
    state.setTimelineHydrated(true);
  };

  /** Copies the current timeline store snapshot into local editing signals. */
  const syncFromTimelineStore = (reason: string) => {
    syncFromTimelineSnapshot(untrack($timelines), reason);
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
          expanded: false,
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

  const unsubscribe = timelines.listen((snapshot) => {
    syncFromTimelineSnapshot(snapshot, "timeline store subscription update");
  });
  onCleanup(unsubscribe);

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
    if (resyncComplete()) syncFromTimelineStore("resync complete");
  });

  return { playback, displayTracks };
}
