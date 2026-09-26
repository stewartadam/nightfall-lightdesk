// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Browser-side helpers for optics GPU specs. Import inside `page.evaluate` as
 * `await import("/e2e/fixtures/optics-harness.ts")` after loading
 * `/e2e/fixtures/optics.html`; the Node-side counterpart is `webui/e2e/optics-harness.ts`.
 */

import { WebGPURenderer } from "three/webgpu";
import { WEBGPU_UNAVAILABLE } from "./optics-constants";

/** Name of the backend a renderer actually initialized. */
export type RendererBackend = "webgpu" | "webgl";

/** Accumulated 8-bit channel totals over a readback region. */
export type ChannelSums = { red: number; green: number; blue: number };

/** Pixel rectangle in device pixels. */
export type PixelRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Minimal renderer surface needed to drive and read frames. */
type FrameSource = Pick<WebGPURenderer, "domElement" | "setAnimationLoop">;

/** Canvases retained for failure diagnostics, keyed by artifact name. */
const retained = new Map<string, HTMLCanvasElement>();

/** Reusable readback surface so repeated captures do not allocate canvases. */
let readback: CanvasRenderingContext2D | undefined;

/** Returns the backend name recorded by Three once `renderer.init()` has settled. */
export function rendererBackend(renderer: WebGPURenderer): RendererBackend {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? "webgpu"
    : "webgl";
}

/**
 * Verifies an initialized renderer runs on the requested backend. `WebGPURenderer`
 * silently falls back to WebGL, so a WebGPU variant must prove it did not. A fallback
 * is reported as unavailability (the Node harness skips the test) only when the
 * browser exposes no WebGPU adapter; with an adapter present it is a real failure.
 * When `forceWebGL` is undefined any backend is accepted and simply reported.
 */
export async function verifyBackend(
  renderer: WebGPURenderer,
  forceWebGL: boolean | undefined,
): Promise<RendererBackend> {
  const backend = rendererBackend(renderer);
  if (forceWebGL === undefined) return backend;
  if (forceWebGL && backend !== "webgl")
    throw new Error("forceWebGL renderer initialized a WebGPU backend");
  if (!forceWebGL && backend !== "webgpu") {
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
    renderer.dispose();
    throw new Error(
      adapter
        ? "Renderer fell back to WebGL although a WebGPU adapter is available"
        : `${WEBGPU_UNAVAILABLE} in this browser`,
    );
  }
  return backend;
}

/**
 * Creates, sizes and initializes a `WebGPURenderer` on the fixture canvas and verifies
 * its backend with {@link verifyBackend}. Pass `forceWebGL: undefined` to accept the
 * default backend (the production selection path).
 */
export async function createTestRenderer(options: {
  forceWebGL: boolean | undefined;
  width: number;
  height: number;
  pixelRatio?: number;
  canvas?: HTMLCanvasElement;
  antialias?: boolean;
}): Promise<{ renderer: WebGPURenderer; backend: RendererBackend }> {
  const renderer = new WebGPURenderer({
    canvas: options.canvas ?? document.querySelector("canvas")!,
    forceWebGL: options.forceWebGL ?? false,
    ...(options.antialias === undefined
      ? {}
      : { antialias: options.antialias }),
  });
  if (options.pixelRatio !== undefined)
    renderer.setPixelRatio(options.pixelRatio);
  renderer.setSize(options.width, options.height);
  await renderer.init();
  return {
    renderer,
    backend: await verifyBackend(renderer, options.forceWebGL),
  };
}

/**
 * Drives `render` from the renderer's animation loop for `frames` frames, so pipeline
 * compilation, instance uploads and asynchronous resources settle before a readback.
 */
export function renderFrames(
  renderer: Pick<WebGPURenderer, "setAnimationLoop">,
  frames: number,
  render: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let rendered = 0;
    renderer.setAnimationLoop(() => {
      try {
        render();
      } catch (error) {
        renderer.setAnimationLoop(null);
        reject(error);
        return;
      }
      if (++rendered === frames) {
        renderer.setAnimationLoop(null);
        resolve();
      }
    });
  });
}

/**
 * Copies the presented canvas into a reusable 2D surface and returns its RGBA pixels,
 * optionally limited to a device-pixel region.
 */
export function readPixels(
  source: HTMLCanvasElement | OffscreenCanvas,
  region?: PixelRegion,
): Uint8ClampedArray {
  if (!readback) {
    readback = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true })!;
  }
  const canvas = readback.canvas;
  if (canvas.width !== source.width || canvas.height !== source.height) {
    canvas.width = source.width;
    canvas.height = source.height;
  } else {
    readback.clearRect(0, 0, canvas.width, canvas.height);
  }
  readback.drawImage(source, 0, 0);
  const { x, y, width, height } = region ?? {
    x: 0,
    y: 0,
    width: canvas.width,
    height: canvas.height,
  };
  return readback.getImageData(x, y, width, height).data;
}

/** Sums the red, green and blue channels of RGBA pixels. */
export function channelSums(pixels: Uint8ClampedArray): ChannelSums {
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    red += pixels[i];
    green += pixels[i + 1];
    blue += pixels[i + 2];
  }
  return { red, green, blue };
}

/**
 * Renders `frames` frames through `render` and returns the channel sums of the
 * presented canvas.
 */
export async function renderAndSum(
  renderer: FrameSource,
  render: () => void,
  frames = 4,
): Promise<ChannelSums> {
  await renderFrames(renderer, frames, render);
  return channelSums(readPixels(renderer.domElement));
}

/**
 * Keeps an unencoded copy of the presented canvas so the Node harness can attach it
 * only if the test fails; passing tests never pay for PNG encoding.
 */
export function retainCanvas(
  name: string,
  source: HTMLCanvasElement | OffscreenCanvas,
): void {
  const copy = retained.get(name) ?? document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d")!.drawImage(source, 0, 0);
  retained.set(name, copy);
}

/** Encodes every retained canvas as a base64 PNG for failure attachments. */
export function encodeRetainedCanvases(): Record<string, string> {
  return Object.fromEntries(
    [...retained].map(([name, canvas]) => [
      name,
      canvas.toDataURL("image/png").split(",")[1],
    ]),
  );
}

/** Returns a PNG data URL of a solid 32×32 mask, optionally painted by `paint`. */
export function maskUrl(
  fill: string,
  paint?: (context: CanvasRenderingContext2D) => void,
  size = 32,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.fillStyle = fill;
  context.fillRect(0, 0, size, size);
  paint?.(context);
  return canvas.toDataURL("image/png");
}

/**
 * Waits until every gobo atlas slot has left the `loading` state and throws if any
 * failed to decode or the deadline elapsed.
 */
export async function waitForGoboSlots(
  slots: readonly { status: string }[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (
    slots.some((slot) => slot.status === "loading") &&
    performance.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const states = slots.map((slot) => slot.status);
  if (states.some((state) => state !== "ready"))
    throw new Error(`Gobo slots did not load: ${states.join(", ")}`);
}
