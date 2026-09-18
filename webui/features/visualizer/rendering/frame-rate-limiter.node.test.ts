// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { consumeDueFrame, TARGET_FRAME_TIME } from "./frame-rate-limiter";

/** Leaves sub-frame elapsed time untouched without scheduling a render. */
test("consumeDueFrame waits for a complete frame interval", () => {
  assert.equal(consumeDueFrame(TARGET_FRAME_TIME / 2), null);
});

/** Retains fractional timing while discarding missed whole-frame intervals. */
test("consumeDueFrame drops catch-up render backlog", () => {
  const remainder = consumeDueFrame(TARGET_FRAME_TIME * 120 + 4);
  assert.ok(remainder !== null);
  assert.ok(remainder >= 0);
  assert.ok(remainder < TARGET_FRAME_TIME);
});

/** Caps a 120 Hz callback stream to at most 60 completed renders per second. */
test("consumeDueFrame caps high-refresh callbacks", () => {
  const callbackInterval = 1000 / 120;
  let accumulator = 0;
  let renderedFrames = 0;

  for (let callback = 0; callback < 120; callback += 1) {
    accumulator += callbackInterval;
    const remainder = consumeDueFrame(accumulator);
    if (remainder === null) continue;
    renderedFrames += 1;
    accumulator = remainder;
  }

  assert.ok(renderedFrames >= 59);
  assert.ok(renderedFrames <= 60);
});
