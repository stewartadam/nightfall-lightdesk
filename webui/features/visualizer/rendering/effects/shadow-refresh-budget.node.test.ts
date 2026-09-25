// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { GpuBudgetSample } from "./atmosphere-budget";
import {
  GPU_SAMPLE_TIMEOUT_MS,
  ShadowRefreshBudget,
} from "./shadow-refresh-budget";

const FRAME_MS = 16;

interface FrameLoad {
  /** GPU sample visible to the frame, if timing is available. */
  gpu?: GpuBudgetSample;
  renderMs?: number;
  updateMs?: number;
}

/** Drives the budget like the render loop and returns the times at which refreshes were granted. */
function simulate(
  budget: ShadowRefreshBudget,
  start: number,
  end: number,
  load: (now: number) => FrameLoad,
): number[] {
  const grants: number[] = [];
  for (let now = start; now < end; now += FRAME_MS) {
    const { gpu, renderMs = 2, updateMs = 1 } = load(now);
    if (budget.canRefresh(gpu, updateMs, now)) grants.push(now);
    budget.recordRender(renderMs, updateMs);
  }
  return grants;
}

/** Emits a new GPU sample every 100ms, matching the timer's sampling interval. */
function gpuSample(now: number, milliseconds: number): GpuBudgetSample {
  return { id: Math.floor(now / 100), milliseconds };
}

/** Asserts that grants never exceed the cadence and never leave long gaps. */
function assertSteadyCadence(grants: number[], intervalMs: number): void {
  assert.ok(grants.length > 2, "expected repeated refreshes");
  for (let i = 1; i < grants.length; i++) {
    const gap = grants[i] - grants[i - 1];
    assert.ok(gap >= intervalMs, `grant gap ${gap} below cadence`);
    assert.ok(gap < intervalMs + FRAME_MS * 2, `grant gap ${gap} too long`);
  }
}

/** Without timestamp queries, sustained CPU headroom alone keeps shadows refreshing at a conservative cadence. */
test("missing GPU timing falls back to a bounded CPU-gated cadence", () => {
  const budget = new ShadowRefreshBudget();
  const grants = simulate(budget, 0, 3000, () => ({}));
  assertSteadyCadence(grants, budget.refreshIntervalMs);
  assert.ok(grants[0] < 200, "fallback should start promptly");
});

/** Fresh GPU samples with headroom admit refreshes faster than the fallback cadence. */
test("GPU headroom admits refreshes at the timed cadence", () => {
  const fallback = new ShadowRefreshBudget();
  simulate(fallback, 0, 100, () => ({}));
  const budget = new ShadowRefreshBudget();
  const grants = simulate(budget, 0, 3000, (now) => ({
    gpu: gpuSample(now, 2),
  }));
  assertSteadyCadence(grants, budget.refreshIntervalMs);
  assert.ok(budget.refreshIntervalMs < fallback.refreshIntervalMs);
});

/** GPU overload stops refreshes; they resume only after sustained headroom returns. */
test("GPU overload denies refreshes until headroom is sustained", () => {
  const budget = new ShadowRefreshBudget();
  simulate(budget, 0, 1000, (now) => ({ gpu: gpuSample(now, 2) }));
  const overloaded = simulate(budget, 1000, 2000, (now) => ({
    gpu: gpuSample(now, 20),
  }));
  assert.deepEqual(overloaded, []);
  const recovered = simulate(budget, 2000, 3000, (now) => ({
    gpu: gpuSample(now, 2),
  }));
  assert.ok(recovered.length > 0);
  assert.ok(recovered[0] >= 2200, "recovery requires several fresh samples");
});

/** CPU submission overload blocks optional work whether or not GPU timing exists. */
test("CPU overload denies refreshes with and without GPU timing", () => {
  for (const timed of [false, true]) {
    const budget = new ShadowRefreshBudget();
    const grants = simulate(budget, 0, 2000, (now) => ({
      gpu: timed ? gpuSample(now, 2) : undefined,
      renderMs: 6,
      updateMs: 4,
    }));
    assert.deepEqual(grants, []);
  }
});

/** Losing GPU timing mid-session switches to the fallback instead of freezing shadows. */
test("lost GPU timing falls back after the sample timeout", () => {
  const budget = new ShadowRefreshBudget();
  simulate(budget, 0, 1000, (now) => ({ gpu: gpuSample(now, 2) }));
  const stale = { id: 9, milliseconds: 2 };
  const grants = simulate(budget, 1000, 4000, () => ({ gpu: stale }));
  const late = grants.filter((time) => time > 1000 + GPU_SAMPLE_TIMEOUT_MS);
  assertSteadyCadence(late, budget.refreshIntervalMs);
});

/** Invalid instrumentation must fail closed instead of being mistaken for idle hardware. */
test("invalid timing never enables a shadow refresh", () => {
  for (const invalid of [NaN, Infinity, -1]) {
    const gpuInvalid = new ShadowRefreshBudget();
    simulate(gpuInvalid, 0, 1000, (now) => ({ gpu: gpuSample(now, 2) }));
    assert.deepEqual(
      simulate(gpuInvalid, 1000, 1100, (now) => ({
        gpu: gpuSample(now, invalid),
      })),
      [],
    );
    const cpuInvalid = new ShadowRefreshBudget();
    assert.deepEqual(
      simulate(cpuInvalid, 0, 1000, () => ({ renderMs: invalid })),
      [],
    );
    assert.deepEqual(
      simulate(cpuInvalid, 1000, 2000, () => ({ updateMs: invalid })),
      [],
    );
  }
});
