// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AvailableObjectInfo, SceneObject } from "../../../types";
import {
  buildWizardObjectOptions,
  filterWizardObjectOptions,
  groupWizardObjectOptions,
  nextAvailableSceneObjectId,
  sceneObjectIdRangeHasConflict,
} from "./object-patch-wizard-model";

/** Creates a minimal scene object for ID allocation tests. */
function sceneObject(id: number): SceneObject {
  return { identifiers: { id } } as SceneObject;
}

/** Verifies contiguous ID allocation skips occupied ranges. */
test("object patch wizard allocates contiguous scene object IDs", () => {
  const sceneObjects = {
    first: sceneObject(1),
    third: sceneObject(3),
  };

  assert.equal(nextAvailableSceneObjectId(sceneObjects, 2), 4);
  assert.equal(sceneObjectIdRangeHasConflict(sceneObjects, 2, 2), true);
  assert.equal(sceneObjectIdRangeHasConflict(sceneObjects, 4, 2), false);
});

/** Verifies library options support metadata search and category grouping. */
test("object patch wizard projects filters and groups library objects", () => {
  const libraryObject = {
    name: "Deck",
    category: "Stage",
    description: "Rolling platform",
    tags: ["platform"],
    scale: 1,
  } as AvailableObjectInfo;
  const options = buildWizardObjectOptions([libraryObject]);
  const filtered = filterWizardObjectOptions(options, "platform");

  assert.deepEqual(
    filtered.map((option) => option.name),
    ["Deck"],
  );
  assert.deepEqual(
    groupWizardObjectOptions(filtered).map(([category]) => category),
    ["Stage"],
  );
});
