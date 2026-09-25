// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  FilteredEmitterRow,
  MAX_BASE_TEXELS,
  TEXTURE_ROW_TEXELS,
} from "./filtered-emitter-row";

/** WebGPU's default maxTextureDimension2D, the tightest limit a device may enforce. */
const WEBGPU_DEFAULT_MAX_TEXTURE_DIMENSION = 8192;

/** Reads the packed pyramid texture's dimensions and data. */
function image(row: FilteredEmitterRow) {
  return (row as unknown as { map: { image: unknown } }).map.image as {
    width: number;
    height: number;
    data: Float32Array;
  };
}

/** Long pixel tapes must never request a texture wider or taller than a default WebGPU device allows. */
test("long rows wrap the packed pyramid within device texture limits", () => {
  for (const count of [2, 510, 511, 1023, 5000, 200000]) {
    const row = new FilteredEmitterRow(count, 0.01, 0.008, 0.01, 0.01);
    const { width, height, data } = image(row);
    assert.ok(width <= WEBGPU_DEFAULT_MAX_TEXTURE_DIMENSION, `${count} cells`);
    assert.ok(height <= WEBGPU_DEFAULT_MAX_TEXTURE_DIMENSION, `${count} cells`);
    assert.ok(width <= TEXTURE_ROW_TEXELS);
    assert.equal(data.length, width * height * 4);
    assert.ok(data.length / 4 <= MAX_BASE_TEXELS * 2);
    row.dispose();
  }
});

/** Wrapping must preserve each level's area-averaged radiance, including coarse levels in later rows. */
test("wrapped pyramid levels preserve area-averaged radiance", () => {
  const count = 1500;
  const row = new FilteredEmitterRow(count, 0.01, 0.008, 0.01, 0.01);
  const colors = new Float32Array(count * 3);
  for (let cell = 0; cell < count; cell++) colors[cell * 3] = 1;
  row.update(colors);
  const { width, height, data } = image(row);
  assert.ok(height > 1, "a 1500-cell row must wrap");
  const base = (width * height) / 2;
  // The coarsest level averages the whole padded row: 80% cell coverage over count of count + 2 spans.
  const coarsest = data[(width * height - 2) * 4];
  assert.ok(
    Math.abs(coarsest - (0.8 * count) / (count + 2)) < 0.01,
    `coarsest level ${coarsest}`,
  );
  let total = 0;
  for (let texel = 0; texel < base; texel++) total += data[texel * 4];
  assert.ok(Math.abs(total / base - coarsest) < 1e-3);
  row.dispose();
});
