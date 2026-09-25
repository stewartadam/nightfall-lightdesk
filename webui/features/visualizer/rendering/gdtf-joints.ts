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
 * to the element the converter records as its controller. A joint keeps its
 * authored rest orientation and adds its own rotation on top: pan about the
 * node's local GDTF Z axis, tilt about its local X axis. Joints move
 * independently, so multi-head fixtures and nested pan/tilt chains follow the
 * Three.js parent hierarchy.
 *
 * Positions come from the profile's physical angles. Continuous rotation
 * functions spin a joint at their physical speed; when rotation stops the
 * joint returns to its position along the shortest turn.
 */

import { MathUtils, type Object3D, Quaternion, Vector3 } from "three/webgpu";
import { AxisType, type FixtureGeometry } from "../../../types";

/** Degrees represented by a normalized pan value of 1, for profiles without physical angles. */
const PAN_RANGE_DEG = 540;
/** Degrees represented by a normalized tilt value of 1, for profiles without physical angles. */
const TILT_RANGE_DEG = 270;
/** Maximum mechanical speed applied when smoothing joint movement. */
const DEFAULT_JOINT_SPEED_DEG_PER_SEC = 180;
const FULL_TURN_RAD = Math.PI * 2;

const LOCAL_Z = new Vector3(0, 0, 1);
const LOCAL_X = new Vector3(1, 0, 0);
const scratchRotation = new Quaternion();

/** A rotating geometry node bound to its element's pan and/or tilt. */
export type GdtfJoint = {
  /** Scene node rotated by this joint. */
  node: Object3D;
  /** Movement axes in application order (pan before tilt). */
  axes: Array<AxisType.Pan | AxisType.Tilt>;
  /** Label of the element whose pan/tilt drives the joint. */
  element: string;
  /** Authored orientation at zero movement. */
  rest: Quaternion;
  /** Current angle in radians per entry of `axes`. */
  currentRad: number[];
  /** Per entry of `axes`, whether the angle was wrapped by continuous rotation. */
  spun: boolean[];
  /** Clock value of the last update in milliseconds, or null before the first update. */
  lastUpdateMs: number | null;
};

/** Pan/tilt values for one element. */
export type JointInput = {
  /** Pan normalized against 540°, used when `panDegrees` is absent. */
  pan?: number;
  /** Tilt normalized against 270°, used when `tiltDegrees` is absent. */
  tilt?: number;
  /** Pan angle in degrees. */
  panDegrees?: number;
  /** Tilt angle in degrees. */
  tiltDegrees?: number;
  /** Continuous pan rotation in degrees per second. */
  panRotation?: number;
  /** Continuous tilt rotation in degrees per second. */
  tiltRotation?: number;
};

/**
 * Creates one joint for every node with movement axes, bound to the node's
 * controlling element.
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
    if (axes.length === 0 || !node.controlledElement) continue;
    const object = nodeObjects.get(node.name);
    if (!object) continue;
    joints.push({
      node: object,
      axes,
      element: node.controlledElement,
      rest: object.quaternion.clone(),
      currentRad: axes.map(() => 0),
      spun: axes.map(() => false),
      lastUpdateMs: null,
    });
  }
  return joints;
}

/**
 * Returns an axis's target angle in radians, preferring the physical angle
 * over the normalized fallback, or undefined when the element has neither.
 */
function targetAngleRad(
  axis: AxisType.Pan | AxisType.Tilt,
  input: JointInput,
): number | undefined {
  const degrees =
    axis === AxisType.Pan
      ? (input.panDegrees ??
        (input.pan === undefined ? undefined : input.pan * PAN_RANGE_DEG))
      : (input.tiltDegrees ??
        (input.tilt === undefined ? undefined : input.tilt * TILT_RANGE_DEG));
  return degrees === undefined ? undefined : MathUtils.degToRad(degrees);
}

/** Returns `angle` shifted by whole turns to lie within half a turn of `target`. */
function nearestTurn(angle: number, target: number): number {
  return (
    target +
    MathUtils.euclideanModulo(angle - target + Math.PI, FULL_TURN_RAD) -
    Math.PI
  );
}

/**
 * Moves joints toward their elements' pan/tilt targets, or spins them while
 * a continuous rotation speed is set.
 *
 * With `speedDegPerSec` set, each positioned axis moves at most that far per
 * elapsed second of the supplied clock; the first update snaps to the
 * target. Pass `null` to apply targets immediately. Joints whose element has
 * no input keep their pose. A node's orientation is its rest pose followed by
 * each axis rotation in order.
 */
export function updateGdtfJoints(
  joints: GdtfJoint[],
  inputs: Map<string, JointInput>,
  nowMs: number,
  speedDegPerSec: number | null = DEFAULT_JOINT_SPEED_DEG_PER_SEC,
): void {
  for (const joint of joints) {
    const input = inputs.get(joint.element);
    if (!input) continue;
    const elapsedSeconds =
      joint.lastUpdateMs === null
        ? null
        : Math.max(0, nowMs - joint.lastUpdateMs) / 1000;
    joint.lastUpdateMs = nowMs;

    joint.node.quaternion.copy(joint.rest);
    joint.axes.forEach((axis, index) => {
      const rotation =
        (axis === AxisType.Pan ? input.panRotation : input.tiltRotation) ?? 0;
      const current = joint.currentRad[index];
      if (rotation !== 0) {
        const step = MathUtils.degToRad(rotation * (elapsedSeconds ?? 0));
        joint.currentRad[index] = MathUtils.euclideanModulo(
          current + step,
          FULL_TURN_RAD,
        );
        joint.spun[index] = true;
      } else {
        const target = targetAngleRad(axis, input);
        if (target !== undefined) {
          // A spun angle is wrapped, so it returns along the shorter way;
          // ordinary moves keep the travel the mechanical range implies.
          const from = joint.spun[index]
            ? nearestTurn(current, target)
            : current;
          joint.spun[index] = false;
          if (speedDegPerSec === null || elapsedSeconds === null) {
            joint.currentRad[index] = target;
          } else {
            const maxStep = MathUtils.degToRad(speedDegPerSec * elapsedSeconds);
            joint.currentRad[index] =
              from + MathUtils.clamp(target - from, -maxStep, maxStep);
          }
        }
      }
      scratchRotation.setFromAxisAngle(
        axis === AxisType.Pan ? LOCAL_Z : LOCAL_X,
        joint.currentRad[index],
      );
      joint.node.quaternion.multiply(scratchRotation);
    });
  }
}
