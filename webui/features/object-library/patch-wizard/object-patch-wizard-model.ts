// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { AvailableObjectInfo, SceneObject } from "../../../types";
import { SceneObjectType } from "../../../types";

export type WizardObjectSource =
  | { type: "library"; object: AvailableObjectInfo }
  | { type: "default"; objectType: SceneObjectType };

export type WizardObjectOption = {
  key: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  scale: number;
  source: WizardObjectSource;
};

export type WizardObjectGroup = [string, WizardObjectOption[]];

export const DEFAULT_OBJECT_OPTIONS: readonly WizardObjectOption[] = [
  {
    key: "default:truss",
    name: "Truss",
    category: "Default Shapes",
    description: "Structural truss for rigging",
    tags: ["default", "shape", "rigging"],
    scale: 1,
    source: { type: "default", objectType: SceneObjectType.Truss },
  },
  {
    key: "default:audience",
    name: "Audience",
    category: "Default Shapes",
    description: "Audience area with multiple people",
    tags: ["default", "shape", "crowd"],
    scale: 1,
    source: { type: "default", objectType: SceneObjectType.Audience },
  },
  {
    key: "default:stage-element",
    name: "Stage Element",
    category: "Default Shapes",
    description: "Generic stage element placeholder",
    tags: ["default", "shape", "stage"],
    scale: 1,
    source: { type: "default", objectType: SceneObjectType.StageElement },
  },
  {
    key: "default:custom",
    name: "Custom Placeholder",
    category: "Default Shapes",
    description: "Placeholder custom object (no external model)",
    tags: ["default", "shape", "custom"],
    scale: 1,
    source: { type: "default", objectType: SceneObjectType.Custom },
  },
];

/** Projects built-in and library objects into sorted wizard options. */
export function buildWizardObjectOptions(
  libraryObjects: AvailableObjectInfo[],
): WizardObjectOption[] {
  const projectedLibraryObjects = libraryObjects.map((object) => ({
    key: `library:${object.name}`,
    name: object.name,
    category: object.category || "Uncategorized",
    description: object.description ?? "",
    tags: object.tags ?? [],
    scale: object.scale,
    source: { type: "library", object } as WizardObjectSource,
  }));

  return [...DEFAULT_OBJECT_OPTIONS, ...projectedLibraryObjects].sort(
    (left, right) => {
      const categoryCompare = left.category.localeCompare(right.category);
      if (categoryCompare !== 0) return categoryCompare;
      return left.name.localeCompare(right.name);
    },
  );
}

/** Finds the first contiguous ID range large enough for the requested quantity. */
export function nextAvailableSceneObjectId(
  sceneObjects: Record<string, SceneObject>,
  quantity: number,
): number {
  const usedIds = new Set(
    Object.values(sceneObjects).map(
      (sceneObject) => sceneObject.identifiers.id,
    ),
  );
  const safeQuantity = Math.max(1, quantity);

  let candidate = 1;
  while (true) {
    let hasConflict = false;
    for (let index = 0; index < safeQuantity; index++) {
      if (usedIds.has(candidate + index)) {
        candidate += index + 1;
        hasConflict = true;
        break;
      }
    }
    if (!hasConflict) return candidate;
  }
}

/** Returns whether the requested contiguous range intersects an existing ID. */
export function sceneObjectIdRangeHasConflict(
  sceneObjects: Record<string, SceneObject>,
  baseId: number,
  quantity: number,
): boolean {
  const usedIds = new Set(
    Object.values(sceneObjects).map(
      (sceneObject) => sceneObject.identifiers.id,
    ),
  );
  for (let index = 0; index < Math.max(1, quantity); index++) {
    if (usedIds.has(baseId + index)) return true;
  }
  return false;
}

/** Filters wizard objects across names, categories, descriptions, and tags. */
export function filterWizardObjectOptions(
  options: WizardObjectOption[],
  filterText: string,
): WizardObjectOption[] {
  const filter = filterText.trim().toLowerCase();
  if (!filter) return options;

  return options.filter(
    (object) =>
      object.name.toLowerCase().includes(filter) ||
      object.category.toLowerCase().includes(filter) ||
      object.description.toLowerCase().includes(filter) ||
      object.tags.some((tag) => tag.toLowerCase().includes(filter)),
  );
}

/** Groups filtered wizard options by sorted category label. */
export function groupWizardObjectOptions(
  options: WizardObjectOption[],
): WizardObjectGroup[] {
  const groups: Record<string, WizardObjectOption[]> = {};
  for (const object of options) {
    const category = object.category || "Uncategorized";
    if (!groups[category]) groups[category] = [];
    groups[category].push(object);
  }
  return Object.entries(groups).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}
