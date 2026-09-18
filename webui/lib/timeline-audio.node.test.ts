// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  configureActiveShowfileUrl,
  resolveCurrentNativeShowfileUrl,
  resolveShowfileResourceUrl,
} from "./showfile-resources";
import { resolveTimelineAudioUrl } from "./timeline-audio";

/** Native audio resolves from the mounted showfile resource root. */
test("resolveTimelineAudioUrl uses the current native showfile URL", () => {
  configureActiveShowfileUrl(
    "http://localhost:3030/api/showfiles/current/showfile.json",
  );
  assert.equal(
    resolveTimelineAudioUrl(
      "timeline-audio/abc123/42-track.mp3",
      "refresh-token",
    ),
    "http://localhost:3030/api/showfiles/current/timeline-audio/abc123/42-track.mp3?rev=refresh-token",
  );
});

/** Embedded audio uses the identical relative-resource resolution path. */
test("resolveTimelineAudioUrl uses the fetched embedded showfile URL", () => {
  configureActiveShowfileUrl("https://foo.example/bar/showfile.json");
  assert.equal(
    resolveTimelineAudioUrl("timeline-audio/abc123/42-track.mp3"),
    "https://foo.example/bar/timeline-audio/abc123/42-track.mp3",
  );
});

/** Native current-showfile URLs are rooted beneath the backend API. */
test("resolveCurrentNativeShowfileUrl identifies the mounted showfile", () => {
  assert.equal(
    resolveCurrentNativeShowfileUrl("http://localhost:3030"),
    "http://localhost:3030/api/showfiles/current/showfile.json",
  );
});

/** Showfile resource resolution rejects paths that escape their owning folder. */
test("resolveShowfileResourceUrl rejects non-relative paths", () => {
  assert.throws(
    () =>
      resolveShowfileResourceUrl(
        "../referenced-audio.wav",
        undefined,
        "https://foo.example/bar/showfile.json",
      ),
    /Invalid showfile resource path/,
  );
  assert.throws(
    () =>
      resolveShowfileResourceUrl(
        "https://other.example/audio.wav",
        undefined,
        "https://foo.example/bar/showfile.json",
      ),
    /Invalid showfile resource path/,
  );
  assert.throws(
    () =>
      resolveShowfileResourceUrl(
        "%2e%2e/referenced-audio.wav",
        undefined,
        "https://foo.example/bar/showfile.json",
      ),
    /Invalid showfile resource path/,
  );
});
