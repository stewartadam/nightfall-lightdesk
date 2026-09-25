// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSampleWav, writeTimelineAudio } from "./browser-demo-audio.mjs";

/** Creates a disposable showfile directory whose timelines reference the given audio paths. */
function createDemo(audioPaths) {
  const root = mkdtempSync(join(tmpdir(), "browser-demo-audio-"));
  const showDir = join(root, "demo.nightfall-show");
  const sampleAudioDir = join(root, "sample-audio");
  mkdirSync(showDir, { recursive: true });
  mkdirSync(sampleAudioDir, { recursive: true });
  const showfilePath = join(showDir, "showfile.json");
  writeFileSync(
    showfilePath,
    JSON.stringify({
      timelines: audioPaths.map((audio_path) => ({ audio_path })),
    }),
  );
  return { root, showDir, showfilePath, sampleAudioDir };
}

/** Every referenced timeline gets audio, so the size report never finds a missing file. */
test("writes audio for every timeline, copying bundled samples by file name", () => {
  const demo = createDemo([
    "timeline-audio/a/lofi.mp3",
    "timeline-audio/b/rap.mp3",
    "timeline-audio/a/lofi.mp3",
  ]);
  try {
    writeFileSync(join(demo.sampleAudioDir, "lofi.mp3"), "real lofi bytes");
    const written = writeTimelineAudio(demo);
    assert.deepEqual(
      written.map(({ source }) => source),
      ["sample", "generated"],
    );
    assert.equal(
      readFileSync(join(demo.showDir, "timeline-audio/a/lofi.mp3"), "utf8"),
      "real lofi bytes",
    );
    assert.deepEqual(
      new Uint8Array(
        readFileSync(join(demo.showDir, "timeline-audio/b/rap.mp3")),
      ),
      createSampleWav(),
    );
  } finally {
    rmSync(demo.root, { recursive: true, force: true });
  }
});

/** An unfetched LFS pointer must not be shipped as audio; the generated track replaces it. */
test("falls back to generated audio when the sample is an LFS pointer", () => {
  const demo = createDemo(["timeline-audio/a/lofi.mp3"]);
  try {
    writeFileSync(
      join(demo.sampleAudioDir, "lofi.mp3"),
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n",
    );
    const [written] = writeTimelineAudio(demo);
    assert.equal(written.source, "generated");
    assert.deepEqual(
      new Uint8Array(readFileSync(written.path)),
      createSampleWav(),
    );
  } finally {
    rmSync(demo.root, { recursive: true, force: true });
  }
});

/** A demo showfile without timeline audio is a packaging error, not a silent no-op. */
test("rejects a showfile that references no timeline audio", () => {
  const demo = createDemo([]);
  try {
    assert.throws(
      () => writeTimelineAudio(demo),
      /does not reference timeline audio/,
    );
  } finally {
    rmSync(demo.root, { recursive: true, force: true });
  }
});
