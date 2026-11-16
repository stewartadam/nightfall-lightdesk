// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Factory function for creating visualizer renderers.
 *
 * Returns the appropriate renderer (worker or main-thread) based on
 * OffscreenCanvas support and configuration.
 */

import * as Comlink from "comlink";
import {
  getVisualizerSimulatedFailure,
  isVisualizerFramePacingEnabled,
  isVisualizerInspectorEnabled,
} from "../../../lib/feature-flags";
import { watchWorkerUncaughtErrors } from "../../../lib/uncaught-error-reporter";
import { visualizerEffectiveQuality } from "../state/settings";
import { MainThreadRenderer } from "./renderers/main-thread-renderer";
import type { SimulatedRenderFailureKind } from "./renderers/render-failure";
import type {
  CameraState,
  IVisualizerRenderer,
} from "./renderers/renderer-api";
import {
  type VisualizerWorkerApi,
  WorkerRendererProxy,
} from "./renderers/worker-renderer";

/**
 * Options for creating a visualizer renderer.
 */
export interface CreateRendererOptions {
  /** Force main thread rendering even if OffscreenCanvas is available */
  forceMainThread?: boolean;
  /** Camera pose to start from instead of the persisted camera state. */
  initialCameraState?: CameraState;
}

interface VisualizerRendererInitializationTestWindow extends Window {
  __nightfallE2eVisualizerRendererInitializationGate?: (
    renderer: IVisualizerRenderer,
  ) => Promise<void>;
}

/**
 * Check if OffscreenCanvas is supported.
 */
function supportsOffscreenCanvas(): boolean {
  return (
    typeof HTMLCanvasElement !== "undefined" &&
    "transferControlToOffscreen" in HTMLCanvasElement.prototype
  );
}

/**
 * Picks the failure a renderer in this mode should fake, from the
 * `visualizer:simulateFailure` URL flag; `render-worker` spares main-thread
 * renderers so the fallback to them can be tested.
 */
function resolveSimulatedFailure(
  useWorker: boolean,
): SimulatedRenderFailureKind | undefined {
  const simulated = getVisualizerSimulatedFailure();
  if (simulated === "render-worker") return useWorker ? "render" : undefined;
  return simulated ?? undefined;
}

/**
 * Allows E2E tests to suspend renderer creation after initialization but before
 * the component takes ownership of the renderer. The gate receives the raw
 * renderer so tests can keep a reference that outlives its disposal.
 */
async function waitAtRendererInitializationTestGate(
  renderer: IVisualizerRenderer,
): Promise<void> {
  if (new URLSearchParams(window.location.search).get("e2e") !== "1") return;
  const testWindow = window as VisualizerRendererInitializationTestWindow;
  await testWindow.__nightfallE2eVisualizerRendererInitializationGate?.(
    renderer,
  );
}

/**
 * Create a visualizer renderer.
 *
 * Unless options specify otherwise, returns a worker-based renderer if
 * OffscreenCanvas is supported, falling back to main thread rendering if not.
 *
 * @param canvas The canvas element to render to
 * @param container The container element for the canvas
 * @param options Creation options
 * @returns A promise resolving to the renderer
 */
export async function createVisualizerRenderer(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  options: CreateRendererOptions = {},
): Promise<IVisualizerRenderer> {
  const useWorker = !options.forceMainThread && supportsOffscreenCanvas();

  // Get initial dimensions
  const rect = container.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : 800;
  const height = rect.height > 0 ? rect.height : 600;

  const createRenderer = (): IVisualizerRenderer => {
    if (useWorker) {
      const worker = new Worker(
        new URL("./renderers/worker-renderer.ts", import.meta.url),
        { type: "module" },
      );
      watchWorkerUncaughtErrors(worker, "visualizer");
      const workerApi = Comlink.wrap<VisualizerWorkerApi>(worker);
      return new WorkerRendererProxy(worker, workerApi);
    } else {
      return new MainThreadRenderer();
    }
  };

  const renderer = createRenderer();

  try {
    await renderer.init({
      canvas,
      width,
      height,
      devicePixelRatio: window.devicePixelRatio,
      initialCameraState: options.initialCameraState,
      diagnostics:
        isVisualizerInspectorEnabled() || isVisualizerFramePacingEnabled(),
      quality: visualizerEffectiveQuality.get(),
      simulateFailure: resolveSimulatedFailure(useWorker),
    });
    await waitAtRendererInitializationTestGate(renderer);
    renderer.setupResizeObserver?.(container);
  } catch (error) {
    // Nobody else holds the renderer yet, so release its worker here.
    renderer.dispose();
    throw error;
  }

  return renderer;
}
