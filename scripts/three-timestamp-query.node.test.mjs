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
  "depend on this three.js member; update the GPU timing code after a three upgrade";

/**
 * GPU timing reads private three.js members. This fails with an actionable
 * message when an upgrade drops or renames any of them, instead of timing
 * silently vanishing.
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
  const inspectorSource = readFileSync(
    new URL(
      "../node_modules/three/examples/jsm/inspector/Inspector.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    inspectorSource,
    /class Inspector extends RendererInspector/,
    `Inspector no longer extends RendererInspector: ${UPGRADE_HINT}`,
  );
  assert.match(
    inspectorSource,
    /frame\.gpu \+=/,
    `Inspector no longer totals frame.gpu: ${UPGRADE_HINT}`,
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
    } finally {
      delete backend.timestampQueryPool.render;
      backend.trackTimestamp = false;
      backend.device = device;
    }
  }
});
