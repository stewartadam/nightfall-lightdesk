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
  carriesParameterState,
  packParameterState,
  queuedWorkerMessageData,
  unpackParameterState,
} from "./parameter-state-transfer";
import type { AnyWsMessage } from "./ws/types";

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

/** Packing sizes its buffer exactly, so transfer carries no unused capacity. */
test("packed parameter buffers hold exactly the encoded values", () => {
  const packed = packParameterState([
    {
      fixture_uid: "fixture",
      parameters: [
        {
          output: { Pan: 1, Tilt: 2 },
          absolute: { Pan: { type: "Absolute", data: { value: 3 } } },
          relative: {},
        },
      ],
    },
  ]);
  // Element count, then output count + 2 pairs, then absolute count + 1 triple, then relative count.
  assert.equal(packed.values.length, 1 + (1 + 4) + (1 + 3) + 1);
  assert.equal(packed.values.buffer.byteLength, packed.values.byteLength);
});

/** The main thread delivers packed snapshots as ParameterState and counts them like unpacked ones. */
test("queued worker messages unpack transferred parameter snapshots", () => {
  const states: OutboundParameterState[] = [
    {
      fixture_uid: "fixture",
      parameters: [{ output: { Dimmer: 255 }, absolute: {}, relative: {} }],
    },
  ];
  const packed = { packedParameters: packParameterState(states) };
  assert.equal(carriesParameterState(packed), true);
  assert.deepEqual(queuedWorkerMessageData(packed), {
    type: "ParameterState",
    data: states,
  });

  const plain = {
    data: { type: "ParameterState", data: states } as AnyWsMessage,
  };
  assert.equal(carriesParameterState(plain), true);
  assert.equal(queuedWorkerMessageData(plain), plain.data);

  const other = { data: { type: "Heartbeat" } as unknown as AnyWsMessage };
  assert.equal(carriesParameterState(other), false);
  assert.equal(queuedWorkerMessageData(other), other.data);
  assert.equal(carriesParameterState(undefined), false);
});
