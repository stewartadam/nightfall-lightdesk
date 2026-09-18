// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { TransitionMode } from "../types";
import {
  durationsNearlyEqual,
  durationToMs,
  durationToSeconds,
  msToDuration,
  secondsNearlyEqual,
  secondsToDuration,
  transitionModeToDuration,
  transitionModeToSeconds,
  ZERO_DURATION,
} from "./duration";

test("duration conversion helpers round-trip milliseconds and seconds", () => {
  assert.deepEqual(msToDuration(1250), { secs: 1, nanos: 250_000_000 });
  assert.equal(durationToMs({ secs: 1, nanos: 250_000_000 }), 1250);
  assert.deepEqual(secondsToDuration(1.25), { secs: 1, nanos: 250_000_000 });
  assert.equal(durationToSeconds({ secs: 1, nanos: 250_000_000 }), 1.25);
  assert.deepEqual(msToDuration(-1), ZERO_DURATION);
});

test("duration comparison helpers use configurable tolerances", () => {
  assert.equal(secondsNearlyEqual(1, 1.0004), true);
  assert.equal(secondsNearlyEqual(1, 1.001), false);
  assert.equal(
    durationsNearlyEqual({ secs: 1, nanos: 0 }, { secs: 1, nanos: 400_000 }),
    true,
  );
});

test("transition mode helpers expose representative duration values", () => {
  const fixed: TransitionMode = {
    type: "Fixed",
    data: { secs: 2, nanos: 0 },
  };
  const interpolated: TransitionMode = {
    type: "Interpolated",
    data: {
      start: { secs: 1, nanos: 0 },
      end: { secs: 3, nanos: 0 },
    },
  };
  const manual: TransitionMode = {
    type: "Manual",
    data: [
      { secs: 4, nanos: 0 },
      { secs: 5, nanos: 0 },
    ],
  };

  assert.deepEqual(transitionModeToDuration(fixed), { secs: 2, nanos: 0 });
  assert.deepEqual(transitionModeToDuration(interpolated), {
    secs: 1,
    nanos: 0,
  });
  assert.deepEqual(transitionModeToDuration(manual), { secs: 4, nanos: 0 });
  assert.equal(transitionModeToSeconds(fixed), 2);
});
