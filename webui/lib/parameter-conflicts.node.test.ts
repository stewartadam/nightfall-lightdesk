// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { outputValuesConflict } from "./parameter-conflicts";

/** Verifies parent rows ignore sub-DMX output differences. */
test("outputValuesConflict ignores differences below one DMX step", () => {
  assert.equal(outputValuesConflict([50.49, 50.745]), false);
  assert.equal(outputValuesConflict([151.98, 151.725]), false);
});

/** Verifies parent rows still mark values that differ by at least one DMX step. */
test("outputValuesConflict detects differences at one DMX step", () => {
  assert.equal(outputValuesConflict([151.49, 152.49]), true);
});
