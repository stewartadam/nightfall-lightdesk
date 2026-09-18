// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  Axis,
  CameraState,
  ScreenPoint2D,
  VisualizerScreenPoint,
} from "../interactions/visualizer-interaction-types";
import { VisualizerRotateController } from "./visualizer-rotate-controller";

/**
 * Creates a visualizer screen point for rotate-controller tests.
 */
function point(x: number, y: number): VisualizerScreenPoint {
  return { x, y, viewportWidth: 1000, viewportHeight: 800 };
}

/**
 * Builds a fixture position record for rotate-controller previews and commits.
 */
function fixture(
  uid: string,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
) {
  return {
    uid,
    position: { x, y, z },
    rotation: { x: rx, y: ry, z: rz },
  };
}

const cameraState: CameraState = {
  position: { x: 0, y: 6, z: 12 },
  target: { x: 0, y: 0, z: 0 },
};

/**
 * Measures the screen-space distance between two projected points.
 */
function distance2D(a: ScreenPoint2D, b: ScreenPoint2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Normalizes an angle into the 0-360 degree range used by rotation assertions.
 */
function wrapDegrees360(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Converts a 2D point into the visualizer screen-point shape.
 */
function toScreenPoint(point2D: ScreenPoint2D): VisualizerScreenPoint {
  return point(point2D.x, point2D.y);
}

/**
 * Flattens rendered ring segments into a single point list for comparisons.
 */
function flattenRingPoints(segments: {
  front: ScreenPoint2D[][];
  back: ScreenPoint2D[][];
}): ScreenPoint2D[] {
  return [...segments.front.flat(), ...segments.back.flat()];
}

/**
 * Extracts ring points with enough separation to drive a drag gesture.
 */
function ringDragPathPoints(segments: {
  front: ScreenPoint2D[][];
  back: ScreenPoint2D[][];
}): ScreenPoint2D[] {
  const allSegments = [...segments.front, ...segments.back];
  if (allSegments.length === 0) return [];

  let longest = allSegments[0];
  for (const candidate of allSegments) {
    if (candidate.length > longest.length) {
      longest = candidate;
    }
  }

  return longest.length > 1 ? longest : flattenRingPoints(segments);
}

/**
 * Chooses a point on a rotation ring for hit-testing and drag setup.
 */
function ringPickPoint(
  controller: VisualizerRotateController,
  axis: Axis,
): { index: number; point: ScreenPoint2D } {
  const overlay = controller.getGizmoOverlay();
  assert.ok(overlay, "expected active rotate gizmo overlay");
  const targetRing = flattenRingPoints(overlay.rings[axis]);
  assert.ok(targetRing.length > 8, `expected ${axis} ring points`);
  const otherPoints = (["x", "y", "z"] as const)
    .filter((candidate) => candidate !== axis)
    .flatMap((candidate) => flattenRingPoints(overlay.rings[candidate]));

  let bestIndex = 0;
  let bestSeparation = -1;
  for (let i = 0; i < targetRing.length; i += 1) {
    const candidate = targetRing[i];
    let nearestOther = Number.POSITIVE_INFINITY;
    for (const other of otherPoints) {
      const distance = distance2D(candidate, other);
      if (distance < nearestOther) {
        nearestOther = distance;
      }
    }
    if (nearestOther > bestSeparation) {
      bestSeparation = nearestOther;
      bestIndex = i;
    }
  }
  return { index: bestIndex, point: targetRing[bestIndex] };
}

/**
 * Finds a ring point at the requested offset from the projected gizmo center.
 */
function ringPointOffsetFromCenter(
  controller: VisualizerRotateController,
  axis: Axis,
  offsetPixels: number,
): VisualizerScreenPoint {
  const overlay = controller.getGizmoOverlay();
  assert.ok(overlay?.center, "expected rotate gizmo center");
  const pick = ringPickPoint(controller, axis);
  const dx = pick.point.x - overlay.center.x;
  const dy = pick.point.y - overlay.center.y;
  const distance = Math.hypot(dx, dy);
  assert.ok(distance > 1e-6, "expected ring pick point away from center");
  return point(
    pick.point.x + (dx / distance) * offsetPixels,
    pick.point.y + (dy / distance) * offsetPixels,
  );
}

/**
 * Finds a ring point near a cross-axis point to exercise ambiguous hit testing.
 */
function ambiguousRingPoint(
  controller: VisualizerRotateController,
): ScreenPoint2D | null {
  const overlay = controller.getGizmoOverlay();
  assert.ok(overlay, "expected active rotate gizmo overlay");
  const xPoints = flattenRingPoints(overlay.rings.x);
  const yPoints = flattenRingPoints(overlay.rings.y);
  let best: { x: number; y: number; distance: number } | null = null;
  for (const xPoint of xPoints) {
    for (const yPoint of yPoints) {
      const distance = distance2D(xPoint, yPoint);
      if (!best || distance < best.distance) {
        best = {
          x: (xPoint.x + yPoint.x) / 2,
          y: (xPoint.y + yPoint.y) / 2,
          distance,
        };
      }
    }
  }
  if (!best) return null;
  return { x: best.x, y: best.y };
}

/**
 * Measures how close one ring can pick to another ring point.
 */
function closestRingPointDistance(
  point: ScreenPoint2D,
  ring: {
    front: ScreenPoint2D[][];
    back: ScreenPoint2D[][];
  },
): number {
  const points = flattenRingPoints(ring);
  let minDistance = Number.POSITIVE_INFINITY;
  for (const candidate of points) {
    const distance = distance2D(point, candidate);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }
  return minDistance;
}

/**
 * Finds the ring point nearest a different axis for ambiguity tests.
 */
function ringPointWithClosestCrossAxis(
  controller: VisualizerRotateController,
  axis: Axis,
  crossAxis: Axis,
): { point: ScreenPoint2D; crossAxisDistance: number } | null {
  const overlay = controller.getGizmoOverlay();
  assert.ok(overlay, "expected active rotate gizmo overlay");
  const axisPoints = flattenRingPoints(overlay.rings[axis]);
  if (axisPoints.length === 0) return null;

  let best: { point: ScreenPoint2D; crossAxisDistance: number } | null = null;
  for (const axisPoint of axisPoints) {
    const distance = closestRingPointDistance(
      axisPoint,
      overlay.rings[crossAxis],
    );
    if (!best || distance < best.crossAxisDistance) {
      best = { point: axisPoint, crossAxisDistance: distance };
    }
  }
  return best;
}

/**
 * Computes the nearest axis angle represented by a projected ring point.
 */
function nearestAxisAngleForRingPoint(
  controller: VisualizerRotateController,
  axis: Axis,
  targetPoint: ScreenPoint2D,
): number {
  let bestAngle = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let angle = 0; angle < 360; angle += 0.5) {
    const candidate = controller.getRingPointForAxisAngle(axis, angle);
    if (!candidate) continue;
    const distance = distance2D(candidate, targetPoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestAngle = angle;
    }
  }
  assert.ok(bestDistance <= 1.5, "expected a nearby angle sample on ring");
  return bestAngle;
}

/**
 * Drags a rotation controller until the preview reaches the requested angle.
 */
function dragUntilAngle(
  controller: VisualizerRotateController,
  axis: Axis,
  minimumAngleDegrees: number,
) {
  const overlay = controller.getGizmoOverlay();
  assert.ok(overlay);
  const points = ringDragPathPoints(overlay.rings[axis]);
  let lastPreview = null;
  for (const candidate of points) {
    const preview = controller.updateDrag(toScreenPoint(candidate));
    assert.ok(preview);
    lastPreview = preview;
    if (
      preview.lockedAxis === axis &&
      preview.angleDegrees > minimumAngleDegrees
    ) {
      return preview;
    }
  }
  return lastPreview;
}

test("rotate controller rotates selected fixtures as a rigid group on x axis", () => {
  const controller = new VisualizerRotateController();
  const fixtures = [
    fixture("a", 0, 0, 0, 0, 0, 0),
    fixture("b", 2, 0, 1, 10, 20, 30),
  ];

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

  const xPick = ringPickPoint(controller, "x");
  const lockedAxis = controller.beginAxisDrag(1, toScreenPoint(xPick.point));
  assert.equal(lockedAxis, "x");

  const preview = dragUntilAngle(controller, "x", 1);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "x");
  assert.ok(preview.angleDegrees > 1);

  const rotatedA = preview.rotations.find((entry) => entry.uid === "a");
  const rotatedB = preview.rotations.find((entry) => entry.uid === "b");
  assert.ok(rotatedA);
  assert.ok(rotatedB);
  assert.equal(rotatedA.rotation.y, fixtures[0].rotation.y);
  assert.equal(rotatedA.rotation.z, fixtures[0].rotation.z);
  assert.equal(rotatedB.rotation.y, fixtures[1].rotation.y);
  assert.equal(rotatedB.rotation.z, fixtures[1].rotation.z);

  const deltaAX = rotatedA.rotation.x - fixtures[0].rotation.x;
  const deltaBX = rotatedB.rotation.x - fixtures[1].rotation.x;
  assert.ok(Math.abs(deltaAX) > 1);
  assert.ok(Math.abs(wrapDegrees360(deltaAX) - wrapDegrees360(deltaBX)) < 1e-6);

  const commit = controller.endDrag();
  assert.ok(commit);
  assert.equal(commit.lockedAxis, "x");
  assert.ok(commit.angleDegrees > 1);
  assert.equal(commit.didRotate, true);
});

test("rotate controller rotates around y axis when dragging y ring", () => {
  const controller = new VisualizerRotateController();
  const fixtures = [fixture("a", 1, 0.5, -1, 10, 15, -20)];

  const begin = controller.beginDrag({
    pointerId: 2,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures,
  });
  assert.ok(begin);

  const yPick = ringPickPoint(controller, "y");
  const lockedAxis = controller.beginAxisDrag(2, toScreenPoint(yPick.point));
  assert.equal(lockedAxis, "y");

  const preview = dragUntilAngle(controller, "y", 1);
  assert.ok(preview);
  assert.equal(preview.lockedAxis, "y");
  assert.ok(preview.angleDegrees > 1);
  assert.equal(preview.rotations.length, 1);
  assert.equal(preview.rotations[0].rotation.x, fixtures[0].rotation.x);
  assert.equal(preview.rotations[0].rotation.z, fixtures[0].rotation.z);
  assert.ok(
    Math.abs(preview.rotations[0].rotation.y - fixtures[0].rotation.y) > 1,
  );
});

test("rotate controller keeps the first selected ring axis during drag", () => {
  const controller = new VisualizerRotateController();
  const begin = controller.beginDrag({
    pointerId: 999,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0, 0, 0, 0)],
  });
  assert.ok(begin);

  const xPick = ringPickPoint(controller, "x");
  const lockedAxis = controller.beginAxisDrag(999, toScreenPoint(xPick.point));
  assert.equal(lockedAxis, "x");
  const xPreview = dragUntilAngle(controller, "x", 0.5);
  assert.ok(xPreview);
  assert.equal(xPreview.lockedAxis, "x");

  const yPick = ringPickPoint(controller, "y");
  const switchedPreview = controller.updateDrag(toScreenPoint(yPick.point));
  assert.ok(switchedPreview);
  assert.equal(switchedPreview.lockedAxis, "x");

  const rotated = switchedPreview.rotations.find((entry) => entry.uid === "a");
  assert.ok(rotated);
  assert.notEqual(rotated.rotation.x, 0);
  assert.equal(rotated.rotation.z, 0);
});

test("rotate controller locks a ring axis for ambiguous ring overlap", () => {
  const controller = new VisualizerRotateController();
  const begin = controller.beginDrag({
    pointerId: 123,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0, 0, 0, 0)],
  });
  assert.ok(begin);

  const ambiguous = ambiguousRingPoint(controller);
  assert.ok(ambiguous);
  const lockedAxis = controller.beginAxisDrag(123, toScreenPoint(ambiguous));
  assert.ok(lockedAxis === "x" || lockedAxis === "y" || lockedAxis === "z");
});

test("rotate controller locks axis when pointer is slightly outside the ring", () => {
  const controller = new VisualizerRotateController();
  const begin = controller.beginDrag({
    pointerId: 71,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0, 0, 0, 0)],
  });
  assert.ok(begin);
  const outsidePoint = ringPointOffsetFromCenter(controller, "z", 12);
  const lockedAxis = controller.beginAxisDrag(71, outsidePoint);
  assert.equal(lockedAxis, "z");
});

test("rotate controller axis dots lock even in ring-overlap regions", () => {
  const probe = new VisualizerRotateController();
  const probeBegin = probe.beginDrag({
    pointerId: 88,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0, 0, 0, 0)],
  });
  assert.ok(probeBegin);

  const overlap = ringPointWithClosestCrossAxis(probe, "x", "y");
  assert.ok(overlap);
  assert.ok(
    overlap.crossAxisDistance <= 2,
    "expected x/y ring overlap within ambiguity threshold",
  );
  const xAngleAtOverlap = nearestAxisAngleForRingPoint(
    probe,
    "x",
    overlap.point,
  );

  const controller = new VisualizerRotateController();
  const begin = controller.beginDrag({
    pointerId: 89,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0, xAngleAtOverlap, 110, 220)],
  });
  assert.ok(begin);

  const xDot = controller.getRingPointForAxisAngle("x", xAngleAtOverlap);
  assert.ok(xDot);
  const lockedAxis = controller.beginAxisDrag(89, toScreenPoint(xDot));
  assert.equal(lockedAxis, "x");
});

test("rotate controller syncFromFixtures updates gizmo center when position changes", () => {
  const controller = new VisualizerRotateController();
  const begin = controller.beginDrag({
    pointerId: 55,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0, 0, 0, 0)],
  });
  assert.ok(begin);

  const before = controller.getGizmoOverlay();
  assert.ok(before?.center);

  const synced = controller.syncFromFixtures([
    fixture("a", 2.5, 1.1, -0.8, 0, 0, 0),
  ]);
  assert.equal(synced, true);

  const after = controller.getGizmoOverlay();
  assert.ok(after?.center);
  const movedDistance = distance2D(before.center, after.center);
  assert.ok(movedDistance > 0.5);
});

test("rotate controller syncCamera updates gizmo center when camera changes", () => {
  const controller = new VisualizerRotateController();
  const begin = controller.beginDrag({
    pointerId: 77,
    hitFixtureUid: "a",
    point: point(500, 400),
    cameraState,
    selectedUids: ["a"],
    fixtures: [fixture("a", 0, 0, 0, 0, 0, 0)],
  });
  assert.ok(begin);

  const before = controller.getGizmoOverlay();
  assert.ok(before?.center);
  const beforeCenter = before.center!;

  const synced = controller.syncCamera(
    {
      position: { x: 4, y: 8, z: 16 },
      target: { x: 0, y: 0, z: 0 },
    },
    1000,
    800,
  );
  assert.equal(synced, true);

  const after = controller.getGizmoOverlay();
  assert.ok(after?.center);
  const afterCenter = after.center!;
  const beforePoints = flattenRingPoints(before.rings.x);
  const afterPoints = flattenRingPoints(after.rings.x);
  assert.ok(beforePoints.length > 0);
  assert.ok(afterPoints.length > 0);
  const beforeAvgRadius =
    beforePoints.reduce(
      (sum, point) => sum + distance2D(point, beforeCenter),
      0,
    ) / beforePoints.length;
  const afterAvgRadius =
    afterPoints.reduce(
      (sum, point) => sum + distance2D(point, afterCenter),
      0,
    ) / afterPoints.length;
  assert.ok(Math.abs(beforeAvgRadius - afterAvgRadius) > 0.5);
});
