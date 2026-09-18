// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { projectWorldPointToScreen } from "../interactions/visualizer-interaction-math";
import type {
  CameraState,
  VisualizerScreenPoint,
} from "../interactions/visualizer-interaction-types";
import { VisualizerMoveController } from "./visualizer-move-controller";

/**
 * Creates a visualizer screen point for move-controller tests.
 */
function point(x: number, y: number): VisualizerScreenPoint {
  return { x, y, viewportWidth: 1000, viewportHeight: 800 };
}

/**
 * Builds a fixture position record for move-controller previews and commits.
 */
function fixture(uid: string, x: number, y: number, z: number) {
  return {
    uid,
    position: { x, y, z },
  };
}

const cameraState: CameraState = {
  position: { x: 0, y: 6, z: 12 },
  target: { x: 0, y: 0, z: 0 },
};

/**
 * Starts a move drag and locks it to the X axis for constraint assertions.
 */
function beginAndLockX(controller: VisualizerMoveController): void {
  const begin = controller.beginDrag({
    pointerId: 999,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0)],
  });
  assert.ok(begin);
  const firstPreview = controller.updateDrag(point(620, 400), false);
  assert.ok(firstPreview);
  assert.equal(firstPreview.lockedAxis, "x");
}

test("move controller drags selected fixtures as a rigid group on x axis", () => {
  const controller = new VisualizerMoveController();
  const fixtures = [fixture("a", 0, 0, 0), fixture("b", 2, 0, 1)];

  const begin = controller.beginDrag({
    pointerId: 1,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a", "b"],
    fixtures,
  });

  assert.ok(begin);
  assert.equal(begin.activeFixtureUids.length, 2);
  assert.equal(begin.setSelectionToHitFixture, false);
  assert.equal(begin.startPositions.length, 2);
  const startA = begin.startPositions.find((entry) => entry.uid === "a");
  const startB = begin.startPositions.find((entry) => entry.uid === "b");
  assert.ok(startA);
  assert.ok(startB);
  assert.deepEqual(startA.position, fixtures[0].position);
  assert.deepEqual(startB.position, fixtures[1].position);

  const preview = controller.updateDrag(point(620, 400), false);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "x");
  assert.ok(preview.distance > 0.2);

  const movedA = preview.positions.find((entry) => entry.uid === "a");
  const movedB = preview.positions.find((entry) => entry.uid === "b");
  assert.ok(movedA);
  assert.ok(movedB);
  assert.equal(movedA.position.y, 0);
  assert.equal(movedA.position.z, 0);
  assert.equal(movedB.position.y, 0);
  assert.equal(movedB.position.z, 1);

  const deltaAX = movedA.position.x - fixtures[0].position.x;
  const deltaBX = movedB.position.x - fixtures[1].position.x;
  assert.ok(Math.abs(deltaAX) > 0.2);
  assert.ok(Math.abs(deltaAX - deltaBX) < 1e-6);

  const commit = controller.endDrag();
  assert.ok(commit);
  assert.equal(commit.lockedAxis, "x");
  assert.ok(commit.distance > 0.2);
  assert.equal(commit.didMove, true);
});

test("move controller shift-drag locks to y axis", () => {
  const controller = new VisualizerMoveController();
  const fixtures = [fixture("a", 1, 0.5, -1)];

  const begin = controller.beginDrag({
    pointerId: 2,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures,
  });
  assert.ok(begin);
  assert.equal(begin.startPositions.length, 1);
  assert.equal(begin.startPositions[0].uid, "a");
  assert.deepEqual(begin.startPositions[0].position, fixtures[0].position);

  const preview = controller.updateDrag(point(500, 460), true);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "y");
  assert.ok(preview.distance > 0.2);
  assert.equal(preview.positions.length, 1);
  assert.equal(preview.positions[0].position.x, fixtures[0].position.x);
  assert.equal(preview.positions[0].position.z, fixtures[0].position.z);
  assert.ok(
    Math.abs(preview.positions[0].position.y - fixtures[0].position.y) > 0.2,
  );
});

test("move controller uses strong vertical intent to switch from x to y", () => {
  const controller = new VisualizerMoveController();
  beginAndLockX(controller);

  let ySwitchCandidate: VisualizerScreenPoint | null = null;
  for (let y = 430; y <= 760; y += 2) {
    for (let x = 470; x <= 530; x += 1) {
      const candidate = point(x, y);
      const probe = new VisualizerMoveController();
      beginAndLockX(probe);
      const preview = probe.updateDrag(candidate, false);
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

  const switchedPreview = controller.updateDrag(ySwitchCandidate, false);
  assert.ok(switchedPreview);
  assert.equal(switchedPreview.lockedAxis, "y");
  const moved = switchedPreview.positions.find((entry) => entry.uid === "a");
  assert.ok(moved);
  assert.equal(moved.position.x, 0);
  assert.equal(moved.position.z, 0);
});

test("move controller keeps x translation endpoint near cursor in shallow camera view", () => {
  const controller = new VisualizerMoveController();
  const shallowCameraState: CameraState = {
    position: { x: 0, y: 0.45, z: 12 },
    target: { x: 0, y: 0, z: 0 },
  };

  const begin = controller.beginDrag({
    pointerId: 6,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState: shallowCameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0)],
  });
  assert.ok(begin);

  const cursorPoint = point(516, 401);
  const preview = controller.updateDrag(cursorPoint, false);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "x");
  assert.ok(preview.distance < 2);

  const moved = preview.positions.find((entry) => entry.uid === "a");
  assert.ok(moved);
  const movedScreen = projectWorldPointToScreen(
    moved.position,
    shallowCameraState,
    cursorPoint.viewportWidth,
    cursorPoint.viewportHeight,
  );
  assert.ok(movedScreen);
  assert.ok(Math.abs(movedScreen.x - cursorPoint.x) <= 10);
});

test("move controller keeps y translation endpoint near cursor in shallow camera view", () => {
  const controller = new VisualizerMoveController();
  const shallowCameraState: CameraState = {
    position: { x: 0, y: 0.45, z: 12 },
    target: { x: 0, y: 0, z: 0 },
  };

  const begin = controller.beginDrag({
    pointerId: 7,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState: shallowCameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0)],
  });
  assert.ok(begin);

  const cursorPoint = point(500, 470);
  const preview = controller.updateDrag(cursorPoint, true);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "y");
  assert.ok(preview.distance < 2);

  const moved = preview.positions.find((entry) => entry.uid === "a");
  assert.ok(moved);
  const movedScreen = projectWorldPointToScreen(
    moved.position,
    shallowCameraState,
    cursorPoint.viewportWidth,
    cursorPoint.viewportHeight,
  );
  assert.ok(movedScreen);
  assert.ok(Math.abs(movedScreen.y - cursorPoint.y) <= 10);
});
