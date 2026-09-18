// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  clearToolPointerState,
  createIdleToolPointerState,
  getPointerTrackingState,
  resolveEscapeCancelPlan,
  resolvePointerUp,
  startToolDrag,
  updateDragDidMoveFromSlop,
} from "./visualizer-tool-interaction-state";

test("tool pointer state enters click-lock on click without drag", () => {
  const dragState = startToolDrag(7, { x: 100, y: 200 });

  const pointerUp = resolvePointerUp(dragState, 7);
  assert.equal(pointerUp.handled, true);
  assert.equal(pointerUp.didMove, false);
  assert.equal(pointerUp.nextState.dragPointerId, null);
  assert.equal(pointerUp.nextState.clickLockActive, true);

  const tracking = getPointerTrackingState(pointerUp.nextState, 99);
  assert.equal(tracking.isActiveDragPointer, false);
  assert.equal(tracking.isClickLockTracking, true);
  assert.equal(tracking.isTracking, true);
});

test("tool pointer state exits click-lock path after drag beyond slop", () => {
  const dragState = startToolDrag(3, { x: 20, y: 30 });
  const movedState = updateDragDidMoveFromSlop(dragState, { x: 28, y: 30 }, 4);

  assert.equal(movedState.dragDidMove, true);

  const pointerUp = resolvePointerUp(movedState, 3);
  assert.equal(pointerUp.handled, true);
  assert.equal(pointerUp.didMove, true);
  assert.equal(pointerUp.nextState.clickLockActive, false);
});

test("escape cancel plan prefers canceling active move/measure operations", () => {
  const idle = createIdleToolPointerState();
  const moveClickLock = resolvePointerUp(
    startToolDrag(1, { x: 0, y: 0 }),
    1,
  ).nextState;

  const moveOnlyPlan = resolveEscapeCancelPlan(moveClickLock, idle);
  assert.equal(moveOnlyPlan.cancelMove, true);
  assert.equal(moveOnlyPlan.cancelMeasure, false);
  assert.equal(moveOnlyPlan.consumed, true);

  const measureClickLock = resolvePointerUp(
    startToolDrag(2, { x: 0, y: 0 }),
    2,
  ).nextState;
  const bothPlan = resolveEscapeCancelPlan(moveClickLock, measureClickLock);
  assert.equal(bothPlan.cancelMove, true);
  assert.equal(bothPlan.cancelMeasure, true);
  assert.equal(bothPlan.consumed, true);

  const nonePlan = resolveEscapeCancelPlan(idle, idle);
  assert.equal(nonePlan.cancelMove, false);
  assert.equal(nonePlan.cancelMeasure, false);
  assert.equal(nonePlan.consumed, false);
});

test("clearing tool pointer state reports whether an operation was active", () => {
  const active = resolvePointerUp(
    startToolDrag(4, { x: 10, y: 10 }),
    4,
  ).nextState;
  const cleared = clearToolPointerState(active);
  assert.equal(cleared.hadOperation, true);
  assert.deepEqual(cleared.nextState, createIdleToolPointerState());

  const idle = clearToolPointerState(createIdleToolPointerState());
  assert.equal(idle.hadOperation, false);
});
