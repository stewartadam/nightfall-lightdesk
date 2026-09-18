// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { msToDuration } from "./utils";

export type MoveTimelineActionOptions = {
  trackId: string;
  actionId: string;
  newPosition: number;
  newTrackId?: string;
};

export type MoveTimelineActionsOptions = {
  moves: MoveTimelineActionOptions[];
};

/** Moves a timeline action to a new position and optional target track. */
export function moveTimelineAction(
  tracks: types.Track[],
  options: MoveTimelineActionOptions,
): types.Track[] {
  return moveTimelineActions(tracks, { moves: [options] });
}

/** Moves multiple timeline actions while preserving their same-track order. */
export function moveTimelineActions(
  tracks: types.Track[],
  options: MoveTimelineActionsOptions,
): types.Track[] {
  const trackIds = new Set(tracks.map((track) => track.id));
  const validMoves = options.moves.filter((move) => {
    const targetTrackId = move.newTrackId ?? move.trackId;
    const sourceTrack = tracks.find((track) => track.id === move.trackId);
    return (
      trackIds.has(targetTrackId) &&
      sourceTrack?.actions.some((action) => action.id === move.actionId)
    );
  });

  if (validMoves.length === 0) {
    return tracks;
  }

  const moveBySourceKey = new Map(
    validMoves.map((move) => [`${move.trackId}:${move.actionId}`, move]),
  );
  const additionsByTrackId = new Map<string, types.Action[]>();

  for (const move of validMoves) {
    const targetTrackId = move.newTrackId ?? move.trackId;
    if (targetTrackId === move.trackId) continue;

    const sourceTrack = tracks.find((track) => track.id === move.trackId);
    const sourceItem = sourceTrack?.actions.find(
      (action) => action.id === move.actionId,
    );
    if (!sourceItem) continue;

    const movedItem = {
      ...sourceItem,
      position: msToDuration(move.newPosition),
    };
    additionsByTrackId.set(targetTrackId, [
      ...(additionsByTrackId.get(targetTrackId) ?? []),
      movedItem,
    ]);
  }

  return tracks.map((track) => {
    const actions = track.actions.flatMap((action) => {
      const move = moveBySourceKey.get(`${track.id}:${action.id}`);
      if (!move) return [action];

      const targetTrackId = move.newTrackId ?? move.trackId;
      if (targetTrackId !== track.id) {
        return [];
      }

      return [
        {
          ...action,
          position: msToDuration(move.newPosition),
        },
      ];
    });

    return {
      ...track,
      actions: [...actions, ...(additionsByTrackId.get(track.id) ?? [])],
    };
  });
}
