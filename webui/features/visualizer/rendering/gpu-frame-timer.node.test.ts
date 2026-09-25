// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  InspectorBase,
  PerspectiveCamera,
  RenderTarget,
  Scene,
} from "three/webgpu";
import {
  GpuFrameTimer,
  gpuIntervalSpan,
  type InspectorGpuFrame,
  readInspectorGpuSample,
  type TimestampRenderer,
} from "./gpu-frame-timer";

/** Overlap counts once, queue gaps remain part of elapsed time, and subtraction preserves large timestamp precision. */
test("GPU elapsed spans handle overlap, gaps and invalid intervals", () => {
  const epoch = 9007199254740993000n;
  assert.equal(
    gpuIntervalSpan([
      [epoch, epoch + 8000000n],
      [epoch + 1000000n, epoch + 7500000n],
    ]),
    8,
  );
  assert.equal(
    gpuIntervalSpan([
      [epoch, epoch + 2000000n],
      [epoch + 4000000n, epoch + 6000000n],
    ]),
    6,
  );
  assert.equal(gpuIntervalSpan([[epoch, epoch]]), 0);
  assert.equal(gpuIntervalSpan([]), undefined);
  assert.equal(gpuIntervalSpan([[epoch + 1n, epoch]]), undefined);
});

/** Pending or unsupported inspector frames must not turn into zero-cost GPU measurements. */
test("inspector timing reuses the latest fully resolved frame", () => {
  const completed: InspectorGpuFrame = {
    frameId: 1,
    gpu: 99,
    resolvedRender: true,
    resolvedCompute: true,
    renders: [{}],
    computes: [],
  };
  const pending: InspectorGpuFrame = {
    ...completed,
    frameId: 2,
    gpu: undefined,
    resolvedRender: false,
  };
  const pools = {
    render: {
      timestamps: new Map<string, number>(),
      frameIntervals: new Map([[1, [1000000n, 5500000n] as const]]),
    },
    compute: {
      timestamps: new Map<string, number>(),
      frameIntervals: new Map([[1, [2000000n, 4000000n] as const]]),
    },
  };
  assert.deepEqual(readInspectorGpuSample([completed, pending], pools), {
    id: 1,
    milliseconds: 4.5,
  });
  assert.deepEqual(
    readInspectorGpuSample([{ ...completed, computes: [{}] }], pools),
    {
      id: 1,
      milliseconds: 4.5,
    },
  );
  assert.equal(readInspectorGpuSample([pending], pools), undefined);
  assert.equal(readInspectorGpuSample([completed], undefined), undefined);
  assert.equal(
    readInspectorGpuSample([{ ...completed, computes: [{}] }], {
      render: pools.render,
    }),
    undefined,
  );
  assert.equal(
    readInspectorGpuSample([{ ...completed, frameId: 3 }], pools),
    undefined,
  );
  assert.equal(
    readInspectorGpuSample(
      [{ ...completed, renders: [{ gpuNotAvailable: true }] }],
      pools,
    ),
    undefined,
  );
});

/** Drains the timer's completion and cleanup microtasks. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Fast readbacks must not turn instrumentation into per-frame GPU buffer mapping. */
test("GPU timing samples at a bounded rate without catching up missed samples", async () => {
  let calls = 0;
  const renderer: TimestampRenderer = {
    backend: {
      trackTimestamp: false,
      timestampQueryPool: {
        render: { timestamps: new Map(), lastInterval: [0n, 3000000n] },
      },
    },
    hasFeature: () => true,
    resolveTimestampsAsync: async (type) => {
      if (type === "compute") return undefined;
      calls++;
      return 3;
    },
  };
  const timer = new GpuFrameTimer();
  for (const time of [0, 16, 32, 48, 64, 80, 96, 100, 116, 1000, 1016]) {
    timer.begin(renderer, time);
    timer.end(renderer);
    await flush();
  }
  assert.equal(calls, 3);
  assert.equal(timer.sample?.id, 3);
  await timer.dispose();
});

/** Named passes survive asynchronous readback while timestamp history is released every frame. */
test("GPU timing groups named passes and bounds backend timestamp history", async () => {
  const timestamps = new Map<string, number>();
  const renderer: TimestampRenderer = {
    inspector: new InspectorBase(),
    backend: {
      trackTimestamp: false,
      timestampQueryPool: {
        render: { timestamps, lastInterval: [0n, 6000000n] },
      },
    },
    hasFeature: () => true,
    resolveTimestampsAsync: async (type) => (type === "render" ? 6 : undefined),
  };
  const timer = new GpuFrameTimer(0);
  const target = new RenderTarget();
  target.texture.name = "scene";
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  for (let frame = 1; frame <= 100; frame++) {
    timer.begin(renderer);
    const first = `r:1:f${frame}`;
    const second = `r:2:f${frame}`;
    renderer.inspector!.beginRender(first, scene, camera, target);
    renderer.inspector!.beginRender(second, scene, camera, target);
    timestamps.set(first, 2);
    timestamps.set(second, 4);
    timer.end(renderer);
    // An intervening animation tick must preserve labels for the pending sample.
    timer.begin(renderer);
    await flush();
    assert.deepEqual(timer.sample, {
      id: frame,
      milliseconds: 6,
      passes: { scene: 6 },
    });
    assert.equal(timestamps.size, 0);
  }
  await timer.dispose();
  target.dispose();
});

/** Idle pools return cached durations that must not contaminate a new frame sample. */
test("GPU timing excludes an idle pool's previous frame duration", async () => {
  const renderPool = {
    currentQueryIndex: 2,
    timestamps: new Map(),
    lastInterval: [0n, 4000000n] as const,
  };
  const computePool = {
    currentQueryIndex: 2,
    timestamps: new Map(),
    lastInterval: [2000000n, 9000000n] as const,
  };
  const renderer: TimestampRenderer = {
    backend: {
      trackTimestamp: false,
      timestampQueryPool: { render: renderPool, compute: computePool },
    },
    hasFeature: () => true,
    resolveTimestampsAsync: async (type) => {
      const pool = type === "render" ? renderPool : computePool;
      pool.currentQueryIndex = 0;
      return type === "render" ? 4 : 7;
    },
  };
  const timer = new GpuFrameTimer(0);
  timer.begin(renderer);
  timer.end(renderer);
  await flush();
  assert.deepEqual(timer.sample, { id: 1, milliseconds: 9 });

  renderPool.currentQueryIndex = 2;
  timer.begin(renderer);
  timer.end(renderer);
  await flush();
  assert.deepEqual(timer.sample, { id: 2, milliseconds: 4 });

  timer.begin(renderer);
  timer.end(renderer);
  await flush();
  assert.deepEqual(timer.sample, { id: 2, milliseconds: 4 });
  await timer.dispose();
});

/** A delayed GPU readback must never multiply pending queries or stall frame submission. */
test("GPU samples remain bounded while the GPU is busy", async () => {
  let complete!: (value: number) => void;
  let calls = 0;
  const renderer: TimestampRenderer = {
    backend: {
      trackTimestamp: false,
      timestampQueryPool: {
        render: { timestamps: new Map(), lastInterval: [0n, 4500000n] },
        compute: { timestamps: new Map(), lastInterval: [4500000n, 6000000n] },
      },
    },
    hasFeature: () => true,
    resolveTimestampsAsync: (type) => {
      if (type === "compute") return Promise.resolve(1.5);
      calls++;
      return new Promise<number>((resolve) => {
        complete = resolve;
      });
    },
  };
  const timer = new GpuFrameTimer(0);
  timer.begin(renderer);
  assert.equal(renderer.backend.trackTimestamp, true);
  timer.end(renderer);
  for (let i = 0; i < 100; i++) {
    timer.begin(renderer);
    assert.equal(renderer.backend.trackTimestamp, false);
    timer.end(renderer);
  }
  assert.equal(calls, 1);
  assert.equal(timer.sample, undefined);
  complete(4.5);
  await flush();
  assert.deepEqual(timer.sample, { id: 1, milliseconds: 6 });
  timer.begin(renderer);
  timer.end(renderer);
  assert.equal(calls, 2);
  let drained = false;
  const disposal = timer.dispose().then(() => {
    drained = true;
  });
  await flush();
  assert.equal(drained, false);
  timer.begin(renderer);
  assert.equal(renderer.backend.trackTimestamp, false);
  complete(7);
  await disposal;
  assert.equal(drained, true);
  assert.equal(timer.sample, undefined);
});

/** Unsupported devices and failed readbacks report unavailable timing without retry storms. */
test("GPU timing tolerates unavailable queries and device loss", async () => {
  let supported = false;
  let calls = 0;
  const renderer: TimestampRenderer = {
    backend: { trackTimestamp: false },
    hasFeature: () => supported,
    resolveTimestampsAsync: async (type) => {
      if (type === "compute") return undefined;
      calls++;
      throw new Error("device lost");
    },
  };
  const timer = new GpuFrameTimer(0);
  timer.begin(renderer);
  timer.end(renderer);
  assert.equal(calls, 0);
  supported = true;
  timer.begin(renderer);
  timer.end(renderer);
  await flush();
  timer.begin(renderer);
  timer.end(renderer);
  assert.equal(calls, 1);
  assert.equal(timer.sample, undefined);
});

/** A failed render query must not let disposal destroy buffers still mapped by a compute query. */
test("GPU timer drains compute readback even when render readback fails", async () => {
  let finishCompute!: (value: number) => void;
  const requested: string[] = [];
  const renderer: TimestampRenderer = {
    backend: { trackTimestamp: false },
    hasFeature: () => true,
    resolveTimestampsAsync: (type) => {
      requested.push(type);
      if (type === "render") return Promise.reject(new Error("mapping failed"));
      return new Promise<number>((resolve) => {
        finishCompute = resolve;
      });
    },
  };
  const timer = new GpuFrameTimer(0);
  timer.begin(renderer);
  timer.end(renderer);
  let disposed = false;
  const disposal = timer.dispose().then(() => {
    disposed = true;
  });
  await flush();
  assert.deepEqual(requested, ["render", "compute"]);
  assert.equal(disposed, false);
  assert.equal(timer.sample, undefined);
  finishCompute(2);
  await disposal;
  assert.equal(disposed, true);
  assert.equal(timer.sample, undefined);
});
