// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  fanNumbersByColumn,
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

/** Verifies each column of a multi-column range fans independently in the given order. */
test("fanNumbersByColumn fans each column across its own cells", () => {
  assert.deepEqual(
    fanNumbersByColumn(
      [
        [6, 0],
        [7, 0],
        [6, 1],
        [7, 1],
        [6, 2],
        [7, 2],
      ],
      [0, 3],
    ),
    [0, 0, 1.5, 1.5, 3, 3],
  );
  assert.deepEqual(fanNumbersByColumn([[2, 5]], [4, 9]), [4]);
});
