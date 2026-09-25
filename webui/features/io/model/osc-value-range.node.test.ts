// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  editOscRange,
  formatOscRangeEnd,
  oscRangeError,
} from "./osc-value-range";

/** Verifies unset ranges display blank and set ranges display each end. */
test("formatOscRangeEnd shows blank for inferred units", () => {
  assert.equal(formatOscRangeEnd(undefined, "min"), "");
  assert.equal(formatOscRangeEnd({ min: 0, max: 127 }, "max"), "127");
});

/** Verifies entering only a maximum keeps the default minimum of 0. */
test("editOscRange fills the other end from the normalized default", () => {
  assert.deepEqual(editOscRange(undefined, "max", " 127 "), {
    ok: true,
    range: { min: 0, max: 127 },
  });
  assert.deepEqual(editOscRange({ min: 0, max: 127 }, "min", "10"), {
    ok: true,
    range: { min: 10, max: 127 },
  });
});

/** Verifies an inverted range is accepted. */
test("editOscRange accepts a minimum above the maximum", () => {
  assert.deepEqual(editOscRange({ min: 0, max: 127 }, "min", "255"), {
    ok: true,
    range: { min: 255, max: 127 },
  });
});

/** Verifies blank text clears the range back to inferred units. */
test("editOscRange clears the range on blank input", () => {
  assert.deepEqual(editOscRange({ min: 0, max: 127 }, "max", "  "), {
    ok: true,
    range: undefined,
  });
});

/** Verifies non-numeric, non-finite, and empty ranges are rejected like the backend does. */
test("editOscRange rejects invalid ends", () => {
  assert.equal(editOscRange(undefined, "max", "abc").ok, false);
  assert.equal(editOscRange(undefined, "max", "Infinity").ok, false);
  assert.deepEqual(editOscRange({ min: 0, max: 127 }, "max", "0"), {
    ok: false,
    error: "OSC value range minimum and maximum must differ (both are 0)",
  });
  assert.equal(editOscRange(undefined, "min", "1").ok, false);
  assert.equal(oscRangeError({ min: Number.NaN, max: 1 }) !== undefined, true);
  assert.equal(oscRangeError({ min: 1, max: 0 }), undefined);
});
