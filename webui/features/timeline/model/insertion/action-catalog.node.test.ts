// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../../types";
import {
  buildActionKind,
  getDefaultTargetForAction,
  getTargetsForAction,
  resolveTrackCompatibility,
} from "./action-catalog";

/** Builds shared action target fixtures for action catalog tests. */
function buildTargets() {
  return {
    cueTargets: [
      { uid: "cue-1", label: "Cue 1" },
      { uid: "cue-2", label: "Cue 2" },
    ],
    clipTargets: [{ uid: "exec-1", label: "Exec 1" }],
    sequenceCueTargets: [
      { uid: "exec-1", label: "Seq 1.2: Cue 2", cueIndex: 2 },
    ],
  };
}

/** Verifies defaults come from the target family used by the action. */
test("getDefaultTargetForAction picks first target in action family", () => {
  const targets = buildTargets();

  assert.deepEqual(getDefaultTargetForAction("FireCue", targets), {
    uid: "cue-1",
    label: "Cue 1",
  });
  assert.deepEqual(getDefaultTargetForAction("StartClip", targets), {
    uid: "exec-1",
    label: "Exec 1",
  });
  assert.deepEqual(getDefaultTargetForAction("SetClipRate", targets), {
    uid: "exec-1",
    label: "Exec 1",
  });
  assert.deepEqual(getDefaultTargetForAction("JumpToCue", targets), {
    uid: "exec-1",
    label: "Seq 1.2: Cue 2",
    cueIndex: 2,
  });
});

/** Verifies jump-to-cue uses sequence cue targets instead of raw clips. */
test("getTargetsForAction resolves JumpToCue to sequence cue targets", () => {
  const targets = buildTargets();

  assert.equal(
    getTargetsForAction("JumpToCue", targets),
    targets.sequenceCueTargets,
  );
});

/** Verifies JumpToCue action data keeps cue indexes inside valid bounds. */
test("buildActionKind clamps JumpToCue cue index to >= 1", () => {
  const action = buildActionKind("JumpToCue", "exec-1", 0);
  assert.deepEqual(action, {
    type: "JumpToCue",
    data: {
      uid: "exec-1",
      cue_index: 1,
    },
  });
});

/** Verifies clip rate actions target clips and store normalized rates. */
test("buildActionKind creates SetClipRate actions", () => {
  assert.equal(getTargetsForAction("SetClipRate", buildTargets()).length, 1);

  const action = buildActionKind("SetClipRate", "exec-1", 1, 2.5);
  assert.deepEqual(action, {
    type: "SetClipRate",
    data: {
      uid: "exec-1",
      rate: 2.5,
    },
  });
});

/** Verifies DeskEval stores the command string directly on the timeline action. */
test("buildActionKind creates DeskEval command actions", () => {
  const action = buildActionKind("DeskEval", " group 1 at 50 ");
  assert.deepEqual(action, {
    type: "DeskEval",
    data: "group 1 at 50",
  });
});

/** Verifies mixed cue and clip actions produce a compatibility warning. */
test("resolveTrackCompatibility warns when inserting mismatched family", () => {
  const track: types.Track = {
    id: "track-1",
    label: "Track 1",
    muted: false,
    solo: false,
    expanded: false,
    actions: [
      {
        id: "action-1",
        label: "Cue Action",
        position: { secs: 0, nanos: 0 },
        duration: { secs: 1, nanos: 0 },
        action: { type: "FireCue", data: "cue-1" },
      },
    ],
    automation_lanes: [],
  };

  assert.equal(resolveTrackCompatibility(track, "FireCue"), "compatible");
  assert.equal(resolveTrackCompatibility(track, "StartClip"), "warning");
});
