// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTimelineInsertDragPayload,
  serializeTimelineInsertDragPayload,
} from "./timeline-insert-drag";

test("parseTimelineInsertDragPayload parses valid cue payload", () => {
  const raw = serializeTimelineInsertDragPayload({
    source: "cue",
    actionType: "FireCue",
    targetUid: "cue-uid-1",
    targetLabel: "Cue 1: Intro",
  });

  assert.deepEqual(parseTimelineInsertDragPayload(raw), {
    source: "cue",
    actionType: "FireCue",
    targetUid: "cue-uid-1",
    targetLabel: "Cue 1: Intro",
    cueIndex: undefined,
  });
});

test("parseTimelineInsertDragPayload rejects invalid payload shape", () => {
  assert.equal(parseTimelineInsertDragPayload("{}"), undefined);
  assert.equal(
    parseTimelineInsertDragPayload(
      JSON.stringify({
        source: "clip",
        actionType: "StoreCue",
        targetUid: "exec-uid-1",
        targetLabel: "Exec 1",
      }),
    ),
    undefined,
  );
});
