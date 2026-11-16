// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WebGPUBackend } from "three/webgpu";
import { supplyWebGpuCanvasContext } from "./webgpu-canvas-context";

/** Builds a renderer double whose canvas counts and optionally fails `getContext` calls. */
function fakeRenderer(options: {
  webGpu: boolean;
  context?: unknown;
  getContext?: () => unknown;
}) {
  const calls: string[] = [];
  const renderer = {
    domElement: {
      getContext: ((type: string) => {
        calls.push(type);
        return options.getContext ? options.getContext() : { type };
      }) as OffscreenCanvas["getContext"],
    },
    backend: {
      isWebGPUBackend: options.webGpu ? true : undefined,
      parameters: { context: options.context },
    },
  };
  return { renderer, calls };
}

/** A WebGPU backend gets exactly one context, which three.js then reuses. */
test("supplyWebGpuCanvasContext hands a WebGPU backend one context", () => {
  const { renderer, calls } = fakeRenderer({ webGpu: true });
  supplyWebGpuCanvasContext(renderer);
  assert.deepEqual(calls, ["webgpu"]);
  assert.deepEqual(renderer.backend.parameters.context, { type: "webgpu" });
});

/** The WebGL fallback must keep its canvas free of a WebGPU context. */
test("supplyWebGpuCanvasContext leaves the WebGL fallback canvas alone", () => {
  const { renderer, calls } = fakeRenderer({ webGpu: false });
  supplyWebGpuCanvasContext(renderer);
  assert.deepEqual(calls, []);
  assert.equal(renderer.backend.parameters.context, undefined);
});

/** A context that is already supplied is kept, so the canvas is never asked twice. */
test("supplyWebGpuCanvasContext keeps an already supplied context", () => {
  const existing = { type: "existing" };
  const { renderer, calls } = fakeRenderer({ webGpu: true, context: existing });
  supplyWebGpuCanvasContext(renderer);
  assert.deepEqual(calls, []);
  assert.equal(renderer.backend.parameters.context, existing);
});

/** A refused context leaves three.js to ask the canvas itself instead of throwing. */
test("supplyWebGpuCanvasContext tolerates a refused context", () => {
  const { renderer } = fakeRenderer({
    webGpu: true,
    getContext: () => {
      throw new Error("InvalidStateError");
    },
  });
  assert.doesNotThrow(() => supplyWebGpuCanvasContext(renderer));
  assert.equal(renderer.backend.parameters.context, undefined);
});

/**
 * Pins the three.js behaviour the fix relies on: after a resize drops the
 * backend's canvas data, the real `WebGPUBackend` reuses the supplied context
 * instead of asking the canvas again. A three.js upgrade that changes this
 * breaks Firefox 159 again, so it must fail here.
 */
test("three.js reuses a supplied canvas context after a resize", () => {
  const globals = globalThis as { GPUTextureUsage?: unknown };
  const previousUsage = globals.GPUTextureUsage;
  globals.GPUTextureUsage = { RENDER_ATTACHMENT: 16, COPY_SRC: 1 };
  try {
    const configured: unknown[] = [];
    const context = {
      configure: (options: unknown) => configured.push(options),
    };
    const getContextCalls: string[] = [];
    const canvas = {
      getContext: (type: string) => {
        getContextCalls.push(type);
        return context;
      },
    };
    const backend = new WebGPUBackend({ canvas } as never);
    const canvasTarget = { isDefaultCanvasTarget: true, domElement: canvas };
    const internals = backend as unknown as {
      renderer: unknown;
      context: unknown;
      updateSize: () => void;
      utils: { getPreferredCanvasFormat: () => string };
    };
    internals.renderer = { getCanvasTarget: () => canvasTarget };
    internals.utils.getPreferredCanvasFormat = () => "bgra8unorm";

    supplyWebGpuCanvasContext({
      domElement: canvas as never,
      backend: backend as never,
    });
    assert.equal(internals.context, context);
    internals.updateSize();
    assert.equal(internals.context, context);

    assert.deepEqual(getContextCalls, ["webgpu"]);
    assert.equal(configured.length, 2);
  } finally {
    globals.GPUTextureUsage = previousUsage;
  }
});
