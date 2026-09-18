// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ScreenPoint2D } from "./visualizer-interaction-types";

export interface ToolPointerState {
  dragPointerId: number | null;
  dragStartScreen: ScreenPoint2D | null;
  dragDidMove: boolean;
  clickLockActive: boolean;
}

export interface PointerTrackingState {
  isActiveDragPointer: boolean;
  isClickLockTracking: boolean;
  isTracking: boolean;
}

export interface PointerUpResolution {
  handled: boolean;
  didMove: boolean;
  nextState: ToolPointerState;
}

export interface EscapeCancelPlan {
  cancelMove: boolean;
  cancelMeasure: boolean;
  consumed: boolean;
}

export function createIdleToolPointerState(): ToolPointerState {
  return {
    dragPointerId: null,
    dragStartScreen: null,
    dragDidMove: false,
    clickLockActive: false,
  };
}

export function isToolOperationActive(state: ToolPointerState): boolean {
  return state.dragPointerId !== null || state.clickLockActive;
}

export function startToolDrag(
  pointerId: number,
  startScreen: ScreenPoint2D,
): ToolPointerState {
  return {
    dragPointerId: pointerId,
    dragStartScreen: { ...startScreen },
    dragDidMove: false,
    clickLockActive: false,
  };
}

export function getPointerTrackingState(
  state: ToolPointerState,
  pointerId: number,
): PointerTrackingState {
  const isActiveDragPointer =
    state.dragPointerId !== null && state.dragPointerId === pointerId;
  const isClickLockTracking =
    state.clickLockActive && state.dragPointerId === null;
  return {
    isActiveDragPointer,
    isClickLockTracking,
    isTracking: isActiveDragPointer || isClickLockTracking,
  };
}

export function updateDragDidMoveFromSlop(
  state: ToolPointerState,
  currentPoint: ScreenPoint2D,
  slopPx: number,
): ToolPointerState {
  if (state.dragDidMove || !state.dragStartScreen) return state;

  const dragDistance = Math.hypot(
    currentPoint.x - state.dragStartScreen.x,
    currentPoint.y - state.dragStartScreen.y,
  );
  if (dragDistance <= slopPx) return state;

  return {
    ...state,
    dragDidMove: true,
  };
}

export function resolvePointerUp(
  state: ToolPointerState,
  pointerId: number,
): PointerUpResolution {
  if (state.dragPointerId === null || state.dragPointerId !== pointerId) {
    return {
      handled: false,
      didMove: false,
      nextState: state,
    };
  }

  const didMove = state.dragDidMove;
  return {
    handled: true,
    didMove,
    nextState: {
      dragPointerId: null,
      dragStartScreen: null,
      dragDidMove: false,
      clickLockActive: !didMove,
    },
  };
}

export function clearToolPointerState(state: ToolPointerState): {
  hadOperation: boolean;
  nextState: ToolPointerState;
} {
  return {
    hadOperation: isToolOperationActive(state),
    nextState: createIdleToolPointerState(),
  };
}

export function resolveEscapeCancelPlan(
  moveState: ToolPointerState,
  measureState: ToolPointerState,
): EscapeCancelPlan {
  const cancelMove = isToolOperationActive(moveState);
  const cancelMeasure = isToolOperationActive(measureState);
  return {
    cancelMove,
    cancelMeasure,
    consumed: cancelMove || cancelMeasure,
  };
}
