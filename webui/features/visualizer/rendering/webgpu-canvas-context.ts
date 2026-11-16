// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Gives three.js a single WebGPU canvas context so it never asks the canvas for
 * one again.
 *
 * three.js throws away its cached canvas context whenever the renderer resizes,
 * and calls `getContext("webgpu")` again on the next frame. Firefox 159 rejects
 * any repeat `getContext()` call on a canvas a worker has already drawn to
 * ("Cannot update created context to different thread"), so the worker
 * visualizer stayed blank and threw on every frame after its first resize.
 * When a context is supplied, three.js uses it for its own canvas instead of
 * asking again.
 */

import type { WebGPURenderer } from "three/webgpu";
import { getLogger } from "../../../lib/logger";

const log = getLogger(import.meta.url);

/** Renderer fields read here; three.js does not type the backend parameters. */
interface CanvasContextRenderer {
  domElement: Pick<OffscreenCanvas, "getContext">;
  backend: {
    isWebGPUBackend?: boolean;
    parameters: { context?: unknown };
  };
}

/**
 * Creates the renderer's WebGPU canvas context and hands it to three.js. Call
 * it right after `renderer.init()` and before the first frame, while three.js
 * has not asked the canvas for a context yet.
 *
 * Only a confirmed WebGPU backend gets a context: a canvas that holds a WebGPU
 * context can no longer give three.js's WebGL fallback a WebGL one. A failure
 * leaves three.js to ask the canvas itself, as it would without this call.
 */
export function supplyWebGpuCanvasContext(
  renderer: WebGPURenderer | CanvasContextRenderer,
): void {
  const { backend, domElement } = renderer as CanvasContextRenderer;
  if (!backend.isWebGPUBackend || backend.parameters.context !== undefined) {
    return;
  }
  try {
    const context = domElement.getContext("webgpu");
    if (context) backend.parameters.context = context;
  } catch (error) {
    log.warn("Could not create the WebGPU canvas context up front", { error });
  }
}
