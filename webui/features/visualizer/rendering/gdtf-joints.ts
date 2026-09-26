// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Articulation of GDTF geometry.
 *
 * Every geometry node that a pan or tilt channel names becomes a joint bound
 * to that channel's element. A joint keeps its authored rest orientation and
 * adds its own rotation on top: pan about the node's local GDTF Z axis, tilt
 * about its local X axis. Joints move independently, so multi-head fixtures
 * and nested pan/tilt chains follow the Three.js parent hierarchy.
 */

import { MathUtils, type Object3D, Quaternion, Vector3 } from "three/webgpu";
import { AxisType, type FixtureGeometry } from "../../../types";

/** Degrees represented by a normalized pan value of 1. */
const PAN_RANGE_DEG = 540;
/** Degrees represented by a normalized tilt value of 1. */
const TILT_RANGE_DEG = 270;
/** Maximum mechanical speed applied when smoothing joint movement. */
const DEFAULT_JOINT_SPEED_DEG_PER_SEC = 180;

const LOCAL_Z = new Vector3(0, 0, 1);
const LOCAL_X = new Vector3(1, 0, 0);
const scratchRotation = new Quaternion();

/** A rotating geometry node bound to its element's pan and/or tilt. */
export type GdtfJoint = {
  /** Scene node rotated by this joint. */
  node: Object3D;
  /** Movement axes in application order (pan before tilt). */
  axes: Array<AxisType.Pan | AxisType.Tilt>;
  /**
   * Label of the element whose pan/tilt drives the joint: the node's own
   * name, since movement channels name the geometry they move. When no
   * element has that label, fixture-wide values are used.
   */
  element: string;
  /** Authored orientation at zero movement. */
  rest: Quaternion;
  /** Current angle in radians per entry of `axes`. */
  currentRad: number[];
  /** Clock value of the last update in milliseconds, or null before the first update. */
  lastUpdateMs: number | null;
};

/** Normalized pan/tilt values for one element. */
export type JointInput = { pan?: number; tilt?: number };

/**
 * Creates one joint for every node with movement axes.
 *
 * Must be called after node transforms are applied so each joint captures its
 * authored rest orientation.
 */
export function createGdtfJoints(
  nodeObjects: Map<string, Object3D>,
  geometry: FixtureGeometry,
): GdtfJoint[] {
  const joints: GdtfJoint[] = [];
  for (const node of geometry.nodes) {
    const axes = (node.axes ?? []).filter(
      (axis): axis is AxisType.Pan | AxisType.Tilt =>
        axis === AxisType.Pan || axis === AxisType.Tilt,
    );
    if (axes.length === 0) continue;
    const object = nodeObjects.get(node.name);
    if (!object) continue;
    joints.push({
      node: object,
      axes,
      element: node.name,
      rest: object.quaternion.clone(),
      currentRad: axes.map(() => 0),
      lastUpdateMs: null,
    });
  }
  return joints;
}

/**
 * Returns the fixture-wide pan/tilt used by joints without a matching element:
 * the first element providing either value.
 */
function fixtureWideInput(inputs: Map<string, JointInput>): JointInput {
  for (const input of inputs.values()) {
    if (input.pan !== undefined || input.tilt !== undefined) return input;
  }
  return {};
}

/** Returns an axis's target angle in radians from an element's normalized input. */
function targetAngleRad(
  axis: AxisType.Pan | AxisType.Tilt,
  input: JointInput,
): number {
  const normalized = axis === AxisType.Pan ? input.pan : input.tilt;
  const rangeDeg = axis === AxisType.Pan ? PAN_RANGE_DEG : TILT_RANGE_DEG;
  return MathUtils.degToRad((normalized ?? 0) * rangeDeg);
}

/**
 * Moves joints toward their elements' pan/tilt targets.
 *
 * With `speedDegPerSec` set, each axis moves at most that far per elapsed
 * second of the supplied clock; the first update snaps to the target. Pass
 * `null` to apply targets immediately. A node's orientation is its rest pose
 * followed by each axis rotation in order.
 */
export function updateGdtfJoints(
  joints: GdtfJoint[],
  inputs: Map<string, JointInput>,
  nowMs: number,
  speedDegPerSec: number | null = DEFAULT_JOINT_SPEED_DEG_PER_SEC,
): void {
  let fallback: JointInput | undefined;
  for (const joint of joints) {
    let input = inputs.get(joint.element);
    if (!input) {
      fallback ??= fixtureWideInput(inputs);
      input = fallback;
    }
    const elapsedSeconds =
      joint.lastUpdateMs === null
        ? null
        : Math.max(0, nowMs - joint.lastUpdateMs) / 1000;
    joint.lastUpdateMs = nowMs;

    joint.node.quaternion.copy(joint.rest);
    joint.axes.forEach((axis, index) => {
      const target = targetAngleRad(axis, input);
      if (speedDegPerSec === null || elapsedSeconds === null) {
        joint.currentRad[index] = target;
      } else {
        const maxStep = MathUtils.degToRad(speedDegPerSec * elapsedSeconds);
        joint.currentRad[index] += MathUtils.clamp(
          target - joint.currentRad[index],
          -maxStep,
          maxStep,
        );
      }
      scratchRotation.setFromAxisAngle(
        axis === AxisType.Pan ? LOCAL_Z : LOCAL_X,
        joint.currentRad[index],
      );
      joint.node.quaternion.multiply(scratchRotation);
    });
  }
}
