// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { pixelsToMs } from "../../../lib/utils";
import type { SnapConfig } from "./grid-utils";
import { snapToGrid } from "./grid-utils";

export type ActionDragPosition = {
  positionPx: number;
  offsetPx: number;
  positionMs: number;
};

/** Converts a pointer location into an action start aligned with the timeline lane. */
export function actionDragPositionFromPointer(options: {
  clientX: number;
  laneLeft: number;
  initialPositionPx: number;
  originalSnapPositionsPx?: number[];
  timelineStartMs: number;
  zoom: number;
  snapConfig: SnapConfig;
}): ActionDragPosition {
  const rawPositionPx = Math.max(0, options.clientX - options.laneLeft);
  const originalPositionPx = options.originalSnapPositionsPx
    ? snapToOriginalPosition(
        rawPositionPx,
        options.originalSnapPositionsPx,
        options.snapConfig.threshold,
      )
    : undefined;
  const positionPx =
    originalPositionPx ??
    (options.snapConfig.enabled
      ? snapToGrid(
          rawPositionPx,
          options.zoom,
          options.timelineStartMs,
          options.snapConfig,
        )
      : rawPositionPx);

  return {
    positionPx,
    offsetPx: positionPx - options.initialPositionPx,
    positionMs: options.timelineStartMs + pixelsToMs(positionPx, options.zoom),
  };
}

/** Returns the nearest original drag position when it is within snap range. */
function snapToOriginalPosition(
  positionPx: number,
  originalPositionsPx: number[],
  thresholdPx: number,
): number | undefined {
  let nearestPositionPx: number | undefined;
  let nearestDistancePx = Number.POSITIVE_INFINITY;
  for (const originalPositionPx of originalPositionsPx) {
    const distancePx = Math.abs(positionPx - originalPositionPx);
    if (distancePx >= nearestDistancePx) continue;
    nearestPositionPx = originalPositionPx;
    nearestDistancePx = distancePx;
  }
  return nearestDistancePx <= thresholdPx ? nearestPositionPx : undefined;
}
