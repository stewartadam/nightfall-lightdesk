// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { getLogger } from "../../../lib/logger";
import {
  type MoveTimelineActionOptions,
  moveTimelineAction,
  moveTimelineActions,
} from "../../../lib/timeline-actions";
import { msToDuration } from "../../../lib/utils";
import type * as types from "../../../types";
import type {
  AddPointEvent,
  AddTrackEvent,
  DeleteActionEvent,
  InsertActionEvent,
  MuteEvent,
  OpenActionEvent,
  RemovePointEvent,
  RemoveTrackEvent,
  RenameTrackEvent,
  ReorderTrackEvent,
  RepositionActionEvent,
  RepositionActionsEvent,
  SoloEvent,
  TimelineMutationOptions,
  TrackReorderPlacement,
  UpdateActionEvent,
  UpdatePointEvent,
} from "../context/timeline-context-contract";
import type { createTimelineSelectionController } from "./timeline-selection-controller";
import type { TimelineState } from "./timeline-state-controller";

const log = getLogger(import.meta.url);

type TimelineSelectionController = ReturnType<
  typeof createTimelineSelectionController
>;

/** Generates an identifier for a locally inserted timeline track. */
function createTrackId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `timeline-track-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** Coordinates local track and action mutations with persistence events. */
export function createTimelineTrackController(
  state: TimelineState,
  selection: TimelineSelectionController,
) {
  const [addPointEvent, setAddPointEvent] = createSignal<AddPointEvent>();
  const [addTrackEvent, setAddTrackEvent] = createSignal<AddTrackEvent>();
  const [lanesChangedEvent, setLanesChangedEvent] = createSignal<{
    trackId: string;
  }>();
  const [removeTrackEvent, setRemoveTrackEvent] =
    createSignal<RemoveTrackEvent>();
  const [renameTrackEvent, setRenameTrackEvent] =
    createSignal<RenameTrackEvent>();
  const [reorderTrackEvent, setReorderTrackEvent] =
    createSignal<ReorderTrackEvent>();
  const [updatePointEvent, setUpdatePointEvent] =
    createSignal<UpdatePointEvent>();
  const [removePointEvent, setRemovePointEvent] =
    createSignal<RemovePointEvent>();
  const [muteEvent, setMuteEvent] = createSignal<MuteEvent>();
  const [soloEvent, setSoloEvent] = createSignal<SoloEvent>();
  const [repositionActionEvent, setRepositionActionEvent] = createSignal<
    RepositionActionEvent | RepositionActionsEvent
  >();
  const [insertActionEvent, setInsertActionEvent] =
    createSignal<InsertActionEvent>();
  const [updateActionEvent, setUpdateActionEvent] =
    createSignal<UpdateActionEvent>();
  const [deleteActionEvent, setDeleteActionEvent] =
    createSignal<DeleteActionEvent>();
  const [openActionEvent] = createSignal<OpenActionEvent>();

  /** Toggles whether a track's details are expanded locally. */
  const toggleTrackExpanded = (trackId: string) => {
    log.debug(`toggling expanded for track ${trackId}`);
    state.setTracks(
      state
        .tracks()
        .map((track) =>
          track.id === trackId
            ? { ...track, expanded: !track.expanded }
            : track,
        ),
    );
  };

  /** Adds a uniquely labelled track and emits its persistence event. */
  const addTrack = (preferredLabel?: string) => {
    const existingTracks = state.tracks();
    const existingLabels = new Set(existingTracks.map((track) => track.label));
    let trackNumber = existingTracks.length + 1;
    let label = preferredLabel ?? `Track ${trackNumber}`;

    while (existingLabels.has(label)) {
      trackNumber += 1;
      label = preferredLabel
        ? `${preferredLabel} ${trackNumber}`
        : `Track ${trackNumber}`;
    }

    const trackId = createTrackId();
    const track: types.Track = {
      id: trackId,
      label,
      muted: false,
      solo: false,
      expanded: false,
      actions: [],
      automation_lanes: [],
    };

    log.debug(`adding track ${trackId}`, { label });
    state.setTracks([...existingTracks, track]);
    setAddTrackEvent({ type: "add-track", trackId });
    return trackId;
  };

  /** Removes a track, clears its selection, and emits its persistence event. */
  const removeTrack = (trackId: string) => {
    const existingTracks = state.tracks();
    if (!existingTracks.some((track) => track.id === trackId)) return;
    log.debug(`removing track ${trackId}`);
    state.setTracks(existingTracks.filter((track) => track.id !== trackId));
    selection.removeTrack(trackId);
    setRemoveTrackEvent({ type: "remove-track", trackId });
  };

  /** Renames an existing track and emits a persistence event. */
  const renameTrack = (trackId: string, label: string) => {
    const nextLabel = label.trim();
    if (nextLabel.length === 0) return;
    const existingTracks = state.tracks();
    const track = existingTracks.find((candidate) => candidate.id === trackId);
    if (!track || track.label === nextLabel) return;
    log.debug(`renaming track ${trackId}`, { label: nextLabel });
    state.setTracks(
      existingTracks.map((candidate) =>
        candidate.id === trackId
          ? { ...candidate, label: nextLabel }
          : candidate,
      ),
    );
    setRenameTrackEvent({ type: "rename-track", trackId, label: nextLabel });
  };

  /** Reorders a track relative to another track and emits a persistence event. */
  const reorderTrack = (
    trackId: string,
    targetTrackId: string,
    placement: TrackReorderPlacement,
  ) => {
    if (trackId === targetTrackId) return;
    const existingTracks = state.tracks();
    const fromIndex = existingTracks.findIndex((track) => track.id === trackId);
    const targetIndex = existingTracks.findIndex(
      (track) => track.id === targetTrackId,
    );
    if (fromIndex === -1 || targetIndex === -1) return;
    let insertIndex = targetIndex + (placement === "after" ? 1 : 0);
    if (insertIndex > fromIndex) insertIndex -= 1;
    if (insertIndex === fromIndex) return;
    const nextTracks = [...existingTracks];
    const [movedTrack] = nextTracks.splice(fromIndex, 1);
    if (!movedTrack) return;
    nextTracks.splice(insertIndex, 0, movedTrack);
    log.debug(`reordering track ${trackId}`, {
      targetTrackId,
      placement,
      fromIndex,
      insertIndex,
    });
    state.setTracks(nextTracks);
    setReorderTrackEvent({
      type: "reorder-track",
      trackId,
      targetTrackId,
      placement,
    });
  };

  /** Toggles a track's muted state and emits a persistence event. */
  const toggleTrackMute = (trackId: string) => {
    let event: MuteEvent | undefined;
    state.setTracks(
      state.tracks().map((track) => {
        if (track.id !== trackId) return track;
        event = { type: "mute", trackId, muted: !track.muted };
        return { ...track, muted: !track.muted };
      }),
    );
    if (event) setMuteEvent(event);
  };

  /** Toggles a track's solo state while clearing solo from sibling tracks. */
  const toggleTrackSolo = (trackId: string) => {
    let event: SoloEvent | undefined;
    state.setTracks(
      state.tracks().map((track) => {
        if (track.id === trackId) {
          event = { type: "solo", trackId, solo: !track.solo };
          return { ...track, solo: !track.solo };
        }
        return track.solo ? { ...track, solo: false } : track;
      }),
    );
    if (event) setSoloEvent(event);
  };

  /** Creates an empty parameter lane and expands its track for point editing. */
  const addLane = (
    trackId: string,
    name: string,
    parameterType: types.ParameterType,
  ) => {
    const track = state.tracks().find((candidate) => candidate.id === trackId);
    if (!track || !name.trim() || !parameterType.data.trim()) return;
    const lane: types.AutomationLane = {
      id: createTrackId(),
      name: name.trim(),
      color: "#60a5fa",
      parameter_type: parameterType,
      points: [],
    };
    state.setTracks(
      state.tracks().map((candidate) =>
        candidate.id === trackId
          ? {
              ...candidate,
              expanded: true,
              automation_lanes: [...candidate.automation_lanes, lane],
            }
          : candidate,
      ),
    );
    setLanesChangedEvent({ trackId });
  };

  /** Deletes a parameter lane and its points while preserving sibling lanes. */
  const removeLane = (trackId: string, laneId: string) => {
    const track = state.tracks().find((candidate) => candidate.id === trackId);
    if (!track?.automation_lanes.some((lane) => lane.id === laneId)) return;
    state.setTracks(
      state.tracks().map((candidate) =>
        candidate.id === trackId
          ? {
              ...candidate,
              automation_lanes: candidate.automation_lanes.filter(
                (lane) => lane.id !== laneId,
              ),
            }
          : candidate,
      ),
    );
    setLanesChangedEvent({ trackId });
  };

  /** Adds an automation point and emits its persistence event. */
  const addPoint = (
    trackId: string,
    automationLaneId: string,
    position: number,
    value: number,
  ) => {
    state.setTracks(
      state.tracks().map((track) =>
        track.id === trackId
          ? {
              ...track,
              automation_lanes: track.automation_lanes.map((automationLane) =>
                automationLane.id === automationLaneId
                  ? {
                      ...automationLane,
                      points: [
                        ...automationLane.points,
                        { position: msToDuration(position), value },
                      ],
                    }
                  : automationLane,
              ),
            }
          : track,
      ),
    );
    setAddPointEvent({
      type: "add-point",
      trackId,
      automationLaneId,
      position,
      value,
    });
  };

  /** Updates an automation point and emits its persistence event. */
  const updatePoint = (
    trackId: string,
    automationLaneId: string,
    pointIndex: number,
    position: number,
    value: number,
  ) => {
    state.setTracks(
      state.tracks().map((track) =>
        track.id === trackId
          ? {
              ...track,
              automation_lanes: track.automation_lanes.map((automationLane) =>
                automationLane.id === automationLaneId
                  ? {
                      ...automationLane,
                      points: automationLane.points.map((point, index) =>
                        index === pointIndex
                          ? {
                              ...point,
                              position: msToDuration(position),
                              value,
                            }
                          : point,
                      ),
                    }
                  : automationLane,
              ),
            }
          : track,
      ),
    );
    setUpdatePointEvent({
      type: "update-point",
      trackId,
      automationLaneId,
      pointIndex,
      position,
      value,
    });
  };

  /** Removes an automation point and emits its persistence event. */
  const removePoint = (
    trackId: string,
    automationLaneId: string,
    pointIndex: number,
  ) => {
    state.setTracks(
      state.tracks().map((track) =>
        track.id === trackId
          ? {
              ...track,
              automation_lanes: track.automation_lanes.map((automationLane) =>
                automationLane.id === automationLaneId
                  ? {
                      ...automationLane,
                      points: automationLane.points.filter(
                        (_, index) => index !== pointIndex,
                      ),
                    }
                  : automationLane,
              ),
            }
          : track,
      ),
    );
    setRemovePointEvent({
      type: "remove-point",
      trackId,
      automationLaneId,
      pointIndex,
    });
  };

  /** Repositions one action and keeps selection track IDs synchronized. */
  const repositionAction = (
    trackId: string,
    actionId: string,
    newPosition: number,
    newTrackId?: string,
  ) => {
    const targetTrackId = newTrackId ?? trackId;
    const currentTracks = state.tracks();
    const nextTracks = moveTimelineAction(currentTracks, {
      trackId,
      actionId,
      newPosition,
      newTrackId,
    });
    state.setTracks(nextTracks);
    if (nextTracks !== currentTracks) {
      selection.repositionAction(trackId, actionId, targetTrackId);
    }
    setRepositionActionEvent({
      type: "reposition-action",
      trackId: newTrackId || trackId,
      actionId,
      newPosition,
      newTrackId: newTrackId || undefined,
    });
  };

  /** Repositions several actions as one local mutation and persistence event. */
  const repositionActions = (actions: MoveTimelineActionOptions[]) => {
    if (actions.length === 0) return;
    const nextTracks = moveTimelineActions(state.tracks(), { moves: actions });
    state.setTracks(nextTracks);
    selection.repositionActions(actions);
    setRepositionActionEvent({ type: "reposition-actions", actions });
  };

  /** Inserts an action and emits the mutation event used for persistence. */
  const insertAction = (
    trackId: string,
    action: types.Action,
    options?: TimelineMutationOptions,
  ) => {
    state.setTracks(
      state
        .tracks()
        .map((track) =>
          track.id === trackId
            ? { ...track, actions: [...track.actions, action] }
            : track,
        ),
    );
    setInsertActionEvent({
      type: "insert-action",
      trackId,
      actionId: action.id,
      batchId: options?.batchId,
    });
  };

  /** Applies a partial action update and emits its persistence event. */
  const updateAction = (
    trackId: string,
    actionId: string,
    patch: Partial<types.Action>,
  ) => {
    state.setTracks(
      state.tracks().map((track) =>
        track.id === trackId
          ? {
              ...track,
              actions: track.actions.map((action) =>
                action.id === actionId ? { ...action, ...patch } : action,
              ),
            }
          : track,
      ),
    );
    setUpdateActionEvent({ type: "update-action", trackId, actionId });
  };

  /** Deletes an action, clears its selection, and emits persistence. */
  const deleteAction = (trackId: string, actionId: string) => {
    state.setTracks(
      state.tracks().map((track) =>
        track.id === trackId
          ? {
              ...track,
              actions: track.actions.filter((action) => action.id !== actionId),
            }
          : track,
      ),
    );
    setDeleteActionEvent({ type: "delete-action", trackId, actionId });
    selection.deleteAction(trackId, actionId);
  };

  return {
    addLane,
    removeLane,
    lanesChangedEvent,
    addTrack,
    removeTrack,
    renameTrack,
    reorderTrack,
    addPoint,
    updatePoint,
    removePoint,
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackExpanded,
    repositionAction,
    repositionActions,
    insertAction,
    updateAction,
    deleteAction,
    addTrackEvent,
    removeTrackEvent,
    renameTrackEvent,
    reorderTrackEvent,
    addPointEvent,
    updatePointEvent,
    removePointEvent,
    muteEvent,
    soloEvent,
    openActionEvent,
    insertActionEvent,
    updateActionEvent,
    deleteActionEvent,
    repositionActionEvent,
  };
}
