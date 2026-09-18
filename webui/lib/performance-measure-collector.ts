// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type PerformanceMeasureStats,
  type PerformanceMeasureUnit,
  performanceMeasureStats,
} from "../state/appStores";
import { RollingTimingSamples } from "./rolling-timing-samples";

const NIGHTFALL_MEASURE_PREFIX = "nightfall:";

const PUBLISH_INTERVAL_MS = 1000;

const samplesByName = new Map<string, RollingTimingSamples>();
let observer: PerformanceObserver | null = null;

/** Records one valid timing sample, bounding both scope count and sample storage. */
function recordSample(
  name: string,
  value: number,
  recordedAtMs = performance.now(),
  unit: PerformanceMeasureUnit = "ms",
): void {
  if (!name.startsWith(NIGHTFALL_MEASURE_PREFIX)) return;
  if (!Number.isFinite(value) || value < 0) return;
  if (!samplesByName.has(name) && samplesByName.size >= 256) return;
  const samples = samplesByName.get(name) ?? new RollingTimingSamples();
  samples.record(value, recordedAtMs, unit);
  samplesByName.set(name, samples);
}

/** Publishes the current aggregate timing table to the app store. */
function publishStats(): void {
  const now = performance.now();
  const next: Record<string, PerformanceMeasureStats> = {};
  for (const [name, samples] of samplesByName) {
    const stats = samples.summarize(name, now);
    if (stats) next[name] = stats;
    else samplesByName.delete(name);
  }
  performanceMeasureStats.set(next);
}

/** Records a timing sample produced outside the main-window PerformanceObserver. */
export function recordExternalPerformanceMeasure(
  name: string,
  durationMs: number,
  unit: PerformanceMeasureUnit = "ms",
): void {
  recordSample(name, durationMs, performance.now(), unit);
}

/** Clears all collected User Timing aggregates and browser measure entries. */
export function clearPerformanceMeasures(): void {
  samplesByName.clear();
  performanceMeasureStats.set({});
  performance.clearMeasures();
}

/** Starts collecting nightfall User Timing measurements into a bounded stats store. */
export function startPerformanceMeasureCollector(): void {
  if (observer !== null) return;
  if (!("PerformanceObserver" in window)) return;

  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntriesByType("measure")) {
      if (!entry.name.startsWith(NIGHTFALL_MEASURE_PREFIX)) continue;
      recordSample(
        entry.name,
        entry.duration,
        entry.startTime + entry.duration,
        "ms",
      );
      performance.clearMeasures(entry.name);
    }
  });
  observer.observe({ type: "measure", buffered: true });

  setInterval(publishStats, PUBLISH_INTERVAL_MS);
}
