// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { vec2Length } from "./visualizer-interaction-math";
import type {
  Axis,
  VisualizerScreenPoint,
} from "./visualizer-interaction-types";

interface AxisLockConfig {
  lockThresholdMeters: number;
  unlockThresholdMeters: number;
  lockMinAlignment: number;
  alignmentClarityMargin: number;
  alignmentSwitchMargin: number;
  switchMinAlignment: number;
  switchMinCursorDeltaPixels: number;
  dragIntentMinPixels: number;
}

const DEFAULT_AXIS_LOCK_CONFIG: Readonly<AxisLockConfig> = {
  lockThresholdMeters: 0.2,
  unlockThresholdMeters: 0.12,
  lockMinAlignment: 0.6,
  alignmentClarityMargin: 0.02,
  alignmentSwitchMargin: 0.08,
  switchMinAlignment: 0.55,
  switchMinCursorDeltaPixels: 10,
  dragIntentMinPixels: 2,
};

export interface AxisLockState {
  lockedAxis: Axis | null;
  lastAxisSwitchPoint: VisualizerScreenPoint | null;
}

export interface ResolveAxisLockInput {
  point: VisualizerScreenPoint;
  startScreenPoint: VisualizerScreenPoint;
  shiftKey: boolean;
  axisDistances: Record<Axis, number>;
  axisScreenDirections: Record<Axis, { x: number; y: number }>;
  state: AxisLockState;
  config?: Readonly<AxisLockConfig>;
}

function computeAlignmentScores(
  dx: number,
  dy: number,
  axisDirections: Record<Axis, { x: number; y: number }>,
): Record<Axis, number> {
  const len = vec2Length(dx, dy);
  if (len <= 0) {
    return { x: 0, y: 0, z: 0 };
  }
  const ndx = dx / len;
  const ndy = dy / len;
  return {
    x: Math.abs(ndx * axisDirections.x.x + ndy * axisDirections.x.y),
    y: Math.abs(ndx * axisDirections.y.x + ndy * axisDirections.y.y),
    z: Math.abs(ndx * axisDirections.z.x + ndy * axisDirections.z.y),
  };
}

function strongestAxisByAlignment(scores: Record<Axis, number>): Axis {
  let strongest: Axis = "x";
  for (const axis of ["y", "z"] as const) {
    if (scores[axis] > scores[strongest]) {
      strongest = axis;
    }
  }
  return strongest;
}

function secondStrongestAlignment(
  strongest: Axis,
  scores: Record<Axis, number>,
): number {
  const others = (["x", "y", "z"] as const).filter(
    (axis) => axis !== strongest,
  );
  return Math.max(scores[others[0]], scores[others[1]]);
}

function hasStrongAlignmentIntent(
  strongest: Axis,
  scores: Record<Axis, number>,
  config: Readonly<AxisLockConfig>,
): boolean {
  const strongestScore = scores[strongest];
  const secondScore = secondStrongestAlignment(strongest, scores);
  return (
    strongestScore >= config.lockMinAlignment &&
    strongestScore - secondScore >= config.alignmentClarityMargin
  );
}

export function resolveAxisLock(input: ResolveAxisLockInput): AxisLockState {
  const config = input.config ?? DEFAULT_AXIS_LOCK_CONFIG;
  const {
    point,
    startScreenPoint,
    shiftKey,
    axisDistances,
    axisScreenDirections,
  } = input;
  const previous = input.state;

  const dx = point.x - startScreenPoint.x;
  const dy = point.y - startScreenPoint.y;
  const alignmentScores = computeAlignmentScores(dx, dy, axisScreenDirections);
  const preferredAxis = shiftKey
    ? "y"
    : strongestAxisByAlignment(alignmentScores);
  const preferredDist = axisDistances[preferredAxis];
  const hasIntent = vec2Length(dx, dy) >= config.dragIntentMinPixels;
  const hasStrongIntent =
    hasIntent &&
    hasStrongAlignmentIntent(preferredAxis, alignmentScores, config);

  let lockedAxis = previous.lockedAxis;
  let lastAxisSwitchPoint = previous.lastAxisSwitchPoint;

  if (lockedAxis) {
    const currentAxis = lockedAxis;
    const currentDist = axisDistances[currentAxis];
    const currentAlignment = alignmentScores[currentAxis];
    const preferredAlignment = alignmentScores[preferredAxis];
    const canSwitchByCursorTravel =
      !lastAxisSwitchPoint ||
      vec2Length(
        point.x - lastAxisSwitchPoint.x,
        point.y - lastAxisSwitchPoint.y,
      ) >= config.switchMinCursorDeltaPixels;

    let nextAxis: Axis | null = currentAxis;

    if (shiftKey && axisDistances.y >= config.lockThresholdMeters) {
      nextAxis = "y";
    } else if (
      hasIntent &&
      canSwitchByCursorTravel &&
      preferredAxis !== currentAxis &&
      preferredAlignment >= config.switchMinAlignment &&
      preferredAlignment >= currentAlignment + config.alignmentSwitchMargin
    ) {
      nextAxis = preferredAxis;
    } else if (
      currentDist < config.unlockThresholdMeters &&
      preferredDist < config.lockThresholdMeters &&
      !hasStrongIntent
    ) {
      nextAxis = null;
    }

    if (nextAxis !== lockedAxis && nextAxis) {
      lastAxisSwitchPoint = { ...point };
    }
    lockedAxis = nextAxis;
  }

  if (!lockedAxis) {
    if (shiftKey && axisDistances.y >= config.lockThresholdMeters) {
      lockedAxis = "y";
      lastAxisSwitchPoint = { ...point };
    } else if (hasStrongIntent && preferredDist >= config.lockThresholdMeters) {
      lockedAxis = preferredAxis;
      lastAxisSwitchPoint = { ...point };
    }
  }

  return {
    lockedAxis,
    lastAxisSwitchPoint,
  };
}
