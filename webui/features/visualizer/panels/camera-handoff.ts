// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CameraState } from "../rendering/renderers/renderer-api";

/** One-shot hand-off of a camera pose from a replaced renderer to the canvas that replaces it. */
export interface CameraHandoff {
  /** Stores the outgoing renderer's pose (or none) for the next mounted canvas. */
  offer(state: CameraState | undefined): void;
  /**
   * Returns the offered pose and clears it, so any later remount falls back to the current
   * persisted camera instead of a stale hand-off.
   */
  take(): CameraState | undefined;
}

/** Creates an empty camera hand-off owned by one visualizer panel. */
export function createCameraHandoff(): CameraHandoff {
  let pending: CameraState | undefined;
  return {
    offer(state) {
      pending = state;
    },
    take() {
      const state = pending;
      pending = undefined;
      return state;
    },
  };
}
