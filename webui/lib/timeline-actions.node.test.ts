// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import { moveTimelineAction, moveTimelineActions } from "./timeline-actions";

/** Builds a compact test track for timeline action movement tests. */
function track(id: string, actions: types.Action[]): types.Track {
  return {
    id,
    label: id,
    muted: false,
    solo: false,
    expanded: false,
    actions,
    automation_lanes: [],
  };
}

/** Builds a compact test action for timeline action movement tests. */
function action(id: string, positionMs: number): types.Action {
  return {
    id,
    label: id,
    position: { secs: 0, nanos: positionMs * 1_000_000 },
    duration: { secs: 1, nanos: 0 },
    action: { type: "FireCue", data: "cue-1" },
  };
}

/** Verifies same-track drags only update the moved action's position. */
test("moveTimelineAction repositions an action on the same track", () => {
  const tracks = [track("a", [action("one", 1000), action("two", 2000)])];

  const moved = moveTimelineAction(tracks, {
    trackId: "a",
    actionId: "one",
    newPosition: 3500,
  });

  assert.equal(moved[0]?.actions.length, 2);
  assert.deepEqual(moved[0]?.actions[0]?.position, {
    secs: 3,
    nanos: 500_000_000,
  });
  assert.equal(moved[0]?.actions[1]?.id, "two");
});

/** Verifies cross-track drags remove from the source and append to the target. */
test("moveTimelineAction moves an action between tracks", () => {
  const tracks = [
    track("a", [action("one", 1000)]),
    track("b", [action("two", 2000)]),
  ];

  const moved = moveTimelineAction(tracks, {
    trackId: "a",
    actionId: "one",
    newPosition: 4500,
    newTrackId: "b",
  });

  assert.deepEqual(
    moved.find((entry) => entry.id === "a")?.actions.map((entry) => entry.id),
    [],
  );
  assert.deepEqual(
    moved.find((entry) => entry.id === "b")?.actions.map((entry) => entry.id),
    ["two", "one"],
  );
  assert.deepEqual(moved[1]?.actions[1]?.position, {
    secs: 4,
    nanos: 500_000_000,
  });
});

/** Verifies grouped drags can move several selected actions in one state update. */
test("moveTimelineActions moves multiple actions as a group", () => {
  const tracks = [
    track("a", [action("one", 1000), action("two", 2000)]),
    track("b", [action("three", 3000)]),
  ];

  const moved = moveTimelineActions(tracks, {
    moves: [
      {
        trackId: "a",
        actionId: "one",
        newPosition: 4000,
        newTrackId: "b",
      },
      {
        trackId: "a",
        actionId: "two",
        newPosition: 5000,
        newTrackId: "b",
      },
    ],
  });

  assert.deepEqual(
    moved.find((entry) => entry.id === "a")?.actions.map((entry) => entry.id),
    [],
  );
  assert.deepEqual(
    moved.find((entry) => entry.id === "b")?.actions.map((entry) => entry.id),
    ["three", "one", "two"],
  );
  assert.deepEqual(moved[1]?.actions[1]?.position, {
    secs: 4,
    nanos: 0,
  });
  assert.deepEqual(moved[1]?.actions[2]?.position, {
    secs: 5,
    nanos: 0,
  });
});
