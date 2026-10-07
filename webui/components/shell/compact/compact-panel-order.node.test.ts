// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { moveCompactPanel, orderCompactPanelIds } from "./compact-panel-order";

/** Saved positions win, and panels opened since keep their workspace order at the end. */
test("orderCompactPanelIds applies the saved order and appends new panels", () => {
  assert.deepEqual(
    orderCompactPanelIds(["a", "b", "c", "d"], ["c", "gone", "a"]),
    ["c", "a", "b", "d"],
  );
});

/** Dragging a panel into the first slots pins it and pushes the last pin out. */
test("moveCompactPanel reorders open panels", () => {
  assert.deepEqual(moveCompactPanel(["a", "b", "c", "d", "e"], [], "e", 1), [
    "a",
    "e",
    "b",
    "c",
    "d",
  ]);
  assert.deepEqual(moveCompactPanel(["a", "b", "c"], [], "a", 99), [
    "b",
    "c",
    "a",
  ]);
});

/** Closed panels keep their saved slot so reopening restores their pin. */
test("moveCompactPanel keeps closed panels in their saved slots", () => {
  const saved = moveCompactPanel(
    ["a", "b", "c", "d"],
    ["x", "a", "b", "c", "d", "y"],
    "d",
    2,
  );
  assert.deepEqual(saved, ["x", "a", "b", "d", "c", "y"]);
  // Reopening x puts it back in the first tab.
  assert.deepEqual(orderCompactPanelIds(["a", "b", "c", "d", "x"], saved), [
    "x",
    "a",
    "b",
    "d",
    "c",
  ]);
});

/** Panels missing from the saved order are recorded where they currently show. */
test("moveCompactPanel records panels the saved order does not know yet", () => {
  assert.deepEqual(moveCompactPanel(["a", "b", "c"], ["z", "b"], "a", 2), [
    "z",
    "b",
    "c",
    "a",
  ]);
});
