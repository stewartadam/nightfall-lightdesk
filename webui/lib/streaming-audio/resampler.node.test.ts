// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { StreamResampler } from "./resampler";

/** Resample `input` pushed in blocks of the given sizes, then flush. */
function resampleInBlocks(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
  blockSizes: number[],
): Float32Array {
  const resampler = new StreamResampler(inputRate, outputRate, 1);
  const parts: Float32Array[] = [];
  let at = 0;
  let block = 0;
  while (at < input.length) {
    const size = blockSizes[block % blockSizes.length];
    parts.push(resampler.push([input.subarray(at, at + size)])[0]);
    at += size;
    block += 1;
  }
  parts.push(resampler.flush()[0]);
  const joined = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** Matching rates pass blocks through untouched. */
test("passes samples through when rates match", () => {
  const resampler = new StreamResampler(48_000, 48_000, 2);
  const block = [new Float32Array([1, 2]), new Float32Array([3, 4])];
  assert.equal(resampler.push(block), block);
  assert.equal(resampler.flush()[1].length, 0);
});

/**
 * The output does not depend on how the stream was split into blocks, so block edges
 * never click, and its length follows the rate ratio.
 */
test("resamples a stream independently of block boundaries", () => {
  const input = Float32Array.from({ length: 4_410 }, (_, i) =>
    Math.sin((2 * Math.PI * 440 * i) / 44_100),
  );
  const whole = resampleInBlocks(input, 44_100, 48_000, [input.length]);
  assert.equal(whole.length, 4_800);
  for (const sizes of [[1], [37, 5, 1_000], [512]]) {
    assert.deepEqual(resampleInBlocks(input, 44_100, 48_000, sizes), whole);
  }
  // Output sample n sits at input time n * 44100 / 48000, still on the 440 Hz sine.
  for (const n of [100, 1_234, 4_000]) {
    const expected = Math.sin((2 * Math.PI * 440 * n) / 48_000);
    assert.ok(Math.abs(whole[n] - expected) < 1e-3, `sample ${n}`);
  }
});

/** Downsampling keeps time aligned too, and a ramp stays exact under cubic interpolation. */
test("downsamples a ramp exactly", () => {
  const input = Float32Array.from({ length: 480 }, (_, i) => i / 480);
  const output = resampleInBlocks(input, 48_000, 44_100, [100]);
  assert.equal(output.length, 441);
  for (const n of [1, 200, 437]) {
    assert.ok(Math.abs(output[n] - (n * 48_000) / 44_100 / 480) < 1e-6);
  }
});
