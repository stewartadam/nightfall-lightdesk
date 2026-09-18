// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PerspectiveCamera } from "three/webgpu";
import { getLogger } from "../../../lib/logger";
import type { CameraState } from "../rendering/renderers/renderer-api";

const CAMERA_STORAGE_KEY = "visualizer-camera-state";

/** Default camera position */
export const DEFAULT_CAMERA_POSITION = { x: 5, y: 8, z: 10 };
/** Default orbit target */
export const DEFAULT_CAMERA_TARGET = { x: 0, y: 2, z: 0 };

const log = getLogger(import.meta.url);

/**
 * Save camera state to localStorage.
 * Silently returns if localStorage is unavailable (e.g., in web workers).
 */
export function saveCameraState(state: CameraState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // localStorage may be unavailable or full
    log.errorWithCause(e, "Failed to save camera state");
  }
}

/**
 * Extract camera state from camera and controls.
 */
export function getCameraState(
  camera: PerspectiveCamera,
  controls: OrbitControls,
): CameraState {
  return {
    position: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    },
    target: {
      x: controls.target.x,
      y: controls.target.y,
      z: controls.target.z,
    },
  };
}

/**
 * Load camera position and target from localStorage.
 * Returns null if localStorage is unavailable (e.g., in web workers).
 */
export function loadCameraState(): CameraState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(CAMERA_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as CameraState;
    }
  } catch {
    // localStorage may be unavailable or corrupted
  }
  return null;
}
