// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Axis = "x" | "y" | "z";

export interface ScreenPoint2D {
  x: number;
  y: number;
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
}

export interface VisualizerScreenPoint {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface VisualizerScreenRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  viewportWidth: number;
  viewportHeight: number;
}
