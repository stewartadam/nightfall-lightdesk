// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { FramePacing } from "./frame-pacing";

/** Variable work can produce a long completion gap while every frame still meets its deadline. */
test("frame pacing separates completion jitter from skipped and late frames", () => {
  const pacing = new FramePacing();
  pacing.record(6, 2, 3, 1, 0);
  pacing.record(32.5, 3, 2.8, 26.7, 16.7);
  const jitter = pacing.snapshot();
  assert.equal(jitter.over25Ms, 1);
  assert.deepEqual(jitter.scheduling, {
    frames: 2,
    over25Ms: 0,
    lateSubmissions: 0,
    windowMaxIntervalMs: 16.7,
    windowMaxLatencyMs: 15.8,
  });

  // A skipped refresh and a frame submitted after its budget must both be visible.
  pacing.record(55, 2, 2, 51, 50);
  pacing.record(90, 5, 15, 70, 66.7);
  const delayed = pacing.snapshot().scheduling!;
  assert.equal(delayed.frames, 4);
  assert.equal(delayed.over25Ms, 1);
  assert.equal(delayed.lateSubmissions, 1);
  assert.ok(Math.abs(delayed.windowMaxIntervalMs - 33.3) < 1e-9);
  assert.ok(Math.abs(delayed.windowMaxLatencyMs - 23.3) < 1e-9);

  pacing.suspend();
  pacing.record(10002, 1, 1, 10000, 10000);
  assert.deepEqual(pacing.snapshot().scheduling, {
    frames: 5,
    over25Ms: 1,
    lateSubmissions: 1,
    windowMaxIntervalMs: 0,
    windowMaxLatencyMs: 2,
  });
});

/** Missing or invalid scheduler timestamps cannot bridge gaps or invent missed frames. */
test("frame scheduling resets its interval baseline after invalid timestamps", () => {
  const pacing = new FramePacing();
  pacing.record(105, 1, 1, 101, 100);
  pacing.record(120, 1, 1, 116, NaN);
  pacing.record(205, 1, 1, 201, 200);
  pacing.record(305, 1, 1, 301, 400);
  pacing.record(405, 1, 1, 401, 400);
  pacing.record(55, 1, 1, 51, 50);
  assert.deepEqual(pacing.snapshot().scheduling, {
    frames: 4,
    over25Ms: 0,
    lateSubmissions: 0,
    windowMaxIntervalMs: 0,
    windowMaxLatencyMs: 5,
  });
});

/** A single missed frame survives publication instead of disappearing into an FPS average. */
test("frame pacing counts long submissions and publishes independent window maxima", () => {
  const pacing = new FramePacing();
  pacing.record(0);
  pacing.record(16);
  pacing.record(49, 2, 14);
  assert.deepEqual(pacing.snapshot(), {
    frames: 3,
    over25Ms: 1,
    windowMaxMs: 33,
    worstFrame: { completedAt: 49, intervalMs: 33, updateMs: 2, renderMs: 14 },
  });
  pacing.record(65);
  assert.deepEqual(pacing.snapshot(), {
    frames: 4,
    over25Ms: 1,
    windowMaxMs: 16,
  });
  pacing.suspend();
  pacing.record(5000);
  pacing.record(5016);
  assert.deepEqual(pacing.snapshot(), {
    frames: 6,
    over25Ms: 1,
    windowMaxMs: 16,
  });
});

/** Invalid samples and a reset clock do not create false stalls. */
test("frame pacing ignores nonfinite times and rebases a backwards clock", () => {
  const pacing = new FramePacing();
  pacing.record(100);
  pacing.record(Number.NaN);
  pacing.record(50);
  pacing.record(66);
  assert.deepEqual(pacing.snapshot(), {
    frames: 3,
    over25Ms: 0,
    windowMaxMs: 16,
  });
});

/** Scheduling delay and all callback work remain distinct from the selected update/render phases. */
test("stalled submissions retain callback scheduling and total CPU duration", () => {
  const pacing = new FramePacing();
  pacing.record(16);
  pacing.record(49, 2, 14, 25, 20);
  assert.deepEqual(pacing.snapshot().worstFrame, {
    completedAt: 49,
    intervalMs: 33,
    updateMs: 2,
    renderMs: 14,
    callbackDelayMs: 5,
    cpuFrameMs: 24,
  });
  pacing.record(80, 1, 2, NaN, NaN);
  assert.deepEqual(pacing.snapshot().worstFrame, {
    completedAt: 80,
    intervalMs: 31,
    updateMs: 1,
    renderMs: 2,
  });
});
