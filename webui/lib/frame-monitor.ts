// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { frameStats } from "../state/appStores";
import { requestIdleCallbackSafe } from "./idle-callback";

const TARGET_FRAME_MS = 1000 / 60; // 16.67ms for 60Hz
const DROPPED_THRESHOLD = TARGET_FRAME_MS * 1.5; // ~25ms
const FRAME_BUFFER_SIZE = 60;
const STATS_UPDATE_INTERVAL_MS = 1000;

/**
 * FrameMonitor tracks frontend frame timing using requestAnimationFrame timestamps.
 * Detects dropped frames when frame delta exceeds 1.5× target frame time.
 */
class FrameMonitor {
  private lastFrameTime = 0;
  private frameTimes: number[] = [];
  private droppedFrames = 0;
  private rafId: number | null = null;
  private statsIntervalId: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  start(): void {
    if (this.rafId !== null) return;

    this.lastFrameTime = 0;
    this.frameTimes = [];
    this.droppedFrames = 0;
    this.initialized = false;

    const tick = (timestamp: number) => {
      if (this.lastFrameTime > 0 && this.initialized) {
        const delta = timestamp - this.lastFrameTime;
        this.frameTimes.push(delta);
        if (this.frameTimes.length > FRAME_BUFFER_SIZE) {
          this.frameTimes.shift();
        }

        if (delta > DROPPED_THRESHOLD) {
          // Count how many frames were likely dropped
          const missedFrames = Math.floor(delta / TARGET_FRAME_MS) - 1;
          this.droppedFrames += Math.max(1, missedFrames);
        }
      }
      // Skip the first frame to avoid huge delta from page load timestamp
      if (this.lastFrameTime > 0) {
        this.initialized = true;
      }
      this.lastFrameTime = timestamp;
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);

    /** Update store at 1 Hz, falling back cleanly on runtimes without idle callbacks. */
    const updateStats = () => {
      frameStats.set({
        fps: this.getFPS(),
        avgFrameTimeMs: this.getAverageFrameTime(),
        droppedFrames: this.droppedFrames,
      });
    };

    this.statsIntervalId = setInterval(() => {
      requestIdleCallbackSafe(() => updateStats(), { timeout: 100 });
    }, STATS_UPDATE_INTERVAL_MS);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.statsIntervalId !== null) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
    }
    frameStats.set(null);
  }

  private getFPS(): number {
    if (this.frameTimes.length === 0) return 0;
    const avgFrameTime = this.getAverageFrameTime();
    return avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
  }

  private getAverageFrameTime(): number {
    if (this.frameTimes.length === 0) return 0;
    const sum = this.frameTimes.reduce((a, b) => a + b, 0);
    return sum / this.frameTimes.length;
  }
}

export const frameMonitor = new FrameMonitor();
