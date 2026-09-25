// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OutboundParameterState } from "../types";
import {
  packParameterState,
  unpackParameterState,
} from "./parameter-state-transfer";

/** Worker transfer preserves sparse attributes, all assertion variants and exact numeric values. */
test("parameter snapshot survives ownership transfer without losing state", () => {
  const states: OutboundParameterState[] = [
    { fixture_uid: "empty", parameters: [] },
    {
      fixture_uid: "fixture",
      parameters: [
        {
          output: { Pan: 65535, Tilt: -0, "Custom λ": 0.125, Red: NaN },
          absolute: {
            Pan: { type: "Absolute", data: { value: 65535 } },
            Dimmer: { type: "AbsolutePercent", data: { value: 0.325 } },
          },
          relative: {
            Tilt: { type: "Relative", data: { offset: -1024 } },
            Dimmer: { type: "RelativePercent", data: { offset: -0.125 } },
          },
        },
        {
          output: { Pan: Infinity, Tilt: -Infinity },
          absolute: {},
          relative: {},
        },
        { output: {}, absolute: {}, relative: {} },
      ],
    },
  ];
  const packed = packParameterState(states);
  assert.equal(packed.attributes.filter((name) => name === "Pan").length, 1);
  const received = structuredClone(packed, {
    transfer: [packed.values.buffer],
  });
  assert.equal(packed.values.byteLength, 0);
  assert.deepEqual(unpackParameterState(received), states);
  assert.deepEqual(unpackParameterState(packParameterState([])), []);
});

/** Arbitrary imported attribute names cannot mutate the decoded map's prototype. */
test("parameter transfer preserves special property names safely", () => {
  const output = JSON.parse('{"__proto__":42,"constructor":12}');
  const [fixture] = unpackParameterState(
    packParameterState([
      {
        fixture_uid: "fixture",
        parameters: [{ output, absolute: {}, relative: {} }],
      },
    ]),
  );
  assert.equal(
    Object.getPrototypeOf(fixture.parameters[0].output),
    Object.prototype,
  );
  assert.deepEqual(
    Object.entries(fixture.parameters[0].output),
    Object.entries(output),
  );
});
