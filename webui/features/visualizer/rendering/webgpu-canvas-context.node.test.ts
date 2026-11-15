// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
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
