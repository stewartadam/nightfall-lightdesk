// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { longAnimationFrameStats } from "../state/appStores";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);
const STATS_UPDATE_INTERVAL_MS = 1000;
const MAX_LOGGED_SCRIPTS = 5;

interface PerformanceScriptTimingLike {
  duration?: number;
  executionStart?: number;
  forcedStyleAndLayoutDuration?: number;
  invoker?: string;
  invokerType?: string;
  pauseDuration?: number;
  sourceCharPosition?: number;
  sourceFunctionName?: string;
  sourceURL?: string;
  windowAttribution?: string;
}

interface PerformanceLongAnimationFrameTimingLike extends PerformanceEntry {
  blockingDuration?: number;
  firstUIEventTimestamp?: number;
  renderStart?: number;
  scripts?: PerformanceScriptTimingLike[];
  styleAndLayoutStart?: number;
}

interface ScriptAttributionSummary {
  durationMs: number;
  forcedStyleAndLayoutMs: number;
  invoker: string;
  invokerType: string;
  sourceCharPosition: number | null;
  sourceFunctionName: string;
  sourceURL: string;
}

class LongAnimationFrameMonitor {
  private observer: PerformanceObserver | null = null;
  private statsIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastStatsAt = performance.now();
  private windowCount = 0;
  private totalCount = 0;
  private totalDuration = 0;
  private totalBlockingDuration = 0;
  private maxDuration = 0;
  private lastDuration = 0;
  private lastBlockingDuration = 0;

  /** Start observing long animation frame entries when the browser exposes the LoAF API. */
  start(): void {
    if (this.observer) return;
    if (
      !("PerformanceObserver" in window) ||
      !PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")
    ) {
      longAnimationFrameStats.set(null);
      return;
    }

    try {
      this.observer = new PerformanceObserver((list) => {
        for (const rawEntry of list.getEntries()) {
          const entry = rawEntry as PerformanceLongAnimationFrameTimingLike;
          const duration = entry.duration ?? 0;
          const blockingDuration = entry.blockingDuration ?? 0;

          this.windowCount += 1;
          this.totalCount += 1;
          this.totalDuration += duration;
          this.totalBlockingDuration += blockingDuration;
          this.lastDuration = duration;
          this.lastBlockingDuration = blockingDuration;
          if (duration > this.maxDuration) {
            this.maxDuration = duration;
          }

          log.warn(
            `${duration.toFixed(1)} ms frame, ${blockingDuration.toFixed(1)} ms blocking`,
            {
              durationMs: duration,
              blockingDurationMs: blockingDuration,
              renderStartMs: entry.renderStart ?? null,
              styleAndLayoutStartMs: entry.styleAndLayoutStart ?? null,
              firstUIEventTimestampMs: entry.firstUIEventTimestamp ?? null,
              scripts: summarizeScripts(entry.scripts ?? []),
            },
          );
        }
      });
      this.observer.observe({ type: "long-animation-frame", buffered: true });
    } catch {
      this.observer = null;
      longAnimationFrameStats.set(null);
      return;
    }

    this.statsIntervalId = setInterval(() => {
      const now = performance.now();
      const elapsedMs = now - this.lastStatsAt;
      const elapsedSec = elapsedMs / 1000;
      const framesPerSec = elapsedSec > 0 ? this.windowCount / elapsedSec : 0;
      const avgDurationMs =
        this.totalCount > 0 ? this.totalDuration / this.totalCount : 0;
      const avgBlockingDurationMs =
        this.totalCount > 0 ? this.totalBlockingDuration / this.totalCount : 0;

      longAnimationFrameStats.set({
        framesPerSec,
        avgDurationMs,
        avgBlockingDurationMs,
        maxDurationMs: this.maxDuration,
        totalFrames: this.totalCount,
        totalDurationMs: this.totalDuration,
        totalBlockingDurationMs: this.totalBlockingDuration,
        lastDurationMs: this.lastDuration,
        lastBlockingDurationMs: this.lastBlockingDuration,
      });

      this.windowCount = 0;
      this.lastStatsAt = now;
    }, STATS_UPDATE_INTERVAL_MS);
  }

  /** Stop observing long animation frame entries and clear the published stats. */
  stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.statsIntervalId) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
    }
    this.windowCount = 0;
    this.totalCount = 0;
    this.totalDuration = 0;
    this.totalBlockingDuration = 0;
    this.maxDuration = 0;
    this.lastDuration = 0;
    this.lastBlockingDuration = 0;
    this.lastStatsAt = performance.now();
    longAnimationFrameStats.set(null);
  }
}

/** Return the highest-cost scripts in a long animation frame entry for console diagnostics. */
function summarizeScripts(
  scripts: PerformanceScriptTimingLike[],
): ScriptAttributionSummary[] {
  return [...scripts]
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, MAX_LOGGED_SCRIPTS)
    .map((script) => ({
      durationMs: script.duration ?? 0,
      forcedStyleAndLayoutMs: script.forcedStyleAndLayoutDuration ?? 0,
      invoker: script.invoker ?? "",
      invokerType: script.invokerType ?? "",
      sourceCharPosition: script.sourceCharPosition ?? null,
      sourceFunctionName: script.sourceFunctionName ?? "",
      sourceURL: script.sourceURL ?? "",
    }));
}

export const longAnimationFrameMonitor = new LongAnimationFrameMonitor();
