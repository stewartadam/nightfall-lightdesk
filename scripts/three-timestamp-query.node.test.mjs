// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RendererInspector } from "three/examples/jsm/inspector/RendererInspector.js";
import { WebGPURenderer } from "three/webgpu";
import { WebGPURenderer as NodesRenderer } from "../node_modules/three/build/three.webgpu.nodes.js";
import WebGPUBackend from "../node_modules/three/src/renderers/webgpu/WebGPUBackend.js";

const UPGRADE_HINT =
  "webui/features/visualizer/rendering/gpu-frame-timer.ts and renderer.ts " +
  "depend on this three.js member; re-apply patches/three+<version>.patch " +
  "or update the GPU timing code after a three upgrade";

/**
 * GPU timing reads private three.js members, some of which only exist because
 * of patches/three+0.185.1.patch. This fails with an actionable message when
 * an upgrade drops or renames any of them, instead of timing silently vanishing.
 */
test("three exposes the members visualizer GPU timing depends on", (t) => {
  for (const [key, value] of Object.entries({
    GPUBufferUsage: { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 },
    GPUMapMode: { READ: 1 },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    /** Restore browser constants after this check. */
    t.after(() =>
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : Reflect.deleteProperty(globalThis, key),
    );
  }
  for (const method of ["resolveTimestampsAsync", "hasFeature"]) {
    assert.equal(
      typeof WebGPURenderer.prototype[method],
      "function",
      `WebGPURenderer.${method} missing: ${UPGRADE_HINT}`,
    );
  }
  const inspector = new RendererInspector();
  assert.ok(
    Array.isArray(inspector.frames),
    `RendererInspector.frames missing: ${UPGRADE_HINT}`,
  );
  assert.equal(
    typeof inspector.resolveTimestamp,
    "function",
    `RendererInspector.resolveTimestamp missing: ${UPGRADE_HINT}`,
  );
  assert.match(
    readFileSync(
      new URL(
        "../node_modules/three/examples/jsm/inspector/Inspector.js",
        import.meta.url,
      ),
      "utf8",
    ),
    /class Inspector extends RendererInspector/,
    `Inspector no longer extends RendererInspector: ${UPGRADE_HINT}`,
  );

  for (const [name, backend] of [
    ["source", new WebGPUBackend()],
    ["webgpu", new WebGPURenderer({ canvas: {} }).backend],
    ["webgpu.nodes", new NodesRenderer({ canvas: {} }).backend],
  ]) {
    assert.equal(
      typeof backend.trackTimestamp,
      "boolean",
      `${name} backend.trackTimestamp missing: ${UPGRADE_HINT}`,
    );
    assert.ok(
      backend.timestampQueryPool && "render" in backend.timestampQueryPool,
      `${name} backend.timestampQueryPool missing: ${UPGRADE_HINT}`,
    );
    const device = backend.device;
    backend.device = {
      /** Supplies the query identity. */
      createQuerySet: () => ({}),
      /** Supplies resolve and readback storage that is never mapped here. */
      createBuffer: () => ({ mapState: "unmapped" }),
    };
    try {
      backend.trackTimestamp = true;
      backend.initTimestampQuery("render", "r:1:f1", {});
      const pool = backend.timestampQueryPool.render;
      assert.ok(
        pool.timestamps instanceof Map,
        `${name} pool.timestamps missing: ${UPGRADE_HINT}`,
      );
      assert.equal(
        typeof pool.currentQueryIndex,
        "number",
        `${name} pool.currentQueryIndex missing: ${UPGRADE_HINT}`,
      );
      // Written by `_resolveQueries` only via patches/three+0.185.1.patch; the
      // interval tests below verify their values.
      const resolver = String(pool._resolveQueries);
      for (const member of ["lastInterval", "frameIntervals"])
        assert.ok(
          resolver.includes(`this.${member}`),
          `${name} pool.${member} is never written (patch not applied?): ${UPGRADE_HINT}`,
        );
    } finally {
      delete backend.timestampQueryPool.render;
      backend.trackTimestamp = false;
      backend.device = device;
    }
  }
});

for (const [name, backend] of [
  ["source", new WebGPUBackend()],
  ["webgpu", new WebGPURenderer({ canvas: {} }).backend],
  ["webgpu.nodes", new NodesRenderer({ canvas: {} }).backend],
]) {
  /** Sampling must disable writes on reused canvas descriptors between measured frames. */
  test(`Three ${name} clears cached timestamp writes when sampling stops`, () => {
    let allocations = 0;
    const querySet = {};
    backend.timestampQueryPool.render = {
      querySet,
      allocateQueriesForContext: () => allocations++ * 2,
    };
    const descriptor = {};
    backend.trackTimestamp = true;
    backend.initTimestampQuery("render", "r:1:f1", descriptor);
    assert.equal(descriptor.timestampWrites.querySet, querySet);
    assert.equal(descriptor.timestampWrites.beginningOfPassWriteIndex, 0);

    backend.trackTimestamp = false;
    backend.initTimestampQuery("render", "r:1:f2", descriptor);
    assert.equal(descriptor.timestampWrites, undefined);
    assert.equal(allocations, 1);

    backend.trackTimestamp = true;
    backend.initTimestampQuery("render", "r:1:f3", descriptor);
    assert.equal(descriptor.timestampWrites.beginningOfPassWriteIndex, 2);
    assert.equal(descriptor.timestampWrites.endOfPassWriteIndex, 3);
    assert.equal(allocations, 2);
  });

  /** Interval bounds survive unmapping in every shipped Three entry point. */
  test(`Three ${name} preserves overlapping GPU interval bounds`, async (t) => {
    for (const [key, value] of Object.entries({
      GPUBufferUsage: {
        QUERY_RESOLVE: 1,
        COPY_SRC: 2,
        COPY_DST: 4,
        MAP_READ: 8,
      },
      GPUMapMode: { READ: 1 },
    })) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { configurable: true, value });
      /** Restore browser constants after this backend check. */
      t.after(() =>
        descriptor
          ? Object.defineProperty(globalThis, key, descriptor)
          : Reflect.deleteProperty(globalThis, key),
      );
    }
    const times = new BigUint64Array([
      1000000n,
      9000000n,
      2000000n,
      7000000n,
      20000000n,
      23000000n,
    ]);
    backend.device = {
      /** Supplies the query identity. */
      createQuerySet() {
        return {};
      },
      /** Creates CPU storage with the normal query-buffer lifecycle. */
      createBuffer() {
        return {
          mapState: "unmapped",
          /** Marks the deterministic readback ready. */
          async mapAsync() {
            this.mapState = "mapped";
          },
          /** Exposes overlapping pass timestamps. */
          getMappedRange() {
            return times.buffer;
          },
          /** Invalidates mapped data so the test detects retained views. */
          unmap() {
            this.mapState = "unmapped";
            times.fill(0n);
          },
        };
      },
      /** Provides the commands used by Three's query resolver. */
      createCommandEncoder() {
        return {
          /** Query values are already populated. */
          resolveQuerySet() {},
          /** Resolve and readback storage are aliased in this test. */
          copyBufferToBuffer() {},
          /** Completes the synthetic command buffer. */
          finish() {
            return {};
          },
        };
      },
      queue: {
        /** Simulated commands need no GPU submission. */
        submit() {},
      },
    };
    delete backend.timestampQueryPool.render;
    backend.trackTimestamp = true;
    backend.initTimestampQuery("render", "r:1:f1", {});
    backend.initTimestampQuery("render", "r:2:f1", {});
    backend.initTimestampQuery("render", "r:1:f2", {});
    const pool = backend.timestampQueryPool.render;
    assert.equal(await pool.resolveQueriesAsync(), 3);
    assert.deepEqual(pool.lastInterval, [1000000n, 23000000n]);
    assert.deepEqual(
      pool.frameIntervals,
      new Map([
        [1, [1000000n, 9000000n]],
        [2, [20000000n, 23000000n]],
      ]),
    );
    assert.equal(times[0], 0n);
    times.set([30000000n, 31000000n]);
    backend.initTimestampQuery("render", "r:1:f3", {});
    assert.equal(await pool.resolveQueriesAsync(), 1);
    assert.deepEqual(
      pool.frameIntervals,
      new Map([[3, [30000000n, 31000000n]]]),
    );
    pool.resultBuffer.mapState = "mapped";
    await pool._resolveQueries();
    assert.equal(pool.lastInterval, undefined);
    assert.equal(pool.frameIntervals, undefined);
  });
}
