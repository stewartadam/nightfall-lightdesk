// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Recovers a visualizer panel from renderer failures by remounting its canvas,
 * falling back from the worker to the main thread, and finally showing the
 * error with a Retry button.
 */

import { createSignal } from "solid-js";
import { isOffscreenCanvasEnabled } from "../../../lib/feature-flags";
import { getLogger } from "../../../lib/logger";
import { forwardRecoveredError } from "../../../lib/uncaught-error-reporter";
import type { VisualizerCanvasApi } from "../controllers/visualizer-canvas-api";
import type { VisualizerRenderFailure } from "../rendering/renderers/render-failure";
import type { CameraState } from "../rendering/renderers/renderer-api";
import type { CameraHandoff } from "./camera-handoff";
import {
  $workerRenderingFailed,
  initialRenderMode,
  planRenderRecovery,
  type VisualizerRenderMode,
} from "./render-recovery";

const log = getLogger(import.meta.url);

/** Longest wait for a failed renderer's camera pose before remounting without it. */
const CAMERA_CAPTURE_TIMEOUT_MS = 1000;

/**
 * Reads the outgoing renderer's camera pose so its replacement starts from the
 * same view. Resolves to undefined when the renderer cannot answer in time,
 * because a broken renderer must not block its own replacement.
 */
export async function captureCameraForRemount(
  api: VisualizerCanvasApi | null,
  reason: string,
): Promise<CameraState | undefined> {
  if (!api) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), CAMERA_CAPTURE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([api.getCameraState(), timeout]);
  } catch (error) {
    log.warn(`Could not capture camera before ${reason}`, { error });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** What the recovery hook needs from its panel. */
interface RenderRecoveryOptions {
  /** The mounted canvas's API, used to carry the camera over. */
  getApi: () => VisualizerCanvasApi | null;
  /** Hands the camera pose to the next mounted canvas. */
  cameraHandoff: CameraHandoff;
}

/**
 * Tracks the panel's render mode and remounts its canvas after a renderer
 * failure, following {@link planRenderRecovery}. The panel keys its canvas on
 * {@link mountKey} and shows {@link failure} once recovery gives up.
 */
export function useRenderRecovery(options: RenderRecoveryOptions) {
  const [mode, setMode] = createSignal<VisualizerRenderMode>(
    initialRenderMode(isOffscreenCanvasEnabled(), $workerRenderingFailed.get()),
  );
  const [generation, setGeneration] = createSignal(0);
  const [failure, setFailure] = createSignal<VisualizerRenderFailure | null>(
    null,
  );
  let restarted = false;
  let mountedAt = performance.now();
  let recovering = false;

  /** Replaces the canvas with a fresh one in the given mode, keeping the camera. */
  const remount = async (nextMode: VisualizerRenderMode, reason: string) => {
    options.cameraHandoff.offer(
      await captureCameraForRemount(options.getApi(), reason),
    );
    setMode(nextMode);
    setGeneration((value) => value + 1);
  };

  /** Applies the next recovery step for a failure of the mounted renderer. */
  const handleFailure = (next: VisualizerRenderFailure) => {
    if (recovering || failure()) return;
    const plan = planRenderRecovery(
      { mode: mode(), restarted, mountedAt },
      performance.now(),
    );
    log.warn(
      `Visualizer renderer failed (${next.kind}, ${mode()}): ${next.message}; next step: ${plan.action}`,
    );
    forwardRecoveredError("visualizer", next);
    if (plan.action === "give-up") {
      setFailure(next);
      return;
    }
    recovering = true;
    restarted = plan.action === "restart";
    if (plan.action === "fallback") $workerRenderingFailed.set(true);
    void remount(plan.mode, "a visualizer restart").finally(() => {
      recovering = false;
    });
  };

  /** Clears a shown failure and starts over with a fresh restart allowance. */
  const retry = () => {
    restarted = false;
    setFailure(null);
    setGeneration((value) => value + 1);
  };

  return {
    mode,
    failure,
    /** The shown failure as an Error, so the error panel lists its stack. */
    failureError: () => {
      const shown = failure();
      if (!shown) return null;
      const error = new Error(shown.message);
      error.name = "Visualizer stopped";
      error.stack = shown.stack;
      return error;
    },
    handleFailure,
    retry,
    /** Changes whenever the canvas must be replaced. */
    mountKey: () => `${mode()}:${generation()}`,
    /** Records when the current canvas mounted, to judge how healthy it was. */
    markMounted: () => {
      mountedAt = performance.now();
    },
  };
}
