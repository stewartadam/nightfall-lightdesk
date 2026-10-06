// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ParameterLayout, ParameterStateFrame } from "../types";
import {
  carriesParameterState,
  type PackedParameterState,
  ParameterStateDecoder,
  packParameterStateFrame,
  parameterStateTransfers,
  queuedWorkerMessageData,
} from "./parameter-state-transfer";
import type { AnyWsMessage, FixtureParameterState } from "./ws/types";

const ASSERTION_VARIANTS = [
  "Absolute",
  "AbsolutePercent",
  "Relative",
  "RelativePercent",
];

/** Builds a layout with the backend's assertion variant table. */
function layout(
  layoutId: number,
  fixtures: ParameterLayout["fixtures"],
): ParameterLayout {
  return {
    layout_id: layoutId,
    fixtures,
    assertion_variants: ASSERTION_VARIANTS,
  };
}

/** Returns the bytes of `values`, placed one byte into a larger buffer like a decoded CBOR byte string. */
function unalignedBytes(values: ArrayBufferView): Uint8Array {
  const bytes = new Uint8Array(
    values.buffer,
    values.byteOffset,
    values.byteLength,
  );
  const backing = new Uint8Array(bytes.length + 1);
  backing.set(bytes, 1);
  return backing.subarray(1);
}

/** Encodes a values frame the way the backend does, with absolute assertions first. */
function valuesFrame(
  layoutId: number,
  output: number[],
  absolute: [slot: number, kind: number, value: number][],
  relative: [slot: number, kind: number, value: number][] = [],
): ParameterStateFrame {
  const assertions = [...absolute, ...relative];
  return {
    layout_id: layoutId,
    output: unalignedBytes(Float32Array.from(output)),
    absolute_count: absolute.length,
    assertion_slots: unalignedBytes(
      Uint32Array.from(assertions.map(([slot]) => slot)),
    ),
    assertion_kinds: unalignedBytes(
      Uint8Array.from(assertions.map(([, kind]) => kind)),
    ),
    assertion_values: unalignedBytes(
      Float32Array.from(assertions.map(([, , value]) => value)),
    ),
  };
}

/** Packs a frame and moves its buffers through a structured clone, as the worker transfer does. */
function transferred(values: ParameterStateFrame): PackedParameterState {
  const packed = packParameterStateFrame(values);
  const received = structuredClone(packed, {
    transfer: parameterStateTransfers(packed),
  });
  assert.equal(packed.output.byteLength, 0, "transfer detaches the buffer");
  return received;
}

/** Values frames resolve into per-element maps, keeping element positions and every assertion variant. */
test("decoder restores fixture state from layout slots", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(
    layout(7, [
      { fixture_uid: "empty", elements: [] },
      {
        fixture_uid: "fixture",
        elements: [["Pan", "Tilt", "Custom λ", "Red"], [], ["Dimmer"]],
      },
    ]),
  );
  const states = decoder.unpack(
    transferred(
      valuesFrame(
        7,
        [65535, -0, 0.125, NaN, 128],
        [
          [0, 0, 65535],
          [4, 1, 0.5],
        ],
        [
          [1, 2, -1024],
          [4, 3, -0.125],
        ],
      ),
    ),
  );
  const expected: FixtureParameterState[] = [
    { fixture_uid: "empty", parameters: [] },
    {
      fixture_uid: "fixture",
      parameters: [
        {
          output: { Pan: 65535, Tilt: -0, "Custom λ": 0.125 },
          absolute: { Pan: { type: "Absolute", data: { value: 65535 } } },
          relative: { Tilt: { type: "Relative", data: { offset: -1024 } } },
        },
        { output: {}, absolute: {}, relative: {} },
        {
          output: { Dimmer: 128 },
          absolute: {
            Dimmer: { type: "AbsolutePercent", data: { value: 0.5 } },
          },
          relative: {
            Dimmer: { type: "RelativePercent", data: { offset: -0.125 } },
          },
        },
      ],
    },
  ];
  assert.deepEqual(states, expected);
});

/** Frames for another layout, or before any layout, cannot be resolved and are dropped. */
test("decoder drops values that do not match its layout", () => {
  const decoder = new ParameterStateDecoder();
  const frame = valuesFrame(2, [1], []);
  assert.equal(decoder.unpack(packParameterStateFrame(frame)), undefined);

  decoder.setLayout(layout(1, [{ fixture_uid: "a", elements: [["Red"]] }]));
  assert.equal(decoder.unpack(packParameterStateFrame(frame)), undefined);
  assert.equal(
    decoder.unpack(packParameterStateFrame(valuesFrame(1, [1, 2], []))),
    undefined,
    "a slot count mismatch is treated as a foreign layout",
  );
  assert.deepEqual(
    decoder.unpack(packParameterStateFrame(valuesFrame(1, [3], []))),
    [
      {
        fixture_uid: "a",
        parameters: [{ output: { Red: 3 }, absolute: {}, relative: {} }],
      },
    ],
  );
});

/** Arbitrary imported attribute names cannot mutate the decoded map's prototype. */
test("decoder preserves special property names safely", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(
    layout(1, [{ fixture_uid: "f", elements: [["__proto__", "constructor"]] }]),
  );
  const [fixture] =
    decoder.unpack(packParameterStateFrame(valuesFrame(1, [42, 12], []))) ?? [];
  const output = fixture.parameters[0].output;
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.deepEqual(Object.entries(output), [
    ["__proto__", 42],
    ["constructor", 12],
  ]);
});

/** Layouts update the decoder without dispatch, and packed frames are delivered as ParameterState. */
test("queued worker messages route layouts and unpack values", () => {
  const decoder = new ParameterStateDecoder();
  const layoutMessage = {
    data: {
      type: "ParameterLayout",
      data: layout(3, [{ fixture_uid: "fixture", elements: [["Dimmer"]] }]),
    } as AnyWsMessage,
  };
  assert.equal(carriesParameterState(layoutMessage), false);
  assert.equal(queuedWorkerMessageData(layoutMessage, decoder), undefined);

  const packed = {
    packedParameters: packParameterStateFrame(valuesFrame(3, [255], [])),
  };
  assert.equal(carriesParameterState(packed), true);
  assert.deepEqual(queuedWorkerMessageData(packed, decoder), {
    type: "ParameterState",
    data: [
      {
        fixture_uid: "fixture",
        parameters: [{ output: { Dimmer: 255 }, absolute: {}, relative: {} }],
      },
    ],
  });

  const other = { data: { type: "Heartbeat" } as unknown as AnyWsMessage };
  assert.equal(carriesParameterState(other), false);
  assert.equal(queuedWorkerMessageData(other, decoder), other.data);
  assert.equal(carriesParameterState(undefined), false);
});
