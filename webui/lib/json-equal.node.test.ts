// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { jsonValuesEqual } from "./json-equal";

/** Verifies nested decoded values compare by content, including NaN and key order. */
test("jsonValuesEqual compares nested decoded values by content", () => {
  assert.equal(
    jsonValuesEqual(
      { a: [1, { b: "x", c: null }], d: Number.NaN },
      { d: Number.NaN, a: [1, { c: null, b: "x" }] },
    ),
    true,
  );
  assert.equal(jsonValuesEqual({ a: [1, 2] }, { a: [1, 3] }), false);
  assert.equal(jsonValuesEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(jsonValuesEqual({ a: 1, b: 2 }, { a: 1, c: 2 }), false);
  assert.equal(jsonValuesEqual([1], { 0: 1 }), false);
  assert.equal(jsonValuesEqual(null, {}), false);
});

/** Verifies prototypes are ignored, so an opaque-marked value equals its plain copy. */
test("jsonValuesEqual ignores prototypes", () => {
  const marked = Object.setPrototypeOf({ a: 1 }, Object.create(null));
  assert.equal(jsonValuesEqual(marked, { a: 1 }), true);
});
