// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { VisualizerStats } from "../../../state/appStores";
import { Instrumentation } from "./instrumentation";

const FRAME_INTERVAL_MS = 1000 / 60;

/** Records the requested number of steady 60 FPS frames. */
function recordSteadyFrames(
  instrumentation: Instrumentation,
  startTime: number,
  frameCount: number,
): void {
  for (let index = 0; index < frameCount; index += 1) {
    instrumentation.recordFrame(startTime + index * FRAME_INTERVAL_MS, {
      updateMs: 1,
      renderMs: 2,
    });
  }
}

/** Ensures the initial timing baseline does not inflate measured FPS. */
test("instrumentation excludes the initial timing baseline from FPS", () => {
  const instrumentation = new Instrumentation();
  const publishedStats: VisualizerStats[] = [];
  instrumentation.setStatsCallback((stats) => {
    if (stats) publishedStats.push(stats);
  });

  recordSteadyFrames(instrumentation, 1_000, 10);

  const latestStats = publishedStats.at(-1);
  assert.ok(latestStats);
  assert.ok(Math.abs(latestStats.fps - 60) < 0.001);
});

/** Ensures resuming establishes a new baseline without adding a zero sample. */
test("instrumentation preserves stable FPS across resume", () => {
  const instrumentation = new Instrumentation();
  const publishedStats: VisualizerStats[] = [];
  instrumentation.setStatsCallback((stats) => {
    if (stats) publishedStats.push(stats);
  });

  recordSteadyFrames(instrumentation, 1_000, 10);
  instrumentation.resume();
  recordSteadyFrames(instrumentation, 2_000, 10);

  const latestStats = publishedStats.at(-1);
  assert.ok(latestStats);
  assert.ok(Math.abs(latestStats.fps - 60) < 0.001);
});
