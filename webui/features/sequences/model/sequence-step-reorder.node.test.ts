// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  moveSequenceStepsByRows,
  reorderSequenceSteps,
} from "./sequence-step-reorder";

/** Verifies one cue can move between valid sequence rows. */
test("reorderSequenceSteps moves one cue without mutating input", () => {
  const steps = ["a", "b", "c"];
  assert.deepEqual(reorderSequenceSteps(steps, 0, 2), ["b", "c", "a"]);
  assert.deepEqual(steps, ["a", "b", "c"]);
});

/** Verifies invalid or unchanged moves preserve the original array identity. */
test("reorderSequenceSteps ignores invalid moves", () => {
  const steps = ["a", "b"];
  assert.equal(reorderSequenceSteps(steps, -1, 1), steps);
  assert.equal(reorderSequenceSteps(steps, 0, 2), steps);
  assert.equal(reorderSequenceSteps(steps, 1, 1), steps);
});

/** Verifies adjacent selected rows move together in either direction. */
test("moveSequenceStepsByRows preserves grouped row order", () => {
  const steps = ["a", "b", "c", "d"];
  assert.deepEqual(moveSequenceStepsByRows(steps, [1, 2], -1), [
    "b",
    "c",
    "a",
    "d",
  ]);
  assert.deepEqual(moveSequenceStepsByRows(steps, [1, 2], 1), [
    "a",
    "d",
    "b",
    "c",
  ]);
});

/** Verifies row movement stops when the selection reaches an outer boundary. */
test("moveSequenceStepsByRows ignores boundary moves", () => {
  const steps = ["a", "b", "c"];
  assert.equal(moveSequenceStepsByRows(steps, [0], -1), steps);
  assert.equal(moveSequenceStepsByRows(steps, [2], 1), steps);
});
