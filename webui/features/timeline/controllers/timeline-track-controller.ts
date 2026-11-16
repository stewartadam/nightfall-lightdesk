// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createSignal, untrack } from "solid-js";
import { getLogger } from "../../../lib/logger";
import {
  type MoveTimelineActionOptions,
  moveTimelineActions,
} from "../../../lib/timeline-actions";
import { msToDuration } from "../../../lib/utils";
import type * as types from "../../../types";
import type {
  OpenActionEvent,
  TimelineMutationOptions,
  TrackReorderPlacement,
} from "../context/timeline-context-contract";
import {
  expandedTimelineTracks,
  setTrackExpanded,
} from "../state/expanded-tracks";
import type { TimelineEdits } from "./timeline-edits";
import type { createTimelineSelectionController } from "./timeline-selection-controller";

const log = getLogger(import.meta.url);

type TimelineSelectionController = ReturnType<
  typeof createTimelineSelectionController
>;

/** Generates an identifier for a new timeline track or automation lane. */
function createTrackId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `timeline-track-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** Returns a copy of the timeline with one track replaced by `update(track)`. */
function updateTrackIn(
  timeline: types.Timeline,
  trackId: string,
  update: (track: types.Track) => types.Track,
): types.Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.id === trackId ? update(track) : track,
    ),
  };
}

/**
 * Returns a copy of `items` with the entry sharing `item`'s ID replaced, or `item` appended
 * when none does, so applying it twice gives the same list (as unconfirmed patches require).
 */
function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((existing) => existing.id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item];
}

/** Returns a copy of the timeline with one automation lane set to `lane`, added if missing. */
function storeLaneIn(
  timeline: types.Timeline,
  trackId: string,
  lane: types.AutomationLane,
): types.Timeline {
  return updateTrackIn(timeline, trackId, (track) => ({
    ...track,
    automation_lanes: upsertById(track.automation_lanes, lane),
  }));
}

/** Returns a copy of the timeline with `action` stored on its track, added if missing. */
function storeActionIn(
  timeline: types.Timeline,
  trackId: string,
  action: types.Action,
): types.Timeline {
  return updateTrackIn(timeline, trackId, (track) => ({
    ...track,
    actions: upsertById(track.actions, action),
  }));
}

/**
 * Turns UI track and action operations into granular timeline edits. Each operation sends one
 * `EditTimeline` command that names only what it changes, and shows the change at once through
 * an unconfirmed patch over the engine's timeline.
 */
export function createTimelineTrackController(
  edits: TimelineEdits,
  selection: TimelineSelectionController,
) {
  const [openActionEvent] = createSignal<OpenActionEvent>();

  /** Returns the tracks as currently shown, including unconfirmed edits. */
  const currentTracks = () => untrack(edits.timeline)?.tracks ?? [];

  /** Returns one shown track by ID. */
  const findTrack = (trackId: string) =>
    currentTracks().find((track) => track.id === trackId);

  /** Sends a change to some of one track's own settings. */
  const updateTrack = (
    trackId: string,
    settings: types.TrackSetting[],
    apply: (track: types.Track) => types.Track,
  ) => {
    edits.edit(
      [{ type: "UpdateTrack", data: { track_id: trackId, settings } }],
      (timeline) => updateTrackIn(timeline, trackId, apply),
    );
  };

  /** IDs of the tracks this device shows expanded, tracked reactively. */
  const $expandedTracks = useStore(expandedTimelineTracks);

  /** Whether this device shows the track's automation lanes; reactive. */
  const isTrackExpanded = (trackId: string) =>
    $expandedTracks().includes(trackId);

  /**
   * Expands or collapses a track's automation lanes on this device only. It is a view choice,
   * so nothing is sent to the engine and other clients keep their own.
   */
  const toggleTrackExpanded = (trackId: string) => {
    const expanded = !untrack(() => isTrackExpanded(trackId));
    log.debug(`setting expanded=${expanded} for track ${trackId}`);
    setTrackExpanded(trackId, expanded);
  };

  /** Adds a uniquely labelled empty track at the end and returns its ID. */
  const addTrack = (preferredLabel?: string) => {
    const existingTracks = currentTracks();
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
      actions: [],
      automation_lanes: [],
    };

    log.debug(`adding track ${trackId}`, { label });
    edits.edit([{ type: "InsertTrack", data: { track } }], (timeline) =>
      timeline.tracks.some((existing) => existing.id === trackId)
        ? timeline
        : { ...timeline, tracks: [...timeline.tracks, track] },
    );
    return trackId;
  };

  /** Removes a track with its actions and lanes, and clears its selection. */
  const removeTrack = (trackId: string) => {
    if (!findTrack(trackId)) return;
    log.debug(`removing track ${trackId}`);
    edits.edit(
      [{ type: "DeleteTrack", data: { track_id: trackId } }],
      (timeline) => ({
        ...timeline,
        tracks: timeline.tracks.filter((track) => track.id !== trackId),
      }),
    );
    selection.removeTrack(trackId);
  };

  /** Renames a track; blank names and unchanged names are ignored. */
  const renameTrack = (trackId: string, label: string) => {
    const nextLabel = label.trim();
    if (nextLabel.length === 0) return;
    const track = findTrack(trackId);
    if (!track || track.label === nextLabel) return;
    log.debug(`renaming track ${trackId}`, { label: nextLabel });
    updateTrack(trackId, [{ type: "Label", data: nextLabel }], (current) => ({
      ...current,
      label: nextLabel,
    }));
  };

  /** Moves a track before or after another track. */
  const reorderTrack = (
    trackId: string,
    targetTrackId: string,
    placement: TrackReorderPlacement,
  ) => {
    if (trackId === targetTrackId) return;
    const others = currentTracks().filter((track) => track.id !== trackId);
    const targetIndex = others.findIndex((track) => track.id === targetTrackId);
    if (targetIndex === -1 || !findTrack(trackId)) return;
    const beforeTrackId =
      placement === "before" ? targetTrackId : others[targetIndex + 1]?.id;
    const tracks = currentTracks();
    const currentNext =
      tracks[tracks.findIndex((track) => track.id === trackId) + 1];
    if (currentNext?.id === beforeTrackId) return;
    log.debug(`reordering track ${trackId}`, { targetTrackId, placement });
    edits.edit(
      [
        {
          type: "MoveTrack",
          data: { track_id: trackId, before_track_id: beforeTrackId },
        },
      ],
      (timeline) => {
        const moved = timeline.tracks.find((track) => track.id === trackId);
        if (!moved) return timeline;
        const rest = timeline.tracks.filter((track) => track.id !== trackId);
        const index = beforeTrackId
          ? rest.findIndex((track) => track.id === beforeTrackId)
          : -1;
        return {
          ...timeline,
          tracks:
            index === -1
              ? [...rest, moved]
              : [...rest.slice(0, index), moved, ...rest.slice(index)],
        };
      },
    );
  };

  /** Toggles whether a track is muted. */
  const toggleTrackMute = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track) return;
    const muted = !track.muted;
    updateTrack(trackId, [{ type: "Muted", data: muted }], (current) => ({
      ...current,
      muted,
    }));
  };

  /** Toggles a track's solo, clearing solo from every other track in the same undo step. */
  const toggleTrackSolo = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track) return;
    const solo = !track.solo;
    const unsoloed = currentTracks()
      .filter((candidate) => candidate.id !== trackId && candidate.solo)
      .map((candidate) => candidate.id);
    edits.edit(
      [
        {
          type: "UpdateTrack",
          data: { track_id: trackId, settings: [{ type: "Solo", data: solo }] },
        },
        ...unsoloed.map(
          (id): types.TimelineEdit => ({
            type: "UpdateTrack",
            data: { track_id: id, settings: [{ type: "Solo", data: false }] },
          }),
        ),
      ],
      (timeline) => ({
        ...timeline,
        tracks: timeline.tracks.map((candidate) =>
          candidate.id === trackId
            ? { ...candidate, solo }
            : unsoloed.includes(candidate.id)
              ? { ...candidate, solo: false }
              : candidate,
        ),
      }),
    );
  };

  /** Stores a new version of one automation lane, showing it until confirmed. */
  const storeLane = (trackId: string, lane: types.AutomationLane) => {
    edits.edit(
      [{ type: "StoreAutomationLane", data: { track_id: trackId, lane } }],
      (timeline) => storeLaneIn(timeline, trackId, lane),
    );
  };

  /** Creates an empty parameter lane and expands its track for point editing. */
  const addLane = (
    trackId: string,
    name: string,
    parameterType: types.ParameterType,
  ) => {
    const track = findTrack(trackId);
    if (!track || !name.trim() || !parameterType.data.trim()) return;
    const lane: types.AutomationLane = {
      id: createTrackId(),
      name: name.trim(),
      color: "#60a5fa",
      parameter_type: parameterType,
      points: [],
    };
    edits.edit(
      [{ type: "StoreAutomationLane", data: { track_id: trackId, lane } }],
      (timeline) => storeLaneIn(timeline, trackId, lane),
    );
    setTrackExpanded(trackId, true);
  };

  /** Deletes a parameter lane and its points, keeping the track's other lanes. */
  const removeLane = (trackId: string, laneId: string) => {
    const track = findTrack(trackId);
    if (!track?.automation_lanes.some((lane) => lane.id === laneId)) return;
    edits.edit(
      [
        {
          type: "DeleteAutomationLane",
          data: { track_id: trackId, lane_id: laneId },
        },
      ],
      (timeline) =>
        updateTrackIn(timeline, trackId, (current) => ({
          ...current,
          automation_lanes: current.automation_lanes.filter(
            (lane) => lane.id !== laneId,
          ),
        })),
    );
  };

  /** Stores a lane whose points are `updatePoints` applied to the shown lane's points. */
  const editLanePoints = (
    trackId: string,
    automationLaneId: string,
    updatePoints: (points: types.AutomationPoint[]) => types.AutomationPoint[],
  ) => {
    const lane = findTrack(trackId)?.automation_lanes.find(
      (candidate) => candidate.id === automationLaneId,
    );
    if (!lane) return;
    storeLane(trackId, { ...lane, points: updatePoints(lane.points) });
  };

  /** Adds an automation point to a lane. */
  const addPoint = (
    trackId: string,
    automationLaneId: string,
    position: number,
    value: number,
  ) => {
    editLanePoints(trackId, automationLaneId, (points) => [
      ...points,
      { position: msToDuration(position), value },
    ]);
  };

  /** Moves an automation point and changes its value. */
  const updatePoint = (
    trackId: string,
    automationLaneId: string,
    pointIndex: number,
    position: number,
    value: number,
  ) => {
    editLanePoints(trackId, automationLaneId, (points) =>
      points.map((point, index) =>
        index === pointIndex
          ? { ...point, position: msToDuration(position), value }
          : point,
      ),
    );
  };

  /** Removes an automation point from a lane. */
  const removePoint = (
    trackId: string,
    automationLaneId: string,
    pointIndex: number,
  ) => {
    editLanePoints(trackId, automationLaneId, (points) =>
      points.filter((_, index) => index !== pointIndex),
    );
  };

  /** Moves actions to new positions and tracks, keeping their selection in step. */
  const repositionActions = (actions: MoveTimelineActionOptions[]) => {
    if (actions.length === 0) return;
    edits.edit(
      [
        {
          type: "MoveActions",
          data: {
            moves: actions.map((move) => ({
              track_id: move.trackId,
              action_id: move.actionId,
              position: msToDuration(move.newPosition),
              to_track_id:
                move.newTrackId && move.newTrackId !== move.trackId
                  ? move.newTrackId
                  : undefined,
            })),
          },
        },
      ],
      (timeline) => ({
        ...timeline,
        tracks: moveTimelineActions(timeline.tracks, { moves: actions }),
      }),
    );
    selection.repositionActions(actions);
  };

  /** Moves one action to a new position, and optionally onto another track. */
  const repositionAction = (
    trackId: string,
    actionId: string,
    newPosition: number,
    newTrackId?: string,
  ) => {
    if (!findTrack(trackId)?.actions.some((action) => action.id === actionId)) {
      return;
    }
    if (newTrackId && !findTrack(newTrackId)) return;
    repositionActions([{ trackId, actionId, newPosition, newTrackId }]);
  };

  /** Adds an action to a track; a shared batch ID makes several inserts one undo step. */
  const insertAction = (
    trackId: string,
    action: types.Action,
    options?: TimelineMutationOptions,
  ) => {
    edits.edit(
      [
        {
          type: "ChangeActions",
          data: { store: [{ track_id: trackId, action }], delete: [] },
        },
      ],
      (timeline) => storeActionIn(timeline, trackId, action),
      { undoId: options?.batchId },
    );
  };

  /** Changes some fields of an action. */
  const updateAction = (
    trackId: string,
    actionId: string,
    patch: Partial<types.Action>,
  ) => {
    const action = findTrack(trackId)?.actions.find(
      (candidate) => candidate.id === actionId,
    );
    if (!action) return;
    const updated = { ...action, ...patch };
    edits.edit(
      [
        {
          type: "ChangeActions",
          data: { store: [{ track_id: trackId, action: updated }], delete: [] },
        },
      ],
      (timeline) => storeActionIn(timeline, trackId, updated),
    );
  };

  /** Deletes an action and clears its selection. */
  const deleteAction = (trackId: string, actionId: string) => {
    edits.edit(
      [
        {
          type: "ChangeActions",
          data: {
            store: [],
            delete: [{ track_id: trackId, action_id: actionId }],
          },
        },
      ],
      (timeline) =>
        updateTrackIn(timeline, trackId, (track) => ({
          ...track,
          actions: track.actions.filter((action) => action.id !== actionId),
        })),
    );
    selection.deleteAction(trackId, actionId);
  };

  return {
    addLane,
    removeLane,
    addTrack,
    removeTrack,
    renameTrack,
    reorderTrack,
    addPoint,
    updatePoint,
    removePoint,
    toggleTrackMute,
    toggleTrackSolo,
    isTrackExpanded,
    toggleTrackExpanded,
    repositionAction,
    repositionActions,
    insertAction,
    updateAction,
    deleteAction,
    openActionEvent,
  };
}
