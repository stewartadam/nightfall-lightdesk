// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import * as types from "../../../types";
import type {
  SetRecordingRequest,
  TimelineNudgeUnit,
} from "../context/timeline-context-contract";
import { ScrollMode } from "../model/types";

/** Creates the local reactive state edited by one timeline panel instance. */
export function createTimelineState() {
  const [tracks, setTracks] = createSignal<types.Track[]>([]);
  const [markers, setMarkers] = createSignal<types.TimelineMarker[]>([]);
  const [editingMarkerLabelUid, setEditingMarkerLabelUid] = createSignal<
    string | undefined
  >(undefined);
  const [markerLabelDrafts, setMarkerLabelDrafts] = createSignal<
    Record<string, string>
  >({});
  const [regions, setRegions] = createSignal<types.TimelineRegion[]>([]);
  const [loopRange, setLoopRange] = createSignal<
    types.TimelineLoopRange | undefined
  >(undefined);
  const [audioPath, setAudioPath] = createSignal("");
  const [beatgrid, setBeatgrid] = createSignal<types.BeatgridData>();
  const [zoom, setZoom] = createSignal(100);
  const [scrollMode, setScrollModeSignal] = createSignal<ScrollMode>(
    ScrollMode.FREE,
  );
  const [showDurationTrails, setShowDurationTrails] = createSignal(false);
  const [useBeatgrid, setUseBeatgridSignal] = createSignal(false);
  const [bpm, setBpmSignal] = createSignal(120);
  const [beatsPerBar, setBeatsPerBarSignal] = createSignal(4);
  const [snapEnabled, setSnapEnabled] = createSignal(false);
  const [nudgeUnit, setNudgeUnit] = createSignal<TimelineNudgeUnit>("quarter");
  const [cursorPosition, setCursorPosition] = createSignal<number>();
  const [recordingEnabled, setRecordingEnabledSignal] = createSignal(false);
  const [recordTargetTrackId, setRecordTargetTrackIdSignal] =
    createSignal<string>();
  const [timelineHydrated, setTimelineHydrated] = createSignal(false);
  const [frameRate] = createSignal<types.TimecodeRate | undefined>(
    types.TimecodeRate.Fps30,
  );

  return {
    tracks,
    setTracks,
    markers,
    setMarkers,
    editingMarkerLabelUid,
    setEditingMarkerLabelUid,
    markerLabelDrafts,
    setMarkerLabelDrafts,
    regions,
    setRegions,
    loopRange,
    setLoopRange,
    audioPath,
    setAudioPath,
    beatgrid,
    setBeatgrid,
    zoom,
    setZoom,
    scrollMode,
    setScrollModeSignal,
    showDurationTrails,
    setShowDurationTrails,
    useBeatgrid,
    setUseBeatgridSignal,
    bpm,
    setBpmSignal,
    beatsPerBar,
    setBeatsPerBarSignal,
    snapEnabled,
    setSnapEnabled,
    nudgeUnit,
    setNudgeUnit,
    cursorPosition,
    setCursorPosition,
    recordingEnabled,
    setRecordingEnabledSignal,
    recordTargetTrackId,
    setRecordTargetTrackIdSignal,
    timelineHydrated,
    setTimelineHydrated,
    frameRate,
  };
}

export type TimelineState = ReturnType<typeof createTimelineState>;

/** Creates recording setters that keep local state and backend requests aligned. */
export function createTimelineRecordingController(
  state: TimelineState,
  onSetRecording: (request: SetRecordingRequest) => void,
) {
  /** Changes the target track and updates an active backend recording session. */
  const setRecordTargetTrackId = (trackId: string | undefined) => {
    state.setRecordTargetTrackIdSignal(trackId);
    if (!state.recordingEnabled()) return;
    onSetRecording({
      enabled: state.recordingEnabled(),
      targetTrackId: trackId,
    });
  };

  /** Enables or disables recording with the currently selected target track. */
  const setRecordingEnabled = (enabled: boolean) => {
    state.setRecordingEnabledSignal(enabled);
    onSetRecording({
      enabled,
      targetTrackId: state.recordTargetTrackId(),
    });
  };

  return { setRecordTargetTrackId, setRecordingEnabled };
}
