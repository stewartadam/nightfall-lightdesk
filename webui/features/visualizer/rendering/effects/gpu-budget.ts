// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Adapts optional GPU work to measured frame cost.
 *
 * One tracker consumes each asynchronous GPU timing readback exactly once per frame; two
 * policies act on it: resolution tiers for the soft effects (atmosphere and bloom) and a
 * bounded cadence for optional shadow-map refreshes.
 */

/** Completed GPU measurements; IDs prevent stale readbacks from counting as new evidence. */
export interface GpuBudgetSample {
  id: number;
  milliseconds: number;
}

/** A frame's GPU evidence: a new usable duration, a new unusable readback, or nothing new. */
type GpuReading = number | "invalid" | "stale";

/** Linear resolution tiers for the soft effects, ordered from highest quality to the performance floor. */
const RESOLUTION_SCALES = [0.5, 0.375, 0.25] as const;
/** GPU frame time above which a sample counts as overload. */
const RESOLUTION_OVERLOAD_MS = 8;
/** GPU frame time below which a sample counts as headroom. */
const RESOLUTION_HEADROOM_MS = 4;
/** Consecutive overloaded samples that step the resolution down one tier. */
const RESOLUTION_OVERLOAD_SAMPLES = 3;
/** Consecutive samples with headroom that step the resolution back up; recovery is deliberately slow. */
const RESOLUTION_HEADROOM_SAMPLES = 120;
/** Minimum time between tier changes, so each change is measured before the next. */
const RESOLUTION_CHANGE_INTERVAL_MS = 1000;
/**
 * Without any valid timing for this long, GPU timing is considered unavailable and
 * the resolution returns to its default tier; long enough to outlast readback latency
 * on a heavily loaded GPU so overload itself never triggers a reset.
 */
export const TIMING_LOSS_RECOVERY_MS = 5000;

/** GPU frame time below which a measurement counts as spare capacity for a shadow refresh. */
const SHADOW_GPU_SPARE_MS = 6;
/** Combined CPU update and render submission time that still leaves room for an extra pass. */
const SHADOW_CPU_SPARE_MS = 8;
/** Consecutive spare measurements required before optional shadow work resumes. */
const SHADOW_SUSTAINED_SPARE = 3;
/** Shadow refresh cadence while GPU timing proves headroom. */
const SHADOW_GPU_REFRESH_INTERVAL_MS = 60;
/** Conservative shadow refresh cadence when only CPU submission time is observable. */
const SHADOW_FALLBACK_REFRESH_INTERVAL_MS = 200;
/** Without a new GPU readback for this long, shadow refreshes fall back to CPU gating. */
export const GPU_SAMPLE_TIMEOUT_MS = 1000;

/** Consumes each readback once and remembers when new and usable timing last arrived. */
class GpuSampleTracker {
  private lastId = -1;
  /** Arrival of the latest new readback, usable or not; invalid readbacks still prove timing exists. */
  lastFreshAt = -Infinity;
  /** Arrival of the latest new readback with a usable duration. */
  lastValidAt = -Infinity;

  /** Classifies this frame's sample, recording its arrival only the first time its ID is seen. */
  read(sample: GpuBudgetSample | undefined, now: number): GpuReading {
    if (sample === undefined || sample.id === this.lastId) return "stale";
    this.lastId = sample.id;
    this.lastFreshAt = now;
    if (!Number.isFinite(sample.milliseconds) || sample.milliseconds < 0)
      return "invalid";
    this.lastValidAt = now;
    return sample.milliseconds;
  }
}

/** Bounds offscreen pixel cost with fast degradation and deliberately slow recovery. */
class ResolutionTiers {
  private tier = 0;
  private overloaded = 0;
  private underloaded = 0;
  private lastChange = -Infinity;

  /** Current linear resolution scale, independent of display pixel ratio. */
  get scale(): number {
    return RESOLUTION_SCALES[this.tier];
  }

  /**
   * Counts only new valid timings; missing timing never implies spare GPU capacity.
   * A sustained absence of valid timing restores the default tier instead of freezing a degraded one.
   */
  update(reading: GpuReading, lastValidAt: number, now: number): void {
    if (typeof reading !== "number") {
      if (now - lastValidAt > TIMING_LOSS_RECOVERY_MS) this.reset(now);
      return;
    }
    this.overloaded =
      reading > RESOLUTION_OVERLOAD_MS ? this.overloaded + 1 : 0;
    this.underloaded =
      reading < RESOLUTION_HEADROOM_MS ? this.underloaded + 1 : 0;
    if (now - this.lastChange < RESOLUTION_CHANGE_INTERVAL_MS) return;
    if (
      this.overloaded >= RESOLUTION_OVERLOAD_SAMPLES &&
      this.tier < RESOLUTION_SCALES.length - 1
    ) {
      this.tier++;
    } else if (
      this.underloaded >= RESOLUTION_HEADROOM_SAMPLES &&
      this.tier > 0
    ) {
      this.tier--;
    } else {
      return;
    }
    this.lastChange = now;
    this.overloaded = 0;
    this.underloaded = 0;
  }

  /** Returns to the highest-quality tier with fresh hysteresis once timing evidence has been lost. */
  private reset(now: number): void {
    this.overloaded = 0;
    this.underloaded = 0;
    if (this.tier === 0) return;
    this.tier = 0;
    this.lastChange = now;
  }
}

/**
 * Admits optional shadow-map refreshes at a bounded cadence.
 *
 * When GPU timestamps arrive, refreshes require sustained GPU and CPU headroom.
 * When they are unavailable (WebGL, browsers without timestamp queries, or a
 * failed timer), sustained CPU headroom alone admits refreshes at a slower,
 * conservative cadence so shadows still render.
 */
class ShadowRefreshCadence {
  private spareSamples = 0;
  private renderMs = Infinity;
  private spareRenders = 0;
  private lastGrantAt = -Infinity;
  private gpuTimed = false;

  /** Cadence of granted refreshes in the current timing mode. */
  get intervalMs(): number {
    return this.gpuTimed
      ? SHADOW_GPU_REFRESH_INTERVAL_MS
      : SHADOW_FALLBACK_REFRESH_INTERVAL_MS;
  }

  /** Counts consecutive new GPU samples with spare capacity; invalid readbacks fail closed. */
  observe(reading: GpuReading): void {
    if (reading === "stale") return;
    this.spareSamples =
      reading !== "invalid" && reading < SHADOW_GPU_SPARE_MS
        ? Math.min(SHADOW_SUSTAINED_SPARE, this.spareSamples + 1)
        : 0;
  }

  /** Records the whole rendering submission, including any shadow work performed, as CPU headroom evidence. */
  recordRender(milliseconds: number, updateMs: number): void {
    this.renderMs = milliseconds;
    this.spareRenders = withinCpuBudget(milliseconds, updateMs)
      ? Math.min(SHADOW_SUSTAINED_SPARE, this.spareRenders + 1)
      : 0;
  }

  /** Grants at most one refresh per cadence interval; each grant is consumed by the call. */
  canRefresh(updateMs: number, lastFreshAt: number, now: number): boolean {
    this.gpuTimed = now - lastFreshAt <= GPU_SAMPLE_TIMEOUT_MS;
    if (now - this.lastGrantAt < this.intervalMs) return false;
    if (!withinCpuBudget(this.renderMs, updateMs)) return false;
    const sustained = this.gpuTimed
      ? this.spareSamples === SHADOW_SUSTAINED_SPARE
      : this.spareRenders === SHADOW_SUSTAINED_SPARE;
    if (!sustained) return false;
    this.lastGrantAt = now;
    return true;
  }
}

/** Rejects missing or invalid CPU timings instead of treating them as idle hardware. */
function withinCpuBudget(renderMs: number, updateMs: number): boolean {
  return (
    Number.isFinite(renderMs) &&
    renderMs >= 0 &&
    Number.isFinite(updateMs) &&
    updateMs >= 0 &&
    renderMs + updateMs < SHADOW_CPU_SPARE_MS
  );
}

/** Shares one frame's GPU evidence between soft-effect resolution and optional shadow refreshes. */
export class GpuBudget {
  private readonly samples = new GpuSampleTracker();
  private readonly resolution = new ResolutionTiers();
  private readonly shadows = new ShadowRefreshCadence();

  /** Linear resolution scale for the atmosphere and bloom passes. */
  get resolutionScale(): number {
    return this.resolution.scale;
  }

  /** Cadence of granted shadow refreshes in the current timing mode, used by the pool to age its maps. */
  get shadowRefreshIntervalMs(): number {
    return this.shadows.intervalMs;
  }

  /** Consumes this frame's GPU sample once for both policies and returns the resolution scale. */
  observe(sample: GpuBudgetSample | undefined, now: number): number {
    const reading = this.samples.read(sample, now);
    this.resolution.update(reading, this.samples.lastValidAt, now);
    this.shadows.observe(reading);
    return this.resolution.scale;
  }

  /** Grants at most one optional shadow refresh per cadence interval, after this frame's observe. */
  canRefreshShadows(updateMs: number, now: number): boolean {
    return this.shadows.canRefresh(updateMs, this.samples.lastFreshAt, now);
  }

  /** Records the frame's CPU update and render submission time. */
  recordRender(renderMs: number, updateMs = 0): void {
    this.shadows.recordRender(renderMs, updateMs);
  }
}
