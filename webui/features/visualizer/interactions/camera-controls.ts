// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PerspectiveCamera } from "three/webgpu";
import { Quaternion, Vector3 } from "three/webgpu";
import { DEFAULT_CAMERA_TARGET } from "../model/camera-state";
import type { VisualizerCameraRotationMode } from "../rendering/renderers/renderer-api";
import { DEFAULT_STAGE_FLOOR_TOP_Y } from "../rendering/scene-environment";

const ORBIT_ROTATION_ORIGIN = new Vector3(0, 0, 0);
const ORBIT_ROTATION_SPEED = 1.0;
const WHEEL_ORBIT_TARGET_SETTLE_MS = 120;
export const DEFAULT_CAMERA_ROTATION_MODE: VisualizerCameraRotationMode =
  "camera-locked";

type ControlsBehaviorController = {
  setRotationMode(mode: VisualizerCameraRotationMode): void;
  getRotationMode(): VisualizerCameraRotationMode;
  cancelInteraction(): void;
  dispose(): void;
};

const controlsBehaviorControllers = new WeakMap<
  OrbitControls,
  ControlsBehaviorController
>();

type TargetControls = Pick<OrbitControls, "target" | "update">;

type CapturingControlsElement = HTMLElement & {
  hasPointerCapture?: (pointerId: number) => boolean;
  releasePointerCapture?: (pointerId: number) => void;
};

type OrbitControlsPointerInternals = OrbitControls & {
  state?: number;
  _pointers?: number[];
  _pointerPositions?: Record<number, unknown>;
  _onPointerMove?: EventListener;
  _onPointerUp?: EventListener;
  domElement: CapturingControlsElement;
};

/**
 * Base speed for dolly movement. Actual speed scales with current distance
 * to maintain consistent perceived movement at all zoom levels.
 */
const DOLLY_SPEED_FACTOR = 0.001;
const MAX_DOLLY_STEP_DISTANCE = 25;
const MAX_DOLLY_STEP_DISTANCE_RATIO = 0.3;

/**
 * Minimum distance to use for speed calculations, preventing
 * movement from becoming too slow when very close.
 */
const MIN_DOLLY_DISTANCE = 0.5;

/** Compute a bounded wheel dolly step for the current camera distance. */
export function calculateWheelDollyMoveAmount(
  deltaY: number,
  distance: number,
): number {
  const effectiveDistance = Math.max(distance, MIN_DOLLY_DISTANCE);
  const rawMoveAmount = -deltaY * DOLLY_SPEED_FACTOR * effectiveDistance ** 1.3;
  const maxStep = Math.max(
    MIN_DOLLY_DISTANCE,
    Math.min(
      MAX_DOLLY_STEP_DISTANCE,
      effectiveDistance * MAX_DOLLY_STEP_DISTANCE_RATIO,
    ),
  );
  return Math.max(-maxStep, Math.min(maxStep, rawMoveAmount));
}

/**
 * Target distance for 1:1 cursor tracking during pan.
 * Pan speed is scaled so that at this distance, cursor movement matches
 * world movement at the target point. At closer distances, pan speed
 * increases proportionally to maintain 1:1 tracking feel.
 */
const PAN_REFERENCE_DISTANCE = 10.0;

/**
 * Update the controls target based on the intersection with the floor.
 * This ensures the camera target is correctly positioned on the floor plane.
 *
 * @param camera The perspective camera.
 * @param controls The target controls.
 * @returns True if the target was updated, false otherwise.
 */
export function updateControlsTargetFromFloorIntersection(
  camera: PerspectiveCamera,
  controls: TargetControls,
): boolean {
  const worldDirection = new Vector3();
  camera.getWorldDirection(worldDirection);
  const denominator = worldDirection.y;
  if (Math.abs(denominator) <= 1e-5) {
    return false;
  }
  const distanceToFloor =
    (DEFAULT_STAGE_FLOOR_TOP_Y - camera.position.y) / denominator;
  if (distanceToFloor <= 0) {
    return false;
  }

  controls.target
    .copy(camera.position)
    .addScaledVector(worldDirection, distanceToFloor);
  controls.update();
  return true;
}

/**
 * Create the orbit controls for camera manipulation.
 * The domElement can be an HTMLElement or a proxy object (for workers).
 *
 * Uses OrbitControls for rotation and panning, but replaces the default
 * drag rotation with configurable pivot behavior and replaces default
 * scroll-wheel zoom with dolly-through (moving camera+target together).
 * This provides consistent zoom behavior at all distances without hitting
 * a minimum distance limit.
 */
export function createControls(
  camera: PerspectiveCamera,
  domElement: HTMLElement,
  target = DEFAULT_CAMERA_TARGET,
  rotationMode: VisualizerCameraRotationMode = DEFAULT_CAMERA_ROTATION_MODE,
): OrbitControls {
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = false; // Disable damping - causes drift with dynamic pan speed
  controls.target.set(target.x, target.y, target.z);

  // Disable OrbitControls' built-in zoom - we handle it ourselves
  controls.enableZoom = false;

  // Setup our dolly-through zoom and enhanced pan
  const behaviorController = setupDollyControls(
    controls,
    camera,
    domElement,
    rotationMode,
  );
  controlsBehaviorControllers.set(controls, behaviorController);

  return controls;
}

/**
 * Set the rotation mode for the given controls.
 *
 * @param controls The orbit controls.
 * @param mode The desired rotation mode.
 */
export function setControlsRotationMode(
  controls: OrbitControls,
  mode: VisualizerCameraRotationMode,
): void {
  controlsBehaviorControllers.get(controls)?.setRotationMode(mode);
}

/**
 * Release a pointer capture if the element still owns it.
 */
function releasePointerCapture(
  domElement: CapturingControlsElement,
  pointerId: number,
): void {
  if (!domElement.releasePointerCapture) return;
  if (
    domElement.hasPointerCapture &&
    !domElement.hasPointerCapture(pointerId)
  ) {
    return;
  }
  try {
    domElement.releasePointerCapture(pointerId);
  } catch {
    // Browsers throw when capture has already been released.
  }
}

/**
 * Clear OrbitControls pointer-drag state without changing the camera.
 */
function clearOrbitControlsPointerState(controls: OrbitControls): void {
  const internals = controls as OrbitControlsPointerInternals;
  const activePointerIds = [...(internals._pointers ?? [])];

  for (const pointerId of activePointerIds) {
    releasePointerCapture(internals.domElement, pointerId);
  }

  const ownerDocument = internals.domElement.ownerDocument as
    | EventTarget
    | undefined;
  if (ownerDocument && internals._onPointerMove) {
    ownerDocument.removeEventListener("pointermove", internals._onPointerMove);
  }
  if (ownerDocument && internals._onPointerUp) {
    ownerDocument.removeEventListener("pointerup", internals._onPointerUp);
  }

  if (internals._pointers) {
    internals._pointers.length = 0;
  }
  if (internals._pointerPositions) {
    internals._pointerPositions = {};
  }
  if (internals.state !== undefined && internals.state !== -1) {
    internals.dispatchEvent({ type: "end" });
  }
  internals.state = -1;
}

/**
 * Cancel active camera-control dragging without moving or resetting the camera.
 */
export function cancelControlsInteraction(controls: OrbitControls): void {
  controlsBehaviorControllers.get(controls)?.cancelInteraction();
  clearOrbitControlsPointerState(controls);
}

/**
 * Dispose the behavior controller for the given controls.
 *
 * @param controls The orbit controls.
 */
export function disposeControlsBehavior(controls: OrbitControls): void {
  controlsBehaviorControllers.get(controls)?.dispose();
  controlsBehaviorControllers.delete(controls);
}

/**
 * Setup dolly-through zoom behavior and enhanced panning.
 *
 * Dolly-through moves camera and target together along the view direction,
 * providing consistent "zoom" feel at any distance without artificial limits.
 */
function setupDollyControls(
  controls: OrbitControls,
  camera: PerspectiveCamera,
  domElement: HTMLElement,
  initialRotationMode: VisualizerCameraRotationMode,
): ControlsBehaviorController {
  let rotationMode = initialRotationMode;

  const yawAxis = new Vector3(0, 1, 0);
  const rightAxis = new Vector3();
  const yawRotation = new Quaternion();
  const pitchRotation = new Quaternion();
  const dollyDirection = new Vector3();
  let rotatePointerId: number | null = null;
  let rotateStartX = 0;
  let rotateStartY = 0;
  let wheelTargetUpdateTimeout: ReturnType<typeof setTimeout> | null = null;

  const cancelCenterLockedRotation = () => {
    if (rotatePointerId !== null) {
      if (domElement.hasPointerCapture?.(rotatePointerId)) {
        domElement.releasePointerCapture(rotatePointerId);
      }
      rotatePointerId = null;
    }
  };

  const setRotationMode = (mode: VisualizerCameraRotationMode) => {
    rotationMode = mode;
    controls.enableRotate = mode === "camera-locked";
    if (mode === "camera-locked") {
      cancelCenterLockedRotation();
    }
  };
  setRotationMode(initialRotationMode);

  const applyOriginRotation = (deltaX: number, deltaY: number) => {
    const width = Math.max(domElement.clientWidth, 1);
    const height = Math.max(domElement.clientHeight, 1);
    const yaw = (-deltaX / width) * Math.PI * ORBIT_ROTATION_SPEED;
    const pitch = (-deltaY / height) * Math.PI * ORBIT_ROTATION_SPEED;

    yawRotation.setFromAxisAngle(yawAxis, yaw);
    rightAxis.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    pitchRotation.setFromAxisAngle(rightAxis, pitch);

    camera.position.sub(ORBIT_ROTATION_ORIGIN);
    camera.position.applyQuaternion(yawRotation);
    camera.position.applyQuaternion(pitchRotation);
    camera.position.add(ORBIT_ROTATION_ORIGIN);

    controls.target.sub(ORBIT_ROTATION_ORIGIN);
    controls.target.applyQuaternion(yawRotation);
    controls.target.applyQuaternion(pitchRotation);
    controls.target.add(ORBIT_ROTATION_ORIGIN);

    controls.update();
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (rotationMode === "camera-locked") {
      if (!controls.enabled || event.button !== 0) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      updateControlsTargetFromFloorIntersection(camera, controls);
      return;
    }
    if (rotationMode !== "center-locked") {
      return;
    }
    if (!controls.enabled || event.button !== 0) {
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    rotatePointerId = event.pointerId;
    rotateStartX = event.clientX;
    rotateStartY = event.clientY;
    domElement.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (rotationMode !== "center-locked") {
      return;
    }
    if (!controls.enabled || rotatePointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - rotateStartX;
    const deltaY = event.clientY - rotateStartY;
    if (deltaX === 0 && deltaY === 0) {
      return;
    }
    applyOriginRotation(deltaX, deltaY);
    rotateStartX = event.clientX;
    rotateStartY = event.clientY;
    event.preventDefault();
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (rotationMode !== "center-locked") {
      return;
    }
    if (rotatePointerId !== event.pointerId) {
      return;
    }
    rotatePointerId = null;
    if (domElement.hasPointerCapture?.(event.pointerId)) {
      domElement.releasePointerCapture(event.pointerId);
    }
  };

  const handleControlsEnd = () => {
    if (rotationMode !== "camera-locked") {
      return;
    }
    updateControlsTargetFromFloorIntersection(camera, controls);
  };

  const scheduleWheelTargetUpdate = () => {
    if (wheelTargetUpdateTimeout !== null) {
      clearTimeout(wheelTargetUpdateTimeout);
    }
    wheelTargetUpdateTimeout = setTimeout(() => {
      wheelTargetUpdateTimeout = null;
      if (rotationMode !== "camera-locked") {
        return;
      }
      updateControlsTargetFromFloorIntersection(camera, controls);
    }, WHEEL_ORBIT_TARGET_SETTLE_MS);
  };

  const handleWheel = (event: WheelEvent) => {
    if (!controls.enabled) {
      return;
    }
    event.preventDefault();

    // Calculate view direction (camera to target = forward)
    dollyDirection.subVectors(controls.target, camera.position).normalize();

    // Current distance for speed scaling
    const distance = camera.position.distanceTo(controls.target);

    // Scale movement by distance^1.5 to compensate for perspective
    // Far distances need faster movement to feel perceptually consistent
    // Negative deltaY = scroll up = zoom in = move forward
    const moveAmount = calculateWheelDollyMoveAmount(event.deltaY, distance);

    // Move both camera and target together
    camera.position.addScaledVector(dollyDirection, moveAmount);
    controls.target.addScaledVector(dollyDirection, moveAmount);

    // Update controls - this fires the "change" event which handles persistence
    controls.update();
    scheduleWheelTargetUpdate();
  };

  // Dynamic pan speed adjustment for 1:1 cursor tracking
  // OrbitControls scales pan by distance, but we want consistent cursor-follows-point behavior
  /** Scale panSpeed inversely with distance so panning feels the same at all zoom levels */
  const updatePanSpeed = () => {
    const distance = camera.position.distanceTo(controls.target);
    // At PAN_REFERENCE_DISTANCE, panSpeed = 1.0
    // At closer distances, panSpeed increases to maintain 1:1 feel
    controls.panSpeed = PAN_REFERENCE_DISTANCE / Math.max(distance, 0.1);
  };

  controls.addEventListener("change", updatePanSpeed);
  controls.addEventListener("end", handleControlsEnd);
  updatePanSpeed();

  // Capture wheel events before they bubble
  domElement.addEventListener("wheel", handleWheel, {
    capture: true,
    passive: false,
  });
  domElement.addEventListener("pointerdown", handlePointerDown, {
    passive: false,
  });
  domElement.addEventListener("pointermove", handlePointerMove, {
    passive: false,
  });
  domElement.addEventListener("pointerup", handlePointerUp);
  domElement.addEventListener("pointercancel", handlePointerUp);

  return {
    setRotationMode,
    getRotationMode: () => rotationMode,
    cancelInteraction: cancelCenterLockedRotation,
    dispose: () => {
      cancelCenterLockedRotation();
      if (wheelTargetUpdateTimeout !== null) {
        clearTimeout(wheelTargetUpdateTimeout);
        wheelTargetUpdateTimeout = null;
      }
      controls.removeEventListener("change", updatePanSpeed);
      controls.removeEventListener("end", handleControlsEnd);
      domElement.removeEventListener("wheel", handleWheel, true);
      domElement.removeEventListener("pointerdown", handlePointerDown);
      domElement.removeEventListener("pointermove", handlePointerMove);
      domElement.removeEventListener("pointerup", handlePointerUp);
      domElement.removeEventListener("pointercancel", handlePointerUp);
    },
  };
}
