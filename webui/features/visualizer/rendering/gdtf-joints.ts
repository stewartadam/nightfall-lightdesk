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

/** A rotating geometry node bound to one element's pan or tilt. */
export type GdtfJoint = {
  /** Scene node rotated by this joint. */
  node: Object3D;
  /** Movement axis. */
  axis: AxisType.Pan | AxisType.Tilt;
  /** Label of the element whose pan or tilt drives the joint; undefined falls back to fixture-wide values. */
  element?: string;
  /** Authored orientation at zero movement. */
  rest: Quaternion;
  /** Current joint angle in radians. */
  currentRad: number;
  /** Clock value of the last update in milliseconds, or null before the first update. */
  lastUpdateMs: number | null;
};

/** Normalized pan/tilt values for one element. */
export type JointInput = { pan?: number; tilt?: number };

/**
 * Creates joints for every axis node of a geometry tree.
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
    if (node.axis !== AxisType.Pan && node.axis !== AxisType.Tilt) continue;
    const object = nodeObjects.get(node.name);
    if (!object) continue;
    joints.push({
      node: object,
      axis: node.axis,
      element: node.controlledElement,
      rest: object.quaternion.clone(),
      currentRad: 0,
      lastUpdateMs: null,
    });
  }
  return joints;
}

/**
 * Returns the fixture-wide pan/tilt used by joints without a bound element:
 * the first element providing either value.
 */
function fixtureWideInput(inputs: Map<string, JointInput>): JointInput {
  for (const input of inputs.values()) {
    if (input.pan !== undefined || input.tilt !== undefined) return input;
  }
  return {};
}

/** Returns a joint's target angle in radians from its element's normalized input. */
function targetAngleRad(joint: GdtfJoint, input: JointInput): number {
  const normalized = joint.axis === AxisType.Pan ? input.pan : input.tilt;
  const rangeDeg = joint.axis === AxisType.Pan ? PAN_RANGE_DEG : TILT_RANGE_DEG;
  return MathUtils.degToRad((normalized ?? 0) * rangeDeg);
}

/**
 * Moves joints toward their elements' pan/tilt targets.
 *
 * With `speedDegPerSec` set, each joint moves at most that far per elapsed
 * second of the supplied clock; the first update snaps to the target. Pass
 * `null` to apply targets immediately.
 */
export function updateGdtfJoints(
  joints: GdtfJoint[],
  inputs: Map<string, JointInput>,
  nowMs: number,
  speedDegPerSec: number | null = DEFAULT_JOINT_SPEED_DEG_PER_SEC,
): void {
  let fallback: JointInput | undefined;
  for (const joint of joints) {
    let input =
      joint.element === undefined ? undefined : inputs.get(joint.element);
    if (!input) {
      fallback ??= fixtureWideInput(inputs);
      input = fallback;
    }
    const target = targetAngleRad(joint, input);

    if (speedDegPerSec === null || joint.lastUpdateMs === null) {
      joint.currentRad = target;
    } else {
      const elapsedSeconds = Math.max(0, nowMs - joint.lastUpdateMs) / 1000;
      const maxStep = MathUtils.degToRad(speedDegPerSec * elapsedSeconds);
      joint.currentRad += MathUtils.clamp(
        target - joint.currentRad,
        -maxStep,
        maxStep,
      );
    }
    joint.lastUpdateMs = nowMs;

    scratchRotation.setFromAxisAngle(
      joint.axis === AxisType.Pan ? LOCAL_Z : LOCAL_X,
      joint.currentRad,
    );
    joint.node.quaternion.copy(joint.rest).multiply(scratchRotation);
  }
}
