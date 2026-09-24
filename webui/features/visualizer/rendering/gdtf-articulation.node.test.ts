// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Numeric scene-graph tests for GDTF articulation.
 *
 * These build real fixture scene graphs headlessly and assert world-space
 * beam directions and pivot positions, so movement regressions fail without
 * a GPU or screenshots. GDTF conventions: Z is up, beams emit along local -Z,
 * pan rotates about local Z and tilt about local X.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  Group,
  MathUtils,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three/webgpu";
import {
  AxisType,
  type FixtureGeometry,
  type GeometryNode,
  GeometryType,
  type Transform,
} from "../../../types";
import type { FixtureInstance } from "../model/types";
import { type JointInput, updateGdtfJoints } from "./gdtf-joints";
import { buildGeometryTree, gdtfPlacementQuaternion } from "./geometry-builder";
import { normalizeGdtfGltfScene } from "./mesh-loader";

/** Column-major matrix of a translation in metres, optionally rotated about X first. */
function transform(
  translation: [number, number, number] = [0, 0, 0],
  rotateXDeg = 0,
): Transform {
  const angle = MathUtils.degToRad(rotateXDeg);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    elements: [1, 0, 0, 0, 0, cos, sin, 0, 0, -sin, cos, 0, ...translation, 1],
  };
}

/** Builds a geometry node with parent/child links filled in by `tree`. */
function node(
  name: string,
  geometryType: GeometryType,
  options: Partial<GeometryNode> = {},
): GeometryNode {
  return {
    name,
    geometryType,
    transform: transform(),
    parentIndex: -1,
    children: [],
    ...options,
  };
}

/** Links nodes given as `[node, parentIndex]` pairs into a single-root geometry tree. */
function tree(entries: Array<[GeometryNode, number]>): FixtureGeometry {
  const nodes = entries.map(([entry, parentIndex]) => ({
    ...entry,
    parentIndex,
    children: [] as number[],
  }));
  nodes.forEach((entry, index) => {
    if (entry.parentIndex >= 0) nodes[entry.parentIndex].children.push(index);
  });
  return { nodes, roots: [0] };
}

/**
 * A hanging moving head: Base → Yoke (pan) → Head (tilt, 0.2 m below the
 * yoke) → Beam (0.05 m below the tilt pivot).
 */
function movingHead(headRestTiltDeg = 0): FixtureGeometry {
  return tree([
    [node("Base", GeometryType.Generic), -1],
    [
      node("Yoke", GeometryType.Axis, {
        axes: [AxisType.Pan],
        controlledElement: "Head",
        transform: transform([0, 0, -0.1]),
      }),
      0,
    ],
    [
      node("Head", GeometryType.Axis, {
        axes: [AxisType.Tilt],
        controlledElement: "Head",
        transform: transform([0, 0, -0.2], headRestTiltDeg),
      }),
      1,
    ],
    [
      node("Beam", GeometryType.Beam, {
        controlledElement: "Head",
        transform: transform([0, 0, -0.05]),
      }),
      2,
    ],
  ]);
}

/** Two independent tilting heads side by side on one bar. */
function twoHeads(): FixtureGeometry {
  const head = (index: number, x: number): Array<[GeometryNode, number]> => [
    [
      node(`Head ${index}`, GeometryType.Axis, {
        axes: [AxisType.Tilt],
        controlledElement: `Head ${index}`,
        transform: transform([x, 0, -0.1]),
      }),
      0,
    ],
  ];
  const entries: Array<[GeometryNode, number]> = [
    [node("Bar", GeometryType.Generic), -1],
    ...head(1, -0.2),
    ...head(2, 0.2),
  ];
  entries.push([
    node("Head 1/Lens", GeometryType.Beam, { controlledElement: "Head 1" }),
    1,
  ]);
  entries.push([
    node("Head 2/Lens", GeometryType.Beam, { controlledElement: "Head 2" }),
    2,
  ]);
  return tree(entries);
}

/** Builds a fixture, places it with a rotation in degrees, and applies joint inputs immediately. */
function pose(
  geometry: FixtureGeometry,
  inputs: Record<string, JointInput>,
  rotationDeg = { x: 0, y: 0, z: 0 },
  instance: FixtureInstance = buildGeometryTree("fixture", geometry),
): FixtureInstance {
  instance.group.quaternion.copy(gdtfPlacementQuaternion(rotationDeg));
  updateGdtfJoints(
    instance.joints ?? [],
    new Map(Object.entries(inputs)),
    0,
    null,
  );
  instance.group.updateMatrixWorld(true);
  return instance;
}

/** Returns a node's world-space beam direction (its local -Z axis). */
function beamDirection(instance: FixtureInstance, name: string): Vector3 {
  const object = instance.nodeObjects.get(name);
  assert.ok(object, `missing node ${name}`);
  const rotation = new Quaternion();
  object.getWorldQuaternion(rotation);
  return new Vector3(0, 0, -1).applyQuaternion(rotation);
}

/** Returns a node's world-space origin in metres. */
function origin(instance: FixtureInstance, name: string): Vector3 {
  const object = instance.nodeObjects.get(name);
  assert.ok(object, `missing node ${name}`);
  return object.getWorldPosition(new Vector3());
}

/** Asserts two vectors match within a tolerance. */
function assertVector(
  actual: Vector3,
  expected: [number, number, number],
  message: string,
): void {
  const distance = actual.distanceTo(new Vector3(...expected));
  assert.ok(
    distance < 1e-6,
    `${message}: expected ${expected.join(",")}, got ${actual.toArray().map((v) => v.toFixed(4))}`,
  );
}

/** Normalized pan input for an angle in degrees. */
const pan = (degrees: number) => degrees / 540;
/** Normalized tilt input for an angle in degrees. */
const tilt = (degrees: number) => degrees / 270;

/** Verifies a hanging head at rest points straight down in world space. */
test("hanging moving head points down at rest", () => {
  const instance = pose(movingHead(), { Head: { pan: 0, tilt: 0 } });
  assertVector(beamDirection(instance, "Beam"), [0, -1, 0], "rest direction");
  assertVector(origin(instance, "Beam"), [0, -0.35, 0], "beam origin");
});

/** Verifies pan turns about the vertical axis and leaves a downward beam downward. */
test("pan alone keeps a downward beam downward", () => {
  const instance = pose(movingHead(), { Head: { pan: pan(90), tilt: 0 } });
  assertVector(beamDirection(instance, "Beam"), [0, -1, 0], "panned direction");
});

/** Verifies tilt swings the beam to horizontal about the head pivot. */
test("tilt swings the beam about the head pivot", () => {
  const instance = pose(movingHead(), { Head: { pan: 0, tilt: tilt(90) } });
  assertVector(beamDirection(instance, "Beam"), [0, 0, -1], "tilted direction");
  assertVector(origin(instance, "Head"), [0, -0.3, 0], "tilt pivot stays put");
  assertVector(
    origin(instance, "Beam"),
    [0, -0.3, -0.05],
    "beam origin orbits the pivot",
  );
});

/** Verifies pan carries the tilted head, rotating the horizontal beam about world Y. */
test("pan carries the tilt assembly", () => {
  const instance = pose(movingHead(), {
    Head: { pan: pan(90), tilt: tilt(90) },
  });
  assertVector(
    beamDirection(instance, "Beam"),
    [-1, 0, 0],
    "pan-and-tilt direction",
  );
});

/** Verifies movement composes with a joint's authored rest rotation instead of replacing it. */
test("tilt composes with the authored rest rotation", () => {
  const rest = pose(movingHead(30), { Head: { tilt: 0 } });
  const moved = pose(movingHead(30), { Head: { tilt: tilt(10) } });
  const down = new Vector3(0, -1, 0);
  assert.ok(
    Math.abs(
      MathUtils.radToDeg(beamDirection(rest, "Beam").angleTo(down)) - 30,
    ) < 1e-6,
  );
  assert.ok(
    Math.abs(
      MathUtils.radToDeg(beamDirection(moved, "Beam").angleTo(down)) - 40,
    ) < 1e-6,
  );
});

/** Verifies a fixture mounted upright points its rest beam upward and still pans about vertical. */
test("upright mounting flips the rest beam and pan axis", () => {
  const instance = pose(
    movingHead(),
    { Head: { pan: pan(90), tilt: tilt(90) } },
    { x: 180, y: 0, z: 0 },
  );
  const rest = pose(movingHead(), { Head: {} }, { x: 180, y: 0, z: 0 });
  assertVector(beamDirection(rest, "Beam"), [0, 1, 0], "upright rest");
  assert.ok(
    Math.abs(beamDirection(instance, "Beam").y) < 1e-6,
    "tilted beam stays horizontal when upright",
  );
});

/** Verifies one head's tilt leaves its sibling and the bar untouched. */
test("independent heads move only their own joint", () => {
  const instance = pose(twoHeads(), {
    "Head 1": { tilt: tilt(45) },
    "Head 2": { tilt: 0 },
  });
  const down = new Vector3(0, -1, 0);
  assert.ok(
    Math.abs(
      MathUtils.radToDeg(beamDirection(instance, "Head 1/Lens").angleTo(down)) -
        45,
    ) < 1e-6,
  );
  assertVector(
    beamDirection(instance, "Head 2/Lens"),
    [0, -1, 0],
    "sibling stays",
  );
  assertVector(beamDirection(instance, "Bar"), [0, -1, 0], "bar stays at rest");
});

/** Verifies two instances built from one geometry hold different poses. */
test("fixture instances do not share joint state", () => {
  const geometry = movingHead();
  const first = pose(geometry, { Head: { tilt: tilt(90) } });
  const second = pose(geometry, { Head: { tilt: 0 } });
  assertVector(beamDirection(first, "Beam"), [0, 0, -1], "first instance");
  assertVector(beamDirection(second, "Beam"), [0, -1, 0], "second instance");
});

/** Verifies joint smoothing follows the injected clock at the configured speed. */
test("joint speed limiting follows the injected clock", () => {
  const instance = buildGeometryTree("fixture", movingHead());
  const joints = instance.joints ?? [];
  const tiltJoint = joints.find((joint) => joint.axes.includes(AxisType.Tilt));
  assert.ok(tiltJoint);

  const target = new Map([["Head", { tilt: tilt(90) }]]);
  updateGdtfJoints(joints, new Map([["Head", { tilt: 0 }]]), 1000, 180);
  updateGdtfJoints(joints, target, 1250, 180);
  assert.ok(Math.abs(MathUtils.radToDeg(tiltJoint.currentRad[0]) - 45) < 1e-6);
  updateGdtfJoints(joints, target, 2000, 180);
  assert.ok(Math.abs(MathUtils.radToDeg(tiltJoint.currentRad[0]) - 90) < 1e-6);
});

/** Verifies glTF meshes are converted from Y-up metres to the Z-up millimetre tree and lose stray cameras. */
test("glTF meshes are normalized into GDTF space", () => {
  const scene = new Group();
  const marker = new Object3D();
  marker.position.set(0, 1, 0);
  scene.add(marker);
  scene.add(new PerspectiveCamera());

  const normalized = normalizeGdtfGltfScene(scene);
  normalized.updateMatrixWorld(true);

  assertVector(
    marker.getWorldPosition(new Vector3()),
    [0, 0, 1000],
    "glTF +Y metre maps to GDTF +Z millimetres",
  );
  let cameras = 0;
  normalized.traverse((object) => {
    if ((object as PerspectiveCamera).isCamera) cameras += 1;
  });
  assert.equal(cameras, 0);
});

/** Verifies a single node carrying pan and tilt applies pan first, then tilt in the panned frame. */
test("one node can carry both pan and tilt", () => {
  const geometry = tree([
    [node("Base", GeometryType.Generic), -1],
    [
      node("Head", GeometryType.Axis, {
        axes: [AxisType.Pan, AxisType.Tilt],
        transform: transform([0, 0, -0.2]),
      }),
      0,
    ],
    [node("Beam", GeometryType.Beam, { controlledElement: "Head" }), 1],
  ]);
  const instance = pose(geometry, { Head: { pan: pan(90), tilt: tilt(90) } });
  assertVector(
    beamDirection(instance, "Beam"),
    [-1, 0, 0],
    "combined pan and tilt",
  );
});
