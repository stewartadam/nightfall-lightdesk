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

import { copyTimelineAudio } from "./browser-demo-audio.mjs";

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

/** Every referenced timeline gets its sample track once, matched by file name. */
test("copies the bundled sample track for every timeline", () => {
  const demo = createDemo([
    "timeline-audio/a/lofi.mp3",
    "timeline-audio/b/rap.mp3",
    "timeline-audio/a/lofi.mp3",
  ]);
  try {
    writeFileSync(join(demo.sampleAudioDir, "lofi.mp3"), "real lofi bytes");
    writeFileSync(join(demo.sampleAudioDir, "rap.mp3"), "real rap bytes");
    const written = copyTimelineAudio(demo);
    assert.equal(written.length, 2);
    assert.equal(
      readFileSync(join(demo.showDir, "timeline-audio/a/lofi.mp3"), "utf8"),
      "real lofi bytes",
    );
    assert.equal(
      readFileSync(join(demo.showDir, "timeline-audio/b/rap.mp3"), "utf8"),
      "real rap bytes",
    );
  } finally {
    rmSync(demo.root, { recursive: true, force: true });
  }
});

/** An unfetched LFS pointer must never ship as audio, so packaging stops with a fix. */
test("rejects a sample track that is still an LFS pointer", () => {
  const demo = createDemo(["timeline-audio/a/lofi.mp3"]);
  try {
    writeFileSync(
      join(demo.sampleAudioDir, "lofi.mp3"),
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n",
    );
    assert.throws(() => copyTimelineAudio(demo), /git lfs pull/);
  } finally {
    rmSync(demo.root, { recursive: true, force: true });
  }
});

/** A timeline whose audio has no bundled track is a packaging error. */
test("rejects a timeline without a bundled sample track", () => {
  const demo = createDemo(["timeline-audio/a/unknown.mp3"]);
  try {
    assert.throws(
      () => copyTimelineAudio(demo),
      /No bundled sample track for timeline-audio\/a\/unknown\.mp3/,
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
      () => copyTimelineAudio(demo),
      /does not reference timeline audio/,
    );
  } finally {
    rmSync(demo.root, { recursive: true, force: true });
  }
});
