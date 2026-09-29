// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { VisualizerStats } from "../../../state/appStores";
import {
  GpuFrameTimer,
  MAX_READBACK_RETRIES,
  type TimestampRenderer,
} from "../rendering/gpu-frame-timer";
import { Instrumentation } from "./instrumentation";

const FRAME_INTERVAL_MS = 1000 / 60;

/** Slow readbacks are counted once, without overweighting repeated reports of the same frame. */
test("instrumentation averages distinct GPU samples and exposes unavailable timing", () => {
  const instrumentation = new Instrumentation({ renderMode: "main-thread" });
  const stats: VisualizerStats[] = [];
  instrumentation.setStatsCallback((value) => {
    if (value) stats.push(value);
  });
  recordSteadyFrames(instrumentation, 1000, 10);
  assert.equal(stats.at(-1)?.gpuMs, undefined);
  for (let i = 0; i < 10; i++) {
    instrumentation.recordFrame(1200 + i * FRAME_INTERVAL_MS, {
      updateMs: 1,
      renderMs: 2,
      gpu: i === 0 ? { id: 1, milliseconds: 8 } : { id: 2, milliseconds: 2 },
    });
  }
  assert.equal(stats.at(-1)?.gpuMs, 5);
  instrumentation.pause();
  assert.equal(stats.at(-1)?.gpuMs, undefined);
});

/** Drains a GPU timer's readback and cleanup microtasks. */
async function flushReadback(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Stats keep no stale GPU average once readback failures exhaust the timer's retries. */
test("instrumentation drops GPU timing when the timer stops producing samples", async () => {
  let failing = false;
  const renderer: TimestampRenderer = {
    backend: {
      trackTimestamp: false,
      timestampQueryPool: {
        render: {
          timestamps: new Map(),
          currentQueryIndex: 1,
          lastInterval: [0n, 3_000_000n],
        },
      },
    },
    hasFeature: () => true,
    resolveTimestampsAsync: async (type) => {
      if (type === "compute") return undefined;
      if (failing) throw new Error("mapping failed");
      return 3;
    },
  };
  const timer = new GpuFrameTimer(0);
  const instrumentation = new Instrumentation({ renderMode: "worker" });
  let latest: VisualizerStats | null = null;
  instrumentation.setStatsCallback((stats) => {
    latest = stats;
  });
  let now = 1_000;
  /** Renders and records one frame the way the renderers wire the timer to instrumentation. */
  const frame = async () => {
    timer.begin(renderer, now);
    timer.end(renderer);
    await flushReadback();
    instrumentation.recordFrame(now, {
      updateMs: 1,
      renderMs: 2,
      gpu: timer.reading,
    });
    now += 60_000;
  };

  for (let i = 0; i < 10; i++) await frame();
  assert.equal((latest as VisualizerStats | null)?.gpuMs, 3);

  failing = true;
  for (let i = 0; i < (MAX_READBACK_RETRIES + 2) * 2; i++) await frame();
  assert.equal(timer.available, false);
  for (let i = 0; i < 10; i++) await frame();
  assert.equal((latest as VisualizerStats | null)?.gpuMs, undefined);
  await timer.dispose();
});

/** A resumed renderer reports absent GPU timing until a fresh sample arrives, not the pre-pause average. */
test("instrumentation clears GPU samples on resume and ignores the stale pre-pause sample", () => {
  const instrumentation = new Instrumentation({
    renderMode: "main-thread",
    diagnostics: true,
  });
  let latest: VisualizerStats | null = null;
  instrumentation.setStatsCallback((stats) => {
    latest = stats;
  });
  const stale = { id: 4, milliseconds: 9, passes: { scene: 9 } };
  for (let i = 0; i < 10; i++)
    instrumentation.recordFrame(1_000 + i * FRAME_INTERVAL_MS, {
      updateMs: 1,
      renderMs: 2,
      gpu: stale,
    });
  assert.equal((latest as VisualizerStats | null)?.gpuMs, 9);

  instrumentation.pause();
  instrumentation.resume();
  for (let i = 0; i < 10; i++)
    instrumentation.recordFrame(5_000 + i * FRAME_INTERVAL_MS, {
      updateMs: 1,
      renderMs: 2,
      gpu: stale,
    });
  const resumed = latest as VisualizerStats | null;
  assert.equal(resumed?.gpuMs, undefined);
  assert.equal(resumed?.gpuPasses, undefined);

  for (let i = 0; i < 10; i++)
    instrumentation.recordFrame(6_000 + i * FRAME_INTERVAL_MS, {
      updateMs: 1,
      renderMs: 2,
      gpu: { id: 5, milliseconds: 2 },
    });
  assert.equal((latest as VisualizerStats | null)?.gpuMs, 2);
});

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
  const instrumentation = new Instrumentation({ renderMode: "main-thread" });
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
  const instrumentation = new Instrumentation({ renderMode: "main-thread" });
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

/** Developer diagnostics are published only when requested, while core stats are always present. */
test("instrumentation gates pacing, resolution scales and GPU passes behind diagnostics", () => {
  for (const diagnostics of [false, true]) {
    const instrumentation = new Instrumentation({
      renderMode: "worker",
      diagnostics,
    });
    let latest: VisualizerStats | null = null;
    instrumentation.setStatsCallback((stats) => {
      latest = stats;
    });
    for (let index = 0; index < 10; index += 1) {
      instrumentation.recordFrame(1_000 + index * FRAME_INTERVAL_MS, {
        updateMs: 1,
        renderMs: 2,
        sceneScale: 0.75,
        atmosphereScale: 0.5,
        omittedSurfaceLights: 3,
        gpu: { id: 1, milliseconds: 4, passes: { scene: 4 } },
      });
    }
    const stats = latest as VisualizerStats | null;
    assert.ok(stats);
    assert.equal(stats.renderMode, "worker");
    assert.equal(stats.gpuMs, 4);
    assert.equal(stats.omittedSurfaceLights, 3);
    if (diagnostics) {
      assert.equal(stats.sceneScale, 0.75);
      assert.equal(stats.atmosphereScale, 0.5);
      assert.deepEqual(stats.gpuPasses, { scene: 4 });
      assert.equal(stats.framePacing?.frames, 10);
    } else {
      for (const key of [
        "framePacing",
        "sceneScale",
        "atmosphereScale",
        "gpuPasses",
      ] as const)
        assert.equal(key in stats, false, key);
    }
  }
});
