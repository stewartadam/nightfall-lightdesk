// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Performance instrumentation for Visualizer.
 * Tracks frame timing, FPS, and render metrics.
 */

import { getLogger } from "../../../lib/logger";
import type { VisualizerStats } from "../../../state/appStores";
import { FramePacing } from "./frame-pacing";

const log = getLogger(import.meta.url);

/** Rolling window size for averaging metrics */
const WINDOW_SIZE = 60;

/** How often to publish stats (in frames) */
const PUBLISH_INTERVAL = 10;

/**
 * Metrics collected each frame.
 */
export interface FrameMetrics {
  atmosphereScale?: number;
  sceneScale?: number;
  omittedSurfaceLights?: number;
  reducedPrismEmitters?: number;
  reducedGoboEmitters?: number;
  /** Actual completion of render submission, separate from the RAF scheduler timestamp. */
  completedAt?: number;
  /** Entry into the animation callback, before controls or fixture updates. */
  startedAt?: number;
  /** Time spent updating fixtures/emitters (ms) */
  updateMs: number;
  /** Total render time (ms) */
  renderMs: number;
  /** Most recent asynchronous GPU sample, with its unique frame identifier. */
  gpu?: { id: number; milliseconds: number; passes?: Record<string, number> };
}

/**
 * Performance instrumentation manager.
 * Collects timing data and publishes aggregated stats.
 */
export class Instrumentation {
  private atmosphereScale: number | undefined;
  private sceneScale: number | undefined;
  private omittedSurfaceLights: number | undefined;
  private reducedPrismEmitters: number | undefined;
  private reducedGoboEmitters: number | undefined;
  private readonly pacing = new FramePacing();
  private frameCount = 0;
  private lastFrameTime = 0;
  private frameTimesMs: number[] = [];
  private updateTimesMs: number[] = [];
  private renderTimesMs: number[] = [];
  private gpuTimesMs: number[] = [];
  private lastGpuSampleId = -1;
  private gpuPasses: Record<string, number> | undefined;
  private onStats: ((stats: VisualizerStats | null) => void) | null = null;
  private renderMode: "worker" | "main-thread" = "main-thread";

  /**
   * Set the rendering mode for stats reporting.
   */
  setRenderMode(mode: "worker" | "main-thread"): void {
    this.renderMode = mode;
  }

  /**
   * Set callback for stats updates.
   */
  setStatsCallback(
    callback: ((stats: VisualizerStats | null) => void) | null,
  ): void {
    this.onStats = callback;
  }

  /**
   * Record metrics for a completed frame.
   * @param currentTime Current timestamp from render loop (ms)
   * @param metrics Frame timing measurements
   */
  recordFrame(currentTime: number, metrics: FrameMetrics): void {
    this.atmosphereScale = metrics.atmosphereScale;
    this.sceneScale = metrics.sceneScale;
    this.omittedSurfaceLights = metrics.omittedSurfaceLights;
    this.reducedPrismEmitters = metrics.reducedPrismEmitters;
    this.reducedGoboEmitters = metrics.reducedGoboEmitters;
    this.pacing.record(
      metrics.completedAt ?? currentTime,
      metrics.updateMs,
      metrics.renderMs,
      metrics.startedAt,
      currentTime,
    );
    // Calculate frame-to-frame time
    const frameToFrameMs =
      this.lastFrameTime > 0 ? currentTime - this.lastFrameTime : 0;
    this.lastFrameTime = currentTime;

    log.trace(
      `Frame: ${frameToFrameMs.toFixed(1)}ms total, ${metrics.updateMs.toFixed(1)}ms update, ${metrics.renderMs.toFixed(1)}ms render`,
    );

    // A start or resume establishes the timing baseline rather than a frame
    // interval. Recording its synthetic zero would inflate the rolling FPS.
    if (Number.isFinite(frameToFrameMs) && frameToFrameMs > 0) {
      this.pushToWindow(this.frameTimesMs, frameToFrameMs);
    }
    this.pushToWindow(this.updateTimesMs, metrics.updateMs);
    this.pushToWindow(this.renderTimesMs, metrics.renderMs);
    if (metrics.gpu && metrics.gpu.id !== this.lastGpuSampleId) {
      this.lastGpuSampleId = metrics.gpu.id;
      this.gpuPasses = metrics.gpu.passes;
      this.pushToWindow(this.gpuTimesMs, metrics.gpu.milliseconds);
    }

    this.frameCount++;

    // Publish stats periodically
    if (this.frameCount % PUBLISH_INTERVAL === 0) {
      this.publishStats();
    }
  }

  /**
   * Reset instrumentation when pausing.
   * Publishes stats with fps=0 to indicate paused state.
   */
  pause(): void {
    this.pacing.suspend();
    this.lastFrameTime = 0;
    // Publish zeroed stats so the section stays visible but shows paused
    this.onStats?.({
      fps: 0,
      frameToFrameMs: 0,
      updateFixturesMs: 0,
      totalRenderMs: 0,
      postProcessMs: 0,
      gpuMs: undefined,
      scenePassMs: 0,
      volumetricPassMs: 0,
      gaussianBlurMs: 0,
      bloomMs: 0,
      renderMode: this.renderMode,
    });
  }

  /**
   * Reset timing state when resuming.
   * Keeps historical data for smooth averaging after resume.
   */
  resume(): void {
    this.pacing.suspend();
    this.lastFrameTime = 0;
  }

  /**
   * Clear all data (e.g., when disposing).
   */
  clear(): void {
    this.pacing.suspend();
    this.frameCount = 0;
    this.lastFrameTime = 0;
    this.frameTimesMs = [];
    this.updateTimesMs = [];
    this.renderTimesMs = [];
    this.gpuTimesMs = [];
    this.lastGpuSampleId = -1;
    this.gpuPasses = undefined;
    this.onStats?.(null);
  }

  private pushToWindow(window: number[], value: number): void {
    window.push(value);
    if (window.length > WINDOW_SIZE) {
      window.shift();
    }
  }

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private publishStats(): void {
    if (!this.onStats || this.frameTimesMs.length === 0) return;

    const avgFrameTime = this.average(this.frameTimesMs);
    const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;

    // Build stats object
    // Note: Some fields are placeholders until post-processing is implemented
    const stats: VisualizerStats = {
      framePacing: this.pacing.snapshot(),
      atmosphereScale: this.atmosphereScale,
      sceneScale: this.sceneScale,
      omittedSurfaceLights: this.omittedSurfaceLights,
      reducedPrismEmitters: this.reducedPrismEmitters,
      reducedGoboEmitters: this.reducedGoboEmitters,
      fps,
      frameToFrameMs: avgFrameTime,
      updateFixturesMs: this.average(this.updateTimesMs),
      totalRenderMs: this.average(this.renderTimesMs),
      postProcessMs: 0, // TODO: Add when post-processing implemented
      gpuMs: this.gpuTimesMs.length ? this.average(this.gpuTimesMs) : undefined,
      gpuPasses: this.gpuPasses,
      scenePassMs: this.average(this.renderTimesMs), // Scene render = total for now
      volumetricPassMs: 0, // TODO: Add when fog implemented
      gaussianBlurMs: 0, // TODO: Add when blur implemented
      bloomMs: 0, // TODO: Add when bloom implemented
      renderMode: this.renderMode,
    };

    this.onStats(stats);
  }
}
