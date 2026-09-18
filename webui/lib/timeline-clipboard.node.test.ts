// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import {
  copySelectedTimelineActions,
  copySelectedTimelineMarkers,
  pasteTimelineClipboardEntries,
} from "./timeline-clipboard";
import { msToDuration } from "./utils";

/** Builds a test marker at a millisecond position. */
function marker(uid: string, positionMs: number): types.TimelineMarker {
  return {
    uid,
    label: uid,
    time: msToDuration(positionMs),
    color: "#facc15",
  };
}

/** Builds a test action at a millisecond position. */
function action(id: string, positionMs: number): types.Action {
  return {
    id,
    label: id,
    position: msToDuration(positionMs),
    duration: msToDuration(1000),
    action: { type: "FireCue", data: "cue-1" },
  };
}

/** Converts a duration into milliseconds for terse assertions. */
function durationMs(duration: types.Duration): number {
  return duration.secs * 1000 + Math.floor(duration.nanos / 1_000_000);
}

test("pasteTimelineClipboardEntries anchors pasted markers at the playhead", () => {
  const copied = copySelectedTimelineMarkers(
    [marker("late", 4000), marker("early", 1000)],
    ["early", "late"],
  );
  let nextId = 0;

  const pasted = pasteTimelineClipboardEntries(
    copied,
    5000,
    () => `copy-${++nextId}`,
  );

  assert.deepEqual(
    pasted.markers.map((entry) => [entry.uid, durationMs(entry.time)]),
    [
      ["copy-1", 5000],
      ["copy-2", 8000],
    ],
  );
  assert.deepEqual(pasted.actions, []);
});

test("copySelectedTimelineActions preserves selected track order and spacing", () => {
  const tracks: types.Track[] = [
    {
      id: "track-a",
      label: "Track A",
      muted: false,
      solo: false,
      expanded: false,
      actions: [action("a-late", 4000), action("a-early", 1000)],
      automation_lanes: [],
    },
  ];
  const copied = copySelectedTimelineActions(tracks, [
    { trackId: "track-a", actionId: "a-early" },
    { trackId: "track-a", actionId: "a-late" },
  ]);
  let nextId = 0;

  const pasted = pasteTimelineClipboardEntries(
    copied,
    9000,
    () => `action-copy-${++nextId}`,
  );

  assert.deepEqual(
    pasted.actions.map(({ trackId, action }) => [
      trackId,
      action.id,
      durationMs(action.position),
      durationMs(action.duration),
    ]),
    [
      ["track-a", "action-copy-1", 9000, 1000],
      ["track-a", "action-copy-2", 12000, 1000],
    ],
  );
  assert.notStrictEqual(
    pasted.actions[0]?.action.duration,
    tracks[0]?.actions[1]?.duration,
  );
  assert.deepEqual(pasted.markers, []);
});

test("pasteTimelineClipboardEntries fills missing legacy action durations", () => {
  const legacyItem = action("legacy", 1000);
  delete (legacyItem as Partial<types.Action>).duration;
  const pasted = pasteTimelineClipboardEntries(
    [
      {
        type: "action",
        trackId: "track-a",
        action: legacyItem,
        positionMs: 1000,
      },
    ],
    2000,
    () => "legacy-copy",
  );

  assert.equal(durationMs(pasted.actions[0]?.action.duration), 1000);
});
