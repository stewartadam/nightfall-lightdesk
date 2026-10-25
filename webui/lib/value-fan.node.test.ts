// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  fannedNumbersForTargets,
  parseNumericFanInput,
  resolveFanNumber,
} from "./value-fan";

/** Verifies numeric fans accept signed and decimal waypoints with surrounding spaces. */
test("parseNumericFanInput parses numeric waypoints", () => {
  assert.deepEqual(parseNumericFanInput("0>3"), [0, 3]);
  assert.deepEqual(parseNumericFanInput(" -1.5 > 0 > 1.5 "), [-1.5, 0, 1.5]);
});

/** Verifies plain numbers and malformed fans are not treated as numeric fans. */
test("parseNumericFanInput rejects non-fan input", () => {
  assert.equal(parseNumericFanInput("3"), null);
  assert.equal(parseNumericFanInput("0>"), null);
  assert.equal(parseNumericFanInput(">3"), null);
  assert.equal(parseNumericFanInput("0>>3"), null);
  assert.equal(parseNumericFanInput("0>3s"), null);
  assert.equal(parseNumericFanInput("0x10>3"), null);
});

/** Verifies fans spread from the first to the last waypoint across targets. */
test("resolveFanNumber interpolates evenly across targets", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((offset) => resolveFanNumber([0, 3], offset, 4)),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((offset) => resolveFanNumber([0, 4, 0], offset, 5)),
    [0, 2, 4, 2, 0],
  );
  assert.equal(resolveFanNumber([2, 5], 0, 1), 2);
  assert.equal(resolveFanNumber([0, 0.3], 1, 4), 0.1);
});

/** Verifies target values fall back to the plain edit value when input is not a fan. */
test("fannedNumbersForTargets fans only fan input", () => {
  assert.deepEqual(fannedNumbersForTargets(3, 0, "0>3"), [0, 1.5, 3]);
  assert.deepEqual(fannedNumbersForTargets(3, 7, "7"), [7, 7, 7]);
  assert.deepEqual(fannedNumbersForTargets(2, 7, undefined), [7, 7]);
});
