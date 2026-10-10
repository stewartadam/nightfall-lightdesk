// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  OutboundLayerStack,
  OutboundLayerState,
  ParameterLayout,
} from "../types";
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

/** Packs numbers as little-endian bytes the way the backend writes layer stack buffers. */
function bytes(kind: "u32" | "f32", values: number[]): Uint8Array {
  const array =
    kind === "u32" ? Uint32Array.from(values) : Float32Array.from(values);
  // Offset into a larger buffer, as a CBOR decoder returns byte strings, to exercise realignment.
  const padded = new Uint8Array(array.byteLength + 1);
  padded.set(new Uint8Array(array.buffer), 1);
  return padded.subarray(1);
}

/** Builds one packed wire layer with only the given assertion and computed buffers set. */
function packedLayer(
  absolute: [slot: number, kind: number, value: number][],
  computed: [slot: number, value: number][],
  transitioning: number[],
): OutboundLayerState {
  const empty = {
    slots: new Uint8Array(0),
    kinds: new Uint8Array(0),
    values: new Uint8Array(0),
  };
  return {
    creator: "Programmer",
    object_ref: undefined,
    priority: 10,
    is_releasing: false,
    runtime_position: undefined,
    asserted_absolute: {
      slots: bytes(
        "u32",
        absolute.map(([slot]) => slot),
      ),
      kinds: Uint8Array.from(absolute.map(([, kind]) => kind)),
      values: bytes(
        "f32",
        absolute.map(([, , value]) => value),
      ),
    },
    asserted_relative: empty,
    lookahead_asserted: empty,
    computed_slots: bytes(
      "u32",
      computed.map(([slot]) => slot),
    ),
    computed_values: bytes(
      "f32",
      computed.map(([, value]) => value),
    ),
    transitioning_slots: bytes("u32", transitioning),
  } as OutboundLayerState;
}

/** Layer stack slots resolve to fixture element attribute maps, keeping earlier elements empty. */
test("decoder restores layer stack values from layout slots", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(
    layout(3, [
      { fixture_uid: "first", elements: [["Dimmer"]] },
      { fixture_uid: "second", elements: [["Pan"], ["Dimmer", "Red"]] },
    ]),
  );
  const stack: OutboundLayerStack = {
    layout_id: 3,
    layers: [packedLayer([[3, 0, 200]], [[3, 180]], [3])],
  };

  const message = queuedWorkerMessageData(
    { data: { type: "LayerStack", data: stack } as unknown as AnyWsMessage },
    decoder,
  );

  assert.deepEqual(message, {
    type: "LayerStack",
    data: [
      {
        creator: "Programmer",
        object_ref: undefined,
        priority: 10,
        is_releasing: false,
        runtime_position: undefined,
        asserted_absolute_values: [
          {
            fixture_uid: "second",
            parameters: [
              {},
              { Red: { type: "Absolute", data: { value: 200 } } },
            ],
          },
        ],
        asserted_relative_values: [],
        lookahead_asserted_values: [],
        computed_values: [
          { fixture_uid: "second", parameters: [{}, { Red: 180 }] },
        ],
        computed_transitioning: [
          { fixture_uid: "second", parameters: [{}, { Red: true }] },
        ],
      },
    ],
  });
});

/** Snapshots for another layout or with slots outside the layout are dropped, not misapplied. */
test("decoder drops layer stacks it cannot resolve", () => {
  const decoder = new ParameterStateDecoder();
  assert.equal(
    decoder.unpackLayerStack({ layout_id: 1, layers: [] }),
    undefined,
  );
  decoder.setLayout(layout(1, [{ fixture_uid: "a", elements: [["Dimmer"]] }]));
  assert.deepEqual(decoder.unpackLayerStack({ layout_id: 1, layers: [] }), []);
  assert.equal(
    decoder.unpackLayerStack({ layout_id: 2, layers: [] }),
    undefined,
  );
  assert.equal(
    decoder.unpackLayerStack({
      layout_id: 1,
      layers: [packedLayer([], [[1, 5]], [])],
    }),
    undefined,
  );
});

/** A reset decoder drops slot-indexed messages until a layout arrives again. */
test("decoder reset forgets the layout", () => {
  const decoder = new ParameterStateDecoder();
  decoder.setLayout(layout(1, [{ fixture_uid: "a", elements: [["Dimmer"]] }]));
  decoder.reset();
  assert.equal(
    decoder.unpackLayerStack({ layout_id: 1, layers: [] }),
    undefined,
  );
});
