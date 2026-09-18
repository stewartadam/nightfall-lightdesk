// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PerspectiveCamera } from "three/webgpu";
import { Box3, type Group, Mesh, Vector3 } from "three/webgpu";
import { getCameraState, saveCameraState } from "./camera-state";

/** Padding factor for zoom-to-fit (1.0 = exact fit, higher = more padding) */
const ZOOM_PADDING_FACTOR = 1.2;

/**
 * Check if an object should be excluded from bounding box calculation.
 * Excludes beam meshes, spotlights, and their targets that extend far from fixtures.
 */
function shouldExcludeFromBoundingBox(object: { name: string }): boolean {
  const name = object.name;
  return (
    name === "Beam" ||
    name === "BeamFootprint" ||
    name.startsWith("Beam_") ||
    name === "SpotLight" ||
    name.startsWith("SpotLight_") ||
    name === "SpotLightTarget" ||
    name.startsWith("SpotLightTarget_")
  );
}

/**
 * Zoom camera to frame the given fixture groups.
 * Computes bounding box of all groups and positions camera to see them all.
 * Preserves the current camera viewing angle - only adjusts distance and target.
 * Excludes beam meshes from bounding box calculation to avoid extreme zoom-out.
 *
 * @param camera - The perspective camera to position
 * @param controls - OrbitControls to update target
 * @param groups - Array of Three.js Groups to frame
 */
export function zoomCameraToGroups(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  groups: Group[],
): void {
  if (groups.length === 0) return;

  // Compute combined bounding box by manually traversing and expanding by mesh geometry
  // This avoids Three.js's expandByObject which includes all children including invisible ones
  const box = new Box3();
  for (const group of groups) {
    group.traverse((object) => {
      // Skip beam-related objects - they extend far and would cause extreme zoom-out
      if (shouldExcludeFromBoundingBox(object)) {
        return;
      }

      // Only include Mesh objects with geometry in the bounding box
      if (object instanceof Mesh && object.geometry) {
        // Update world matrix to get correct world position
        object.updateWorldMatrix(true, false);
        // Compute bounding box of this mesh's geometry
        if (!object.geometry.boundingBox) {
          object.geometry.computeBoundingBox();
        }
        if (object.geometry.boundingBox) {
          // Transform bounding box to world coordinates
          const meshBox = object.geometry.boundingBox.clone();
          meshBox.applyMatrix4(object.matrixWorld);
          box.union(meshBox);
        }
      }
    });
  }

  // Check for valid bounding box
  if (box.isEmpty()) return;

  const center = box.getCenter(new Vector3());

  // Preserve current camera viewing direction (from camera to current target)
  const currentDir = new Vector3()
    .subVectors(camera.position, controls.target)
    .normalize();

  // Calculate the "up" direction for the camera view (world Y is up)
  const worldUp = new Vector3(0, 1, 0);
  // Calculate the right vector (perpendicular to view direction and up)
  const rightDir = new Vector3().crossVectors(currentDir, worldUp).normalize();
  // Recalculate up vector to be perpendicular to both view and right
  const upDir = new Vector3().crossVectors(rightDir, currentDir).normalize();

  // Handle edge case where camera is looking straight down/up
  if (rightDir.lengthSq() < 0.001) {
    rightDir.set(1, 0, 0);
    upDir.crossVectors(rightDir, currentDir).normalize();
  }

  // Calculate the bounding box corners
  const corners = [
    new Vector3(box.min.x, box.min.y, box.min.z),
    new Vector3(box.min.x, box.min.y, box.max.z),
    new Vector3(box.min.x, box.max.y, box.min.z),
    new Vector3(box.min.x, box.max.y, box.max.z),
    new Vector3(box.max.x, box.min.y, box.min.z),
    new Vector3(box.max.x, box.min.y, box.max.z),
    new Vector3(box.max.x, box.max.y, box.min.z),
    new Vector3(box.max.x, box.max.y, box.max.z),
  ];

  // Calculate FOV parameters
  const fovRad = (camera.fov * Math.PI) / 180;
  const halfVerticalFovTan = Math.tan(fovRad / 2);
  const halfHorizontalFovTan = halfVerticalFovTan * camera.aspect;

  // For perspective projection, we need to find the minimum distance such that
  // all corners are within the view frustum. For each corner:
  // - Calculate its offset from the view axis (in right and up directions)
  // - Calculate its depth along the view direction (from center)
  // - Compute the required distance so that corner is within FOV
  //
  // The key insight is that a corner at depth d from center and offset r from
  // the view axis requires the camera to be at distance D where:
  //   r / (D - d) <= tan(fov/2)  =>  D >= r / tan(fov/2) + d

  let maxRequiredDistance = 0;

  for (const corner of corners) {
    const relativePos = corner.clone().sub(center);

    // Project onto camera coordinate system
    const rightOffset = Math.abs(relativePos.dot(rightDir));
    const upOffset = Math.abs(relativePos.dot(upDir));
    // Depth is positive when corner is behind center (further from camera)
    const depth = -relativePos.dot(currentDir);

    // Calculate required distance for this corner to fit horizontally and vertically
    const distanceForHorizontal =
      (rightOffset * ZOOM_PADDING_FACTOR) / halfHorizontalFovTan + depth;
    const distanceForVertical =
      (upOffset * ZOOM_PADDING_FACTOR) / halfVerticalFovTan + depth;

    maxRequiredDistance = Math.max(
      maxRequiredDistance,
      distanceForHorizontal,
      distanceForVertical,
    );
  }

  // Ensure minimum distance
  const distance = Math.max(maxRequiredDistance, 1);

  // Position camera along the current viewing direction from the new center
  camera.position.copy(center).addScaledVector(currentDir, distance);
  controls.target.copy(center);
  controls.update();

  // Save camera state
  saveCameraState(getCameraState(camera, controls));
}
