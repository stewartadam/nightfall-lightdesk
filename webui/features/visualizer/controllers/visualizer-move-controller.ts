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
  vec3Length,
} from "../interactions/visualizer-interaction-math";
import type {
  Axis,
  CameraState,
  Vec3,
  VisualizerScreenPoint,
} from "../interactions/visualizer-interaction-types";

interface MoveFixture {
  uid: string;
  position: Vec3;
}

interface MoveDragSession {
  pointerId: number;
  startPoint: Vec3;
  startScreenPoint: VisualizerScreenPoint;
  fixtureUids: string[];
  startPositions: Map<string, Vec3>;
  cameraBasis: CameraBasis;
  axisScreenDirections: Record<Axis, { x: number; y: number }>;
  initialAxisRayDistances: Record<Axis, number>;
  lockedAxis: Axis | null;
  lastAxisSwitchPoint: VisualizerScreenPoint | null;
  currentDelta: Vec3;
}

export interface BeginMoveDragInput {
  pointerId: number;
  hitFixtureUid: string;
  point: VisualizerScreenPoint;
  cameraState: CameraState;
  selectedUids: readonly string[];
  fixtures: readonly MoveFixture[];
}

export interface BeginMoveDragResult {
  activeFixtureUids: string[];
  setSelectionToHitFixture: boolean;
  startPositions: Array<{ uid: string; position: Vec3 }>;
}

export interface MoveDragPreview {
  lockedAxis: Axis | null;
  positions: Array<{ uid: string; position: Vec3 }>;
  distance: number;
}

export interface MoveDragCommit extends MoveDragPreview {
  didMove: boolean;
}

const MOVE_EPSILON = DEFAULT_INTERACTION_EPSILON;

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function createZeroVec3(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

function fixturePositionsFromDelta(
  fixtureUids: readonly string[],
  startPositions: ReadonlyMap<string, Vec3>,
  delta: Vec3,
): Array<{ uid: string; position: Vec3 }> {
  const result: Array<{ uid: string; position: Vec3 }> = [];
  for (const uid of fixtureUids) {
    const start = startPositions.get(uid);
    if (!start) continue;
    result.push({
      uid,
      position: {
        x: start.x + delta.x,
        y: start.y + delta.y,
        z: start.z + delta.z,
      },
    });
  }
  return result;
}

function deltaDistanceForAxis(delta: Vec3, axis: Axis | null): number {
  if (!axis) return 0;
  if (axis === "x") return Math.abs(delta.x);
  if (axis === "y") return Math.abs(delta.y);
  return Math.abs(delta.z);
}

export class VisualizerMoveController {
  private dragSession: MoveDragSession | null = null;

  getActivePointerId(): number | null {
    return this.dragSession?.pointerId ?? null;
  }

  beginDrag(input: BeginMoveDragInput): BeginMoveDragResult | null {
    const fixtureMap = new Map(
      input.fixtures.map((fixture) => [fixture.uid, fixture]),
    );

    const selectedUids = unique(input.selectedUids).filter((uid) =>
      fixtureMap.has(uid),
    );
    const hitIsSelected = selectedUids.includes(input.hitFixtureUid);
    const fixtureUids =
      hitIsSelected && selectedUids.length > 0
        ? selectedUids
        : [input.hitFixtureUid];

    const startPositions = new Map<string, Vec3>();
    for (const uid of fixtureUids) {
      const fixture = fixtureMap.get(uid);
      if (!fixture) continue;
      startPositions.set(uid, { ...fixture.position });
    }

    const hitStartPosition = startPositions.get(input.hitFixtureUid);
    if (!hitStartPosition) return null;

    const cameraBasis = createCameraBasis(input.cameraState, MOVE_EPSILON);
    this.dragSession = {
      pointerId: input.pointerId,
      startPoint: { ...hitStartPosition },
      startScreenPoint: { ...input.point },
      fixtureUids,
      startPositions,
      cameraBasis,
      axisScreenDirections: determineAxisScreenDirections(
        hitStartPosition,
        input.cameraState,
        input.point.viewportWidth,
        input.point.viewportHeight,
        MOVE_EPSILON,
      ),
      initialAxisRayDistances: {
        x:
          axisDistanceFromCursorRay(
            "x",
            hitStartPosition,
            input.point,
            cameraBasis,
            MOVE_EPSILON,
          ) ?? 0,
        y:
          axisDistanceFromCursorRay(
            "y",
            hitStartPosition,
            input.point,
            cameraBasis,
            MOVE_EPSILON,
          ) ?? 0,
        z:
          axisDistanceFromCursorRay(
            "z",
            hitStartPosition,
            input.point,
            cameraBasis,
            MOVE_EPSILON,
          ) ?? 0,
      },
      lockedAxis: null,
      lastAxisSwitchPoint: null,
      currentDelta: createZeroVec3(),
    };

    return {
      activeFixtureUids: fixtureUids,
      setSelectionToHitFixture: !hitIsSelected,
      startPositions: fixturePositionsFromDelta(
        fixtureUids,
        startPositions,
        createZeroVec3(),
      ),
    };
  }

  updateDrag(
    point: VisualizerScreenPoint,
    shiftKey: boolean,
  ): MoveDragPreview | null {
    const session = this.dragSession;
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
      session.currentDelta = createZeroVec3();
    }

    if (session.lockedAxis) {
      session.currentDelta = this.computeDeltaForAxis(
        session.lockedAxis,
        point,
      );
    } else {
      session.currentDelta = createZeroVec3();
    }

    return {
      lockedAxis: session.lockedAxis,
      positions: fixturePositionsFromDelta(
        session.fixtureUids,
        session.startPositions,
        session.currentDelta,
      ),
      distance: deltaDistanceForAxis(session.currentDelta, session.lockedAxis),
    };
  }

  endDrag(): MoveDragCommit | null {
    const session = this.dragSession;
    if (!session) return null;

    const result: MoveDragCommit = {
      lockedAxis: session.lockedAxis,
      positions: fixturePositionsFromDelta(
        session.fixtureUids,
        session.startPositions,
        session.currentDelta,
      ),
      distance: deltaDistanceForAxis(session.currentDelta, session.lockedAxis),
      didMove:
        session.lockedAxis !== null &&
        vec3Length(session.currentDelta) >= MOVE_EPSILON,
    };
    this.dragSession = null;
    return result;
  }

  cancelDrag(): MoveDragPreview | null {
    const session = this.dragSession;
    if (!session) return null;
    const preview: MoveDragPreview = {
      lockedAxis: null,
      positions: fixturePositionsFromDelta(
        session.fixtureUids,
        session.startPositions,
        createZeroVec3(),
      ),
      distance: 0,
    };
    this.dragSession = null;
    return preview;
  }

  private computeDistanceForAxis(
    axis: Axis,
    point: VisualizerScreenPoint,
  ): number {
    const delta = this.computeAxisDeltaForRayAxis(axis, point);
    return Math.abs(delta ?? 0);
  }

  private computeDeltaForAxis(axis: Axis, point: VisualizerScreenPoint): Vec3 {
    const delta = this.computeAxisDeltaForRayAxis(axis, point);
    if (delta === null) return createZeroVec3();

    if (axis === "x") {
      return { x: delta, y: 0, z: 0 };
    }
    if (axis === "y") {
      return { x: 0, y: delta, z: 0 };
    }
    return { x: 0, y: 0, z: delta };
  }

  private computeAxisDeltaForRayAxis(
    axis: Axis,
    point: VisualizerScreenPoint,
  ): number | null {
    const session = this.dragSession;
    if (!session) return null;

    const axisDistance = axisDistanceFromCursorRay(
      axis,
      session.startPoint,
      point,
      session.cameraBasis,
      MOVE_EPSILON,
    );
    if (axisDistance === null) return null;
    return axisDistance - session.initialAxisRayDistances[axis];
  }
}
