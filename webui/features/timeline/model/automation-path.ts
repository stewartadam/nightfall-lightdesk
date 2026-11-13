// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Pixel position of one automation point inside its lane. */
export type AutomationPointPosition = { x: number; y: number };

/** An automation point being dragged: its index in the sorted points and its live position. */
export type DraggedAutomationPoint = AutomationPointPosition & {
  index: number;
};

/**
 * Builds the SVG polyline joining an automation lane's points in order. The dragged point,
 * whichever index it has (the first included), is drawn at its live position instead of its
 * stored one, so the line follows the pointer without a leg back to where the point was.
 */
export function automationLinePath(
  points: readonly AutomationPointPosition[],
  dragged: DraggedAutomationPoint | null,
): string {
  return points
    .map((point, index) => {
      const { x, y } = dragged?.index === index ? dragged : point;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}
