// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AvailableObjectInfo } from "../../../types";
import {
  objectLibrarySelectedObject,
  setObjectLibrarySelectedObject,
} from "./selection";

/**
 * Builds an object-library entry with stable defaults for context state tests.
 */
function makeObject(
  overrides: Partial<AvailableObjectInfo> = {},
): AvailableObjectInfo {
  return {
    name: "Truss 1",
    category: "truss",
    description: "Default truss",
    scale: 1,
    tags: ["rigging"],
    modelPath: "bundle/truss.glb",
    assetVersion: "v1",
    ...overrides,
  };
}

test("setObjectLibrarySelectedObject stores an unproxified copy", () => {
  const source = makeObject();
  setObjectLibrarySelectedObject(source);

  const selected = objectLibrarySelectedObject.get();
  assert.ok(selected);
  assert.notEqual(selected, source);
  assert.notEqual(selected.tags, source.tags);

  source.name = "Mutated Source";
  source.tags?.push("changed");

  assert.equal(objectLibrarySelectedObject.get()?.name, "Truss 1");
  assert.deepEqual(objectLibrarySelectedObject.get()?.tags, ["rigging"]);

  setObjectLibrarySelectedObject(null);
});

test("multi-row click simulation keeps row objects isolated", () => {
  const rowA = makeObject({ name: "Row A", tags: ["a"] });
  const rowB = makeObject({ name: "Row B", tags: ["b"] });
  const rows = [rowA, rowB];

  setObjectLibrarySelectedObject(rows[0]);
  const selectedA = objectLibrarySelectedObject.get();
  assert.ok(selectedA);
  selectedA.name = "Changed Selected A";
  selectedA.tags?.push("selected-a");
  assert.equal(rows[0].name, "Row A");
  assert.deepEqual(rows[0].tags, ["a"]);

  setObjectLibrarySelectedObject(rows[1]);
  const selectedB = objectLibrarySelectedObject.get();
  assert.ok(selectedB);
  selectedB.name = "Changed Selected B";
  selectedB.tags?.push("selected-b");
  assert.equal(rows[1].name, "Row B");
  assert.deepEqual(rows[1].tags, ["b"]);

  assert.equal(rows[0].name, "Row A");
  assert.deepEqual(rows[0].tags, ["a"]);

  setObjectLibrarySelectedObject(null);
});
