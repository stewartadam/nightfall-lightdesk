// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InspectorBase } from "three/webgpu";

/** One resolved frame's GPU work, grouped by render target or compute operation. */
export interface GpuTimingSample {
  id: number;
  milliseconds: number;
  passes?: Record<string, number>;
}

/** Labels only the frame being sampled, without the full inspector's UI or frame history. */
class GpuPassLabels extends InspectorBase {
  recording = false;
  readonly labels = new Map<string, string>();

  /** Associates render queries with the pass's named output texture. */
  override beginRender(
    ...[uid, scene, , target]: Parameters<InspectorBase["beginRender"]>
  ): void {
    if (this.recording)
      this.labels.set(uid, target?.texture.name || scene.name || "output");
  }

  /** Associates compute queries with their kernel, including clustered-light assignment. */
  override beginCompute(
    ...[uid, node]: Parameters<InspectorBase["beginCompute"]>
  ): void {
    if (this.recording) this.labels.set(uid, node.name || "compute");
  }
}

/** Minimal renderer interface keeps GPU timing testable without creating a device. */
export interface TimestampRenderer {
  backend: {
    trackTimestamp: boolean;
    timestampQueryPool?: Partial<
      Record<
        "render" | "compute",
        {
          timestamps: Map<string, number>;
          currentQueryIndex?: number;
          lastInterval?: readonly [bigint, bigint];
          frameIntervals?: ReadonlyMap<number, readonly [bigint, bigint]>;
        } | null
      >
    >;
  };
  inspector?: InspectorBase;
  hasFeature(name: string): boolean;
  resolveTimestampsAsync(
    type: "render" | "compute",
  ): Promise<number | undefined>;
}

/** Measures elapsed GPU time across overlapping or disjoint queue intervals without double-counting passes. */
export function gpuIntervalSpan(
  intervals: readonly (readonly [bigint, bigint])[],
): number | undefined {
  let start: bigint | undefined;
  let end: bigint | undefined;
  for (const [first, last] of intervals) {
    if (last < first) return undefined;
    if (start === undefined || first < start) start = first;
    if (end === undefined || last > end) end = last;
  }
  return start === undefined || end === undefined
    ? undefined
    : Number(end - start) / 1e6;
}

/** The timestamp-bearing subset of Three's inspector frame records. */
export interface InspectorGpuFrame {
  frameId: number;
  gpu?: number;
  resolvedRender: boolean;
  resolvedCompute: boolean;
  renders: { gpuNotAvailable?: boolean }[];
  computes: { gpuNotAvailable?: boolean }[];
}

/** Reuses frame-specific inspector readbacks, excluding other frames and overlapping pass double-counting. */
export function readInspectorGpuSample(
  frames: readonly InspectorGpuFrame[],
  pools: TimestampRenderer["backend"]["timestampQueryPool"],
): { id: number; milliseconds: number } | undefined {
  for (let i = frames.length - 1; i >= Math.max(0, frames.length - 60); i--) {
    const frame = frames[i];
    if (!frame.resolvedRender || !frame.resolvedCompute) continue;
    if (
      frame.renders.some((pass) => pass.gpuNotAvailable) ||
      frame.computes.some((pass) => pass.gpuNotAvailable)
    )
      return undefined;
    const render = pools?.render?.frameIntervals?.get(frame.frameId);
    const compute = pools?.compute?.frameIntervals?.get(frame.frameId);
    if (!render || (frame.computes.length > 0 && !compute)) continue;
    const milliseconds = gpuIntervalSpan(
      frame.computes.length > 0 && compute ? [render, compute] : [render],
    );
    return milliseconds === undefined
      ? undefined
      : { id: frame.frameId, milliseconds };
  }
  return undefined;
}

/**
 * Measures GPU execution without awaiting readback in the animation loop.
 * Only one frame is recorded per pending readback, so a slow GPU cannot create
 * an unbounded promise queue or mix several frames into one duration.
 */
export class GpuFrameTimer {
  private pending = false;
  private readback: Promise<void> = Promise.resolve();
  private recording = false;
  private disposed = false;
  private failed = false;
  private latest: number | undefined;
  private sampleId = 0;
  private readonly passLabels = new GpuPassLabels();
  private passes: Record<string, number> | undefined;
  private nextSampleAt = -Infinity;

  /** Bounds query mapping overhead independently of the display's refresh rate. */
  constructor(private readonly sampleIntervalMs = 100) {}

  /** Reports the last completed GPU sample; unavailable timing is never zero. */
  get sample(): GpuTimingSample | undefined {
    return this.latest === undefined
      ? undefined
      : {
          id: this.sampleId,
          milliseconds: this.latest,
          ...(this.passes ? { passes: this.passes } : {}),
        };
  }

  /** Enables timestamp writes only when the previous sample has finished. */
  begin(renderer: TimestampRenderer, now = performance.now()): void {
    if (renderer.inspector?.constructor === InspectorBase)
      renderer.inspector = this.passLabels;
    this.recording =
      !this.disposed &&
      !this.failed &&
      !this.pending &&
      now >= this.nextSampleAt &&
      renderer.hasFeature("timestamp-query");
    renderer.backend.trackTimestamp = this.recording;
    this.passLabels.recording = this.recording;
    if (this.recording) {
      this.nextSampleAt = now + this.sampleIntervalMs;
      this.passLabels.labels.clear();
    }
  }

  /** Starts bounded asynchronous readback after all passes of the frame are submitted. */
  end(renderer: TimestampRenderer): void {
    if (!this.recording) return;
    this.recording = false;
    this.passLabels.recording = false;
    this.pending = true;
    // Three returns the previous duration when a pool has no queries this frame.
    const hasRenderQueries =
      !!renderer.backend.timestampQueryPool?.render &&
      renderer.backend.timestampQueryPool.render.currentQueryIndex !== 0;
    const hasComputeQueries =
      !!renderer.backend.timestampQueryPool?.compute &&
      renderer.backend.timestampQueryPool.compute.currentQueryIndex !== 0;
    // Calling before disabling tracking lets the backend enqueue the resolve.
    const result = Promise.allSettled([
      renderer.resolveTimestampsAsync("render"),
      renderer.resolveTimestampsAsync("compute"),
    ]);
    renderer.backend.trackTimestamp = false;
    this.readback = result
      .then(([renderResult, computeResult]) => {
        if (renderResult.status === "rejected") throw renderResult.reason;
        if (computeResult.status === "rejected") throw computeResult.reason;
        const render = hasRenderQueries ? renderResult.value : undefined;
        const compute = hasComputeQueries ? computeResult.value : undefined;
        const pools = renderer.backend.timestampQueryPool;
        const renderInterval = pools?.render?.lastInterval;
        const computeInterval = pools?.compute?.lastInterval;
        const milliseconds =
          render === undefined ||
          !renderInterval ||
          (compute !== undefined && !computeInterval)
            ? undefined
            : gpuIntervalSpan(
                compute !== undefined && computeInterval
                  ? [renderInterval, computeInterval]
                  : [renderInterval],
              );
        if (
          !this.disposed &&
          milliseconds !== undefined &&
          Number.isFinite(milliseconds) &&
          milliseconds >= 0
        ) {
          this.latest = milliseconds;
          const passes: Record<string, number> = {};
          for (const pool of Object.values(
            renderer.backend.timestampQueryPool ?? {},
          )) {
            if (!pool) continue;
            for (const [uid, duration] of pool.timestamps) {
              const label = this.passLabels.labels.get(uid);
              if (
                label !== undefined &&
                Number.isFinite(duration) &&
                duration >= 0
              )
                passes[label] = (passes[label] ?? 0) + duration;
            }
          }
          this.passes = Object.keys(passes).length ? passes : undefined;
          this.sampleId++;
        }
      })
      .catch(() => {
        // Device loss or failed mapping must not break timeline playback.
        this.failed = true;
        this.latest = undefined;
      })
      .finally(() => {
        // This timer owns readback; retain no per-frame keys after consuming them.
        for (const pool of Object.values(
          renderer.backend.timestampQueryPool ?? {},
        ))
          pool?.timestamps.clear();
        this.pending = false;
      });
  }

  /** Stops recording and lets the owner drain mapping before destroying GPU buffers. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.latest = undefined;
    this.passes = undefined;
    return this.readback;
  }
}
