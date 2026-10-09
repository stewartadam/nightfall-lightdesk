// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ParameterLayout } from "../types";
import {
  carriesParameterState,
  type PackedParameterState,
  ParameterStateDecoder,
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

/** Builds parameter state the way the worker packs it, with absolute assertions first. */
function packedState(
  layoutId: number,
  output: number[],
  absolute: [slot: number, kind: number, value: number][],
  relative: [slot: number, kind: number, value: number][] = [],
): PackedParameterState {
  const assertions = [...absolute, ...relative];
  return {
    layoutId,
    output: Float32Array.from(output),
    absoluteCount: absolute.length,
    assertionSlots: Uint32Array.from(assertions.map(([slot]) => slot)),
    assertionKinds: Uint8Array.from(assertions.map(([, kind]) => kind)),
    assertionValues: Float32Array.from(assertions.map(([, , value]) => value)),
  };
}

/** Moves packed state's buffers through a structured clone, as the worker transfer does. */
function transferred(packed: PackedParameterState): PackedParameterState {
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
      packedState(
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
  const frame = packedState(2, [1], []);
  assert.equal(decoder.unpack(frame), undefined);

  decoder.setLayout(layout(1, [{ fixture_uid: "a", elements: [["Red"]] }]));
  assert.equal(decoder.unpack(frame), undefined);
  assert.equal(
    decoder.unpack(packedState(1, [1, 2], [])),
    undefined,
    "a slot count mismatch is treated as a foreign layout",
  );
  assert.deepEqual(decoder.unpack(packedState(1, [3], [])), [
    {
      fixture_uid: "a",
      parameters: [{ output: { Red: 3 }, absolute: {}, relative: {} }],
    },
  ]);
});

/** Arbitrary imported attribute names cannot mutate the decoded map's prototype. */
test("decoder preserves special property names safely", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(
    layout(1, [{ fixture_uid: "f", elements: [["__proto__", "constructor"]] }]),
  );
  const [fixture] = decoder.unpack(packedState(1, [42, 12], [])) ?? [];
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
    packedParameters: packedState(3, [255], []),
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

/** Three fixtures with two single-attribute elements each, for reuse tests. */
const REUSE_LAYOUT = layout(5, [
  { fixture_uid: "a", elements: [["Red"], ["Green"]] },
  { fixture_uid: "b", elements: [["Red"], ["Green"]] },
  { fixture_uid: "c", elements: [["Red"], ["Green"]] },
]);

/**
 * A frame that changes one fixture's output returns a new state for that fixture only, keeps the
 * unchanged element and assertion records inside it, and decodes the same values a fresh decoder
 * would.
 */
test("decoder reuses fixtures whose output did not change", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(REUSE_LAYOUT);
  const absolute: [number, number, number][] = [[2, 0, 1]];
  const first = decoder.unpack(packedState(5, [1, 2, 3, 4, 5, 6], absolute));
  assert.ok(first);
  const next = decoder.unpack(packedState(5, [1, 2, 3, 9, 5, 6], absolute));
  assert.ok(next);

  assert.equal(next[0], first[0]);
  assert.equal(next[2], first[2]);
  assert.notEqual(next[1], first[1]);
  assert.equal(next[1].parameters[0].output, first[1].parameters[0].output);
  assert.equal(next[1].parameters[0].absolute, first[1].parameters[0].absolute);
  assert.notEqual(next[1].parameters[1].output, first[1].parameters[1].output);

  const fresh = new ParameterStateDecoder();
  fresh.setLayout(REUSE_LAYOUT);
  assert.deepEqual(
    next,
    fresh.unpack(packedState(5, [1, 2, 3, 9, 5, 6], absolute)),
  );
});

/**
 * Bit-level changes the backend sends, such as a signed zero or a NaN becoming a number, count as
 * changes, and an identical frame returns every previous fixture.
 */
test("decoder compares outputs by their bits", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(REUSE_LAYOUT);
  const first = decoder.unpack(packedState(5, [0, NaN, 1, 1, 1, 1], []));
  const next = decoder.unpack(packedState(5, [-0, 7, 1, 1, 1, 1], []));
  assert.ok(first && next);
  assert.notEqual(next[0], first[0]);
  assert.deepEqual(next[0].parameters[0].output, { Red: -0 });
  assert.deepEqual(next[0].parameters[1].output, { Green: 7 });

  const same = decoder.unpack(packedState(5, [-0, 7, 1, 1, 1, 1], []));
  assert.ok(same);
  for (const [index, state] of same.entries()) {
    assert.equal(state, next[index]);
  }
});

/**
 * When assertions change, only fixtures whose own assertions differ get new state; fixtures with
 * the same assertions keep theirs, even if other entries moved within the assertion arrays.
 */
test("decoder reuses fixtures whose assertions did not change", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(REUSE_LAYOUT);
  const output = [1, 2, 3, 4, 5, 6];
  const first = decoder.unpack(
    packedState(5, output, [
      [0, 0, 10],
      [4, 1, 0.5],
    ]),
  );
  const next = decoder.unpack(
    packedState(
      5,
      output,
      [
        [4, 1, 0.5],
        [0, 0, 10],
      ],
      [[2, 2, -3]],
    ),
  );
  assert.ok(first && next);
  assert.equal(next[0], first[0]);
  assert.equal(next[2], first[2]);
  assert.notEqual(next[1], first[1]);
  assert.deepEqual(next[1].parameters[0].relative, {
    Red: { type: "Relative", data: { offset: -3 } },
  });
  assert.equal(next[1].parameters[0].output, first[1].parameters[0].output);
});

/** A new layout, even with the same fixtures, rebuilds every fixture rather than reusing state. */
test("decoder rebuilds every fixture after a layout", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(REUSE_LAYOUT);
  const output = [1, 2, 3, 4, 5, 6];
  const first = decoder.unpack(packedState(5, output, []));
  decoder.setLayout(REUSE_LAYOUT);
  const next = decoder.unpack(packedState(5, output, []));
  assert.ok(first && next);
  for (const [index, state] of next.entries()) {
    assert.notEqual(state, first[index]);
  }
  assert.deepEqual(next, first);
});
