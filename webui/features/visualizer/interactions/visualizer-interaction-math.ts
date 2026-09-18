// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  Axis,
  CameraState,
  Vec3,
  VisualizerScreenPoint,
} from "./visualizer-interaction-types";

export interface CameraBasis {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export const DEFAULT_INTERACTION_EPSILON = 0.0001;
const CAMERA_FOV_DEGREES = 55;

/**
 * Vec3 length.
 */
export function vec3Length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * Vec3 distance.
 */
export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3Length(vec3Sub(a, b));
}

/**
 * Vec2 length.
 */
export function vec2Length(x: number, y: number): number {
  return Math.hypot(x, y);
}

/**
 * Vec3 sub.
 */
export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * Vec3 add.
 */
export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * Vec3 scale.
 */
export function vec3Scale(v: Vec3, scale: number): Vec3 {
  return { x: v.x * scale, y: v.y * scale, z: v.z * scale };
}

/**
 * Vec3 dot.
 */
export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Vec3 cross.
 */
export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Vec3 normalize.
 */
export function vec3Normalize(
  v: Vec3,
  epsilon: number = DEFAULT_INTERACTION_EPSILON,
): Vec3 {
  const len = vec3Length(v);
  if (len < epsilon) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function createCameraBasis(
  cameraState: CameraState,
  epsilon: number = DEFAULT_INTERACTION_EPSILON,
): CameraBasis {
  const position = { ...cameraState.position };
  const target = cameraState.target;

  let forward = vec3Normalize(vec3Sub(target, position), epsilon);
  if (vec3Length(forward) < epsilon) {
    forward = { x: 0, y: 0, z: -1 };
  }

  const worldUp = { x: 0, y: 1, z: 0 };
  let right = vec3Normalize(vec3Cross(forward, worldUp), epsilon);
  if (vec3Length(right) < epsilon) {
    right = vec3Normalize(vec3Cross(forward, { x: 0, y: 0, z: 1 }), epsilon);
  }
  const up = vec3Normalize(vec3Cross(right, forward), epsilon);

  return { position, forward, right, up };
}

export function screenPointRayDirection(
  point: VisualizerScreenPoint,
  cameraBasis: CameraBasis,
  epsilon: number = DEFAULT_INTERACTION_EPSILON,
): Vec3 {
  const aspect = point.viewportWidth / Math.max(point.viewportHeight, 1);
  const ndcX = (point.x / Math.max(point.viewportWidth, 1)) * 2 - 1;
  const ndcY = -(point.y / Math.max(point.viewportHeight, 1)) * 2 + 1;
  const halfFovTan = Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360);

  const dir = vec3Add(
    vec3Add(
      cameraBasis.forward,
      vec3Scale(cameraBasis.right, ndcX * halfFovTan * aspect),
    ),
    vec3Scale(cameraBasis.up, ndcY * halfFovTan),
  );
  return vec3Normalize(dir, epsilon);
}

/**
 * Intersect screen point with horizontal plane.
 */
export function intersectScreenPointWithHorizontalPlane(
  point: VisualizerScreenPoint,
  planeY: number,
  cameraState: CameraState,
  epsilon: number = DEFAULT_INTERACTION_EPSILON,
): Vec3 | null {
  const cameraBasis = createCameraBasis(cameraState, epsilon);
  const direction = screenPointRayDirection(point, cameraBasis, epsilon);
  if (Math.abs(direction.y) < epsilon) return null;

  const distance = (planeY - cameraBasis.position.y) / direction.y;
  if (distance < 0) return null;

  return vec3Add(cameraBasis.position, vec3Scale(direction, distance));
}

export function projectWorldPointToScreen(
  worldPoint: Vec3,
  cameraState: CameraState,
  viewportWidth: number,
  viewportHeight: number,
  epsilon: number = DEFAULT_INTERACTION_EPSILON,
): { x: number; y: number } | null {
  const cameraBasis = createCameraBasis(cameraState, epsilon);
  const relative = vec3Sub(worldPoint, cameraBasis.position);
  const aspect = viewportWidth / Math.max(viewportHeight, 1);
  const halfFovTan = Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360);

  const cameraX = vec3Dot(relative, cameraBasis.right);
  const cameraY = vec3Dot(relative, cameraBasis.up);
  const cameraZ = vec3Dot(relative, cameraBasis.forward);

  if (cameraZ <= epsilon) return null;

  const ndcX = cameraX / (cameraZ * halfFovTan * aspect);
  const ndcY = cameraY / (cameraZ * halfFovTan);
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return null;

  return {
    x: ((ndcX + 1) * viewportWidth) / 2,
    y: ((1 - ndcY) * viewportHeight) / 2,
  };
}

export function determineAxisScreenDirections(
  startPoint: Vec3,
  cameraState: CameraState,
  viewportWidth: number,
  viewportHeight: number,
  epsilon: number = DEFAULT_INTERACTION_EPSILON,
): Record<Axis, { x: number; y: number }> {
  const fallback: Record<Axis, { x: number; y: number }> = {
    x: { x: 1, y: 0 },
    y: { x: 0, y: -1 },
    z: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
  };
  const start = projectWorldPointToScreen(
    startPoint,
    cameraState,
    viewportWidth,
    viewportHeight,
    epsilon,
  );
  if (!start) return fallback;

  const axisTargets: Record<Axis, Vec3> = {
    x: { x: startPoint.x + 1, y: startPoint.y, z: startPoint.z },
    y: { x: startPoint.x, y: startPoint.y + 1, z: startPoint.z },
    z: { x: startPoint.x, y: startPoint.y, z: startPoint.z + 1 },
  };
  const result: Partial<Record<Axis, { x: number; y: number }>> = {};
  for (const axis of ["x", "y", "z"] as const) {
    const projected = projectWorldPointToScreen(
      axisTargets[axis],
      cameraState,
      viewportWidth,
      viewportHeight,
      epsilon,
    );
    if (!projected) {
      result[axis] = fallback[axis];
      continue;
    }
    const dirX = projected.x - start.x;
    const dirY = projected.y - start.y;
    const len = vec2Length(dirX, dirY);
    if (len < epsilon) {
      result[axis] = fallback[axis];
      continue;
    }
    result[axis] = { x: dirX / len, y: dirY / len };
  }
  return result as Record<Axis, { x: number; y: number }>;
}

export function axisDistanceFromCursorRay(
  axis: Axis,
  startPoint: Vec3,
  point: VisualizerScreenPoint,
  cameraBasis: CameraBasis,
  epsilon: number = DEFAULT_INTERACTION_EPSILON,
): number | null {
  const rayDirection = screenPointRayDirection(point, cameraBasis, epsilon);
  const axisDirection =
    axis === "x"
      ? ({ x: 1, y: 0, z: 0 } as const)
      : axis === "y"
        ? ({ x: 0, y: 1, z: 0 } as const)
        : ({ x: 0, y: 0, z: 1 } as const);
  const cameraToStart = vec3Sub(startPoint, cameraBasis.position);
  const axisToRayDot = vec3Dot(axisDirection, rayDirection);
  const denominator = 1 - axisToRayDot * axisToRayDot;
  if (denominator <= epsilon) return null;

  const axisToStartDot = vec3Dot(axisDirection, cameraToStart);
  const rayToStartDot = vec3Dot(rayDirection, cameraToStart);
  let axisDistance =
    (axisToRayDot * rayToStartDot - axisToStartDot) / denominator;
  const rayDistance =
    (rayToStartDot - axisToRayDot * axisToStartDot) / denominator;

  if (rayDistance < 0) {
    axisDistance = -axisToStartDot;
  }
  return axisDistance;
}
