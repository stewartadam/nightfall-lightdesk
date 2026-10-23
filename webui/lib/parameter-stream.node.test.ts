// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ParameterLayout, ParameterStateFrame } from "../types";
import { ParameterStream } from "./parameter-stream";

type Assertion = [slot: number, kind: number, value: number];

/** Builds a layout of one fixture with one element holding `slotCount` slots. */
function layout(layoutId: number, slotCount: number): ParameterLayout {
  return {
    layout_id: layoutId,
    fixtures: [
      {
        fixture_uid: "fixture",
        elements: [Array.from({ length: slotCount }, (_, i) => `A${i}`)],
      },
    ],
    assertion_variants: ["Absolute"],
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

/** Encodes `assertions` into a frame's assertion fields, all absolute. */
function assertionFields(assertions: Assertion[] | undefined) {
  const list = assertions ?? [];
  return {
    assertions_included: assertions !== undefined,
    absolute_count: list.length,
    assertion_slots: unalignedBytes(Uint32Array.from(list.map(([s]) => s))),
    assertion_kinds: unalignedBytes(Uint8Array.from(list.map(([, k]) => k))),
    assertion_values: unalignedBytes(
      Float32Array.from(list.map(([, , v]) => v)),
    ),
  };
}

/** Encodes keyframe `seq` carrying every slot of `output`. */
function keyframe(
  layoutId: number,
  seq: number,
  output: number[],
  assertions: Assertion[] = [],
  changedSlots?: number[],
): ParameterStateFrame {
  return {
    layout_id: layoutId,
    seq,
    keyframe: true,
    verifiable: changedSlots !== undefined,
    changed_slots: unalignedBytes(Uint32Array.from(changedSlots ?? [])),
    output: unalignedBytes(Float32Array.from(output)),
    ...assertionFields(assertions),
  };
}

/** Encodes delta `seq` setting each `[slot, value]` pair, with assertions only when given. */
function delta(
  layoutId: number,
  seq: number,
  changes: [slot: number, value: number][],
  assertions?: Assertion[],
): ParameterStateFrame {
  return {
    layout_id: layoutId,
    seq,
    keyframe: false,
    verifiable: false,
    changed_slots: unalignedBytes(Uint32Array.from(changes.map(([s]) => s))),
    output: unalignedBytes(Float32Array.from(changes.map(([, v]) => v))),
    ...assertionFields(assertions),
  };
}

/** Returns the rebuilt output a pull would deliver, as plain numbers. */
function pulledOutput(stream: ParameterStream): number[] | undefined {
  const packed = stream.takePacked();
  return packed && Array.from(packed.output);
}

/** Deltas apply on top of the keyframe in order, and only changed state is delivered again. */
test("deltas update the state a keyframe started", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 3));
  assert.equal(stream.apply(keyframe(1, 7, [1, 2, 3], [[2, 0, 9]])), "applied");
  assert.equal(stream.apply(delta(1, 8, [[0, 10]])), "applied");
  assert.equal(stream.apply(delta(1, 9, [[2, -0]], [])), "applied");
  const packed = stream.takePacked();
  assert.deepEqual(Array.from(packed?.output ?? []), [10, 2, -0]);
  assert.ok(Object.is(packed?.output[2], -0), "signed zero survives");
  assert.equal(packed?.assertionSlots.length, 0, "included assertions replace");
  assert.equal(stream.takePacked(), undefined);
  assert.deepEqual(stream.stats, {
    keyframes: 1,
    deltas: 2,
    gaps: 0,
    discarded: 0,
    verifiedKeyframes: 0,
    driftedKeyframes: 0,
    driftedSlots: 0,
  });
});

/** Deltas that leave out assertions keep the previous ones. */
test("deltas without assertions keep earlier assertions", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 2));
  stream.apply(keyframe(1, 1, [0, 0], [[1, 0, 5]]));
  stream.apply(delta(1, 2, [[0, 3]]));
  const packed = stream.takePacked();
  assert.deepEqual(Array.from(packed?.assertionSlots ?? []), [1]);
  assert.deepEqual(Array.from(packed?.assertionValues ?? []), [5]);
});

/** A missed frame stops delivery until a keyframe, so a partial update is never shown. */
test("a gap refuses deltas until the next keyframe", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 2));
  stream.apply(keyframe(1, 1, [0, 0]));
  stream.takePacked();
  assert.equal(stream.apply(delta(1, 3, [[0, 5]])), "gap");
  assert.equal(stream.apply(delta(1, 4, [[1, 6]])), "gap");
  assert.equal(pulledOutput(stream), undefined);
  assert.equal(stream.stats.gaps, 1, "one gap however many deltas follow");

  assert.equal(stream.apply(keyframe(1, 5, [5, 6])), "applied");
  assert.equal(stream.apply(delta(1, 6, [[1, 7]])), "applied");
  assert.deepEqual(pulledOutput(stream), [5, 7]);
});

/** Sequence numbers wrap at u32 like the backend's. */
test("sequence numbers wrap", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 1));
  stream.apply(keyframe(1, 0xffff_ffff, [1]));
  assert.equal(stream.apply(delta(1, 0, [[0, 2]])), "applied");
  assert.deepEqual(pulledOutput(stream), [2]);
});

/** Frames for another layout, or before any layout, are ignored without breaking the stream. */
test("frames for other layouts are discarded", () => {
  const stream = new ParameterStream();
  assert.equal(stream.apply(keyframe(1, 1, [1])), "discarded");
  stream.setLayout(layout(1, 1));
  assert.equal(stream.apply(keyframe(2, 1, [1])), "discarded");
  assert.equal(stream.apply(keyframe(1, 1, [1, 2])), "discarded");
  assert.equal(stream.apply(keyframe(1, 2, [3])), "applied");

  stream.setLayout(layout(1, 1));
  assert.equal(
    stream.apply(delta(1, 3, [[0, 4]])),
    "applied",
    "republishing the same layout keeps state",
  );
  stream.setLayout(layout(2, 1));
  assert.equal(pulledOutput(stream), undefined, "a new layout drops state");
  assert.equal(stream.apply(delta(2, 4, [[0, 5]])), "gap");
});

/** A malformed delta, such as one naming a slot outside the layout, is treated as a gap. */
test("malformed deltas break the stream", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 2));
  stream.apply(keyframe(1, 1, [0, 0]));
  assert.equal(stream.apply(delta(1, 2, [[2, 1]])), "gap");
  assert.equal(pulledOutput(stream), undefined);
});

/**
 * A verifiable keyframe that directly follows applied frames is compared with the rebuilt state
 * plus the changes it lists, so ordinary value changes are not drift but unlisted differences
 * are. Keyframes that list nothing, or arrive after a gap, are not checked.
 */
test("verifiable keyframes detect drift without flagging listed changes", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 3));
  stream.apply(keyframe(1, 1, [1, 2, 3]));
  stream.apply(delta(1, 2, [[0, 4]]));
  stream.apply(keyframe(1, 3, [4, 9, 3], [], [1]));
  assert.equal(stream.stats.verifiedKeyframes, 1);
  assert.equal(stream.stats.driftedKeyframes, 0, "listed changes are expected");

  stream.apply(keyframe(1, 4, [5, 9, 8], [], [2]));
  assert.equal(stream.stats.driftedKeyframes, 1);
  assert.equal(stream.stats.driftedSlots, 1, "only the unlisted slot drifted");
  assert.deepEqual(pulledOutput(stream), [5, 9, 8], "the keyframe wins");

  stream.apply(keyframe(1, 5, [0, 0, 0]));
  stream.apply(keyframe(1, 10, [1, 1, 1], [], []));
  assert.equal(
    stream.stats.verifiedKeyframes,
    2,
    "unverifiable or after a gap",
  );
  assert.equal(stream.stats.driftedKeyframes, 1);
});

/** Back-to-back keyframes are only copied when a pull or a delta needs them. */
test("superseded keyframes are delivered as the newest one", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 2));
  for (let seq = 1; seq <= 5; seq++)
    stream.apply(keyframe(1, seq, [seq, -seq]));
  assert.deepEqual(pulledOutput(stream), [5, -5]);
  stream.apply(delta(1, 6, [[1, 7]]));
  assert.deepEqual(pulledOutput(stream), [5, 7]);
});

/** A keyframe whose assertions are malformed is caught when it is first used. */
test("malformed keyframe assertions break the stream when used", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 1));
  assert.equal(stream.apply(keyframe(1, 1, [1], [[3, 0, 1]])), "applied");
  assert.equal(pulledOutput(stream), undefined);
  assert.equal(stream.apply(delta(1, 2, [[0, 2]])), "gap");
});

/** Invalidation forgets the layout, as after a reconnect, until the backend republishes it. */
test("invalidate waits for a new layout", () => {
  const stream = new ParameterStream();
  stream.setLayout(layout(1, 1));
  stream.apply(keyframe(1, 1, [1]));
  stream.invalidate();
  assert.equal(stream.pending, false);
  assert.equal(stream.apply(keyframe(1, 2, [2])), "discarded");
  stream.setLayout(layout(1, 1));
  assert.equal(stream.apply(keyframe(1, 1, [3])), "applied");
  assert.deepEqual(pulledOutput(stream), [3]);
});
