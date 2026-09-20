// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createContext, type JSX, useContext } from "solid-js";
import { getLogger } from "../../../lib/logger";
import { createTimelineHydrationController } from "../controllers/timeline-hydration-controller";
import { createTimelineMarkerRegionController } from "../controllers/timeline-marker-region-controller";
import { createTimelineSelectionController } from "../controllers/timeline-selection-controller";
import { createTimelineSettingsController } from "../controllers/timeline-settings-controller";
import {
  createTimelineRecordingController,
  createTimelineState,
} from "../controllers/timeline-state-controller";
import { createTimelineTrackController } from "../controllers/timeline-track-controller";
import type {
  InstanceCommandCallbacks,
  SetRecordingRequest,
  TimelineContextType,
} from "./timeline-context-contract";

export type {
  SelectedAction,
  SelectedMarker,
  TimelineContextType,
  TimelineNudgeUnit,
  TrackReorderPlacement,
} from "./timeline-context-contract";

const log = getLogger(import.meta.url);
const TimelineContext = createContext<TimelineContextType>();

interface TimelineContextProviderProps {
  children: JSX.Element;
  initialTimelineUid: string;
  initialPanelId: string;
  onSetRecording: (request: SetRecordingRequest) => void;
  playbackCommands: InstanceCommandCallbacks;
}

/** Composes the scoped controllers exposed to one timeline panel instance. */
export function TimelineContextProvider(props: TimelineContextProviderProps) {
  log.trace("mounting");
  const state = createTimelineState();
  const selection = createTimelineSelectionController({
    tracks: state.tracks,
    setTracks: state.setTracks,
    markers: state.markers,
    setMarkers: state.setMarkers,
    regions: state.regions,
    setRegions: state.setRegions,
  });
  const hydration = createTimelineHydrationController({
    timelineUid: props.initialTimelineUid,
    state,
    selection,
    playbackCommands: props.playbackCommands,
  });
  const settings = createTimelineSettingsController(state);
  const track = createTimelineTrackController(state, selection);
  const markerRegion = createTimelineMarkerRegionController(state, selection);
  const recording = createTimelineRecordingController(
    state,
    props.onSetRecording,
  );

  const value: TimelineContextType = {
    timelineUid: props.initialTimelineUid,
    componentId: props.initialPanelId,
    timelineHydrated: state.timelineHydrated,
    start: hydration.playback.start,
    position: hydration.playback.position,
    paused: hydration.playback.paused,
    audioPath: state.audioPath,
    setAudioPath: state.setAudioPath,
    tracks: state.tracks,
    displayTracks: hydration.displayTracks,
    markers: state.markers,
    regions: state.regions,
    loopRange: state.loopRange,
    selection: selection.selection,
    beatgrid: state.beatgrid,
    frameRate: state.frameRate,
    end: hydration.playback.end,
    setEnd: hydration.playback.setEnd,
    zoom: state.zoom,
    setZoom: state.setZoom,
    scrollMode: state.scrollMode,
    setScrollMode: settings.setScrollMode,
    onScrollModeChange: settings.scrollModeEvent,
    showDurationTrails: state.showDurationTrails,
    setShowDurationTrails: state.setShowDurationTrails,
    useBeatgrid: state.useBeatgrid,
    setUseBeatgrid: settings.setUseBeatgrid,
    bpm: state.bpm,
    setBpm: settings.setBpm,
    beatsPerBar: state.beatsPerBar,
    setBeatsPerBar: settings.setBeatsPerBar,
    onBeatgridSettingsChange: settings.beatgridSettingsEvent,
    snapEnabled: state.snapEnabled,
    setSnapEnabled: state.setSnapEnabled,
    nudgeUnit: state.nudgeUnit,
    setNudgeUnit: state.setNudgeUnit,
    cursorPosition: state.cursorPosition,
    setCursorPosition: state.setCursorPosition,
    recordingEnabled: state.recordingEnabled,
    recordTargetTrackId: state.recordTargetTrackId,
    setRecordingEnabled: recording.setRecordingEnabled,
    setRecordTargetTrackId: recording.setRecordTargetTrackId,
    selectTimelineObject: selection.selectTimelineObject,
    markersActions: {
      selectMarker: selection.selectMarker,
      storeMarker: markerRegion.storeMarker,
      storeMarkers: markerRegion.storeMarkers,
      deleteMarker: markerRegion.deleteMarker,
      selectedMarkers: selection.selectedMarkers,
      onStoreMarker: markerRegion.storeMarkerEvent,
      onDeleteMarker: markerRegion.deleteMarkerEvent,
    },
    markerLabelEditing: {
      editingMarkerUid: state.editingMarkerLabelUid,
      draftLabel: markerRegion.markerLabelDraft,
      setDraftLabel: markerRegion.setMarkerLabelDraft,
      clearDraftLabel: markerRegion.clearMarkerLabelDraft,
      startEditing: markerRegion.startMarkerLabelEditing,
      stopEditing: () => state.setEditingMarkerLabelUid(undefined),
    },
    regionsActions: {
      storeRegion: markerRegion.storeRegion,
      deleteRegion: markerRegion.deleteRegion,
      onStoreRegion: markerRegion.storeRegionEvent,
      onDeleteRegion: markerRegion.deleteRegionEvent,
    },
    loopActions: {
      setLoopRange: markerRegion.setPersistedLoopRange,
      onSetLoopRange: markerRegion.setLoopRangeEvent,
    },
    nudgeSelection: selection.nudgeSelection,
    onNudgeSelection: selection.nudgeSelectionEvent,
    playback: {
      play: hydration.playback.play,
      pause: hydration.playback.pause,
      stop: hydration.playback.stop,
      seek: hydration.playback.seek,
    },
    track: {
      addLane: track.addLane,
      removeLane: track.removeLane,
      onLanesChanged: track.lanesChangedEvent,
      addTrack: track.addTrack,
      removeTrack: track.removeTrack,
      renameTrack: track.renameTrack,
      reorderTrack: track.reorderTrack,
      addPoint: track.addPoint,
      updatePoint: track.updatePoint,
      removePoint: track.removePoint,
      toggleMute: track.toggleTrackMute,
      toggleSolo: track.toggleTrackSolo,
      toggleTrackExpanded: track.toggleTrackExpanded,
      onAddTrack: track.addTrackEvent,
      onRemoveTrack: track.removeTrackEvent,
      onRenameTrack: track.renameTrackEvent,
      onReorderTrack: track.reorderTrackEvent,
      onAddPoint: track.addPointEvent,
      onUpdatePoint: track.updatePointEvent,
      onRemovePoint: track.removePointEvent,
      onMute: track.muteEvent,
      onSolo: track.soloEvent,
    },
    actions: {
      selectAction: selection.selectAction,
      insertAction: track.insertAction,
      updateAction: track.updateAction,
      deleteAction: track.deleteAction,
      repositionAction: track.repositionAction,
      repositionActions: track.repositionActions,
      selectedActions: selection.selectedActions,
      onSelect: selection.selectActionEvent,
      onOpen: track.openActionEvent,
      onInsert: track.insertActionEvent,
      onUpdate: track.updateActionEvent,
      onDelete: track.deleteActionEvent,
      onReposition: track.repositionActionEvent,
    },
  };

  return (
    <TimelineContext.Provider value={value}>
      {props.children}
    </TimelineContext.Provider>
  );
}

/** Returns the timeline context scoped to the nearest panel provider. */
export function useTimelineContext(): TimelineContextType {
  const context = useContext(TimelineContext);
  if (!context) {
    throw new Error(
      "useTimelineContext must be used within a TimelineContextProvider",
    );
  }
  return context;
}
