// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  beatScaleMarkers,
  captureOriginForTaps,
  formatBpm,
  formatMs,
  oneShotSequencePatternFromTaps,
  segmentTimelinePercent,
} from "./panel-model";

/** Verifies compact timing presentation keeps milliseconds and seconds readable. */
test("tap pattern timing formatters preserve compact units", () => {
  assert.equal(formatMs(999.6), "1000ms");
  assert.equal(formatMs(1250), "1.250s");
  assert.equal(formatBpm(99.5), "99.50");
  assert.equal(formatBpm(120), "120.0");
});

/** Verifies restored taps anchor their last event at the current monotonic time. */
test("captureOriginForTaps aligns restored taps with the supplied clock", () => {
  assert.equal(
    captureOriginForTaps(
      [
        { id: 1, timeMs: 100 },
        { id: 2, timeMs: 350 },
      ],
      1000,
    ),
    650,
  );
});

/** Verifies timeline projection clamps markers and preserves fractional beat endpoints. */
test("tap pattern timeline projection uses padded bounded coordinates", () => {
  assert.equal(segmentTimelinePercent(-10, 100), 1.5);
  assert.equal(segmentTimelinePercent(200, 100), 98.5);
  assert.deepEqual(beatScaleMarkers(2.5), [0, 1, 2, 2.5]);
});

/** Verifies one-shot sequence projection preserves captured tap intervals. */
test("one-shot tap projection builds ordered sequence phases", () => {
  assert.deepEqual(
    oneShotSequencePatternFromTaps(
      [
        { id: 2, timeMs: 400 },
        { id: 1, timeMs: 100 },
      ],
      200,
    ),
    {
      clusters: [
        { id: 0, phaseMs: 0, tapIds: [1], averageErrorMs: 0 },
        { id: 1, phaseMs: 300, tapIds: [2], averageErrorMs: 0 },
      ],
      loopLengthMs: 500,
    },
  );
});
