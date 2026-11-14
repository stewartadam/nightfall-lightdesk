// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { automationLinePath } from "./automation-path";

const points = [
  { x: 0, y: 60 },
  { x: 10, y: 30 },
  { x: 20, y: 0 },
];

/** Verifies an idle lane joins every point in order, and an empty lane draws nothing. */
test("automationLinePath joins points in order", () => {
  assert.equal(automationLinePath(points, null), "M 0 60 L 10 30 L 20 0");
  assert.equal(automationLinePath([], null), "");
});

/** Verifies dragging the first point moves the path's start instead of adding a leg from its old spot. */
test("automationLinePath starts at a dragged first point", () => {
  assert.equal(
    automationLinePath(points, { index: 0, x: 5, y: 50 }),
    "M 5 50 L 10 30 L 20 0",
  );
});

/** Verifies dragging a middle or last point replaces just that vertex, without repeating it. */
test("automationLinePath replaces a dragged later point", () => {
  assert.equal(
    automationLinePath(points, { index: 1, x: 12, y: 40 }),
    "M 0 60 L 12 40 L 20 0",
  );
  assert.equal(
    automationLinePath(points, { index: 2, x: 25, y: 5 }),
    "M 0 60 L 10 30 L 25 5",
  );
});
