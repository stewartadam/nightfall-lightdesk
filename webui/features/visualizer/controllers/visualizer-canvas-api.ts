// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as THREE from "three";
import type { CameraState, Vec3 } from "../rendering/renderers/renderer-api";

export interface VisualizerCanvasApi {
  /** Pause rendering */
  pause: () => void;
  /** Resume rendering */
  resume: () => void;
  /** Check if paused */
  isPaused: () => boolean;
  /** Get the Three.js scene for inspection (only available in main thread mode) */
  getScene: () => THREE.Scene | undefined;
  /** Toggle emitter debug markers */
  toggleEmitterDebug: () => void;
  /** Toggle volumetric beam rendering */
  toggleBeams: () => void;
  /** Check if using offscreen canvas worker */
  isUsingWorker: () => boolean;

  // Viewport control for programmatic camera manipulation / testing
  /** Get the current camera state (position and target) */
  getCameraState: () => Promise<CameraState>;
  /** Set the camera position */
  setCameraPosition: (position: Vec3) => void;
  /** Set the orbit target (the point the camera looks at) */
  setCameraTarget: (target: Vec3) => void;
  /** Set both camera position and target at once */
  setCameraState: (state: CameraState) => void;
  /** Reset the camera to default position and target */
  resetCamera: () => void;
  /** Zoom camera to frame the specified fixtures (or all if no UIDs provided) */
  zoomToFit: (uids?: string[]) => void;
  /** Zoom camera to frame the currently selected fixtures */
  zoomToSelection: () => void;
}
