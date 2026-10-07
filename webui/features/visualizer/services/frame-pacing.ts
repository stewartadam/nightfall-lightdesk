// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TARGET_FRAME_TIME } from "../rendering/frame-rate-limiter";

/** Unsmoothened render submission intervals, independent of the UI thread's animation loop. */
export interface FramePacingSnapshot {
  frames: number;
  over25Ms: number;
  windowMaxMs: number;
  /** Callback cadence and submission latency distinguish skipped frames from completion jitter. */
  scheduling?: {
    frames: number;
    over25Ms: number;
    lateSubmissions: number;
    windowMaxIntervalMs: number;
    windowMaxLatencyMs: number;
  };
  /** CPU work attached to the longest stalled submission in this publication window. */
  worstFrame?: {
    completedAt: number;
    intervalMs: number;
    updateMs?: number;
    renderMs?: number;
    /** Delay between the animation timestamp and entry into the render callback. */
    callbackDelayMs?: number;
    /** Entire callback through submission, including controls and other unclassified work. */
    cpuFrameMs?: number;
  };
}

/** Counts long intervals without allocating per-frame samples or waiting for the GPU. */
export class FramePacing {
  private previous: number | undefined;
  private frames = 0;
  private over25Ms = 0;
  private windowMaxMs = 0;
  private worstFrame: FramePacingSnapshot["worstFrame"];
  private previousScheduled: number | undefined;
  private scheduledFrames = 0;
  private scheduledOver25Ms = 0;
  private lateSubmissions = 0;
  private windowMaxScheduledMs = 0;
  private windowMaxLatencyMs = 0;

  /** Records the actual CPU submission completion time, including scheduling and submission delays. */
  record(
    completedAt: number,
    updateMs?: number,
    renderMs?: number,
    startedAt?: number,
    scheduledAt?: number,
  ): void {
    if (!Number.isFinite(completedAt)) return;
    if (
      scheduledAt !== undefined &&
      Number.isFinite(scheduledAt) &&
      scheduledAt <= completedAt
    ) {
      const latency = completedAt - scheduledAt;
      this.scheduledFrames++;
      this.windowMaxLatencyMs = Math.max(this.windowMaxLatencyMs, latency);
      if (latency > TARGET_FRAME_TIME) this.lateSubmissions++;
      if (
        this.previousScheduled !== undefined &&
        scheduledAt >= this.previousScheduled
      ) {
        const interval = scheduledAt - this.previousScheduled;
        this.windowMaxScheduledMs = Math.max(
          this.windowMaxScheduledMs,
          interval,
        );
        if (interval > 25) this.scheduledOver25Ms++;
      }
      this.previousScheduled = scheduledAt;
    } else {
      this.previousScheduled = undefined;
    }
    if (this.previous !== undefined && completedAt >= this.previous) {
      const interval = completedAt - this.previous;
      this.windowMaxMs = Math.max(this.windowMaxMs, interval);
      if (interval > 25) {
        this.over25Ms++;
        if (!this.worstFrame || interval > this.worstFrame.intervalMs)
          this.worstFrame = {
            completedAt,
            intervalMs: interval,
            ...(updateMs === undefined ? {} : { updateMs }),
            ...(renderMs === undefined ? {} : { renderMs }),
            ...(startedAt !== undefined &&
            Number.isFinite(startedAt) &&
            startedAt <= completedAt
              ? { cpuFrameMs: completedAt - startedAt }
              : {}),
            ...(startedAt !== undefined &&
            scheduledAt !== undefined &&
            Number.isFinite(startedAt) &&
            Number.isFinite(scheduledAt)
              ? { callbackDelayMs: Math.max(0, startedAt - scheduledAt) }
              : {}),
          };
      }
    }
    this.previous = completedAt;
    this.frames++;
  }

  /** Excludes deliberate suspension while preserving monotonic counters for interval comparisons. */
  suspend(): void {
    this.previous = undefined;
    this.previousScheduled = undefined;
    this.windowMaxScheduledMs = 0;
    this.windowMaxLatencyMs = 0;
    this.windowMaxMs = 0;
    this.worstFrame = undefined;
  }

  /** Publishes cumulative counters and the worst interval since the previous publication. */
  snapshot(): FramePacingSnapshot {
    const result = {
      frames: this.frames,
      over25Ms: this.over25Ms,
      windowMaxMs: this.windowMaxMs,
      ...(this.scheduledFrames > 0
        ? {
            scheduling: {
              frames: this.scheduledFrames,
              over25Ms: this.scheduledOver25Ms,
              lateSubmissions: this.lateSubmissions,
              windowMaxIntervalMs: this.windowMaxScheduledMs,
              windowMaxLatencyMs: this.windowMaxLatencyMs,
            },
          }
        : {}),
      ...(this.worstFrame ? { worstFrame: this.worstFrame } : {}),
    };
    this.windowMaxMs = 0;
    this.windowMaxScheduledMs = 0;
    this.windowMaxLatencyMs = 0;
    this.worstFrame = undefined;
    return result;
  }
}
