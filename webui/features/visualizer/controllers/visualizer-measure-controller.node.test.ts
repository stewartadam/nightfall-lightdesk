// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  intersectScreenPointWithHorizontalPlane,
  projectWorldPointToScreen,
} from "../interactions/visualizer-interaction-math";
import type {
  CameraState,
  VisualizerScreenPoint,
} from "../interactions/visualizer-interaction-types";
import { VisualizerMeasureController } from "./visualizer-measure-controller";

/**
 * Creates a visualizer screen point for measure-controller tests.
 */
function point(x: number, y: number): VisualizerScreenPoint {
  return { x, y, viewportWidth: 1000, viewportHeight: 800 };
}

const cameraState: CameraState = {
  position: { x: 0, y: 6, z: 12 },
  target: { x: 0, y: 0, z: 0 },
};

const AXIS_LOCK_THRESHOLD_METERS = 0.2;

/**
 * Starts a measure drag and locks it to the X axis for constraint assertions.
 */
function beginAndLockX(controller: VisualizerMeasureController): void {
  controller.beginMeasure({
    pointerId: 999,
    startPoint: { x: 0, y: 0, z: 0 },
    startScreenPoint: point(500, 400),
    cameraState,
  });
  const firstPreview = controller.updateMeasure(point(620, 400), false);
  assert.ok(firstPreview);
  assert.equal(firstPreview.lockedAxis, "x");
}

test("intersectScreenPointWithHorizontalPlane returns a world point", () => {
  const hit = intersectScreenPointWithHorizontalPlane(
    point(500, 400),
    0,
    cameraState,
  );
  assert.ok(hit);
  assert.ok(Number.isFinite(hit.x));
  assert.equal(hit.y, 0);
  assert.ok(Number.isFinite(hit.z));
});

test("measure controller locks to x axis for strong horizontal drag", () => {
  const controller = new VisualizerMeasureController();
  controller.beginMeasure({
    pointerId: 1,
    startPoint: { x: 0, y: 0, z: 0 },
    startScreenPoint: point(500, 400),
    cameraState,
  });

  const preview = controller.updateMeasure(point(620, 400), false);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "x");
  assert.ok(preview.endPoint);
  assert.equal(preview.endPoint.y, 0);
  assert.equal(preview.endPoint.z, 0);
  assert.ok(preview.distance > 0.2);

  const result = controller.endMeasure();
  assert.ok(result);
  assert.equal(result.lockedAxis, "x");
  assert.equal(result.didMeasure, true);
});

test("measure controller shift drag locks to y axis", () => {
  const controller = new VisualizerMeasureController();
  controller.beginMeasure({
    pointerId: 2,
    startPoint: { x: 1, y: 2, z: 3 },
    startScreenPoint: point(500, 400),
    cameraState,
  });

  const preview = controller.updateMeasure(point(500, 460), true);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "y");
  assert.ok(preview.endPoint);
  assert.equal(preview.endPoint.x, 1);
  assert.equal(preview.endPoint.z, 3);
  assert.ok(preview.distance > 0.2);
});

test("measure controller allows axis swap within widened start zone", () => {
  const controller = new VisualizerMeasureController();
  beginAndLockX(controller);

  const swapCandidateY = 560;
  let swapCandidate: VisualizerScreenPoint | null = null;
  for (let x = 504; x <= 578; x += 2) {
    const candidate = point(x, swapCandidateY);
    const hit = intersectScreenPointWithHorizontalPlane(
      candidate,
      0,
      cameraState,
    );
    if (!hit) continue;
    const xDistance = Math.abs(hit.x);
    if (xDistance > AXIS_LOCK_THRESHOLD_METERS) {
      swapCandidate = candidate;
      break;
    }
  }

  assert.ok(
    swapCandidate,
    "expected to find a candidate inside the widened axis-swap zone",
  );

  const swappedPreview = controller.updateMeasure(swapCandidate, false);
  assert.ok(swappedPreview);
  assert.equal(swappedPreview.lockedAxis, "y");
  assert.ok(swappedPreview.endPoint);
});

test("measure controller uses strong vertical intent to switch from x to y", () => {
  const controller = new VisualizerMeasureController();
  beginAndLockX(controller);

  let ySwitchCandidate: VisualizerScreenPoint | null = null;
  for (let y = 430; y <= 760; y += 2) {
    for (let x = 470; x <= 530; x += 1) {
      const candidate = point(x, y);
      const probe = new VisualizerMeasureController();
      beginAndLockX(probe);
      const preview = probe.updateMeasure(candidate, false);
      if (preview?.lockedAxis === "y") {
        ySwitchCandidate = candidate;
        break;
      }
    }
    if (ySwitchCandidate) break;
  }

  assert.ok(
    ySwitchCandidate,
    "expected to find a cursor position with strong vertical screen intent",
  );

  const switchedPreview = controller.updateMeasure(ySwitchCandidate, false);
  assert.ok(switchedPreview);
  assert.equal(switchedPreview.lockedAxis, "y");
  assert.ok(switchedPreview.endPoint);
  assert.equal(switchedPreview.endPoint.x, 0);
  assert.equal(switchedPreview.endPoint.z, 0);
});

test("measure controller keeps x endpoint near cursor in shallow camera view", () => {
  const controller = new VisualizerMeasureController();
  const shallowCameraState: CameraState = {
    position: { x: 0, y: 0.45, z: 12 },
    target: { x: 0, y: 0, z: 0 },
  };

  controller.beginMeasure({
    pointerId: 6,
    startPoint: { x: 0, y: 0, z: 0 },
    startScreenPoint: point(500, 400),
    cameraState: shallowCameraState,
  });

  const cursorPoint = point(516, 401);
  const preview = controller.updateMeasure(cursorPoint, false);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "x");
  assert.ok(preview.endPoint);
  assert.ok(preview.distance < 2);

  const endScreen = projectWorldPointToScreen(
    preview.endPoint,
    shallowCameraState,
    cursorPoint.viewportWidth,
    cursorPoint.viewportHeight,
  );
  assert.ok(endScreen);
  assert.ok(Math.abs(endScreen.x - cursorPoint.x) <= 10);
});

test("measure controller keeps y endpoint near cursor in shallow camera view", () => {
  const controller = new VisualizerMeasureController();
  const shallowCameraState: CameraState = {
    position: { x: 0, y: 0.45, z: 12 },
    target: { x: 0, y: 0, z: 0 },
  };

  controller.beginMeasure({
    pointerId: 7,
    startPoint: { x: 0, y: 0, z: 0 },
    startScreenPoint: point(500, 400),
    cameraState: shallowCameraState,
  });

  const cursorPoint = point(500, 470);
  const preview = controller.updateMeasure(cursorPoint, true);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "y");
  assert.ok(preview.endPoint);
  assert.ok(preview.distance < 2);

  const endScreen = projectWorldPointToScreen(
    preview.endPoint,
    shallowCameraState,
    cursorPoint.viewportWidth,
    cursorPoint.viewportHeight,
  );
  assert.ok(endScreen);
  assert.ok(Math.abs(endScreen.y - cursorPoint.y) <= 10);
});

test("measure controller avoids x/y flicker after switching to y", () => {
  const controller = new VisualizerMeasureController();
  beginAndLockX(controller);

  const switched = controller.updateMeasure(point(500, 560), false);
  assert.ok(switched);
  assert.equal(switched.lockedAxis, "y");

  const jitterPath = [
    point(504, 565),
    point(496, 571),
    point(503, 579),
    point(497, 586),
    point(505, 592),
  ];

  for (const cursor of jitterPath) {
    const preview = controller.updateMeasure(cursor, false);
    assert.ok(preview);
    assert.equal(
      preview.lockedAxis,
      "y",
      "axis lock should remain on y under small horizontal jitter",
    );
  }
});
