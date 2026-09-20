// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor } from "solid-js";
import type { MoveTimelineActionOptions } from "../../../lib/timeline-actions";
import type * as types from "../../../types";
import type { ScrollMode } from "../model/types";

export interface MuteEvent {
  type: "mute";
  trackId: string;
  muted: boolean;
}

export interface SoloEvent {
  type: "solo";
  trackId: string;
  solo: boolean;
}

export type TrackReorderPlacement = "before" | "after";
export type TimelineNudgeUnit = "bar" | "beat" | "half" | "quarter" | "eighth";

export interface AddTrackEvent {
  type: "add-track";
  trackId: string;
}

export interface RemoveTrackEvent {
  type: "remove-track";
  trackId: string;
}

export interface ReorderTrackEvent {
  type: "reorder-track";
  trackId: string;
  targetTrackId: string;
  placement: TrackReorderPlacement;
}

export interface RenameTrackEvent {
  type: "rename-track";
  trackId: string;
  label: string;
}

export interface AddPointEvent {
  type: "add-point";
  trackId: string;
  automationLaneId: string;
  position: number;
  value: number;
}

export interface UpdatePointEvent {
  type: "update-point";
  trackId: string;
  automationLaneId: string;
  pointIndex: number;
  position: number;
  value: number;
}

export interface RemovePointEvent {
  type: "remove-point";
  trackId: string;
  automationLaneId: string;
  pointIndex: number;
}

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

export interface RepositionActionEvent {
  type: "reposition-action";
  trackId: string;
  actionId: string;
  newPosition: number;
  newTrackId?: string;
}

export interface RepositionActionsEvent {
  type: "reposition-actions";
  actions: MoveTimelineActionOptions[];
}

export interface InsertActionEvent {
  type: "insert-action";
  trackId: string;
  actionId: string;
  batchId?: string;
}

export interface UpdateActionEvent {
  type: "update-action";
  trackId: string;
  actionId: string;
}

export interface DeleteActionEvent {
  type: "delete-action";
  trackId: string;
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

export interface ScrollModeEvent {
  type: "set-scroll-mode";
  scrollMode: ScrollMode;
}

export interface BeatgridSettingsEvent {
  type: "set-beatgrid-settings";
  useBeatgrid: boolean;
  bpm: number;
  beatsPerBar: number;
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
  onInsert: Accessor<InsertActionEvent | undefined>;
  onUpdate: Accessor<UpdateActionEvent | undefined>;
  onDelete: Accessor<DeleteActionEvent | undefined>;
  onReposition: Accessor<
    RepositionActionEvent | RepositionActionsEvent | undefined
  >;
}

/** Public reactive state and action contract exposed by the timeline provider. */
export interface TimelineContextType {
  timelineUid: string;
  componentId: string;
  timelineHydrated: Accessor<boolean>;
  start: Accessor<number>;
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
  onScrollModeChange: Accessor<ScrollModeEvent | undefined>;
  showDurationTrails: Accessor<boolean>;
  setShowDurationTrails: (show: boolean) => void;
  useBeatgrid: Accessor<boolean>;
  setUseBeatgrid: (use: boolean) => void;
  bpm: Accessor<number>;
  setBpm: (bpm: number) => void;
  beatsPerBar: Accessor<number>;
  setBeatsPerBar: (beats: number) => void;
  onBeatgridSettingsChange: Accessor<BeatgridSettingsEvent | undefined>;
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
    onLanesChanged: Accessor<{ trackId: string } | undefined>;
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
    onAddTrack: Accessor<AddTrackEvent | undefined>;
    onRemoveTrack: Accessor<RemoveTrackEvent | undefined>;
    onRenameTrack: Accessor<RenameTrackEvent | undefined>;
    onReorderTrack: Accessor<ReorderTrackEvent | undefined>;
    onAddPoint: Accessor<AddPointEvent | undefined>;
    onUpdatePoint: Accessor<UpdatePointEvent | undefined>;
    onRemovePoint: Accessor<RemovePointEvent | undefined>;
    onMute: Accessor<MuteEvent | undefined>;
    onSolo: Accessor<SoloEvent | undefined>;
  };
  actions: ActionOperations;
}
