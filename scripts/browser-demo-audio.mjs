// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const SAMPLE_RATE_HZ = 8_000;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/";
const SAMPLE_DURATION_SECONDS = 4;

/** Write one ASCII chunk identifier into a WAV data view. */
function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/** Build a deterministic mono PCM click track without external media inputs. */
export function createSampleWav() {
  const sampleCount = SAMPLE_RATE_HZ * SAMPLE_DURATION_SECONDS;
  const buffer = new ArrayBuffer(44 + sampleCount);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE_HZ, true);
  view.setUint32(28, SAMPLE_RATE_HZ, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount, true);

  for (let index = 0; index < sampleCount; index++) {
    const seconds = index / SAMPLE_RATE_HZ;
    const beatPhase = seconds % 0.5;
    const envelope = Math.exp(-beatPhase * 12);
    const carrier = Math.sin(seconds * Math.PI * 2 * 220);
    view.setUint8(44 + index, 128 + Math.round(carrier * envelope * 54));
  }
  return new Uint8Array(buffer);
}

/** Report whether a file holds real media rather than an unfetched Git LFS pointer. */
function isFetchedMedia(path) {
  if (!existsSync(path)) return false;
  const head = readFileSync(path).subarray(0, LFS_POINTER_PREFIX.length);
  return head.toString("utf8") !== LFS_POINTER_PREFIX;
}

/**
 * Write audio for every timeline the demo showfile references.
 * Bundled sample tracks with a matching file name are copied as-is; any other
 * path, or a sample whose LFS object was not fetched, receives the generated click track.
 * Returns each written path with the source used.
 */
export function writeTimelineAudio({ showfilePath, sampleAudioDir }) {
  const showfile = JSON.parse(readFileSync(showfilePath, "utf8"));
  const audioPaths = [
    ...new Set(
      (showfile.timelines ?? [])
        .map((timeline) => timeline.audio_path)
        .filter((audioPath) => typeof audioPath === "string" && audioPath),
    ),
  ];
  if (audioPaths.length === 0) {
    throw new Error("Browser demo showfile does not reference timeline audio");
  }
  return audioPaths.map((audioPath) => {
    const outputPath = resolve(dirname(showfilePath), audioPath);
    const samplePath = resolve(sampleAudioDir, basename(audioPath));
    mkdirSync(dirname(outputPath), { recursive: true });
    if (isFetchedMedia(samplePath)) {
      copyFileSync(samplePath, outputPath);
      return { path: outputPath, source: "sample" };
    }
    writeFileSync(outputPath, createSampleWav());
    return { path: outputPath, source: "generated" };
  });
}
