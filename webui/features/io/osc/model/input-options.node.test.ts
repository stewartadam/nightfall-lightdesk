// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { oscInputOptionsError } from "./input-options";

/** Accepts explicit controller units instead of assuming all OSC faders send zero through one. */
test("OSC input options accept finite custom ranges", () => {
  for (const [minimum, maximum] of [
    [0, 127],
    [-100, 100],
    [0, 1],
  ])
    assert.equal(
      oscInputOptionsError({
        arg_index: 1,
        input: { type: "Continuous", data: { minimum, maximum } },
      }),
      undefined,
    );
});

/** Mirrors float32 backend limits, including endpoints that collapse after conversion. */
test("OSC input options reject invalid and unrepresentable ranges", () => {
  for (const [minimum, maximum] of [
    [0, 0],
    [1, 0],
    [NaN, 1],
    [0, Infinity],
    [0, 1e40],
    [-3e38, 3e38],
    [1, 1 + Number.EPSILON],
  ])
    assert.ok(
      oscInputOptionsError({
        input: { type: "Continuous", data: { minimum, maximum } },
      }),
    );
});

/** Argument selection must remain representable by the transport's byte-sized index. */
test("OSC input options validate argument indices", () => {
  for (const arg_index of [undefined, 0, 1, 255])
    assert.equal(
      oscInputOptionsError({ arg_index, input: { type: "Press" } }),
      undefined,
    );
  for (const arg_index of [-1, 256, 1.5, NaN])
    assert.ok(oscInputOptionsError({ arg_index, input: { type: "Release" } }));
});
