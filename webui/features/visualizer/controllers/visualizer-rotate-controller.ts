// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type CameraBasis,
  createCameraBasis,
  DEFAULT_INTERACTION_EPSILON,
  projectWorldPointToScreen,
  screenPointRayDirection,
  vec2Length,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from "../interactions/visualizer-interaction-math";
import type {
  Axis,
  CameraState,
  ScreenPoint2D,
  Vec3,
  VisualizerScreenPoint,
} from "../interactions/visualizer-interaction-types";

interface RotateFixture {
  uid: string;
  position: Vec3;
  rotation: Vec3;
}

interface RotateDragSession {
  pointerId: number;
  referenceUid: string;
  startPoint: Vec3;
  fixtureUids: string[];
  startPositions: Map<string, Vec3>;
  startRotations: Map<string, Vec3>;
  cameraState: CameraState;
  viewportWidth: number;
  viewportHeight: number;
  ringRadiusWorld: number;
  cameraBasis: CameraBasis;
  ringCenter: ScreenPoint2D | null;
  ringPolylines: Record<Axis, ScreenPoint2D[]>;
  ringArcs: Record<Axis, RotateGizmoRingArcs>;
  lockedAxis: Axis | null;
  lastRotationVector: Vec3 | null;
  currentAngleDegrees: number;
}

export interface BeginRotateDragInput {
  pointerId: number;
  hitFixtureUid: string;
  point: VisualizerScreenPoint;
  cameraState: CameraState;
  selectedUids: readonly string[];
  fixtures: readonly RotateFixture[];
}

export interface BeginRotateDragResult {
  activeFixtureUids: string[];
  setSelectionToHitFixture: boolean;
  startPositions: Array<{ uid: string; position: Vec3 }>;
}

export interface RotateDragPreview {
  lockedAxis: Axis | null;
  rotations: Array<{ uid: string; rotation: Vec3 }>;
  angleDegrees: number;
}

export interface RotateDragCommit extends RotateDragPreview {
  didRotate: boolean;
}

const ROTATE_EPSILON_DEGREES = 0.05;
const ROTATE_INTERACTION_EPSILON = DEFAULT_INTERACTION_EPSILON;
const RING_RADIUS_PX = 56;
const RING_HIT_TOLERANCE_PX = 14;
const RING_AMBIGUITY_THRESHOLD_PX = 2;
const RING_SEGMENTS = 64;

/**
 * Wraps a degree value into the `[0, 360)` range used by rotation handles.
 */
function wrapDegrees360(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = ((value % 360) + 360) % 360;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export interface RotateGizmoOverlay {
  center: ScreenPoint2D | null;
  activeAxis: Axis | null;
  rings: Record<Axis, RotateGizmoRingArcs>;
}

interface RotateGizmoRingArcs {
  front: ScreenPoint2D[][];
  back: ScreenPoint2D[][];
}

function axisVector(axis: Axis): Vec3 {
  if (axis === "x") return { x: 1, y: 0, z: 0 };
  if (axis === "y") return { x: 0, y: 1, z: 0 };
  return { x: 0, y: 0, z: 1 };
}

function ringBasis(axis: Axis): { u: Vec3; v: Vec3 } {
  if (axis === "x") return { u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 } };
  if (axis === "y")
    return { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 } };
  return { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Measures the shortest screen-space distance from a point to a line segment.
 */
function distancePointToSegment2D(
  point: ScreenPoint2D,
  start: ScreenPoint2D,
  end: ScreenPoint2D,
): number {
  const segX = end.x - start.x;
  const segY = end.y - start.y;
  const segLenSq = segX * segX + segY * segY;
  if (segLenSq <= ROTATE_INTERACTION_EPSILON) {
    return vec2Length(point.x - start.x, point.y - start.y);
  }
  const projection =
    ((point.x - start.x) * segX + (point.y - start.y) * segY) / segLenSq;
  const t = clamp(projection, 0, 1);
  const closestX = start.x + segX * t;
  const closestY = start.y + segY * t;
  return vec2Length(point.x - closestX, point.y - closestY);
}

/**
 * Measures the nearest screen-space distance from a cursor point to a ring polyline.
 */
function distanceToRingPolyline(
  point: ScreenPoint2D,
  polyline: readonly ScreenPoint2D[],
): number {
  if (polyline.length < 2) return Number.POSITIVE_INFINITY;
  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length; i += 1) {
    const start = polyline[i];
    const end = polyline[(i + 1) % polyline.length];
    const distance = distancePointToSegment2D(point, start, end);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }
  return minDistance;
}

/**
 * Estimates the world-space radius represented by one screen pixel at a point.
 */
function worldUnitsPerPixelAtPoint(
  point: Vec3,
  cameraBasis: CameraBasis,
  viewportHeight: number,
): number {
  const distance = vec3Length(vec3Sub(point, cameraBasis.position));
  const frustumHeight =
    2 * Math.tan((55 * Math.PI) / 360) * Math.max(distance, 1);
  return frustumHeight / Math.max(viewportHeight, 1);
}

/**
 * Projects a rotation ring into screen-space samples for hit testing.
 */
function buildRingPolyline(
  axis: Axis,
  center: Vec3,
  radiusWorld: number,
  cameraState: { position: Vec3; target: Vec3 },
  viewportWidth: number,
  viewportHeight: number,
): ScreenPoint2D[] {
  const { u, v } = ringBasis(axis);
  const points: ScreenPoint2D[] = [];
  for (let i = 0; i < RING_SEGMENTS; i += 1) {
    const angle = (i / RING_SEGMENTS) * Math.PI * 2;
    const offset = vec3Add(
      vec3Scale(u, Math.cos(angle) * radiusWorld),
      vec3Scale(v, Math.sin(angle) * radiusWorld),
    );
    const worldPoint = vec3Add(center, offset);
    const screenPoint = projectWorldPointToScreen(
      worldPoint,
      cameraState,
      viewportWidth,
      viewportHeight,
    );
    if (!screenPoint) continue;
    points.push(screenPoint);
  }
  return points;
}

interface RingSample {
  screen: ScreenPoint2D;
  facing: number;
}

const RING_FACING_EPSILON = 1e-6;

/**
 * Compares screen points with tolerance to avoid zero-length ring segments.
 */
function sameScreenPoint(
  a: ScreenPoint2D,
  b: ScreenPoint2D,
  epsilon = 1e-3,
): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

/**
 * Interpolates where a ring segment crosses the front/back facing boundary.
 */
function interpolateScreenPointByFacing(
  start: RingSample,
  end: RingSample,
): ScreenPoint2D {
  const denominator = start.facing - end.facing;
  if (Math.abs(denominator) <= RING_FACING_EPSILON) {
    return {
      x: (start.screen.x + end.screen.x) * 0.5,
      y: (start.screen.y + end.screen.y) * 0.5,
    };
  }
  const t = clamp(start.facing / denominator, 0, 1);
  return {
    x: start.screen.x + (end.screen.x - start.screen.x) * t,
    y: start.screen.y + (end.screen.y - start.screen.y) * t,
  };
}

/**
 * Appends a visible ring segment, continuing the current polyline when possible.
 */
function appendArcEdge(
  polylines: ScreenPoint2D[][],
  start: ScreenPoint2D,
  end: ScreenPoint2D,
) {
  if (sameScreenPoint(start, end)) return;
  const last = polylines[polylines.length - 1];
  if (!last) {
    polylines.push([start, end]);
    return;
  }
  const tail = last[last.length - 1];
  if (sameScreenPoint(tail, start)) {
    last.push(end);
    return;
  }
  polylines.push([start, end]);
}

/**
 * Splits ring samples into front and back arcs for layered gizmo rendering.
 */
function ringArcsFromSamples(
  samples: readonly RingSample[],
): RotateGizmoRingArcs {
  if (samples.length < 2) {
    return { front: [], back: [] };
  }

  const front: ScreenPoint2D[][] = [];
  const back: ScreenPoint2D[][] = [];

  for (let i = 0; i < samples.length; i += 1) {
    const start = samples[i];
    const end = samples[(i + 1) % samples.length];
    const startFront = start.facing >= -RING_FACING_EPSILON;
    const endFront = end.facing >= -RING_FACING_EPSILON;

    if (startFront === endFront) {
      appendArcEdge(startFront ? front : back, start.screen, end.screen);
      continue;
    }

    const boundaryPoint = interpolateScreenPointByFacing(start, end);
    appendArcEdge(startFront ? front : back, start.screen, boundaryPoint);
    appendArcEdge(endFront ? front : back, boundaryPoint, end.screen);
  }

  return { front, back };
}

function buildRingArcs(
  axis: Axis,
  center: Vec3,
  radiusWorld: number,
  cameraState: { position: Vec3; target: Vec3 },
  viewportWidth: number,
  viewportHeight: number,
): RotateGizmoRingArcs {
  const { u, v } = ringBasis(axis);
  const cameraToCenter = vec3Normalize(
    vec3Sub(cameraState.position, center),
    ROTATE_INTERACTION_EPSILON,
  );
  const samples: RingSample[] = [];

  for (let i = 0; i < RING_SEGMENTS; i += 1) {
    const angle = (i / RING_SEGMENTS) * Math.PI * 2;
    const offset = vec3Add(
      vec3Scale(u, Math.cos(angle) * radiusWorld),
      vec3Scale(v, Math.sin(angle) * radiusWorld),
    );
    const worldPoint = vec3Add(center, offset);
    const screenPoint = projectWorldPointToScreen(
      worldPoint,
      cameraState,
      viewportWidth,
      viewportHeight,
    );
    if (!screenPoint) continue;

    samples.push({
      screen: screenPoint,
      facing: vec3Dot(offset, cameraToCenter),
    });
  }

  return ringArcsFromSamples(samples);
}

/**
 * Projects a cursor ray onto the rotation plane when it cannot intersect cleanly.
 */
function cursorPlaneProjectedRayVector(
  axis: Axis,
  point: VisualizerScreenPoint,
  cameraBasis: CameraBasis,
): Vec3 | null {
  const normal = axisVector(axis);
  const rayDirection = screenPointRayDirection(
    point,
    cameraBasis,
    ROTATE_INTERACTION_EPSILON,
  );
  const projected = vec3Sub(
    rayDirection,
    vec3Scale(normal, vec3Dot(rayDirection, normal)),
  );
  const direction = vec3Normalize(projected, ROTATE_INTERACTION_EPSILON);
  if (vec3Length(direction) <= ROTATE_INTERACTION_EPSILON) return null;
  return direction;
}

function cursorPlaneArcVector(
  axis: Axis,
  center: Vec3,
  point: VisualizerScreenPoint,
  cameraBasis: CameraBasis,
): Vec3 | null {
  const normal = axisVector(axis);
  const rayDirection = screenPointRayDirection(
    point,
    cameraBasis,
    ROTATE_INTERACTION_EPSILON,
  );
  const denominator = vec3Dot(rayDirection, normal);
  if (Math.abs(denominator) <= ROTATE_INTERACTION_EPSILON) {
    return cursorPlaneProjectedRayVector(axis, point, cameraBasis);
  }

  const numerator = vec3Dot(vec3Sub(center, cameraBasis.position), normal);
  const distance = numerator / denominator;
  if (distance <= ROTATE_INTERACTION_EPSILON) {
    return cursorPlaneProjectedRayVector(axis, point, cameraBasis);
  }

  const hitPoint = vec3Add(
    cameraBasis.position,
    vec3Scale(rayDirection, distance),
  );
  const centerToHit = vec3Sub(hitPoint, center);
  const direction = vec3Normalize(centerToHit, ROTATE_INTERACTION_EPSILON);
  if (vec3Length(direction) <= ROTATE_INTERACTION_EPSILON) return null;
  return direction;
}

/**
 * Computes the signed angle between two ring vectors around the active axis.
 */
function signedAngleDegreesAroundAxis(
  axis: Axis,
  from: Vec3,
  to: Vec3,
): number {
  const normal = axisVector(axis);
  const cross = vec3Cross(from, to);
  const sin = vec3Dot(normal, cross);
  const cos = clamp(vec3Dot(from, to), -1, 1);
  return (Math.atan2(sin, cos) * 180) / Math.PI;
}

/**
 * Preserves the first occurrence of each selected fixture ID.
 */
function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Captures the original fixture positions for a rotation drag commit.
 */
function fixturePositionsFromDelta(
  fixtureUids: readonly string[],
  startPositions: ReadonlyMap<string, Vec3>,
): Array<{ uid: string; position: Vec3 }> {
  const result: Array<{ uid: string; position: Vec3 }> = [];
  for (const uid of fixtureUids) {
    const start = startPositions.get(uid);
    if (!start) continue;
    result.push({
      uid,
      position: {
        x: start.x,
        y: start.y,
        z: start.z,
      },
    });
  }
  return result;
}

function fixtureRotationsFromAngle(
  fixtureUids: readonly string[],
  startRotations: ReadonlyMap<string, Vec3>,
  axis: Axis | null,
  angleDegrees: number,
): Array<{ uid: string; rotation: Vec3 }> {
  const result: Array<{ uid: string; rotation: Vec3 }> = [];
  for (const uid of fixtureUids) {
    const start = startRotations.get(uid);
    if (!start) continue;

    if (!axis) {
      result.push({
        uid,
        rotation: {
          x: start.x,
          y: start.y,
          z: start.z,
        },
      });
      continue;
    }

    const next = {
      x: start.x,
      y: start.y,
      z: start.z,
    };
    if (axis === "x") next.x = wrapDegrees360(start.x + angleDegrees);
    if (axis === "y") next.y = wrapDegrees360(start.y + angleDegrees);
    if (axis === "z") next.z = wrapDegrees360(start.z + angleDegrees);
    result.push({ uid, rotation: next });
  }
  return result;
}

export class VisualizerRotateController {
  private dragSession: RotateDragSession | null = null;

  getActivePointerId(): number | null {
    return this.dragSession?.pointerId ?? null;
  }

  getActiveFixtureUids(): string[] {
    return this.dragSession ? [...this.dragSession.fixtureUids] : [];
  }

  getSessionCameraState(): CameraState | null {
    return this.dragSession ? this.dragSession.cameraState : null;
  }

  beginDrag(input: BeginRotateDragInput): BeginRotateDragResult | null {
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
    const startRotations = new Map<string, Vec3>();
    for (const uid of fixtureUids) {
      const fixture = fixtureMap.get(uid);
      if (!fixture) continue;
      startPositions.set(uid, { ...fixture.position });
      startRotations.set(uid, { ...fixture.rotation });
    }

    const hitStartPosition = startPositions.get(input.hitFixtureUid);
    if (!hitStartPosition) return null;

    const cameraBasis = createCameraBasis(
      input.cameraState,
      ROTATE_INTERACTION_EPSILON,
    );
    const ringRadiusWorld =
      worldUnitsPerPixelAtPoint(
        hitStartPosition,
        cameraBasis,
        input.point.viewportHeight,
      ) * RING_RADIUS_PX;
    const ringPolylines: Record<Axis, ScreenPoint2D[]> = {
      x: buildRingPolyline(
        "x",
        hitStartPosition,
        ringRadiusWorld,
        input.cameraState,
        input.point.viewportWidth,
        input.point.viewportHeight,
      ),
      y: buildRingPolyline(
        "y",
        hitStartPosition,
        ringRadiusWorld,
        input.cameraState,
        input.point.viewportWidth,
        input.point.viewportHeight,
      ),
      z: buildRingPolyline(
        "z",
        hitStartPosition,
        ringRadiusWorld,
        input.cameraState,
        input.point.viewportWidth,
        input.point.viewportHeight,
      ),
    };
    const ringArcs: Record<Axis, RotateGizmoRingArcs> = {
      x: buildRingArcs(
        "x",
        hitStartPosition,
        ringRadiusWorld,
        input.cameraState,
        input.point.viewportWidth,
        input.point.viewportHeight,
      ),
      y: buildRingArcs(
        "y",
        hitStartPosition,
        ringRadiusWorld,
        input.cameraState,
        input.point.viewportWidth,
        input.point.viewportHeight,
      ),
      z: buildRingArcs(
        "z",
        hitStartPosition,
        ringRadiusWorld,
        input.cameraState,
        input.point.viewportWidth,
        input.point.viewportHeight,
      ),
    };
    const ringCenter = projectWorldPointToScreen(
      hitStartPosition,
      input.cameraState,
      input.point.viewportWidth,
      input.point.viewportHeight,
    );
    this.dragSession = {
      pointerId: input.pointerId,
      referenceUid: input.hitFixtureUid,
      startPoint: { ...hitStartPosition },
      fixtureUids,
      startPositions,
      startRotations,
      cameraState: input.cameraState,
      viewportWidth: input.point.viewportWidth,
      viewportHeight: input.point.viewportHeight,
      ringRadiusWorld,
      cameraBasis,
      ringCenter,
      ringPolylines,
      ringArcs,
      lockedAxis: null,
      lastRotationVector: null,
      currentAngleDegrees: 0,
    };

    return {
      activeFixtureUids: fixtureUids,
      setSelectionToHitFixture: !hitIsSelected,
      startPositions: fixturePositionsFromDelta(fixtureUids, startPositions),
    };
  }

  updateDrag(point: VisualizerScreenPoint): RotateDragPreview | null {
    const session = this.dragSession;
    if (!session) return null;

    if (session.lockedAxis) {
      const currentDirection = cursorPlaneArcVector(
        session.lockedAxis,
        session.startPoint,
        point,
        session.cameraBasis,
      );
      if (currentDirection && session.lastRotationVector) {
        session.currentAngleDegrees += signedAngleDegreesAroundAxis(
          session.lockedAxis,
          session.lastRotationVector,
          currentDirection,
        );
        session.lastRotationVector = currentDirection;
      }
    }

    return {
      lockedAxis: session.lockedAxis,
      rotations: fixtureRotationsFromAngle(
        session.fixtureUids,
        session.startRotations,
        session.lockedAxis,
        session.currentAngleDegrees,
      ),
      angleDegrees: wrapDegrees360(Math.abs(session.currentAngleDegrees)),
    };
  }

  getCurrentPreview(): RotateDragPreview | null {
    const session = this.dragSession;
    if (!session) return null;
    return {
      lockedAxis: session.lockedAxis,
      rotations: fixtureRotationsFromAngle(
        session.fixtureUids,
        session.startRotations,
        session.lockedAxis,
        session.currentAngleDegrees,
      ),
      angleDegrees: wrapDegrees360(Math.abs(session.currentAngleDegrees)),
    };
  }

  beginAxisDrag(pointerId: number, point: VisualizerScreenPoint): Axis | null {
    const session = this.dragSession;
    if (!session) return null;
    if (session.lockedAxis) {
      session.pointerId = pointerId;
      session.lastRotationVector = cursorPlaneArcVector(
        session.lockedAxis,
        session.startPoint,
        point,
        session.cameraBasis,
      );
      return session.lockedAxis;
    }
    const axis = this.tryLockAxisForPoint(point);
    if (!axis) return null;
    session.pointerId = pointerId;
    return axis;
  }

  endDrag(keepSession = false): RotateDragCommit | null {
    const session = this.dragSession;
    if (!session) return null;

    const result: RotateDragCommit = {
      lockedAxis: session.lockedAxis,
      rotations: fixtureRotationsFromAngle(
        session.fixtureUids,
        session.startRotations,
        session.lockedAxis,
        session.currentAngleDegrees,
      ),
      angleDegrees: wrapDegrees360(Math.abs(session.currentAngleDegrees)),
      didRotate:
        session.lockedAxis !== null &&
        wrapDegrees360(Math.abs(session.currentAngleDegrees)) >=
          ROTATE_EPSILON_DEGREES,
    };
    if (keepSession) {
      for (const { uid, rotation } of result.rotations) {
        session.startRotations.set(uid, {
          x: rotation.x,
          y: rotation.y,
          z: rotation.z,
        });
      }
      session.lockedAxis = null;
      session.lastRotationVector = null;
      session.currentAngleDegrees = 0;
      return result;
    }

    this.dragSession = null;
    return result;
  }

  cancelDrag(): RotateDragPreview | null {
    const session = this.dragSession;
    if (!session) return null;

    const preview: RotateDragPreview = {
      lockedAxis: null,
      rotations: fixtureRotationsFromAngle(
        session.fixtureUids,
        session.startRotations,
        null,
        0,
      ),
      angleDegrees: 0,
    };
    this.dragSession = null;
    return preview;
  }

  getGizmoOverlay(): RotateGizmoOverlay | null {
    const session = this.dragSession;
    if (!session) return null;
    return {
      center: session.ringCenter,
      activeAxis: session.lockedAxis,
      rings: {
        x: {
          front: session.ringArcs.x.front.map((polyline) => [...polyline]),
          back: session.ringArcs.x.back.map((polyline) => [...polyline]),
        },
        y: {
          front: session.ringArcs.y.front.map((polyline) => [...polyline]),
          back: session.ringArcs.y.back.map((polyline) => [...polyline]),
        },
        z: {
          front: session.ringArcs.z.front.map((polyline) => [...polyline]),
          back: session.ringArcs.z.back.map((polyline) => [...polyline]),
        },
      },
    };
  }

  getRingPointForAxisAngle(
    axis: Axis,
    angleDegrees: number,
  ): ScreenPoint2D | null {
    const session = this.dragSession;
    if (!session) return null;

    const { u, v } = ringBasis(axis);
    const angleRadians = (angleDegrees * Math.PI) / 180;
    const offset = vec3Add(
      vec3Scale(u, Math.cos(angleRadians) * session.ringRadiusWorld),
      vec3Scale(v, Math.sin(angleRadians) * session.ringRadiusWorld),
    );
    const worldPoint = vec3Add(session.startPoint, offset);
    return projectWorldPointToScreen(
      worldPoint,
      session.cameraState,
      session.viewportWidth,
      session.viewportHeight,
    );
  }

  syncFromFixtures(fixtures: readonly RotateFixture[]): boolean {
    const session = this.dragSession;
    if (!session) return false;

    const fixtureMap = new Map(
      fixtures.map((fixture) => [fixture.uid, fixture]),
    );
    for (const uid of session.fixtureUids) {
      const fixture = fixtureMap.get(uid);
      if (!fixture) continue;
      session.startPositions.set(uid, { ...fixture.position });
      session.startRotations.set(uid, { ...fixture.rotation });
    }

    const referenceFixture =
      fixtureMap.get(session.referenceUid) ??
      fixtureMap.get(session.fixtureUids[0] ?? "");
    if (!referenceFixture) return false;

    session.startPoint = { ...referenceFixture.position };
    this.refreshSessionRingGeometry(session);
    session.currentAngleDegrees = 0;
    session.lastRotationVector = null;
    return true;
  }

  syncCamera(
    cameraState: CameraState,
    viewportWidth: number,
    viewportHeight: number,
  ): boolean {
    const session = this.dragSession;
    if (!session) return false;

    session.cameraState = cameraState;
    session.viewportWidth = viewportWidth;
    session.viewportHeight = viewportHeight;
    session.cameraBasis = createCameraBasis(
      cameraState,
      ROTATE_INTERACTION_EPSILON,
    );
    this.refreshSessionRingGeometry(session);
    return true;
  }

  private tryLockAxisForPoint(point: VisualizerScreenPoint): Axis | null {
    const session = this.dragSession;
    if (!session) return null;
    if (session.lockedAxis) return session.lockedAxis;

    const axis =
      this.findNearestDotAxis(point) ?? this.findNearestRingAxis(point);
    if (!axis) return null;

    session.lockedAxis = axis;
    session.currentAngleDegrees = 0;
    session.lastRotationVector = cursorPlaneArcVector(
      axis,
      session.startPoint,
      point,
      session.cameraBasis,
    );
    return axis;
  }

  private findNearestDotAxis(point: VisualizerScreenPoint): Axis | null {
    const session = this.dragSession;
    if (!session) return null;

    const referenceRotation =
      session.startRotations.get(session.referenceUid) ??
      session.startRotations.get(session.fixtureUids[0] ?? "");
    if (!referenceRotation) return null;

    const cursor = { x: point.x, y: point.y };
    const hits: Array<{ axis: Axis; distance: number }> = [];
    for (const axis of ["x", "y", "z"] as const) {
      const angleDegrees =
        axis === "x"
          ? referenceRotation.x
          : axis === "y"
            ? referenceRotation.y
            : referenceRotation.z;
      const dot = this.getRingPointForAxisAngle(axis, angleDegrees);
      if (!dot) continue;
      const distance = vec2Length(cursor.x - dot.x, cursor.y - dot.y);
      if (distance <= RING_HIT_TOLERANCE_PX) {
        hits.push({ axis, distance });
      }
    }

    if (hits.length === 0) return null;

    hits.sort((a, b) => a.distance - b.distance);
    if (
      hits.length > 1 &&
      Math.abs(hits[0].distance - hits[1].distance) <=
        RING_AMBIGUITY_THRESHOLD_PX
    ) {
      return null;
    }
    return hits[0].axis;
  }

  private findNearestRingAxis(point: VisualizerScreenPoint): Axis | null {
    const session = this.dragSession;
    if (!session) return null;

    const cursor = { x: point.x, y: point.y };
    const hits: Array<{ axis: Axis; distance: number }> = [];
    for (const axis of ["x", "y", "z"] as const) {
      const distance = distanceToRingPolyline(
        cursor,
        session.ringPolylines[axis],
      );
      if (distance <= RING_HIT_TOLERANCE_PX) {
        hits.push({ axis, distance });
      }
    }

    if (hits.length === 0) {
      return null;
    }

    hits.sort((a, b) => a.distance - b.distance);
    return hits[0].axis;
  }

  private refreshSessionRingGeometry(session: RotateDragSession): void {
    session.ringRadiusWorld =
      worldUnitsPerPixelAtPoint(
        session.startPoint,
        session.cameraBasis,
        session.viewportHeight,
      ) * RING_RADIUS_PX;
    session.ringPolylines = {
      x: buildRingPolyline(
        "x",
        session.startPoint,
        session.ringRadiusWorld,
        session.cameraState,
        session.viewportWidth,
        session.viewportHeight,
      ),
      y: buildRingPolyline(
        "y",
        session.startPoint,
        session.ringRadiusWorld,
        session.cameraState,
        session.viewportWidth,
        session.viewportHeight,
      ),
      z: buildRingPolyline(
        "z",
        session.startPoint,
        session.ringRadiusWorld,
        session.cameraState,
        session.viewportWidth,
        session.viewportHeight,
      ),
    };
    session.ringArcs = {
      x: buildRingArcs(
        "x",
        session.startPoint,
        session.ringRadiusWorld,
        session.cameraState,
        session.viewportWidth,
        session.viewportHeight,
      ),
      y: buildRingArcs(
        "y",
        session.startPoint,
        session.ringRadiusWorld,
        session.cameraState,
        session.viewportWidth,
        session.viewportHeight,
      ),
      z: buildRingArcs(
        "z",
        session.startPoint,
        session.ringRadiusWorld,
        session.cameraState,
        session.viewportWidth,
        session.viewportHeight,
      ),
    };
    session.ringCenter = projectWorldPointToScreen(
      session.startPoint,
      session.cameraState,
      session.viewportWidth,
      session.viewportHeight,
    );
  }
}
