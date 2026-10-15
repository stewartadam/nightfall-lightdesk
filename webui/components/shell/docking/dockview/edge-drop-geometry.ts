// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DefaultEdgeGroupPosition } from "./default-edge-groups";

/** Thickness of an app-owned edge drop band, in pixels. */
export const EDGE_DROP_TARGET_SIZE = 35;
/** Resting inset reserved beside a hidden, empty side edge group. */
export const HIDDEN_EDGE_GROUP_PADDING = 16;

/** Returns the CSS classes for an invisible app-owned edge drop target. */
export function edgeDropTargetClasses(
  position: DefaultEdgeGroupPosition,
): string {
  const base = "absolute z-50 bg-transparent";

  switch (position) {
    case "left":
      return `${base} bottom-0 left-0 top-0`;
    case "right":
      return `${base} bottom-0 right-0 top-0`;
    case "bottom":
      return `${base} bottom-0 left-0 right-0`;
  }
}

/** Returns the inline size for an app-owned edge drop target. */
export function edgeDropTargetStyle(position: DefaultEdgeGroupPosition) {
  if (position === "bottom") {
    return {
      height: `${EDGE_DROP_TARGET_SIZE}px`,
    };
  }

  return {
    width: `${EDGE_DROP_TARGET_SIZE}px`,
  };
}

/** Returns Dockview selection classes for the app-owned edge drop highlight. */
export function edgeDropTargetSelectionClasses(
  position: DefaultEdgeGroupPosition,
): string {
  const base = "dv-drop-target-selection";

  switch (position) {
    case "left":
      return `${base} dv-drop-target-left dv-drop-target-small-horizontal`;
    case "right":
      return `${base} dv-drop-target-right dv-drop-target-small-horizontal`;
    case "bottom":
      return `${base} dv-drop-target-bottom dv-drop-target-small-vertical`;
  }
}

/** Insets empty hidden side edges while reserving space for any armed drop target. */
export function dockviewHostStyle(
  armedPosition: DefaultEdgeGroupPosition | undefined,
  hiddenPositions: readonly DefaultEdgeGroupPosition[],
) {
  /** Keeps the drag preview inset larger than the resting workspace padding. */
  const inset = (position: DefaultEdgeGroupPosition) =>
    `${armedPosition === position ? EDGE_DROP_TARGET_SIZE : hiddenPositions.includes(position) ? HIDDEN_EDGE_GROUP_PADDING : 0}px`;

  return {
    bottom: armedPosition === "bottom" ? `${EDGE_DROP_TARGET_SIZE}px` : "0px",
    left: inset("left"),
    right: inset("right"),
  };
}

/** Returns whether the instant edge-drop modifier is pressed. */
export function isEdgeDropModifierPressed(
  event: Pick<MouseEvent, "altKey">,
): boolean {
  return event.altKey;
}

/**
 * Resolves a pointer coordinate to one of the app-owned edge drop bands of
 * `element`, checking left, then right, then bottom. Returns undefined outside
 * the element or when the band under the pointer is not an active target.
 */
export function getEdgeDropPositionFromPoint(
  element: Pick<Element, "getBoundingClientRect">,
  clientX: number,
  clientY: number,
  targetPositions: readonly DefaultEdgeGroupPosition[],
): DefaultEdgeGroupPosition | undefined {
  const rect = element.getBoundingClientRect();
  const insideX = clientX >= rect.left && clientX <= rect.right;
  const insideY = clientY >= rect.top && clientY <= rect.bottom;
  if (!insideX || !insideY) return undefined;

  if (
    clientX <= rect.left + EDGE_DROP_TARGET_SIZE &&
    targetPositions.includes("left")
  ) {
    return "left";
  }
  if (
    clientX >= rect.right - EDGE_DROP_TARGET_SIZE &&
    targetPositions.includes("right")
  ) {
    return "right";
  }
  if (
    clientY >= rect.bottom - EDGE_DROP_TARGET_SIZE &&
    targetPositions.includes("bottom")
  ) {
    return "bottom";
  }
  return undefined;
}
