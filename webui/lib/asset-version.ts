// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { AvailableObjectInfo, SceneObject } from "../types";

export function objectLibraryVersionMap(
  objects: AvailableObjectInfo[],
): Map<string, string> {
  const versionsByName = new Map<string, string>();
  for (const object of objects) {
    versionsByName.set(object.name, object.assetVersion);
  }
  return versionsByName;
}

/**
 * Find scene object version conflict IDs.
 */
export function findSceneObjectVersionConflictIds(
  sceneObjectMap: Record<string, SceneObject>,
  objectName: string,
  objectVersion: string,
): number[] {
  const conflicts: number[] = [];

  for (const sceneObject of Object.values(sceneObjectMap)) {
    if (sceneObject.properties.type !== "Custom") continue;
    if (sceneObject.properties.data.libraryObjectName !== objectName) continue;

    const currentVersion = sceneObject.properties.data.libraryObjectVersion;
    if (!currentVersion || currentVersion !== objectVersion) {
      conflicts.push(sceneObject.identifiers.id);
    }
  }

  conflicts.sort((a, b) => a - b);
  return conflicts;
}

export function hasSceneObjectLibraryVersionWarning(
  sceneObject: SceneObject,
  versionsByName: ReadonlyMap<string, string>,
): boolean {
  if (sceneObject.properties.type !== "Custom") {
    return false;
  }

  const objectName = sceneObject.properties.data.libraryObjectName;
  const objectVersion = sceneObject.properties.data.libraryObjectVersion;
  if (!objectName) {
    return false;
  }

  const libraryVersion = versionsByName.get(objectName);
  if (!libraryVersion) {
    return false;
  }

  if (!objectVersion) {
    return true;
  }

  return libraryVersion !== objectVersion;
}
