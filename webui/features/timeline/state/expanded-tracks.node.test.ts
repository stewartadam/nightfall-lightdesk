// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeExpandedTracks,
  expandedTimelineTracks,
  setTrackExpanded,
} from "./expanded-tracks";

/** Verifies persisted expand state keeps only string track IDs. */
test("decodeExpandedTracks filters malformed persisted entries", () => {
  assert.deepEqual(decodeExpandedTracks('["track-a", 3, null, "track-b"]'), [
    "track-a",
    "track-b",
  ]);
  assert.deepEqual(decodeExpandedTracks("not-json"), []);
  assert.deepEqual(decodeExpandedTracks('{"track-a": true}'), []);
});

/** Verifies expanding twice lists a track once and collapsing removes only that track. */
test("setTrackExpanded adds and removes one track without duplicates", () => {
  expandedTimelineTracks.set(["other"]);
  setTrackExpanded("track-a", true);
  setTrackExpanded("track-a", true);
  assert.deepEqual(expandedTimelineTracks.get(), ["other", "track-a"]);
  setTrackExpanded("track-a", false);
  assert.deepEqual(expandedTimelineTracks.get(), ["other"]);
  expandedTimelineTracks.set([]);
});
