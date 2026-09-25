// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GpuBudgetSample } from "./atmosphere-budget";

/** GPU frame time below which a measurement counts as spare capacity. */
const GPU_SPARE_MS = 6;
/** Combined CPU update and render submission time that still leaves room for an extra pass. */
const CPU_SPARE_MS = 8;
/** Consecutive spare measurements required before optional work resumes. */
const SUSTAINED_SPARE = 3;
/** Refresh cadence while GPU timing proves headroom. */
const GPU_REFRESH_INTERVAL_MS = 60;
/** Conservative cadence when only CPU submission time is observable. */
const FALLBACK_REFRESH_INTERVAL_MS = 200;
/** Without a fresh GPU measurement for this long, timing is treated as unavailable. */
export const GPU_SAMPLE_TIMEOUT_MS = 1000;

/**
 * Admits optional shadow-map refreshes at a bounded cadence.
 *
 * When GPU timestamps arrive, refreshes require sustained GPU and CPU headroom.
 * When they are unavailable (WebGL, browsers without timestamp queries, or a
 * failed timer), sustained CPU headroom alone admits refreshes at a slower,
 * conservative cadence so shadows still render.
 */
export class ShadowRefreshBudget {
  private lastSample = -1;
  private lastSampleAt = -Infinity;
  private spareSamples = 0;
  private renderMs = Infinity;
  private spareRenders = 0;
  private lastGrantAt = -Infinity;
  private gpuTimed = false;

  /** Records the whole rendering submission, including any shadow work performed, as CPU headroom evidence. */
  recordRender(milliseconds: number, updateMs = 0): void {
    this.renderMs = milliseconds;
    this.spareRenders = withinCpuBudget(milliseconds, updateMs)
      ? Math.min(SUSTAINED_SPARE, this.spareRenders + 1)
      : 0;
  }

  /** Cadence of granted refreshes in the current timing mode, used by the pool to age its maps. */
  get refreshIntervalMs(): number {
    return this.gpuTimed
      ? GPU_REFRESH_INTERVAL_MS
      : FALLBACK_REFRESH_INTERVAL_MS;
  }

  /**
   * Grants at most one refresh per cadence interval; each grant is consumed by the call.
   * Fresh GPU samples decide headroom while they keep arriving; invalid samples fail closed.
   */
  canRefresh(
    sample: GpuBudgetSample | undefined,
    updateMs: number,
    now: number,
  ): boolean {
    if (sample && sample.id !== this.lastSample) {
      this.lastSample = sample.id;
      this.lastSampleAt = now;
      this.spareSamples =
        Number.isFinite(sample.milliseconds) &&
        sample.milliseconds >= 0 &&
        sample.milliseconds < GPU_SPARE_MS
          ? Math.min(SUSTAINED_SPARE, this.spareSamples + 1)
          : 0;
    }
    this.gpuTimed = now - this.lastSampleAt <= GPU_SAMPLE_TIMEOUT_MS;
    if (now - this.lastGrantAt < this.refreshIntervalMs) return false;
    if (!withinCpuBudget(this.renderMs, updateMs)) return false;
    const sustained = this.gpuTimed
      ? this.spareSamples === SUSTAINED_SPARE
      : this.spareRenders === SUSTAINED_SPARE;
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
    renderMs + updateMs < CPU_SPARE_MS
  );
}
