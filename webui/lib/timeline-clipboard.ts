// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { durationToMs, msToDuration } from "./utils";

const DEFAULT_PASTED_ACTION_DURATION_MS = 1000;

export type TimelineClipboardMarkerEntry = {
  type: "marker";
  marker: types.TimelineMarker;
  positionMs: number;
};

export type TimelineClipboardActionEntry = {
  type: "action";
  trackId: string;
  action: types.Action;
  positionMs: number;
};

export type TimelineClipboardEntry =
  | TimelineClipboardMarkerEntry
  | TimelineClipboardActionEntry;

export type PastedTimelineEntries = {
  markers: types.TimelineMarker[];
  actions: Array<{ trackId: string; action: types.Action }>;
};

/** Returns a stable copy of the selected timeline markers in timeline order. */
export function copySelectedTimelineMarkers(
  markers: types.TimelineMarker[],
  selectedMarkerUids: string[],
): TimelineClipboardMarkerEntry[] {
  if (selectedMarkerUids.length === 0) return [];
  const selectedUids = new Set(selectedMarkerUids);
  return markers
    .filter((marker) => selectedUids.has(marker.uid))
    .map((marker, index) => ({ marker, index }))
    .sort((left, right) => {
      const positionDelta =
        durationToMs(left.marker.time) - durationToMs(right.marker.time);
      return positionDelta === 0 ? left.index - right.index : positionDelta;
    })
    .map(({ marker }) => ({
      type: "marker" as const,
      marker: { ...marker },
      positionMs: durationToMs(marker.time),
    }));
}

/** Returns a stable copy of the selected timeline actions in track/time order. */
export function copySelectedTimelineActions(
  tracks: types.Track[],
  selectedActions: Array<{ trackId: string; actionId: string }>,
): TimelineClipboardActionEntry[] {
  if (selectedActions.length === 0) return [];
  const selectedKeys = new Set(
    selectedActions.map((selection) =>
      JSON.stringify([selection.trackId, selection.actionId]),
    ),
  );
  return tracks.flatMap((track, trackIndex) =>
    track.actions
      .map((action, itemIndex) => ({ action, itemIndex, track, trackIndex }))
      .filter(({ action }) =>
        selectedKeys.has(JSON.stringify([track.id, action.id])),
      )
      .sort((left, right) => {
        const positionDelta =
          durationToMs(left.action.position) -
          durationToMs(right.action.position);
        return positionDelta === 0
          ? left.itemIndex - right.itemIndex
          : positionDelta;
      })
      .map(({ action, track }) => ({
        type: "action" as const,
        trackId: track.id,
        action: { ...action, action: { ...action.action } },
        positionMs: durationToMs(action.position),
        trackIndex,
      })),
  );
}

/** Returns the earliest position in a timeline clipboard payload. */
function timelineClipboardStartMs(
  entries: TimelineClipboardEntry[],
): number | undefined {
  if (entries.length === 0) return undefined;
  return Math.min(...entries.map((entry) => entry.positionMs));
}

/** Creates pasted timeline objects anchored at the supplied playhead position. */
export function pasteTimelineClipboardEntries(
  entries: TimelineClipboardEntry[],
  playheadMs: number,
  createId: () => string,
): PastedTimelineEntries {
  const clipboardStartMs = timelineClipboardStartMs(entries);
  if (clipboardStartMs === undefined) {
    return { markers: [], actions: [] };
  }

  const anchorMs = Math.max(0, Math.round(playheadMs));
  const positionForEntry = (entry: TimelineClipboardEntry) =>
    msToDuration(
      Math.max(0, Math.round(anchorMs + entry.positionMs - clipboardStartMs)),
    );

  return entries.reduce<PastedTimelineEntries>(
    (pasted, entry) => {
      if (entry.type === "marker") {
        pasted.markers.push({
          ...entry.marker,
          uid: createId(),
          time: positionForEntry(entry),
        });
      } else {
        pasted.actions.push({
          trackId: entry.trackId,
          action: {
            ...entry.action,
            id: createId(),
            position: positionForEntry(entry),
            duration: msToDuration(
              durationToMs(
                entry.action.duration ??
                  msToDuration(DEFAULT_PASTED_ACTION_DURATION_MS),
              ),
            ),
            action: { ...entry.action.action },
          },
        });
      }
      return pasted;
    },
    { markers: [], actions: [] },
  );
}
