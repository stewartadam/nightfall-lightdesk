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
import { MP3_DECODER_DELAY, readMp3Gapless } from "./mp3-gapless";

const repoRoot = process.env.NIGHTFALL_REPO_ROOT ?? process.cwd();

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo: 417 bytes.
const HEADER_128K = [0xff, 0xfb, 0x90, 0x44];

/** Build a LAME info frame with every optional Xing field, `delay` and `padding`. */
function lameInfoFrame(delay: number, padding: number): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set(HEADER_128K);
  const xing = 4 + 32;
  bytes.set(
    [..."Info"].map((c) => c.charCodeAt(0)),
    xing,
  );
  new DataView(bytes.buffer).setUint32(xing + 4, 0xf);
  const lame = xing + 8 + 4 + 4 + 100 + 4;
  bytes.set(
    [..."LAME3.100"].map((c) => c.charCodeAt(0)),
    lame,
  );
  bytes[lame + 21] = delay >> 4;
  bytes[lame + 22] = ((delay & 0x0f) << 4) | (padding >> 8);
  bytes[lame + 23] = padding & 0xff;
  return bytes;
}

/** An ID3v2 tag of `size` bytes after its header. */
function id3Tag(size: number): Uint8Array {
  const bytes = new Uint8Array(10 + size);
  bytes.set([0x49, 0x44, 0x33, 4, 0]);
  bytes.set(
    [size >> 21, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f],
    6,
  );
  return bytes;
}

/**
 * A reader over `file` that hands out exactly the bytes asked for, so the gapless reader
 * has to ask again for anything further, and records each request.
 */
function reader(file: Uint8Array, requests: number[] = []) {
  return async (end: number) => {
    requests.push(end);
    return file.subarray(0, Math.min(file.length, end));
  };
}

/**
 * Stacked ID3 tags and the padding after them are skipped, and the LAME delay and padding
 * become trims.
 */
test("reads the LAME gapless record after ID3 tags", async () => {
  const parts = [
    id3Tag(300),
    id3Tag(70_000),
    new Uint8Array(100),
    lameInfoFrame(576, 1_000),
  ];
  const file = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    file.set(part, at);
    at += part.length;
  }
  const requests: number[] = [];
  assert.deepEqual(await readMp3Gapless(reader(file, requests)), {
    startSkip: 576 + MP3_DECODER_DELAY,
    endTrim: 1_000 - MP3_DECODER_DELAY,
  });
  // One read per tag header, then one for the info frame.
  assert.equal(requests.length, 4);
});

/** Padding shorter than the decoder delay trims nothing at the end. */
test("never trims a negative amount at the end", async () => {
  const gapless = await readMp3Gapless(reader(lameInfoFrame(0, 100)));
  assert.deepEqual(gapless, { startSkip: MP3_DECODER_DELAY, endTrim: 0 });
});

/** A file whose first frame carries audio rather than an info frame is left untrimmed. */
test("finds no record in the bundled sample audio", async () => {
  const file = new Uint8Array(
    readFileSync(
      join(repoRoot, "crates/app-runtime/assets/sample-audio/lofi.mp3"),
    ),
  );
  assert.equal(await readMp3Gapless(reader(file)), null);
  assert.equal(await readMp3Gapless(reader(new Uint8Array(4))), null);
});
