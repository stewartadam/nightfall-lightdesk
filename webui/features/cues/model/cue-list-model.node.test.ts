// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Cue, Sequence } from "../../../types";
import {
  buildCueGridOrder,
  buildCueGroups,
  buildCueListRows,
  groupCueData,
} from "./cue-list-model";

/** Builds the cue fields consumed by cue-list projection tests. */
function cue(uid: string, id: number, label: string): Cue {
  return { identifiers: { uid, id, label } } as unknown as Cue;
}

/** Builds the sequence fields consumed by cue-list projection tests. */
function sequence(uid: string, id: number, steps: string[]): Sequence {
  return {
    identifiers: { uid, id, label: `Sequence ${id}` },
    steps,
  } as unknown as Sequence;
}

/** Verifies grouped projection preserves sequence order and sorts ungrouped cues. */
test("groups cues by sequence and sorts ungrouped cues", () => {
  const cues = {
    a: cue("a", 3, "A"),
    b: cue("b", 1, "B"),
    c: cue("c", 2, "C"),
  };
  const grouped = groupCueData(
    cues,
    { seq: sequence("seq", 7, ["c", "a"]) },
    () => true,
  );
  assert.deepEqual(
    grouped.sequencesWithCues[0]?.cues.map((entry) => entry.identifiers.uid),
    ["c", "a"],
  );
  assert.deepEqual(
    grouped.ungroupedCues.map((entry) => entry.identifiers.uid),
    ["b"],
  );
  assert.deepEqual(buildCueGridOrder(grouped), ["c", "a", "b"]);
});

/** Verifies collapsed groups retain summaries while omitting their cue rows. */
test("builds collapsed cue list rows", () => {
  const grouped = groupCueData(
    { a: cue("a", 1, "A") },
    { seq: sequence("seq", 7, ["a"]) },
    () => true,
  );
  const groups = buildCueGroups(grouped);
  const rows = buildCueListRows(groups, new Set(["sequence-seq"]));
  assert.deepEqual(rows, [
    {
      rowKind: "group",
      groupKey: "sequence-seq",
      title: "Sequence 7: Sequence 7",
      sequenceId: 7,
      cueCount: 1,
      isCollapsed: true,
    },
  ]);
});
