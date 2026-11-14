// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { pixelsToMs } from "../../../lib/utils";
import type { SnapConfig } from "./grid-utils";
import { snapPositionMs } from "./grid-utils";

export type ActionDragPosition = {
  /** Lane pixel offset of the action start, derived from `positionMs` for drawing. */
  positionPx: number;
  /** Timeline position of the action start, exact when it snapped to a grid point. */
  positionMs: number;
};

/**
 * Converts a pointer location into an action start aligned with the timeline lane.
 *
 * The start is chosen in milliseconds: the pointer snaps back to one of the
 * `originalSnapPositionsMs` when it is within the snap threshold, otherwise to the grid when
 * snapping is on. Snapped starts are the exact original or grid times, so a drop never moves
 * an action off its beat by pixel rounding.
 */
export function actionDragPositionFromPointer(options: {
  clientX: number;
  laneLeft: number;
  originalSnapPositionsMs?: number[];
  timelineStartMs: number;
  zoom: number;
  snapConfig: SnapConfig;
}): ActionDragPosition {
  const rawPositionPx = Math.max(0, options.clientX - options.laneLeft);
  const rawPositionMs =
    options.timelineStartMs + pixelsToMs(rawPositionPx, options.zoom);
  const originalPositionMs = options.originalSnapPositionsMs
    ? snapToOriginalPosition(
        rawPositionMs,
        options.originalSnapPositionsMs,
        (options.snapConfig.threshold * 1000) / options.zoom,
      )
    : undefined;
  const positionMs =
    originalPositionMs ??
    snapPositionMs(rawPositionMs, options.zoom, options.snapConfig);

  return {
    positionPx: ((positionMs - options.timelineStartMs) * options.zoom) / 1000,
    positionMs,
  };
}

/** Returns the nearest original drag position when it is within snap range. */
function snapToOriginalPosition(
  positionMs: number,
  originalPositionsMs: number[],
  thresholdMs: number,
): number | undefined {
  let nearestPositionMs: number | undefined;
  let nearestDistanceMs = Number.POSITIVE_INFINITY;
  for (const originalPositionMs of originalPositionsMs) {
    const distanceMs = Math.abs(positionMs - originalPositionMs);
    if (distanceMs >= nearestDistanceMs) continue;
    nearestPositionMs = originalPositionMs;
    nearestDistanceMs = distanceMs;
  }
  return nearestDistanceMs <= thresholdMs ? nearestPositionMs : undefined;
}
