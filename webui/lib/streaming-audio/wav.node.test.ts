// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { decodeWavSamples, parseWavHeader } from "./wav";

/** Build a WAV file with a `LIST` chunk before the data, as many editors write. */
function wavFile(bitsPerSample: number, samples: number[]): Uint8Array {
  const channels = 2;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = samples.length * bytesPerSample;
  const bytes = new Uint8Array(12 + 24 + 14 + 8 + dataLength);
  const view = new DataView(bytes.buffer);
  /** Write a chunk id or tag at `at`. */
  const ascii = (at: number, text: string) =>
    bytes.set(
      [...text].map((c) => c.charCodeAt(0)),
      at,
    );
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 8_000 * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  // An odd-sized chunk is padded to an even length.
  ascii(36, "LIST");
  view.setUint32(40, 5, true);
  ascii(50, "data");
  view.setUint32(54, dataLength, true);
  samples.forEach((sample, index) => {
    const at = 58 + index * bytesPerSample;
    if (bitsPerSample === 16) view.setInt16(at, sample, true);
    else {
      view.setUint8(at, sample & 0xff);
      view.setUint8(at + 1, (sample >> 8) & 0xff);
      view.setInt8(at + 2, sample >> 16);
    }
  });
  return bytes;
}

/** Header fields and interleaved 16-bit samples convert to per-channel floats. */
test("parses a 16-bit WAV header and samples", () => {
  const file = wavFile(16, [16_384, -32_768, 0, 8_192]);
  const format = parseWavHeader(file, file.length);
  assert.deepEqual(format, {
    channelCount: 2,
    sampleRate: 8_000,
    blockAlign: 4,
    bitsPerSample: 16,
    float: false,
    dataOffset: 58,
    dataLength: 8,
  });
  const channels = decodeWavSamples(format!, file.subarray(58));
  assert.deepEqual([...channels[0]], [0.5, 0]);
  assert.deepEqual([...channels[1]], [-1, 0.25]);
});

/** 24-bit samples sign-extend, and a data size past the file end is clamped to the file. */
test("parses 24-bit samples and clamps the data length", () => {
  const file = wavFile(24, [-4_194_304, 4_194_304]);
  new DataView(file.buffer).setUint32(54, 1_000, true);
  const format = parseWavHeader(file, file.length)!;
  assert.equal(format.dataLength, 6);
  const channels = decodeWavSamples(format, file.subarray(58));
  assert.deepEqual([channels[0][0], channels[1][0]], [-0.5, 0.5]);
  assert.equal(parseWavHeader(file.subarray(0, 40), file.length), null);
});
