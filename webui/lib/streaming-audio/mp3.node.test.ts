// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MP3_DECODER_DELAY, Mp3FrameIndex, parseMp3FrameHeader } from "./mp3";

const repoRoot = process.env.NIGHTFALL_REPO_ROOT ?? process.cwd();

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo: 417 bytes, or 418 with padding.
const HEADER_128K = [0xff, 0xfb, 0x90, 0x44];

/** Build one MPEG-1 128 kbps frame, padded or not, with a recognisable payload byte. */
function frame(padded: boolean, fill = 0x11): Uint8Array {
  const bytes = new Uint8Array(padded ? 418 : 417).fill(fill);
  bytes.set(HEADER_128K);
  if (padded) bytes[2] |= 0x02;
  return bytes;
}

/** Build a LAME info frame announcing `frameCount` frames, `delay` and `padding`. */
function lameInfoFrame(
  frameCount: number,
  delay: number,
  padding: number,
): Uint8Array {
  const bytes = frame(false, 0);
  const xing = 4 + 32;
  bytes.set(
    [..."Info"].map((c) => c.charCodeAt(0)),
    xing,
  );
  // Only the frame count field is present.
  new DataView(bytes.buffer).setUint32(xing + 4, 0x1);
  new DataView(bytes.buffer).setUint32(xing + 8, frameCount);
  const lame = xing + 12;
  bytes.set(
    [..."LAME3.100"].map((c) => c.charCodeAt(0)),
    lame,
  );
  bytes[lame + 21] = delay >> 4;
  bytes[lame + 22] = ((delay & 0x0f) << 4) | (padding >> 8);
  bytes[lame + 23] = padding & 0xff;
  return bytes;
}

/** Join byte arrays into one. */
function concat(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** Feed `bytes` to a new index in chunks of `chunkSize` and finish it. */
function indexInChunks(bytes: Uint8Array, chunkSize: number): Mp3FrameIndex {
  const index = new Mp3FrameIndex();
  for (let at = 0; at < bytes.length; at += chunkSize) {
    index.push(bytes.subarray(at, at + chunkSize));
  }
  index.finish();
  return index;
}

/** Frame headers decode to the length, rate and channel layout the bits describe. */
test("parses MPEG Layer III frame headers", () => {
  assert.deepEqual(parseMp3FrameHeader(frame(true), 0), {
    version: 1,
    sampleRate: 44_100,
    channelCount: 2,
    frameLength: 418,
    samplesPerFrame: 1_152,
  });
  // MPEG-2, 64 kbps, 22.05 kHz, mono.
  assert.deepEqual(
    parseMp3FrameHeader(new Uint8Array([0xff, 0xf3, 0x80, 0xc0]), 0),
    {
      version: 2,
      sampleRate: 22_050,
      channelCount: 1,
      frameLength: 208,
      samplesPerFrame: 576,
    },
  );
  // Layer II and a free-format bitrate are rejected.
  assert.equal(
    parseMp3FrameHeader(new Uint8Array([0xff, 0xfd, 0x90, 0x44]), 0),
    null,
  );
  assert.equal(
    parseMp3FrameHeader(new Uint8Array([0xff, 0xfb, 0x00, 0x44]), 0),
    null,
  );
});

/**
 * An ID3 tag, a LAME info frame, padded and unpadded frames and trailing tag bytes are
 * indexed the same however the download is chunked: the info frame is skipped, its
 * gapless delay and padding trim the playable length, and the tag is not a frame.
 */
test("indexes frames across download chunks with gapless trimming", () => {
  const id3 = new Uint8Array(10 + 300);
  id3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x02, 0x2c]);
  const audio = Array.from({ length: 12 }, (_, i) => frame(i % 3 === 0));
  const trailer = new Uint8Array(128).fill(0x54);
  const file = concat([id3, lameInfoFrame(12, 576, 1_000), ...audio, trailer]);
  const expectedOffsets: number[] = [];
  let at = id3.length + 417;
  for (const part of audio) {
    expectedOffsets.push(at);
    at += part.length;
  }
  for (const chunkSize of [1, 7, 400, 4_096, file.length]) {
    const index = indexInChunks(file, chunkSize);
    assert.equal(index.frameCount, 12, `chunk size ${chunkSize}`);
    assert.deepEqual(
      Array.from({ length: 12 }, (_, i) => index.frameOffset(i)),
      expectedOffsets,
    );
    assert.equal(index.frameEnd(11), at);
    assert.equal(index.info?.startSkip, 576 + MP3_DECODER_DELAY);
    // The decoder delay is dropped at the start and comes back at the end.
    assert.equal(index.totalSamples(), 12 * 1_152 - 576 - 1_000);
    assert.equal(index.info?.endTrim, 1_000 - MP3_DECODER_DELAY);
  }
});

/** Before the scan finishes, the info frame's count gives the length and readers can wait. */
test("announces length early and wakes readers as frames arrive", async () => {
  const file = concat([
    lameInfoFrame(4, 0, 0),
    ...Array.from({ length: 4 }, () => frame(false)),
  ]);
  const index = new Mp3FrameIndex();
  index.push(file.subarray(0, 417 * 2 - 10));
  assert.equal(index.frameCount, 0);
  assert.equal(index.totalSamples(), 4 * 1_152 - MP3_DECODER_DELAY);
  let woke = false;
  const waiting = index.waitForFrame(2).then(() => {
    woke = true;
  });
  index.push(file.subarray(417 * 2 - 10, 417 * 4 - 10));
  await Promise.resolve();
  assert.equal(index.frameCount, 2);
  assert.equal(woke, false);
  index.push(file.subarray(417 * 4 - 10));
  await waiting;
  assert.equal(woke, true);
  assert.equal(index.frameCount, 4);
  index.finish();
  await index.waitForFrame(10);
});

/** The bundled sample audio indexes to the frame count ffprobe reports. */
test("indexes the bundled sample audio", () => {
  const bytes = new Uint8Array(
    readFileSync(
      join(repoRoot, "crates/app-runtime/assets/sample-audio/lofi.mp3"),
    ),
  );
  const index = indexInChunks(bytes, 65_536);
  assert.equal(index.frameCount, 1_452);
  assert.equal(index.info?.sampleRate, 44_100);
  assert.equal(index.totalSamples(), 1_452 * 1_152);
});
