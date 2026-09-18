// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  PerformanceMeasureStats,
  PerformanceMeasureUnit,
} from "../state/appStores";

export const TIMING_SAMPLE_LIMIT = 6000;
export const TIMING_WINDOW_MS = 60_000;

/** Retains the newest timing samples in a fixed-capacity ring for rolling summaries. */
export class RollingTimingSamples {
  private samples: {
    value: number;
    at: number;
    unit: PerformanceMeasureUnit;
  }[] = [];
  private next = 0;

  /** Records a valid sample in constant time, replacing the oldest at capacity. */
  record(value: number, at: number, unit: PerformanceMeasureUnit = "ms"): void {
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(at)) return;
    this.samples[this.next] = { value, at, unit };
    this.next = (this.next + 1) % TIMING_SAMPLE_LIMIT;
  }

  /** Summarizes samples from the last minute using nearest-rank percentiles. */
  summarize(name: string, now: number): PerformanceMeasureStats | undefined {
    const recent = this.samples.filter(
      (sample) => sample.at >= now - TIMING_WINDOW_MS && sample.at <= now,
    );
    if (recent.length === 0) return undefined;
    const sorted = recent.map((sample) => sample.value).sort((a, b) => a - b);
    const last =
      this.samples[(this.next + this.samples.length - 1) % this.samples.length];
    return {
      name,
      unit: last.unit,
      count: recent.length,
      avgMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
      maxMs: sorted[sorted.length - 1],
      lastMs: last.value,
    };
  }
}
