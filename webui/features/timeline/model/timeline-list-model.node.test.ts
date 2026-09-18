// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Timeline } from "../../../types";
import {
  buildTimelineList,
  indexTimelinesByUid,
  nextTimelineId,
  normalizeTimelineUid,
  timelineAudioLabel,
  timelineExclusivelyOwnsTimecode,
} from "./timeline-list-model";

/** Builds the timeline fields consumed by list projection tests. */
function timeline(
  uid: string,
  id: number,
  timecodeUid = `timecode-${uid}`,
  audioPath = "",
): Timeline {
  return {
    identifiers: { uid, id, label: `Timeline ${id}` },
    timecode_uid: timecodeUid,
    audio_path: audioPath,
  } as unknown as Timeline;
}

/** Verifies UID normalization, numeric ordering, indexing, and gap allocation. */
test("projects timelines into stable identity and display order", () => {
  const first = timeline("AA-BB", 1);
  const third = timeline("CC-DD", 3);
  const ordered = buildTimelineList({ third, first });

  assert.deepEqual(
    ordered.map((entry) => entry.identifiers.id),
    [1, 3],
  );
  assert.equal(normalizeTimelineUid("AA-BB"), "aabb");
  assert.equal(indexTimelinesByUid(ordered).get("ccdd"), third);
  assert.equal(nextTimelineId(ordered), 2);
});

/** Verifies audio labels and exclusive linked-timecode ownership projection. */
test("formats audio and detects shared timecodes", () => {
  const first = timeline("first", 1, "shared", "/show/audio/intro.wav");
  const second = timeline("second", 2, "shared");
  const unique = timeline("unique", 3, "unique");

  assert.equal(timelineAudioLabel(first), "intro.wav");
  assert.equal(timelineAudioLabel(second), "No audio");
  assert.equal(
    timelineExclusivelyOwnsTimecode([first, second, unique], first),
    false,
  );
  assert.equal(
    timelineExclusivelyOwnsTimecode([first, second, unique], unique),
    true,
  );
});
