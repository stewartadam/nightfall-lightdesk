// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Renderer lifecycle hook for Visualizer canvas panels.
 *
 * Owns renderer creation/disposal, bridges panel state into renderer startup,
 * and exposes a panel-scoped debug/control API used by dock panels and tests.
 */

import { createSignal, onCleanup, onMount } from "solid-js";
import type * as THREE from "three";
import { getLogger } from "../../../lib/logger";
import type { VisualizerStats } from "../../../state/appStores";
import { createVisualizerRenderer } from "../rendering/create-renderer";
import type {
  CameraState,
  IVisualizerRenderer,
  Vec3,
  VisualizerInteractionMode,
} from "../rendering/renderers/renderer-api";
import { initializeOwnedVisualizerRenderer } from "./renderer-lifecycle-ownership";

const log = getLogger(import.meta.url);

interface UseVisualizerRendererLifecycleOptions {
  canvasRef: () => HTMLCanvasElement | undefined;
  containerRef: () => HTMLDivElement | undefined;
  forceMainThread?: boolean;
  getToolMode: () => VisualizerInteractionMode;
  getSelection: () => readonly string[];
  onStats: (stats: VisualizerStats | null) => void;
  /** Receives the active renderer API, then `null` once that renderer is disposed. */
  apiRef?: (api: VisualizerRendererPublicApi | null) => void;
  /** Camera pose carried over from a renderer this one replaces. */
  initialCameraState?: CameraState;
}

/**
 * Public imperative API exposed by `VisualizerCanvas` to panel/debug callers.
 */
interface VisualizerRendererPublicApi {
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  getScene: () => THREE.Scene | undefined;
  toggleEmitterDebug: () => void;
  toggleBeams: () => void;
  isUsingWorker: () => boolean;
  getCameraState: () => Promise<CameraState>;
  setCameraPosition: (position: Vec3) => void;
  setCameraTarget: (target: Vec3) => void;
  setCameraState: (state: CameraState) => void;
  resetCamera: () => void;
  zoomToFit: (uids?: string[]) => void;
  zoomToSelection: () => void;
}

/**
 * Creates and manages the renderer instance for the current canvas element.
 */
export function useVisualizerRendererLifecycle(
  options: UseVisualizerRendererLifecycleOptions,
) {
  const [renderer, setRenderer] = createSignal<IVisualizerRenderer | null>(
    null,
  );
  let disposed = false;

  onMount(async () => {
    log.trace("mounting");
    const canvas = options.canvasRef();
    const container = options.containerRef();
    if (!canvas || !container) return;

    try {
      await initializeOwnedVisualizerRenderer(
        () =>
          createVisualizerRenderer(canvas, container, {
            forceMainThread: options.forceMainThread,
            initialCameraState: options.initialCameraState,
          }),
        () => disposed,
        (newRenderer) => {
          newRenderer.setStatsCallback((stats) => {
            if (!disposed) options.onStats(stats);
          });
          newRenderer.setInteractionMode(options.getToolMode());

          setRenderer(newRenderer);

          options.apiRef?.({
            pause: () => renderer()?.pause(),
            resume: () => renderer()?.resume(),
            isPaused: () => renderer()?.isPaused() ?? true,
            getScene: () => renderer()?.getScene(),
            toggleEmitterDebug: () => renderer()?.toggleEmitterDebug(),
            toggleBeams: () => renderer()?.toggleBeams(),
            isUsingWorker: () => renderer()?.isUsingWorker() ?? false,
            getCameraState: async () =>
              (await renderer()?.getCameraState()) ?? {
                position: { x: 5, y: 8, z: 10 },
                target: { x: 0, y: 2, z: 0 },
              },
            setCameraPosition: (position) =>
              renderer()?.setCameraPosition(position),
            setCameraTarget: (target) => renderer()?.setCameraTarget(target),
            setCameraState: (state) => renderer()?.setCameraState(state),
            resetCamera: () => renderer()?.resetCamera(),
            zoomToFit: (uids?: string[]) => renderer()?.zoomToFit(uids),
            zoomToSelection: () => {
              const selection = options.getSelection();
              if (selection.length > 0) {
                renderer()?.zoomToFit([...selection]);
              } else {
                renderer()?.zoomToFit();
              }
            },
          });

          log.debug(
            `Canvas initialized (${newRenderer.isUsingWorker() ? "worker" : "main-thread"})`,
          );
        },
      );
    } catch (error) {
      if (!disposed) {
        log.errorWithCause(error, "Failed to initialize renderer");
      }
    }
  });

  onCleanup(() => {
    disposed = true;
    const currentRenderer = renderer();
    // Callers holding the published API must not reach the disposed renderer.
    setRenderer(null);
    if (currentRenderer) options.apiRef?.(null);
    currentRenderer?.setStatsCallback(null);
    currentRenderer?.dispose();
    options.onStats(null);
  });

  return {
    renderer,
  };
}
