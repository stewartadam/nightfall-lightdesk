// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUndoTimelineAge,
  smoothStatusMetric,
  type UndoTimelineEntry,
  undoTimelineActionLabel,
} from "./model";

/** Verifies metric smoothing handles initial, ordinary, and invalid samples. */
test("smoothStatusMetric stabilizes status-bar samples", () => {
  assert.equal(smoothStatusMetric(0, 60), 60);
  assert.equal(smoothStatusMetric(40, 80), 50);
  assert.equal(smoothStatusMetric(40, Number.NaN), 40);
});

/** Verifies undo timeline labels preserve branch and command-count semantics. */
test("undoTimelineActionLabel identifies branch-preserving undo entries", () => {
  const item = {
    kind: "undo",
    entry: {
      undo_id: "undo",
      description: "Edit",
      entry_count: 2,
      is_gurq_preserved: true,
      order: 0,
      age_ms: 0,
    },
    receivedAtMs: 0,
  } as UndoTimelineEntry;
  assert.equal(undoTimelineActionLabel(item), "REDO BRANCH [2x]");
});

/** Verifies compact age formatting keeps the immediate state readable. */
test("formatUndoTimelineAge renders immediate entries as now", () => {
  assert.equal(formatUndoTimelineAge(0), "now");
});
