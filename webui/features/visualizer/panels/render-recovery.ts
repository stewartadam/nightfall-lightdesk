// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Decides how a visualizer panel recovers when its renderer fails: restart it
 * once, then fall back from the worker renderer to the main-thread renderer,
 * then give up and show the error.
 */

import { atom } from "nanostores";

/** Where a visualizer renders. */
export type VisualizerRenderMode = "worker" | "main-thread";

/**
 * Rendering this long without a failure counts as healthy again, so a later
 * failure (such as GPU device loss after the computer sleeps) gets a fresh
 * restart instead of an immediate fallback.
 */
export const HEALTHY_RENDER_MS = 60_000;

/**
 * Set once a worker renderer failed after its restart. Every visualizer then
 * renders on the main thread for the rest of the session, since the browser's
 * worker rendering is evidently broken.
 */
export const $workerRenderingFailed = atom(false);

/** What a panel knows about its current renderer when it fails. */
export interface RenderRecoveryState {
  /** The failed renderer's mode. */
  mode: VisualizerRenderMode;
  /** Whether this renderer is already a restart in the same mode. */
  restarted: boolean;
  /** When the failed renderer was mounted, in milliseconds. */
  mountedAt: number;
}

/** The next step after a renderer failure. */
export type RenderRecoveryPlan =
  | { action: "restart"; mode: VisualizerRenderMode }
  | { action: "fallback"; mode: "main-thread" }
  | { action: "give-up" };

/**
 * Picks the next recovery step. A renderer that had been healthy for a while,
 * or that is not a restart yet, is restarted in the same mode. A restarted
 * worker renderer that fails again falls back to the main thread; a restarted
 * main-thread renderer gives up so the panel can show the error.
 */
export function planRenderRecovery(
  state: RenderRecoveryState,
  now: number,
): RenderRecoveryPlan {
  const wasHealthy = now - state.mountedAt >= HEALTHY_RENDER_MS;
  if (!state.restarted || wasHealthy) {
    return { action: "restart", mode: state.mode };
  }
  if (state.mode === "worker")
    return { action: "fallback", mode: "main-thread" };
  return { action: "give-up" };
}

/** Picks the mode a new visualizer starts in. */
export function initialRenderMode(
  offscreenCanvasEnabled: boolean,
  workerRenderingFailed: boolean,
): VisualizerRenderMode {
  return offscreenCanvasEnabled && !workerRenderingFailed
    ? "worker"
    : "main-thread";
}
