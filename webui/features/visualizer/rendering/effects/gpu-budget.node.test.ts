// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  GPU_SAMPLE_TIMEOUT_MS,
  GpuBudget,
  type GpuBudgetSample,
  TIMING_LOSS_RECOVERY_MS,
} from "./gpu-budget";

const FRAME_MS = 16;

interface FrameLoad {
  /** GPU sample visible to the frame, if timing is available. */
  gpu?: GpuBudgetSample;
  renderMs?: number;
  updateMs?: number;
}

/** Drives the budget like the render loop and returns the times at which shadow refreshes were granted. */
function simulate(
  budget: GpuBudget,
  start: number,
  end: number,
  load: (now: number) => FrameLoad,
): number[] {
  const grants: number[] = [];
  for (let now = start; now < end; now += FRAME_MS) {
    const { gpu, renderMs = 2, updateMs = 1 } = load(now);
    budget.observe(gpu, now);
    if (budget.canRefreshShadows(updateMs, now)) grants.push(now);
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

/** A stall or repeated readback must not trigger repeated target reallocations. */
test("resolution ignores stale samples and isolated spikes", () => {
  const budget = new GpuBudget();
  for (let i = 0; i < 500; i++)
    budget.observe({ id: 1, milliseconds: 30 }, i * 17);
  assert.equal(budget.resolutionScale, 0.5);
  budget.observe({ id: 2, milliseconds: 2 }, 9000);
  budget.observe({ id: 3, milliseconds: 30 }, 9017);
  assert.equal(budget.resolutionScale, 0.5);
  budget.observe(undefined, 10000);
  budget.observe({ id: 4, milliseconds: NaN }, 10001);
  assert.equal(budget.resolutionScale, 0.5);
});

/** A degraded tier must not persist forever once GPU timing stops arriving. */
test("resolution restores its default tier after timing is lost", () => {
  const budget = new GpuBudget();
  for (let id = 0; id < 10; id++)
    budget.observe({ id, milliseconds: 12 }, id * 1001);
  assert.equal(budget.resolutionScale, 0.25);
  const lastSampleAt = 9 * 1001;
  budget.observe(undefined, lastSampleAt + TIMING_LOSS_RECOVERY_MS - 1);
  budget.observe({ id: 9, milliseconds: 12 }, lastSampleAt + 1000);
  assert.equal(
    budget.resolutionScale,
    0.25,
    "brief gaps and stale samples keep the tier",
  );
  budget.observe(undefined, lastSampleAt + TIMING_LOSS_RECOVERY_MS + 1);
  assert.equal(budget.resolutionScale, 0.5);
  for (let id = 10; id < 13; id++)
    budget.observe(
      { id, milliseconds: 12 },
      lastSampleAt + TIMING_LOSS_RECOVERY_MS + 1001 + id,
    );
  assert.equal(
    budget.resolutionScale,
    0.375,
    "returning timing resumes degradation",
  );
});

/** Sustained overload reduces cost to a floor; recovery requires sustained headroom. */
test("resolution bounds cost and recovers with hysteresis", () => {
  const budget = new GpuBudget();
  for (let id = 0; id < 10; id++)
    budget.observe({ id, milliseconds: 12 }, id * 1001);
  assert.equal(budget.resolutionScale, 0.25);
  for (let id = 10; id < 129; id++)
    budget.observe({ id, milliseconds: 2 }, 10000 + id * 17);
  assert.equal(budget.resolutionScale, 0.25);
  budget.observe({ id: 129, milliseconds: 2 }, 13000);
  assert.equal(budget.resolutionScale, 0.375);
  budget.observe({ id: 130, milliseconds: 12 }, 13017);
  assert.equal(budget.resolutionScale, 0.375);
});

/** Without timestamp queries, sustained CPU headroom alone keeps shadows refreshing at a conservative cadence. */
test("missing GPU timing falls back to a bounded CPU-gated shadow cadence", () => {
  const budget = new GpuBudget();
  const grants = simulate(budget, 0, 3000, () => ({}));
  assertSteadyCadence(grants, budget.shadowRefreshIntervalMs);
  assert.ok(grants[0] < 200, "fallback should start promptly");
});

/** Fresh GPU samples with headroom admit shadow refreshes faster than the fallback cadence. */
test("GPU headroom admits shadow refreshes at the timed cadence", () => {
  const fallback = new GpuBudget();
  simulate(fallback, 0, 100, () => ({}));
  const budget = new GpuBudget();
  const grants = simulate(budget, 0, 3000, (now) => ({
    gpu: gpuSample(now, 2),
  }));
  assertSteadyCadence(grants, budget.shadowRefreshIntervalMs);
  assert.ok(budget.shadowRefreshIntervalMs < fallback.shadowRefreshIntervalMs);
});

/** GPU overload stops shadow refreshes; they resume only after sustained headroom returns. */
test("GPU overload denies shadow refreshes until headroom is sustained", () => {
  const budget = new GpuBudget();
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
test("CPU overload denies shadow refreshes with and without GPU timing", () => {
  for (const timed of [false, true]) {
    const budget = new GpuBudget();
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
  const budget = new GpuBudget();
  simulate(budget, 0, 1000, (now) => ({ gpu: gpuSample(now, 2) }));
  const stale = { id: 9, milliseconds: 2 };
  const grants = simulate(budget, 1000, 4000, () => ({ gpu: stale }));
  const late = grants.filter((time) => time > 1000 + GPU_SAMPLE_TIMEOUT_MS);
  assertSteadyCadence(late, budget.shadowRefreshIntervalMs);
});

/** Invalid instrumentation must fail closed instead of being mistaken for idle hardware. */
test("invalid timing never enables a shadow refresh", () => {
  for (const invalid of [NaN, Infinity, -1]) {
    const gpuInvalid = new GpuBudget();
    simulate(gpuInvalid, 0, 1000, (now) => ({ gpu: gpuSample(now, 2) }));
    assert.deepEqual(
      simulate(gpuInvalid, 1000, 2500, (now) => ({
        gpu: gpuSample(now, invalid),
      })),
      [],
      "invalid readbacks still prove timing exists, so they never trigger the CPU fallback",
    );
    const cpuInvalid = new GpuBudget();
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
