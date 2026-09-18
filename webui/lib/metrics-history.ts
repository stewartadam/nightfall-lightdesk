// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  engineMetrics,
  frameStats,
  metricsHistory,
  wsLatency,
} from "../state/appStores";

/**
 * Ring buffer for storing fixed-length metric history.
 * Used for sparkline visualizations with bounded memory.
 */
class MetricsRingBuffer {
  private buffer: number[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 60) {
    this.maxSize = maxSize;
  }

  push(value: number): void {
    this.buffer.push(value);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getValues(): number[] {
    return [...this.buffer];
  }

  getLatest(): number | undefined {
    return this.buffer[this.buffer.length - 1];
  }

  clear(): void {
    this.buffer = [];
  }
}

/**
 * Collects metrics history at 1 Hz for sparkline visualizations.
 * Maintains 60-second rolling history for key performance metrics.
 */
class MetricsHistoryCollector {
  private fpsBuffer = new MetricsRingBuffer(60);
  private latencyBuffer = new MetricsRingBuffer(60);
  private frameTimeBuffer = new MetricsRingBuffer(60);
  private uiFpsBuffer = new MetricsRingBuffer(60);
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.intervalId !== null) return;

    this.intervalId = setInterval(() => {
      // Collect engine FPS from backend metrics
      const metrics = engineMetrics.get();
      if (metrics?.fps !== undefined) {
        this.fpsBuffer.push(metrics.fps);
      }

      // Collect WebSocket latency
      const latency = wsLatency.get();
      if (latency > 0) {
        this.latencyBuffer.push(latency);
      }

      // Collect engine frame time from backend metrics
      if (metrics?.frame_time_ms !== undefined) {
        this.frameTimeBuffer.push(metrics.frame_time_ms);
      }

      // Collect UI FPS from frame monitor
      const frame = frameStats.get();
      if (frame?.fps !== undefined) {
        this.uiFpsBuffer.push(frame.fps);
      }

      // Update the store with current history
      metricsHistory.set({
        fps: this.fpsBuffer.getValues(),
        latency: this.latencyBuffer.getValues(),
        frameTime: this.frameTimeBuffer.getValues(),
        uiFps: this.uiFpsBuffer.getValues(),
      });
    }, 1000);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  clear(): void {
    this.fpsBuffer.clear();
    this.latencyBuffer.clear();
    this.frameTimeBuffer.clear();
    this.uiFpsBuffer.clear();
    metricsHistory.set({
      fps: [],
      latency: [],
      frameTime: [],
      uiFps: [],
    });
  }
}

export const metricsHistoryCollector = new MetricsHistoryCollector();
