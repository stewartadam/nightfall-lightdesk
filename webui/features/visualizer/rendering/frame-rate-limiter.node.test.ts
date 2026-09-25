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

/** Browser timestamp quantization must not turn a steady 60 Hz display into a 40 FPS renderer. */
test("consumeDueFrame preserves every quantized 60 Hz refresh", () => {
  let accumulator = 0;
  let previousTime = 0;
  let renderedFrames = 0;
  for (let callback = 1; callback <= 720; callback++) {
    const time = Math.round(callback * TARGET_FRAME_TIME * 10) / 10;
    accumulator += time - previousTime;
    previousTime = time;
    const remainder = consumeDueFrame(accumulator);
    if (remainder === null) continue;
    renderedFrames++;
    accumulator = remainder;
  }
  assert.equal(renderedFrames, 720);
});

/** The timestamp tolerance must still throttle high-refresh displays after quantization. */
test("consumeDueFrame caps quantized 120 Hz refreshes", () => {
  let accumulator = 0;
  let previousTime = 0;
  let renderedFrames = 0;
  for (let callback = 1; callback <= 1440; callback++) {
    const time = Math.round(callback * (1000 / 120) * 10) / 10;
    accumulator += time - previousTime;
    previousTime = time;
    const remainder = consumeDueFrame(accumulator);
    if (remainder === null) continue;
    renderedFrames++;
    accumulator = remainder;
  }
  assert.equal(renderedFrames, 720);
});
