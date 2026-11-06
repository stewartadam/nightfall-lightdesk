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
  createControls,
  disposeControlsBehavior,
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

/** A canvas stand-in that dispatches events and records pointer capture like a browser element. */
class FakeCanvas extends EventTarget {
  readonly ownerDocument = new EventTarget();
  readonly style: Record<string, string> = {};
  readonly clientWidth = 100;
  readonly clientHeight = 100;
  readonly captured = new Set<number>();
  readonly released: number[] = [];

  /** Records that the element captured a pointer. */
  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId);
  }

  /** Reports whether the element still owns a pointer capture. */
  hasPointerCapture(pointerId: number): boolean {
    return this.captured.has(pointerId);
  }

  /** Releases a captured pointer and records the release. */
  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId);
    this.released.push(pointerId);
  }

  /** OrbitControls listens for modifier keys on the element's root node. */
  getRootNode(): EventTarget {
    return this.ownerDocument;
  }

  /** Reports the element's on-screen bounds for pointer math. */
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
}

/** Builds a mouse pointer event carrying the fields OrbitControls reads. */
function pointerEvent(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
): Event {
  return Object.assign(new Event(type), {
    pointerId,
    pointerType: "mouse",
    button: 0,
    clientX,
    clientY,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
  });
}

/**
 * Verifies an abandoned OrbitControls drag releases its capture, reports its end once,
 * ignores the stale pointer afterwards, and leaves the controls usable for a new drag.
 */
test("cancelControlsInteraction abandons an active OrbitControls drag", () => {
  const camera = new PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(0, 8, 12);
  const canvas = new FakeCanvas();
  const controls = createControls(
    camera,
    canvas as unknown as HTMLElement,
    { x: 0, y: 2, z: 0 },
    "camera-locked",
  );
  const events: string[] = [];
  controls.addEventListener("start", () => events.push("start"));
  controls.addEventListener("end", () => events.push("end"));

  canvas.dispatchEvent(pointerEvent("pointerdown", 7, 10, 10));
  assert.deepEqual(events, ["start"]);
  assert.ok(canvas.captured.has(7));

  cancelControlsInteraction(controls);
  assert.deepEqual(canvas.released, [7]);
  assert.deepEqual(events, ["start", "end"]);

  const position = camera.position.clone();
  canvas.ownerDocument.dispatchEvent(pointerEvent("pointermove", 7, 60, 60));
  controls.update();
  assert.ok(camera.position.equals(position), "stale drag moved the camera");

  canvas.dispatchEvent(pointerEvent("pointerdown", 8, 10, 10));
  assert.deepEqual(events, ["start", "end", "start"]);
  // OrbitControls finishes drags from document-level pointerup listeners.
  canvas.ownerDocument.dispatchEvent(pointerEvent("pointerup", 8, 10, 10));
  assert.deepEqual(events, ["start", "end", "start", "end"]);
  disposeControlsBehavior(controls);
  controls.dispose();
});
