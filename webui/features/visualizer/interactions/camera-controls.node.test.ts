// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three/webgpu";
import {
  calculateWheelDollyMoveAmount,
  cancelControlsInteraction,
  updateControlsTargetFromFloorIntersection,
} from "./camera-controls";

/**
 * Creates OrbitControls with a fixed target for camera-control behavior tests.
 */
function makeControls(target: Vector3) {
  let updateCount = 0;
  return {
    controls: {
      target,
      update: () => {
        updateCount += 1;
        return true;
      },
    },
    getUpdateCount: () => updateCount,
  };
}

test("updateControlsTargetFromFloorIntersection moves stale panned target back to floor hit", () => {
  const camera = new PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(0, 8, 12);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld(true);

  const staleTarget = new Vector3(0, 2, 0);
  const { controls, getUpdateCount } = makeControls(staleTarget);

  const didUpdate = updateControlsTargetFromFloorIntersection(camera, controls);

  assert.equal(didUpdate, true);
  assert.equal(getUpdateCount(), 1);
  assert.ok(Math.abs(controls.target.x) < 1e-6);
  assert.ok(Math.abs(controls.target.y) < 1e-6);
  assert.ok(Math.abs(controls.target.z + 4) < 1e-6);
});

test("updateControlsTargetFromFloorIntersection ignores views that do not hit the floor ahead", () => {
  const camera = new PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(0, 6, 12);
  camera.lookAt(0, 6, 0);
  camera.updateMatrixWorld(true);

  const target = new Vector3(1, 2, 3);
  const { controls, getUpdateCount } = makeControls(target);

  const didUpdate = updateControlsTargetFromFloorIntersection(camera, controls);

  assert.equal(didUpdate, false);
  assert.equal(getUpdateCount(), 0);
  assert.deepEqual(controls.target.toArray(), [1, 2, 3]);
});

test("calculateWheelDollyMoveAmount clamps large wheel bursts", () => {
  assert.equal(calculateWheelDollyMoveAmount(-100000, 1000), 25);
  assert.equal(calculateWheelDollyMoveAmount(100000, 1000), -25);
  assert.equal(calculateWheelDollyMoveAmount(-100000, 2), 0.6);
});

/**
 * Verifies stuck OrbitControls pointer state can be cleared without moving the camera.
 */
test("cancelControlsInteraction clears active OrbitControls pointer state", () => {
  const releasedPointerIds: number[] = [];
  const removedListeners: string[] = [];
  const dispatchedEvents: string[] = [];
  const ownerDocument = {
    removeEventListener: (type: string) => {
      removedListeners.push(type);
    },
  };
  const controls = {
    state: 2,
    _pointers: [7],
    _pointerPositions: { 7: { x: 10, y: 20 } },
    _onPointerMove: () => undefined,
    _onPointerUp: () => undefined,
    domElement: {
      ownerDocument,
      hasPointerCapture: (pointerId: number) => pointerId === 7,
      releasePointerCapture: (pointerId: number) => {
        releasedPointerIds.push(pointerId);
      },
    },
    dispatchEvent: (event: { type: string }) => {
      dispatchedEvents.push(event.type);
    },
  };

  cancelControlsInteraction(controls as never);

  assert.deepEqual(releasedPointerIds, [7]);
  assert.deepEqual(removedListeners, ["pointermove", "pointerup"]);
  assert.deepEqual(dispatchedEvents, ["end"]);
  assert.equal(controls.state, -1);
  assert.deepEqual(controls._pointers, []);
  assert.deepEqual(controls._pointerPositions, {});
});
