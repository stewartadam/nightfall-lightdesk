// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor } from "solid-js";
import type { MoveTimelineActionOptions } from "../../../lib/timeline-actions";
import type * as types from "../../../types";
import type { TimelineEdits } from "../controllers/timeline-edits";
import type { ScrollMode } from "../model/types";

export type TrackReorderPlacement = "before" | "after";
export type TimelineNudgeUnit = "bar" | "beat" | "half" | "quarter" | "eighth";

export interface SelectActionEvent {
  type: "select-action";
  trackId: string;
  actionId: string;
}

export interface SelectedAction {
  trackId: string;
  actionId: string;
}

export interface SelectActionOptions {
  range?: boolean;
  toggle?: boolean;
}

export interface SelectedMarker {
  markerUid: string;
}

export interface SelectMarkerOptions {
  range?: boolean;
  toggle?: boolean;
}

export interface OpenActionEvent {
  type: "open-action";
  actionId: string;
}

export interface StoreMarkerEvent {
  type: "store-marker";
  markers: types.TimelineMarker[];
  batchId?: string;
}

export interface DeleteMarkerEvent {
  type: "delete-marker";
  markerUids: string[];
}

export interface StoreRegionEvent {
  type: "store-region";
  region: types.TimelineRegion;
}

export interface DeleteRegionEvent {
  type: "delete-region";
  regionUid: string;
}

export interface SetLoopRangeEvent {
  type: "set-loop-range";
  loopRange?: types.TimelineLoopRange;
}

export interface NudgeSelectionEvent {
  type: "nudge-selection";
  selection: types.TimelineSelection[];
  deltaMs: number;
}

export interface SetRecordingRequest {
  enabled: boolean;
  targetTrackId?: string;
}

export interface InstanceCommandCallbacks {
  onPlay: (position: number) => void;
  onPause: (position: number) => void;
  onSeek: (position: number) => void;
  onStop: (position: number) => void;
}

export interface TimelineMutationOptions {
  batchId?: string;
}

export interface ActionOperations {
  selectAction: (
    trackId: string,
    actionId: string,
    options?: SelectActionOptions,
  ) => void;
  insertAction: (
    trackId: string,
    action: types.Action,
    options?: TimelineMutationOptions,
  ) => void;
  updateAction: (
    trackId: string,
    actionId: string,
    patch: Partial<types.Action>,
  ) => void;
  deleteAction: (trackId: string, actionId: string) => void;
  repositionAction: (
    trackId: string,
    actionId: string,
    newPosition: number,
    newTrackId?: string,
  ) => void;
  repositionActions: (actions: MoveTimelineActionOptions[]) => void;
  selectedActions: Accessor<SelectedAction[]>;
  onSelect: Accessor<SelectActionEvent | undefined>;
  onOpen: Accessor<OpenActionEvent | undefined>;
}

/** Public reactive state and action contract exposed by the timeline provider. */
export interface TimelineContextType {
  timelineUid: string;
  componentId: string;
  /** Granular edits of this timeline, with the edits not yet confirmed laid over it. */
  edits: TimelineEdits;
  timelineHydrated: Accessor<boolean>;
  /** Playhead in timeline time: milliseconds since the timeline's `timecode_start`. */
  position: Accessor<number>;
  paused: Accessor<boolean>;
  audioPath: Accessor<string>;
  setAudioPath: (audioPath: string) => void;
  tracks: Accessor<types.Track[]>;
  displayTracks: Accessor<types.Track[]>;
  markers: Accessor<types.TimelineMarker[]>;
  regions: Accessor<types.TimelineRegion[]>;
  loopRange: Accessor<types.TimelineLoopRange | undefined>;
  selection: Accessor<types.TimelineSelection | undefined>;
  beatgrid: Accessor<types.BeatgridData | undefined>;
  frameRate: Accessor<types.TimecodeRate | undefined>;
  end: Accessor<number>;
  setEnd: (end: number) => void;
  zoom: Accessor<number>;
  setZoom: (zoom: number) => void;
  scrollMode: Accessor<ScrollMode>;
  setScrollMode: (mode: ScrollMode) => void;
  showDurationTrails: Accessor<boolean>;
  setShowDurationTrails: (show: boolean) => void;
  useBeatgrid: Accessor<boolean>;
  setUseBeatgrid: (use: boolean) => void;
  bpm: Accessor<number>;
  setBpm: (bpm: number) => void;
  beatsPerBar: Accessor<number>;
  setBeatsPerBar: (beats: number) => void;
  snapEnabled: Accessor<boolean>;
  setSnapEnabled: (enabled: boolean) => void;
  nudgeUnit: Accessor<TimelineNudgeUnit>;
  setNudgeUnit: (unit: TimelineNudgeUnit) => void;
  cursorPosition: Accessor<number | undefined>;
  setCursorPosition: (position: number | undefined) => void;
  recordingEnabled: Accessor<boolean>;
  recordTargetTrackId: Accessor<string | undefined>;
  setRecordingEnabled: (enabled: boolean) => void;
  setRecordTargetTrackId: (trackId: string | undefined) => void;
  selectTimelineObject: (
    selection: types.TimelineSelection | undefined,
  ) => void;
  markersActions: {
    selectMarker: (markerUid: string, options?: SelectMarkerOptions) => void;
    storeMarker: (marker: types.TimelineMarker) => void;
    storeMarkers: (
      markers: types.TimelineMarker[],
      options?: TimelineMutationOptions,
    ) => void;
    deleteMarker: (markerUid: string) => void;
    selectedMarkers: Accessor<SelectedMarker[]>;
    onStoreMarker: Accessor<StoreMarkerEvent | undefined>;
    onDeleteMarker: Accessor<DeleteMarkerEvent | undefined>;
  };
  markerLabelEditing: {
    editingMarkerUid: Accessor<string | undefined>;
    draftLabel: (markerUid: string, fallback: string) => string;
    setDraftLabel: (markerUid: string, label: string) => void;
    clearDraftLabel: (markerUid: string) => void;
    startEditing: (markerUid: string, label: string) => void;
    stopEditing: () => void;
  };
  regionsActions: {
    storeRegion: (region: types.TimelineRegion) => void;
    deleteRegion: (regionUid: string) => void;
    onStoreRegion: Accessor<StoreRegionEvent | undefined>;
    onDeleteRegion: Accessor<DeleteRegionEvent | undefined>;
  };
  loopActions: {
    setLoopRange: (loopRange: types.TimelineLoopRange | undefined) => void;
    onSetLoopRange: Accessor<SetLoopRangeEvent | undefined>;
  };
  nudgeSelection: (deltaMs: number) => void;
  onNudgeSelection: Accessor<NudgeSelectionEvent | undefined>;
  playback: {
    play: () => void;
    pause: () => void;
    stop: () => void;
    seek: (position: number) => void;
  };
  track: {
    addLane: (
      trackId: string,
      name: string,
      parameterType: types.ParameterType,
    ) => void;
    removeLane: (trackId: string, laneId: string) => void;
    addTrack: (label?: string) => string | undefined;
    removeTrack: (trackId: string) => void;
    renameTrack: (trackId: string, label: string) => void;
    reorderTrack: (
      trackId: string,
      targetTrackId: string,
      placement: TrackReorderPlacement,
    ) => void;
    addPoint: (
      trackId: string,
      automationLaneId: string,
      position: number,
      value: number,
    ) => void;
    updatePoint: (
      trackId: string,
      automationLaneId: string,
      pointIndex: number,
      position: number,
      value: number,
    ) => void;
    removePoint: (
      trackId: string,
      automationLaneId: string,
      pointIndex: number,
    ) => void;
    toggleMute: (trackId: string) => void;
    toggleSolo: (trackId: string) => void;
    toggleTrackExpanded: (trackId: string) => void;
  };
  actions: ActionOperations;
}
