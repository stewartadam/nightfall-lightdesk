// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const SAMPLE_RATE_HZ = 8_000;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/";
const SAMPLE_DURATION_SECONDS = 4;

/** Write one ASCII chunk identifier into a WAV data view. */
function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/** Build a deterministic mono PCM click track for specs that need audio without external media. */
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

/** Parse one demo showfile snapshot, inflating it first when stored as `.json.gz`. */
export function readShowfileJson(path) {
  const bytes = readFileSync(path);
  const json = path.endsWith(".gz") ? gunzipSync(bytes) : bytes;
  return JSON.parse(json.toString("utf8"));
}

/** Report whether a file holds real media rather than an unfetched Git LFS pointer. */
function isFetchedMedia(path) {
  const head = readFileSync(path).subarray(0, LFS_POINTER_PREFIX.length);
  return head.toString("utf8") !== LFS_POINTER_PREFIX;
}

/**
 * Copy the bundled sample track for every timeline the demo showfile
 * references, matched by file name. A missing track, or one whose Git LFS
 * object was never fetched, is a packaging error. Returns each written path.
 */
export function copyTimelineAudio({ showfilePath, sampleAudioDir }) {
  const showfile = readShowfileJson(showfilePath);
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
    if (!existsSync(samplePath)) {
      throw new Error(
        `No bundled sample track for ${audioPath} (${samplePath})`,
      );
    }
    if (!isFetchedMedia(samplePath)) {
      throw new Error(
        `${samplePath} is a Git LFS pointer; run \`git lfs pull\` first`,
      );
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(samplePath, outputPath);
    return outputPath;
  });
}
