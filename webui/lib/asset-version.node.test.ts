// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../types/index";
import {
  findFixtureVersionConflictIds,
  findSceneObjectVersionConflictIds,
  hasSceneObjectLibraryVersionWarning,
  objectLibraryVersionMap,
} from "./asset-version";

/**
 * Builds a fixture record with overridable asset version fields.
 */
function fixture(
  id: number,
  uid: string,
  attrs: types.Attribute[],
  libraryAssetVersion?: string,
): types.Fixture {
  return {
    identifiers: {
      id,
      uid,
      label: `Fixture ${id}`,
    },
    make: "Acme",
    model: "Beam 200",
    mode: "16ch",
    elements: [
      {
        label: "Element",
        parameters: attrs.map((attribute) => ({
          attribute,
          min: 0,
          max: 255,
          offset: { type: "Absolute", data: { value: 0 } },
          resolution: types.DmxValueResolution.Coarse,
          is_inverted: false,
          is_snap: false,
          merge_type: types.MergeStrategy.HTP,
          use_grandmaster: false,
        })),
      },
    ],
    physical: undefined,
    placement: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    library_asset_etag: libraryAssetVersion,
  };
}

test("findFixtureVersionConflictIds identifies mismatched stored profiles", () => {
  const libraryFixture = fixture(0, "lib", [{ type: "Red" }], "v2");
  const fixtureMap: Record<string, types.Fixture> = {
    a: fixture(1, "uid-a", [{ type: "Red" }], "v2"),
    b: fixture(2, "uid-b", [{ type: "Blue" }], "v1"),
  };

  assert.deepEqual(
    findFixtureVersionConflictIds(fixtureMap, libraryFixture, "v2"),
    [2],
  );
});

test("findSceneObjectVersionConflictIds returns IDs with older versions", () => {
  const sceneObjectMap: Record<string, types.SceneObject> = {
    a: {
      identifiers: { id: 10, uid: "a", label: "Road Case A" },
      objectType: types.SceneObjectType.Custom,
      placement: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      properties: {
        type: "Custom",
        data: {
          modelPath: "show-token-a",
          scale: 1,
          colorOverride: undefined,
          libraryObjectName: "Road Case",
          libraryObjectVersion: "v1",
        },
      },
    },
    b: {
      identifiers: { id: 11, uid: "b", label: "Road Case B" },
      objectType: types.SceneObjectType.Custom,
      placement: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      properties: {
        type: "Custom",
        data: {
          modelPath: "show-token-b",
          scale: 1,
          colorOverride: undefined,
          libraryObjectName: "Road Case",
          libraryObjectVersion: "v2",
        },
      },
    },
  };

  assert.deepEqual(
    findSceneObjectVersionConflictIds(sceneObjectMap, "Road Case", "v2"),
    [10],
  );
});

test("findSceneObjectVersionConflictIds treats missing stored version as conflict", () => {
  const sceneObjectMap: Record<string, types.SceneObject> = {
    a: {
      identifiers: { id: 12, uid: "a", label: "Road Case A" },
      objectType: types.SceneObjectType.Custom,
      placement: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      properties: {
        type: "Custom",
        data: {
          modelPath: "show-token-a",
          scale: 1,
          colorOverride: undefined,
          libraryObjectName: "Road Case",
          libraryObjectVersion: undefined,
        },
      },
    },
  };

  assert.deepEqual(
    findSceneObjectVersionConflictIds(sceneObjectMap, "Road Case", "v2"),
    [12],
  );
});

test("hasSceneObjectLibraryVersionWarning is true when library version differs", () => {
  const versions = objectLibraryVersionMap([
    {
      name: "Road Case",
      category: "Props",
      description: "",
      scale: 1,
      tags: [],
      modelPath: "lib-token",
      assetVersion: "v2",
    },
  ]);

  const sceneObject: types.SceneObject = {
    identifiers: { id: 20, uid: "uid-20", label: "Road Case" },
    objectType: types.SceneObjectType.Custom,
    placement: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    properties: {
      type: "Custom",
      data: {
        modelPath: "show-token",
        scale: 1,
        colorOverride: undefined,
        libraryObjectName: "Road Case",
        libraryObjectVersion: "v1",
      },
    },
  };

  assert.equal(
    hasSceneObjectLibraryVersionWarning(sceneObject, versions),
    true,
  );
});

test("hasSceneObjectLibraryVersionWarning is true when object has no stored version", () => {
  const versions = objectLibraryVersionMap([
    {
      name: "Road Case",
      category: "Props",
      description: "",
      scale: 1,
      tags: [],
      modelPath: "lib-token",
      assetVersion: "v2",
    },
  ]);

  const sceneObject: types.SceneObject = {
    identifiers: { id: 21, uid: "uid-21", label: "Road Case" },
    objectType: types.SceneObjectType.Custom,
    placement: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    properties: {
      type: "Custom",
      data: {
        modelPath: "show-token",
        scale: 1,
        colorOverride: undefined,
        libraryObjectName: "Road Case",
        libraryObjectVersion: undefined,
      },
    },
  };

  assert.equal(
    hasSceneObjectLibraryVersionWarning(sceneObject, versions),
    true,
  );
});
