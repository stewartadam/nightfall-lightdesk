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
import { isVisualizerInspectorEnabled } from "../../../lib/feature-flags";
import { visualizerQualityPreset } from "../state/settings";
import { MainThreadRenderer } from "./renderers/main-thread-renderer";
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
  __nightfallE2eVisualizerRendererInitializationGate?: () => Promise<void>;
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
 * Allows E2E tests to suspend renderer creation after initialization but before
 * the component takes ownership of the renderer.
 */
async function waitAtRendererInitializationTestGate(): Promise<void> {
  if (new URLSearchParams(window.location.search).get("e2e") !== "1") return;
  const testWindow = window as VisualizerRendererInitializationTestWindow;
  await testWindow.__nightfallE2eVisualizerRendererInitializationGate?.();
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
      const workerApi = Comlink.wrap<VisualizerWorkerApi>(worker);
      return new WorkerRendererProxy(worker, workerApi);
    } else {
      return new MainThreadRenderer();
    }
  };

  const renderer = createRenderer();

  await renderer.init({
    canvas,
    width,
    height,
    devicePixelRatio: window.devicePixelRatio,
    initialCameraState: options.initialCameraState,
    diagnostics: isVisualizerInspectorEnabled(),
    beamQuality: visualizerQualityPreset.get(),
  });

  await waitAtRendererInitializationTestGate();

  if (renderer.setupResizeObserver) {
    renderer.setupResizeObserver(container);
  }

  return renderer;
}
