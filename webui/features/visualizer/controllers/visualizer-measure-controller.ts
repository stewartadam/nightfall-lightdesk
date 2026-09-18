// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { resolveAxisLock } from "../interactions/visualizer-axis-lock";
import {
  axisDistanceFromCursorRay,
  type CameraBasis,
  createCameraBasis,
  DEFAULT_INTERACTION_EPSILON,
  determineAxisScreenDirections,
  intersectScreenPointWithHorizontalPlane,
  projectWorldPointToScreen,
  vec3Distance,
} from "../interactions/visualizer-interaction-math";
import type {
  Axis,
  CameraState,
  Vec3,
  VisualizerScreenPoint,
} from "../interactions/visualizer-interaction-types";

interface MeasureSession {
  pointerId: number;
  startPoint: Vec3;
  startScreenPoint: VisualizerScreenPoint;
  cameraState: CameraState;
  cameraBasis: CameraBasis;
  axisScreenDirections: Record<Axis, { x: number; y: number }>;
  lockedAxis: Axis | null;
  lastAxisSwitchPoint: VisualizerScreenPoint | null;
  endPoint: Vec3 | null;
}

export interface BeginMeasureInput {
  pointerId: number;
  startPoint: Vec3;
  startScreenPoint: VisualizerScreenPoint;
  cameraState: CameraState;
}

export interface MeasurePreview {
  lockedAxis: Axis | null;
  startPoint: Vec3;
  endPoint: Vec3 | null;
  distance: number;
}

export interface MeasureResult extends MeasurePreview {
  didMeasure: boolean;
}

const EPSILON = DEFAULT_INTERACTION_EPSILON;

export { intersectScreenPointWithHorizontalPlane, projectWorldPointToScreen };

function measureDistance(startPoint: Vec3, endPoint: Vec3, axis: Axis): number {
  if (axis === "x") return Math.abs(endPoint.x - startPoint.x);
  if (axis === "y") return Math.abs(endPoint.y - startPoint.y);
  return Math.abs(endPoint.z - startPoint.z);
}

export class VisualizerMeasureController {
  private session: MeasureSession | null = null;

  getActivePointerId(): number | null {
    return this.session?.pointerId ?? null;
  }

  getCameraState(): CameraState | null {
    return this.session?.cameraState ?? null;
  }

  beginMeasure(input: BeginMeasureInput): void {
    this.session = {
      pointerId: input.pointerId,
      startPoint: { ...input.startPoint },
      startScreenPoint: { ...input.startScreenPoint },
      cameraState: input.cameraState,
      cameraBasis: createCameraBasis(input.cameraState, EPSILON),
      axisScreenDirections: determineAxisScreenDirections(
        input.startPoint,
        input.cameraState,
        input.startScreenPoint.viewportWidth,
        input.startScreenPoint.viewportHeight,
        EPSILON,
      ),
      lockedAxis: null,
      lastAxisSwitchPoint: null,
      endPoint: null,
    };
  }

  updateMeasure(
    point: VisualizerScreenPoint,
    shiftKey: boolean,
  ): MeasurePreview | null {
    const session = this.session;
    if (!session) return null;

    const axisDistances: Record<Axis, number> = {
      x: this.computeDistanceForAxis("x", point),
      y: this.computeDistanceForAxis("y", point),
      z: this.computeDistanceForAxis("z", point),
    };

    const previousLock = session.lockedAxis;
    const lockState = resolveAxisLock({
      point,
      startScreenPoint: session.startScreenPoint,
      shiftKey,
      axisDistances,
      axisScreenDirections: session.axisScreenDirections,
      state: {
        lockedAxis: session.lockedAxis,
        lastAxisSwitchPoint: session.lastAxisSwitchPoint,
      },
    });
    session.lockedAxis = lockState.lockedAxis;
    session.lastAxisSwitchPoint = lockState.lastAxisSwitchPoint;

    if (previousLock && !session.lockedAxis) {
      session.endPoint = null;
    }

    if (session.lockedAxis) {
      session.endPoint = this.computeEndPointForAxis(session.lockedAxis, point);
    } else {
      session.endPoint = null;
    }

    const distance =
      session.lockedAxis && session.endPoint
        ? measureDistance(
            session.startPoint,
            session.endPoint,
            session.lockedAxis,
          )
        : 0;

    return {
      lockedAxis: session.lockedAxis,
      startPoint: session.startPoint,
      endPoint: session.endPoint,
      distance,
    };
  }

  endMeasure(): MeasureResult | null {
    const session = this.session;
    if (!session) return null;
    const distance =
      session.lockedAxis && session.endPoint
        ? measureDistance(
            session.startPoint,
            session.endPoint,
            session.lockedAxis,
          )
        : 0;
    const result: MeasureResult = {
      lockedAxis: session.lockedAxis,
      startPoint: session.startPoint,
      endPoint: session.endPoint,
      distance,
      didMeasure:
        !!session.lockedAxis && !!session.endPoint && distance >= EPSILON,
    };
    this.session = null;
    return result;
  }

  cancelMeasure(): void {
    this.session = null;
  }

  private computeDistanceForAxis(
    axis: Axis,
    point: VisualizerScreenPoint,
  ): number {
    const endPoint = this.computeEndPointForAxis(axis, point);
    if (!endPoint) return 0;

    const session = this.session;
    if (!session) return 0;
    return vec3Distance(endPoint, session.startPoint);
  }

  private computeEndPointForAxis(
    axis: Axis,
    point: VisualizerScreenPoint,
  ): Vec3 | null {
    const session = this.session;
    if (!session) return null;

    const axisDistance = axisDistanceFromCursorRay(
      axis,
      session.startPoint,
      point,
      session.cameraBasis,
      EPSILON,
    );
    if (axisDistance === null) return null;

    if (axis === "x") {
      return {
        x: session.startPoint.x + axisDistance,
        y: session.startPoint.y,
        z: session.startPoint.z,
      };
    }
    if (axis === "y") {
      return {
        x: session.startPoint.x,
        y: session.startPoint.y + axisDistance,
        z: session.startPoint.z,
      };
    }

    return {
      x: session.startPoint.x,
      y: session.startPoint.y,
      z: session.startPoint.z + axisDistance,
    };
  }
}
